// Transfer decoding and holder concentration (session A).
// Pure domain module: ERC-20 Transfer logs rebuild holder balances from
// the deployment block up to the analysis block. The pool, burn addresses
// and known lockers are excluded from the holder ranking; the deployer and
// owner shares are reported separately. Beyond the documented log cap the
// result is can't-tell, never a truncated ranking.
import { TRANSFER_TOPIC } from "./topics.ts";
import { addressOfTopicWord, isZeroOrDead } from "./topics.ts";
import { lockerAddresses } from "./lockers.ts";
import type { DecodableLog } from "./pools.ts";

// Documented cap on Transfer logs per concentration read: beyond it the
// ranking would silently drop holders, so the driver reports can't-tell.
export const TRANSFER_LOG_CAP = 10000;

export type TransferEvent = {
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
  readonly blockNumber: number;
  readonly logIndex: number;
};

// ERC-20 Transfer(address,address,uint256): indexed from and to in topics
// 1-2, the amount in the single data word.
export function decodeTransfer(log: DecodableLog): TransferEvent | null {
  if ((log.topics[0] ?? "").toLowerCase() !== TRANSFER_TOPIC || log.topics.length !== 3) {
    return null;
  }
  const from = addressOfTopicWord(log.topics[1] ?? "");
  const to = addressOfTopicWord(log.topics[2] ?? "");
  if (from === null || to === null) {
    return null;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(log.data)) {
    return null;
  }
  let value: bigint;
  try {
    value = BigInt(log.data);
  } catch {
    return null;
  }
  if (value < 0n) {
    return null;
  }
  return Object.freeze({ from, to, value, blockNumber: log.blockNumber, logIndex: log.logIndex });
}

export type ConcentrationInput = {
  readonly transfers: readonly TransferEvent[];
  readonly excluded: readonly string[];
  readonly totalSupply: bigint | null;
  readonly deployer: string | null;
  readonly owner: string | null;
};

export type ConcentrationResult =
  | {
      readonly kind: "ok";
      readonly top1Share: number;
      readonly top10Share: number;
      readonly deployerShare: number | null;
      readonly ownerShare: number | null;
      readonly holders: number;
    }
  | { readonly kind: "cant-tell"; readonly reason: string };

// Deterministic concentration over decoded transfers in log order: mints
// (from zero) raise balances, burns (to zero or dead) lower the holder's
// balance, and every other transfer moves value between holders. Shares
// divide by the on-chain totalSupply at the analysis block; a missing or
// zero supply stays can't-tell rather than dividing by a local sum.
export function concentrationOf(input: ConcentrationInput): ConcentrationResult {
  if (input.totalSupply === null || input.totalSupply <= 0n) {
    return { kind: "cant-tell", reason: "total supply is missing or zero" };
  }
  const excluded = new Set<string>([
    ...input.excluded.map((entry) => entry.toLowerCase()),
    ...lockerAddresses(),
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
  ]);
  const balances = new Map<string, bigint>();
  const ordered = [...input.transfers].sort((left, right) =>
    left.blockNumber !== right.blockNumber
      ? left.blockNumber - right.blockNumber
      : left.logIndex - right.logIndex,
  );
  for (const event of ordered) {
    if (!isZeroOrDead(event.from)) {
      balances.set(event.from, (balances.get(event.from) ?? 0n) - event.value);
    }
    if (!isZeroOrDead(event.to)) {
      balances.set(event.to, (balances.get(event.to) ?? 0n) + event.value);
    }
  }
  const supply = Number(input.totalSupply);
  const shareOf = (address: string | null): number | null => {
    if (address === null || isZeroOrDead(address)) {
      return null;
    }
    const balance = balances.get(address.toLowerCase()) ?? 0n;
    if (balance <= 0n) {
      return 0;
    }
    return Number(balance) / supply;
  };
  const ranked = [...balances.entries()]
    .filter(([address, balance]) => balance > 0n && !excluded.has(address))
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return left[1] > right[1] ? -1 : 1;
      }
      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
    });
  const top = ranked.slice(0, 10);
  const top1 = top.length > 0 ? Number(top[0]?.[1] ?? 0n) / supply : 0;
  const top10 = top.reduce((total, [, balance]) => total + Number(balance), 0) / supply;
  return Object.freeze({
    kind: "ok",
    top1Share: top1,
    top10Share: top10,
    deployerShare: shareOf(input.deployer),
    ownerShare: shareOf(input.owner),
    holders: ranked.length,
  });
}
