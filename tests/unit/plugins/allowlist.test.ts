// S-049 signed allowlist distribution (K-514, H-46/M-52). A separately
// published plugin package is admitted at build time only: the package
// must be named in the allowlist with a matching digest and a valid
// signature, verified from package bytes before any import. An unsigned
// package and a byte-changed package are turned away. Written first (red)
// per A-21: the allowlist module does not exist yet. No network; the
// signing pair is generated ephemerally in-process for the test.
import { describe, expect, test } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  canonicalPackageDigest,
  verifyPluginPackage,
} from "../../../src/adapters/pluginAllowlist/allowlist.ts";
import type { Allowlist, PluginPackage } from "../../../src/adapters/pluginAllowlist/allowlist.ts";

function testPackage(): PluginPackage {
  return Object.freeze({
    pluginId: "dev.example.signed-detector",
    version: "1.0.0",
    files: Object.freeze([
      Object.freeze({ path: "manifest.ts", text: "export const version = '1.0.0';\n" }),
      Object.freeze({ path: "detect.ts", text: "export function detect(): string[] {\n  return [];\n}\n" }),
    ]),
  });
}

function signingSetup(): { allowlist: Allowlist; package: PluginPackage } {
  const signingPair = generateKeyPairSync("ed25519");
  const verifier = signingPair.publicKey.export({ format: "jwk" });
  const pkg = testPackage();
  const digest = canonicalPackageDigest(pkg);
  const payload = Buffer.from(`${pkg.pluginId}\n${pkg.version}\n${digest}`, "utf8");
  const signature = sign(null, payload, signingPair.privateKey).toString("hex");
  const allowlist: Allowlist = Object.freeze({
    signer: "brandklipparen-build-signer",
    verifier,
    entries: Object.freeze([
      Object.freeze({
        pluginId: pkg.pluginId,
        version: pkg.version,
        digest,
        signature,
      }),
    ]),
  });
  return { allowlist, package: pkg };
}

describe("k514_unsigned_or_tampered_plugin_rejected_at_build", () => {
  test("a listed package with a valid signature verifies before any import", () => {
    const { allowlist, package: pkg } = signingSetup();
    const verified = verifyPluginPackage(pkg, allowlist);
    expect(verified.ok).toBe(true);
  });

  test("an unsigned package (absent from the allowlist) is turned away", () => {
    const { allowlist } = signingSetup();
    const foreign: PluginPackage = Object.freeze({
      pluginId: "dev.example.foreign-detector",
      version: "1.0.0",
      files: Object.freeze([Object.freeze({ path: "detect.ts", text: "export function detect(): string[] {\n  return [];\n}\n" })]),
    });
    const verified = verifyPluginPackage(foreign, allowlist);
    if (verified.ok) {
      throw new Error("expected an unsigned package to be rejected");
    }
    expect(verified.error.kind).toBe("unsigned-plugin");
  });

  test("a byte-changed package (one file edited) is turned away", () => {
    const { allowlist, package: pkg } = signingSetup();
    const tampered: PluginPackage = Object.freeze({
      ...pkg,
      files: Object.freeze([
        Object.freeze({ path: "manifest.ts", text: "export const version = '1.0.0';\n" }),
        Object.freeze({ path: "detect.ts", text: "export function detect(): string[] {\n  return ['extra'];\n}\n" }),
      ]),
    });
    const verified = verifyPluginPackage(tampered, allowlist);
    if (verified.ok) {
      throw new Error("expected a byte-changed package to be rejected");
    }
    expect(verified.error.kind).toBe("tampered-plugin");
  });

  test("a package signed by a foreign signer is turned away", () => {
    const { allowlist, package: pkg } = signingSetup();
    const foreignPair = generateKeyPairSync("ed25519");
    const digest = canonicalPackageDigest(pkg);
    const payload = Buffer.from(`${pkg.pluginId}\n${pkg.version}\n${digest}`, "utf8");
    const foreignSignature = sign(null, payload, foreignPair.privateKey).toString("hex");
    const forged: Allowlist = Object.freeze({
      ...allowlist,
      entries: Object.freeze([
        Object.freeze({ pluginId: pkg.pluginId, version: pkg.version, digest, signature: foreignSignature }),
      ]),
    });
    const verified = verifyPluginPackage(pkg, forged);
    if (verified.ok) {
      throw new Error("expected a foreign-signed package to be rejected");
    }
    expect(verified.error.kind).toBe("tampered-plugin");
  });
});
