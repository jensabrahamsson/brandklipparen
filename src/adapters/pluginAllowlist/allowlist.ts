// Signed allowlist distribution for separately published plugins (S-049,
// K-514, H-46/M-52). Build-time gate only, never the analysis path: a
// plugin package (id, version, file list with text) is admitted only when
// the allowlist names its id and version with a matching canonical digest
// and a valid signature from the trusted build signer. Verification runs
// on package bytes before any import: this module loads no plugin code,
// reads no filesystem, uses no network, and never throws. The digest uses
// SHA-256 over the path-sorted file list; the signature is ed25519 over
// `pluginId + "\n" + version + "\n" + digest`.
import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";

export type PluginPackageFile = {
  readonly path: string;
  readonly text: string;
};

export type PluginPackage = {
  readonly pluginId: string;
  readonly version: string;
  readonly files: readonly PluginPackageFile[];
};

export type AllowlistEntry = {
  readonly pluginId: string;
  readonly version: string;
  readonly digest: string;
  readonly signature: string;
};

// One trusted build signer for v1 (H-46): the allowlist carries the signer
// label and the verifier material, so rotation means one reviewed change
// to this value, never a per-package exception. The module lives beside
// the other process-bound adapters (never in `src/plugins`), so detector
// purity lint and the static-registration gate stay untouched.
export type Allowlist = {
  readonly signer: string;
  readonly verifier: JsonWebKey;
  readonly entries: readonly AllowlistEntry[];
};

export type AllowlistError =
  | { kind: "unsigned-plugin"; pluginId: string; message: string }
  | { kind: "tampered-plugin"; pluginId: string; message: string }
  | { kind: "invalid-allowlist"; message: string }
  | { kind: "invalid-package"; message: string };

// Canonical digest over the package bytes: files sort by path, each
// contributing `path + "\0" + text + "\0"`. The same bytes always give the
// same digest on every platform.
export function canonicalPackageDigest(pkg: PluginPackage): string {
  const sorted = pkg.files.slice().sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of sorted) {
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(file.text, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function isHexString(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/.test(value);
}

function digestsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

// Build-time admission check (S-049): unsigned (absent id or version) and
// tampered (digest mismatch or bad signature) packages are turned away
// with a typed error before any import. Never throws.
export function verifyPluginPackage(
  pkg: PluginPackage,
  allowlist: Allowlist,
): Result<{ readonly pluginId: string; readonly version: string }, AllowlistError> {
  if (pkg.pluginId.length === 0 || pkg.version.length === 0 || pkg.files.length === 0) {
    return err({ kind: "invalid-package", message: "a plugin package carries an id, a version and at least one file" });
  }
  if (allowlist.signer.length === 0 || allowlist.entries.length === 0) {
    return err({ kind: "invalid-allowlist", message: "the plugin allowlist carries a signer and at least one entry" });
  }
  const entry = allowlist.entries.find(
    (candidate) => candidate.pluginId === pkg.pluginId && candidate.version === pkg.version,
  );
  if (entry === undefined) {
    return err({
      kind: "unsigned-plugin",
      pluginId: pkg.pluginId,
      message: `plugin package ${pkg.pluginId}@${pkg.version} is absent from the signed allowlist`,
    });
  }
  if (!isHexString(entry.digest)) {
    return err({ kind: "invalid-allowlist", message: "the plugin allowlist carries a malformed digest" });
  }
  const computed = canonicalPackageDigest(pkg);
  if (!digestsEqual(computed, entry.digest)) {
    return err({
      kind: "tampered-plugin",
      pluginId: pkg.pluginId,
      message: `plugin package ${pkg.pluginId}@${pkg.version} differs from its allowlisted bytes`,
    });
  }
  if (!isHexString(entry.signature)) {
    return err({ kind: "invalid-allowlist", message: "the plugin allowlist carries a malformed signature" });
  }
  let admitted = false;
  try {
    const verifier = createPublicKey({ key: allowlist.verifier, format: "jwk" });
    const payload = Buffer.from(`${pkg.pluginId}\n${pkg.version}\n${computed}`, "utf8");
    admitted = verify(null, payload, verifier, Buffer.from(entry.signature, "hex"));
  } catch {
    admitted = false;
  }
  if (!admitted) {
    return err({
      kind: "tampered-plugin",
      pluginId: pkg.pluginId,
      message: `plugin package ${pkg.pluginId}@${pkg.version} carries no valid build signature`,
    });
  }
  return ok(Object.freeze({ pluginId: pkg.pluginId, version: pkg.version }));
}
