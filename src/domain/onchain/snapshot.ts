// Training-snapshot schema and feature mapping for the real point-in-time
// snapshot file (snapshot v1.0, assembled externally).
// Pure domain module: validation of the externally supplied snapshot file,
// the join against calibration rows by token id (lowercase address), the
// snapshot-block offset check, and the mapping of each snapshot field to
// the versioned numeric on-chain feature vector. Nothing here reads files
// or the chain; the adapter loads the file and calibration wires the join.
// When the file schema later differs, only this module (plus its schema
// doc) changes.
//
// Leakage rules enforced here, not in the script:
// - Status, reason, missingness indicators, pairIsMain, mainPairDex,
//   afterFixtureBlock and pair counts are NEVER features. A missing value
//   maps to the neutral value 0 with no indicator column, so a missing
//   on-chain feature contributes exactly zero to a linear head.
// - Drained LP (lpSupplyIsMinimumLiquidityOnly) maps burnedShare to 0 and
//   raises the separate affirmed liquidity_removed_24h flag instead: the
//   drain is visible at the snapshot block, so the flag is point-in-time
//   signal, while burnedShare 1.0 there would read as falsely safe.
// - Holder figures map to 0 when logBalanceSumOverSupply deviates from 1
//   beyond LOG_BALANCE_TOLERANCE (rebasing/reflection/fee tokens).
// - Deploy-to-first-liquidity is capped at DEPLOY_TO_FIRST_CAP_BLOCKS so
//   pre-Uniswap-V2 tokens (snapshot years after deployment) do not proxy
//   for era through this feature. Absolute block numbers are never
//   features; the join carries them for era diagnostics only.
import { err, ok } from "../result.ts";
import type { Result } from "../result.ts";
import { lockerShareOfBreakdown } from "./lockers.ts";

// Declared snapshot offset in blocks: firstLiquidityBlock + 7200. Rows
// whose snapshot block differs are collected as offset violations.
export const SNAPSHOT_OFFSET_BLOCKS = 7200;

// Version of the numeric mapping below: recalibration reports name it so
// a later mapping change cannot be confused with a weight change.
export const ONCHAIN_FEATURE_VERSION = "onchain-v3";

// Holder figures are unreliable for rebasing/reflection/fee tokens: when
// logBalanceSumOverSupply deviates from 1 beyond this tolerance, top1,
// top10 and holder-derived shares map to 0 (zero contribution).
export const LOG_BALANCE_TOLERANCE = 0.1;

// Deploy-to-first-liquidity cap in blocks (about 30 days): differences
// beyond the cap are era, not behaviour, so the feature stops there.
export const DEPLOY_TO_FIRST_CAP_BLOCKS = 216000;

export type SnapshotParseError = { kind: "schema-error"; message: string };

function schemaError(message: string): SnapshotParseError {
  return { kind: "schema-error", message };
}

export type OwnerClass = "zero/dead" | "eoa" | "contract" | "multisig" | "n/a";

export type SnapshotOwnerEntry = {
  readonly address: string | null;
  readonly class: OwnerClass;
};

export type SnapshotOwner =
  | { readonly status: "ok"; readonly owner: SnapshotOwnerEntry; readonly getOwner: SnapshotOwnerEntry }
  | { readonly status: "unavailable" | "error"; readonly reason: string };

export type SnapshotField<T> =
  | ({ readonly status: "ok" } & T)
  | { readonly status: "unavailable" | "error"; readonly reason: string };

export type SnapshotSection = {
  readonly status: "ok";
  readonly snapshotBlock: number;
  readonly firstLiquidityBlock: number;
  readonly mainPair: string;
  readonly mainPairDex: "v2" | "v3";
  readonly mainPairQuote: string;
  readonly afterFixtureBlock: boolean;
};

export type SnapshotRow = {
  readonly id: string;
  readonly snapshot: SnapshotField<SnapshotSection> & { readonly reason?: string | undefined };
  readonly deployBlock: number | null;
  readonly deployer: string | null;
  readonly deployerMethod: string | null;
  readonly owner: SnapshotOwner;
  readonly deployerShare: number | null;
  readonly ownerShare: number | null;
  readonly ownerIsDeployer: boolean | null;
  readonly holders: {
    readonly available: boolean;
    readonly reason: string | null;
    readonly top1Share: number;
    readonly top10Share: number;
    readonly logBalanceSumOverSupply: number | null;
  };
  readonly lp: {
    readonly available: boolean;
    readonly reason: string | null;
    readonly burnedShare: number;
    readonly lockerShare: number;
    // Per-locker breakdown (locker name to share) backing lockerShare: the
    // mapping recomputes the share from this record through the shared
    // locker registry, so train uses the same locker set the live plugin
    // reads by address. Empty when no locker holds LP.
    readonly lockerBreakdown: Readonly<Record<string, number>>;
    readonly deployerOrOwnerShare: number;
    readonly otherShare: number;
    readonly drained: boolean;
    readonly pairIsMain: boolean | null;
  };
  readonly liquidityWeth: number | null;
  readonly liquidityReason: string | null;
};

export type SnapshotFile = {
  readonly offsetBlocks: number;
  readonly rows: readonly SnapshotRow[];
  // Rows that failed validation by count and reason: reported, never
  // silently dropped. They stay out of the join index.
  readonly invalidRows: readonly { readonly index: number; readonly reason: string }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isShare(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function statusOf(group: unknown): "ok" | "unavailable" | "error" | null {
  if (!isRecord(group)) {
    return null;
  }
  const status = group["status"];
  if (status === "ok" || status === "unavailable" || status === "error") {
    return status;
  }
  return null;
}

function reasonOf(group: Record<string, unknown>): string | null {
  const reason = group["reason"];
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}

function asReason(group: Record<string, unknown>, what: string): Result<string, SnapshotParseError> {
  const reason = reasonOf(group);
  if (reason === null) {
    return err(schemaError(`${what} with a non-ok status needs a non-empty reason`));
  }
  return ok(reason);
}

function parseOwnerEntry(raw: unknown, what: string): Result<SnapshotOwnerEntry, SnapshotParseError> {
  if (!isRecord(raw)) {
    return err(schemaError(`${what} is not an object`));
  }
  const cls = raw["class"];
  if (cls !== "zero/dead" && cls !== "eoa" && cls !== "contract" && cls !== "multisig" && cls !== "n/a") {
    return err(schemaError(`${what} class is not a known owner class`));
  }
  const address = raw["address"];
  if (address !== null && address !== undefined && !isAddress(address)) {
    return err(schemaError(`${what} address is not a 0x address or null`));
  }
  const value = typeof address === "string" ? address.toLowerCase() : null;
  return ok({ address: value, class: cls });
}

function parseOwner(raw: unknown): Result<SnapshotOwner, SnapshotParseError> {
  const status = statusOf(raw);
  if (status === null) {
    return err(schemaError("owner needs status ok, unavailable or error"));
  }
  const record = raw as Record<string, unknown>;
  if (status !== "ok") {
    const reason = asReason(record, "owner");
    if (!reason.ok) {
      return reason;
    }
    return ok({ status, reason: reason.value });
  }
  const owner = parseOwnerEntry(record["owner"], "owner.owner");
  if (!owner.ok) {
    return owner;
  }
  const getOwner = parseOwnerEntry(record["getOwner"], "owner.getOwner");
  if (!getOwner.ok) {
    return getOwner;
  }
  return ok({ status: "ok", owner: owner.value, getOwner: getOwner.value });
}

// One numeric share field with a validated fallback: ok requires a share
// in [0, 1]; a non-ok status requires a reason and yields null.
function parseShareField(
  raw: unknown,
  what: string,
): Result<{ readonly value: number | null; readonly reason: string | null }, SnapshotParseError> {
  const status = statusOf(raw);
  if (status === null) {
    return err(schemaError(`${what} needs status ok, unavailable or error`));
  }
  const record = raw as Record<string, unknown>;
  if (status !== "ok") {
    const reason = asReason(record, what);
    if (!reason.ok) {
      return reason;
    }
    return ok({ value: null, reason: reason.value });
  }
  if (!isShare(record["value"])) {
    return err(schemaError(`${what} value is not a share in [0, 1]`));
  }
  return ok({ value: record["value"] as number, reason: null });
}

function parseRow(address: string, raw: unknown): Result<SnapshotRow, SnapshotParseError> {
  const id = address.toLowerCase();
  if (!isRecord(raw)) {
    return err(schemaError(`row ${id} is not an object`));
  }
  const declared = raw["address"];
  if (typeof declared === "string" && declared.toLowerCase() !== id) {
    return err(schemaError(`row key ${id} does not match its address field`));
  }

  const snapshotRaw = raw["snapshot"];
  const snapshotStatus = statusOf(snapshotRaw);
  if (snapshotStatus === null) {
    return err(schemaError(`row ${id}: snapshot needs status ok, unavailable or error`));
  }
  let snapshot: SnapshotRow["snapshot"];
  if (snapshotStatus !== "ok") {
    const reason = asReason(snapshotRaw as Record<string, unknown>, `row ${id} snapshot`);
    if (!reason.ok) {
      return reason;
    }
    snapshot = { status: snapshotStatus, reason: reason.value };
  } else {
    const record = snapshotRaw as Record<string, unknown>;
    const snapshotBlock = record["snapshotBlock"];
    const firstLiquidityBlock = record["firstLiquidityBlock"];
    if (!isSafeInteger(snapshotBlock) || (snapshotBlock as number) < 0) {
      return err(schemaError(`row ${id}: snapshotBlock is not a block number`));
    }
    if (!isSafeInteger(firstLiquidityBlock) || (firstLiquidityBlock as number) < 0) {
      return err(schemaError(`row ${id}: firstLiquidityBlock is not a block number`));
    }
    if (!isAddress(record["mainPair"])) {
      return err(schemaError(`row ${id}: mainPair is not a 0x address`));
    }
    // Main-pair quote travels as a symbol (WETH/USDC/USDT/DAI), never as
    // an address. It is diagnostic only and never a feature.
    if (typeof record["mainPairQuote"] !== "string" || (record["mainPairQuote"] as string).length === 0) {
      return err(schemaError(`row ${id}: mainPairQuote is not a non-empty string`));
    }
    if (record["mainPairDex"] !== "v2" && record["mainPairDex"] !== "v3") {
      return err(schemaError(`row ${id}: mainPairDex is not v2 or v3`));
    }
    if (typeof record["afterFixtureBlock"] !== "boolean") {
      return err(schemaError(`row ${id}: afterFixtureBlock is not a boolean`));
    }
    snapshot = {
      status: "ok",
      snapshotBlock: snapshotBlock as number,
      firstLiquidityBlock: firstLiquidityBlock as number,
      mainPair: (record["mainPair"] as string).toLowerCase(),
      mainPairDex: record["mainPairDex"] as "v2" | "v3",
      mainPairQuote: record["mainPairQuote"] as string,
      afterFixtureBlock: record["afterFixtureBlock"] as boolean,
    };
  }

  const deployRaw = raw["deployBlock"];
  let deployBlock: number | null = null;
  if (statusOf(deployRaw) === "ok") {
    const value = (deployRaw as Record<string, unknown>)["value"];
    if (!isSafeInteger(value) || (value as number) < 0) {
      return err(schemaError(`row ${id}: deployBlock value is not a block number`));
    }
    deployBlock = value as number;
  } else if (deployRaw !== undefined && deployRaw !== null && statusOf(deployRaw) === null) {
    return err(schemaError(`row ${id}: deployBlock needs status ok, unavailable or error`));
  }

  let deployer: string | null = null;
  let deployerMethod: string | null = null;
  const deployerRaw = raw["deployer"];
  if (deployerRaw !== undefined && deployerRaw !== null) {
    const deployerStatus = statusOf(deployerRaw);
    if (deployerStatus === null) {
      return err(schemaError(`row ${id}: deployer needs status ok, unavailable or error`));
    }
    const record = deployerRaw as Record<string, unknown>;
    if (deployerStatus === "ok") {
      if (!isAddress(record["value"])) {
        return err(schemaError(`row ${id}: deployer value is not a 0x address`));
      }
      deployer = (record["value"] as string).toLowerCase();
      deployerMethod = typeof record["method"] === "string" ? (record["method"] as string) : null;
    } else {
      const reason = asReason(record, `row ${id} deployer`);
      if (!reason.ok) {
        return reason;
      }
      deployerMethod = typeof record["method"] === "string" ? (record["method"] as string) : reason.value;
    }
  }

  const owner = parseOwner(raw["owner"]);
  if (!owner.ok) {
    return err(schemaError(`row ${id}: ${owner.error.message}`));
  }
  const deployerShare = parseShareField(raw["deployerShare"], `row ${id} deployerShare`);
  if (!deployerShare.ok) {
    return deployerShare;
  }
  const ownerShareRaw = raw["ownerShare"];
  const ownerShareStatus = statusOf(ownerShareRaw);
  if (ownerShareStatus === null) {
    return err(schemaError(`row ${id}: ownerShare needs status ok, unavailable or error`));
  }
  let ownerShare: number | null = null;
  let ownerIsDeployer: boolean | null = null;
  if (ownerShareStatus === "ok") {
    const record = ownerShareRaw as Record<string, unknown>;
    if (!isShare(record["value"])) {
      return err(schemaError(`row ${id}: ownerShare value is not a share in [0, 1]`));
    }
    ownerShare = record["value"] as number;
    ownerIsDeployer = typeof record["ownerIsDeployer"] === "boolean" ? (record["ownerIsDeployer"] as boolean) : null;
  } else {
    const reason = asReason(ownerShareRaw as Record<string, unknown>, `row ${id} ownerShare`);
    if (!reason.ok) {
      return reason;
    }
  }

  const holdersRaw = raw["holders"];
  const holdersStatus = statusOf(holdersRaw);
  if (holdersStatus === null) {
    return err(schemaError(`row ${id}: holders needs status ok, unavailable or error`));
  }
  let holders: SnapshotRow["holders"];
  if (holdersStatus !== "ok") {
    const reason = asReason(holdersRaw as Record<string, unknown>, `row ${id} holders`);
    if (!reason.ok) {
      return reason;
    }
    holders = {
      available: false,
      reason: reason.value,
      top1Share: 0,
      top10Share: 0,
      logBalanceSumOverSupply: null,
    };
  } else {
    const record = holdersRaw as Record<string, unknown>;
    if (!isShare(record["top1Share"]) || !isShare(record["top10Share"])) {
      return err(schemaError(`row ${id}: holders top1/top10 is not a share in [0, 1]`));
    }
    const balanceSum = record["logBalanceSumOverSupply"];
    if (typeof balanceSum !== "number" || !Number.isFinite(balanceSum)) {
      return err(schemaError(`row ${id}: holders logBalanceSumOverSupply is not a finite number`));
    }
    if ((record["top10Share"] as number) + 1e-12 < (record["top1Share"] as number)) {
      return err(schemaError(`row ${id}: holders top10 is below top1`));
    }
    holders = {
      available: true,
      reason: null,
      top1Share: record["top1Share"] as number,
      top10Share: record["top10Share"] as number,
      logBalanceSumOverSupply: balanceSum,
    };
  }

  const lpRaw = raw["lpDistribution"];
  const lpStatus = statusOf(lpRaw);
  if (lpStatus === null) {
    return err(schemaError(`row ${id}: lpDistribution needs status ok, unavailable or error`));
  }
  let lp: SnapshotRow["lp"];
  if (lpStatus !== "ok") {
    const reason = asReason(lpRaw as Record<string, unknown>, `row ${id} lpDistribution`);
    if (!reason.ok) {
      return reason;
    }
    const record = lpRaw as Record<string, unknown>;
    const pairIsMain = record["pairIsMain"];
    lp = {
      available: false,
      reason: reason.value,
      burnedShare: 0,
      lockerShare: 0,
      lockerBreakdown: Object.freeze({}),
      deployerOrOwnerShare: 0,
      otherShare: 0,
      drained: false,
      pairIsMain: typeof pairIsMain === "boolean" ? pairIsMain : null,
    };
  } else {
    const record = lpRaw as Record<string, unknown>;
    for (const field of ["burnedShare", "lockerShare", "deployerOrOwnerShare", "otherShare"] as const) {
      if (!isShare(record[field])) {
        return err(schemaError(`row ${id}: lpDistribution ${field} is not a share in [0, 1]`));
      }
    }
    const drained = record["lpSupplyIsMinimumLiquidityOnly"];
    if (typeof drained !== "boolean") {
      return err(schemaError(`row ${id}: lpDistribution lpSupplyIsMinimumLiquidityOnly is not a boolean`));
    }
    const breakdownRaw = record["lockerBreakdown"];
    const lockerBreakdown: Record<string, number> = {};
    if (breakdownRaw !== undefined && breakdownRaw !== null) {
      if (!isRecord(breakdownRaw)) {
        return err(schemaError(`row ${id}: lpDistribution lockerBreakdown is not an object`));
      }
      for (const [name, share] of Object.entries(breakdownRaw)) {
        if (!isShare(share)) {
          return err(schemaError(`row ${id}: lpDistribution lockerBreakdown entry is not a share in [0, 1]`));
        }
        lockerBreakdown[name] = share;
      }
    }
    const pairIsMain = record["pairIsMain"];
    lp = {
      available: true,
      reason: null,
      burnedShare: record["burnedShare"] as number,
      lockerShare: record["lockerShare"] as number,
      lockerBreakdown: Object.freeze(lockerBreakdown),
      deployerOrOwnerShare: record["deployerOrOwnerShare"] as number,
      otherShare: record["otherShare"] as number,
      drained,
      pairIsMain: typeof pairIsMain === "boolean" ? pairIsMain : null,
    };
  }

  const liquidityRaw = raw["liquidity"];
  const liquidityStatus = statusOf(liquidityRaw);
  if (liquidityStatus === null) {
    return err(schemaError(`row ${id}: liquidity needs status ok, unavailable or error`));
  }
  let liquidityWeth: number | null = null;
  let liquidityReason: string | null = null;
  if (liquidityStatus !== "ok") {
    const reason = asReason(liquidityRaw as Record<string, unknown>, `row ${id} liquidity`);
    if (!reason.ok) {
      return reason;
    }
    liquidityReason = reason.value;
  } else {
    const record = liquidityRaw as Record<string, unknown>;
    const weth = record["mainPairWeth"];
    if (typeof weth !== "number" || !Number.isFinite(weth) || weth < 0) {
      return err(schemaError(`row ${id}: liquidity mainPairWeth is not a non-negative number`));
    }
    liquidityWeth = weth;
  }

  return ok({
    id,
    snapshot,
    deployBlock,
    deployer,
    deployerMethod,
    owner: owner.value,
    deployerShare: deployerShare.value.value,
    ownerShare,
    ownerIsDeployer,
    holders,
    lp,
    liquidityWeth,
    liquidityReason,
  });
}

// Strict on every consumed field, lenient on unknown extras: extra keys at
// any level are ignored so a later schema addition keeps old readers
// working, while a missing or mistyped consumed field fails loudly per
// row. Rows that fail are collected with their reason and stay out of the
// join index; the counts report them so nothing is silently dropped.
export function parseSnapshotFile(raw: unknown): Result<SnapshotFile, SnapshotParseError> {
  if (!isRecord(raw)) {
    return err(schemaError("snapshot file is not a JSON object"));
  }
  const meta = raw["meta"];
  if (!isRecord(meta)) {
    return err(schemaError("snapshot meta is not an object"));
  }
  const offset = meta["snapshotOffsetBlocks"];
  if (!isSafeInteger(offset) || (offset as number) < 0) {
    return err(schemaError("snapshot meta snapshotOffsetBlocks is not a non-negative integer"));
  }
  const groups: Record<string, unknown>[] = [];
  for (const key of ["calibration", "real"] as const) {
    const group = raw[key];
    if (group !== undefined && group !== null) {
      if (!isRecord(group)) {
        return err(schemaError(`snapshot ${key} is not an object keyed by address`));
      }
      groups.push(group);
    }
  }
  if (groups.length === 0) {
    return err(schemaError("snapshot file holds neither a calibration nor a real group"));
  }
  const rows: SnapshotRow[] = [];
  const invalidRows: { readonly index: number; readonly reason: string }[] = [];
  let index = 0;
  for (const group of groups) {
    for (const address of Object.keys(group)) {
      if (!isAddress(address)) {
        invalidRows.push(Object.freeze({ index, reason: `row key ${address} is not a 0x address` }));
        index += 1;
        continue;
      }
      const parsed = parseRow(address, (group as Record<string, unknown>)[address]);
      if (!parsed.ok) {
        invalidRows.push(Object.freeze({ index, reason: parsed.error.message }));
      } else {
        rows.push(parsed.value);
      }
      index += 1;
    }
  }
  return ok({
    offsetBlocks: offset as number,
    rows: Object.freeze(rows),
    invalidRows: Object.freeze(invalidRows),
  });
}

export type OffsetViolation = {
  readonly rowIndex: number;
  readonly snapshotBlock: number;
  readonly firstLiquidityBlock: number;
  readonly expectedBlock: number;
};

// Every ok snapshot section must sit at firstLiquidityBlock plus the
// file's declared offset. Violations carry row positions and block
// numbers only, never token ids, so the calibration report stays free of
// addresses.
export function checkSnapshotOffsets(file: SnapshotFile): {
  readonly checked: number;
  readonly violations: readonly OffsetViolation[];
} {
  const violations: OffsetViolation[] = [];
  for (let index = 0; index < file.rows.length; index += 1) {
    const row = file.rows[index];
    if (row === undefined || row.snapshot.status !== "ok") {
      continue;
    }
    const expected = row.snapshot.firstLiquidityBlock + file.offsetBlocks;
    if (row.snapshot.snapshotBlock !== expected) {
      violations.push(Object.freeze({
        rowIndex: index,
        snapshotBlock: row.snapshot.snapshotBlock,
        firstLiquidityBlock: row.snapshot.firstLiquidityBlock,
        expectedBlock: expected,
      }));
    }
  }
  return { checked: file.rows.length, violations: Object.freeze(violations) };
}

// Join index by token id (lowercase address): first row wins, later
// duplicates count as duplicates and are ignored. Unknown extra rows stay
// in the file; calibration reports them as unmatched.
export function indexSnapshotById(file: SnapshotFile): {
  readonly byId: ReadonlyMap<string, SnapshotRow>;
  readonly duplicates: number;
} {
  const byId = new Map<string, SnapshotRow>();
  let duplicates = 0;
  for (const row of file.rows) {
    if (byId.has(row.id)) {
      duplicates += 1;
      continue;
    }
    byId.set(row.id, row);
  }
  return { byId, duplicates };
}

// Chosen owner class: the owner() entry when it classifies, else the
// getOwner() entry when it classifies, else null (no proven owner).
export function chosenOwnerClass(row: SnapshotRow): OwnerClass | null {
  if (row.owner.status !== "ok") {
    return null;
  }
  if (row.owner.owner.class !== "n/a") {
    return row.owner.owner.class;
  }
  if (row.owner.getOwner.class !== "n/a") {
    return row.owner.getOwner.class;
  }
  return null;
}

// Holder figures are available only when the log-balance check passes:
// a deviation beyond tolerance means rebasing/reflection/fee mechanics
// broke the ranking, so the figures read as unavailable.
export function holdersReliable(row: SnapshotRow): boolean {
  if (!row.holders.available || row.holders.logBalanceSumOverSupply === null) {
    return false;
  }
  return Math.abs(row.holders.logBalanceSumOverSupply - 1) <= LOG_BALANCE_TOLERANCE;
}

// Deploy-to-first-liquidity in blocks, capped so pre-Uniswap-V2 tokens do
// not proxy for era, or null when either endpoint is unknown or inverted.
export function deployToFirstLiq(row: SnapshotRow): number | null {
  if (row.deployBlock === null || row.snapshot.status !== "ok") {
    return null;
  }
  const delta = row.snapshot.firstLiquidityBlock - row.deployBlock;
  if (!Number.isSafeInteger(delta) || delta < 0) {
    return null;
  }
  return Math.min(delta, DEPLOY_TO_FIRST_CAP_BLOCKS);
}

// Versioned numeric mapping (onchain-v3). Every entry is 0 when its source
// is missing, drained or unreliable, and there are NO missing-indicator
// columns: a missing on-chain feature contributes exactly zero to a linear
// head by construction. Status, reason, pairIsMain, mainPairDex,
// afterFixtureBlock and pair counts never enter the vector. The locker
// share recomputes from the breakdown through the shared locker registry,
// so train and serve count the same locker set.
export const ONCHAIN_FEATURE_NAMES: readonly string[] = Object.freeze([
  "owner_renounced",
  "owner_eoa",
  "owner_contract",
  "owner_safe",
  "lp_burned_share",
  "lp_locker_share",
  "lp_deployer_or_owner_share",
  "liquidity_removed_24h",
  "conc_deployer_share",
  "conc_top1_share",
  "conc_top10_share",
  "liq_log10_1p_weth",
  "blocks_deploy_to_first_capped",
]);

// Features whose live computation matches the snapshot definition, and so
// the only ones a calibrated artifact may carry weights for. Holder top
// shares use different exclusion sets live (lockers excluded) than in the
// snapshot (lockers counted), holder balances are rebuilt from logs live
// but read directly in the snapshot, and liquidity needs a serving-side
// unit normalisation first; those stay diagnostic-only. Deploy-to-first
// is out of the model entirely: even capped it proxies launch era, so it
// is diagnostic-only too (its mapping and univariate stay for the report).
export const SERVABLE_FEATURE_NAMES: readonly string[] = Object.freeze([
  "owner_renounced",
  "owner_eoa",
  "owner_contract",
  "owner_safe",
  "lp_burned_share",
  "lp_locker_share",
  "lp_deployer_or_owner_share",
  "liquidity_removed_24h",
]);

export const ONCHAIN_FEATURE_COUNT = ONCHAIN_FEATURE_NAMES.length;

export function snapshotFeaturesOf(row: SnapshotRow | null): readonly number[] {
  if (row === null) {
    return Object.freeze(ONCHAIN_FEATURE_NAMES.map(() => 0));
  }
  const cls = chosenOwnerClass(row);
  const reliable = holdersReliable(row);
  const deployToFirst = deployToFirstLiq(row);
  const weth = row.liquidityWeth === null ? null : Math.log10(1 + row.liquidityWeth);
  return Object.freeze([
    cls === "zero/dead" ? 1 : 0,
    cls === "eoa" ? 1 : 0,
    cls === "contract" ? 1 : 0,
    cls === "multisig" ? 1 : 0,
    // Drained pairs read burnedShare as unavailable: 1.0 there means the
    // liquidity was already pulled, not locked.
    row.lp.available && !row.lp.drained ? row.lp.burnedShare : 0,
    // Locker share recomputed from the breakdown through the shared locker
    // registry (not the file's precomputed value), so train uses exactly
    // the locker set the live plugin reads by address.
    row.lp.available ? lockerShareOfBreakdown(row.lp.lockerBreakdown) : 0,
    row.lp.available ? row.lp.deployerOrOwnerShare : 0,
    // Affirmed point-in-time signal only: 1 exactly when the snapshot proves
    // the drain (minimum-liquidity-only supply at the snapshot block).
    row.lp.available && row.lp.drained ? 1 : 0,
    reliable && row.deployerShare !== null ? row.deployerShare : 0,
    reliable ? row.holders.top1Share : 0,
    reliable ? row.holders.top10Share : 0,
    weth === null || !Number.isFinite(weth) ? 0 : weth,
    deployToFirst === null ? 0 : deployToFirst,
  ]);
}

// Per-feature availability for coverage and univariate-AUC denominators:
// true exactly when the mapped value above is measured rather than the
// neutral 0. Univariate AUCs must condition on this subset per feature.
export function featureAvailable(row: SnapshotRow | null, feature: string): boolean {
  if (row === null) {
    return false;
  }
  switch (feature) {
    case "owner_renounced":
    case "owner_eoa":
    case "owner_contract":
    case "owner_safe":
      return chosenOwnerClass(row) !== null;
    case "lp_burned_share":
      return row.lp.available && !row.lp.drained;
    case "lp_locker_share":
    case "lp_deployer_or_owner_share":
      return row.lp.available;
    case "liquidity_removed_24h":
      return row.lp.available;
    case "conc_deployer_share":
    case "conc_top1_share":
    case "conc_top10_share":
      return holdersReliable(row);
    case "liq_log10_1p_weth":
      return row.liquidityWeth !== null;
    case "blocks_deploy_to_first_capped":
      return deployToFirstLiq(row) !== null;
    default:
      return false;
  }
}
