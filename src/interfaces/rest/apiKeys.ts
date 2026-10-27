// Salted API key store for the REST driving adapter (S-027, K-024, K-510).
// Keys arrive as SecretString values from the validated config per I-08;
// the store keeps solely salted SHA-256 hashes and compares candidates in
// constant time (M-10). Raw key values and the pepper never leave this
// module: hashing happens here at construction and per verification, and
// serialisation of the store carries solely hashes and key IDs.
import { createHash, timingSafeEqual } from "node:crypto";
import type { SecretString } from "../../ports/config.ts";

export type ApiKeyStoreOptions = {
  readonly keys: readonly SecretString[];
  readonly pepper: SecretString | undefined;
};

// Domain separation prefix, so the stored hashes cannot double as hashes
// computed for another purpose.
const HASH_DOMAIN = "brandklipparen-rest-api-key-v1";

function saltedHash(candidate: string, pepper: string): Buffer {
  return createHash("sha256")
    .update(HASH_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(pepper, "utf8")
    .update("\0", "utf8")
    .update(candidate, "utf8")
    .digest();
}

function keyIdFor(hash: Buffer): string {
  return hash.toString("hex").slice(0, 16);
}

export type ApiKeyStore = {
  // Constant-time membership check over every stored hash: the loop never
  // exits early, so timing stays independent of which key matches.
  readonly verify: (candidate: string) => boolean;
  // Stable non-secret identifier for the matching key, or null. The ID is
  // a truncated salted hash: it names the key in logs without exposing it.
  readonly keyId: (candidate: string) => string | null;
  readonly size: number;
};

export function createApiKeyStore(options: ApiKeyStoreOptions): ApiKeyStore {
  const pepper = options.pepper?.reveal() ?? "";
  const entries = options.keys.map((key) => {
    const hash = saltedHash(key.reveal(), pepper);
    return { hash, id: keyIdFor(hash) };
  });
  // A fixed dummy keeps the comparison count at one even when no key is
  // configured, so the empty store fails closed in constant time as well.
  const dummy = Buffer.alloc(32, 0);
  const store: ApiKeyStore = {
    verify: (candidate: string): boolean => {
      const hashed = saltedHash(candidate, pepper);
      const compared = entries.length === 0 ? [dummy] : entries.map((entry) => entry.hash);
      let matches = 0;
      for (const stored of compared) {
        if (timingSafeEqual(hashed, stored)) {
          matches += 1;
        }
      }
      return entries.length > 0 && matches > 0;
    },
    keyId: (candidate: string): string | null => {
      const hashed = saltedHash(candidate, pepper);
      let found: string | null = null;
      for (const entry of entries) {
        if (timingSafeEqual(hashed, entry.hash)) {
          found = entry.id;
        }
      }
      return found;
    },
    size: entries.length,
  };
  return Object.freeze(store);
}
