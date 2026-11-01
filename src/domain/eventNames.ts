// Event topic0 naming (VS-B1, S-080 style). Pure deterministic mapping
// from a log topic0 to its canonical event signature's name: the decompiler
// prints `emit Transfer();` instead of a 64-hex literal when the topic
// matches a public event signature below. Rules mirror the selector table:
// every row pairs the canonical signature text with the name printed for
// its topic0, and the unit test recomputes each topic0 from its signature
// through the shared keccak helper, so a wrong row fails instead of
// reaching the output. Unknown topics stay raw hex and never invent a name.
import { keccak256HexOfUtf8 } from "./types.ts";

// Published event table: canonical signature with the printed name. The
// ERC-20 rows cover the standard token events; the ownership, pausable,
// blacklist, issue/redeem, params, mint/burn and upgrade rows cover the
// common admin events the detectors gate on.
const EVENT_TABLE: Readonly<Record<string, string>> = Object.freeze({
  "Transfer(address,address,uint256)": "Transfer",
  "Approval(address,address,uint256)": "Approval",
  "OwnershipTransferred(address,address)": "OwnershipTransferred",
  "Paused(address)": "Paused",
  "Unpaused(address)": "Unpaused",
  "Pause()": "Pause",
  "Unpause()": "Unpause",
  "AddedBlackList(address)": "AddedBlackList",
  "RemovedBlackList(address)": "RemovedBlackList",
  "Issue(uint256)": "Issue",
  "Redeem(uint256)": "Redeem",
  "Params(uint256,uint256)": "Params",
  "Mint(address,uint256)": "Mint",
  "Burn(address,uint256)": "Burn",
  "Upgraded(address)": "Upgraded",
});

export const EVENT_TABLE_VERSION = "1.0.0";

// keccak256 of an event signature, 0x-prefixed lowercase: the topic0.
export function topic0Of(signature: string): string {
  return keccak256HexOfUtf8(signature).toLowerCase();
}

// Every versioned table row for the keccak pin test: signature text with
// its printed name.
export function eventRows(): ReadonlyArray<{ readonly signature: string; readonly name: string }> {
  return Object.freeze(
    Object.entries(EVENT_TABLE).map(([signature, name]) =>
      Object.freeze({ signature, name }),
    ),
  );
}

// Printed name for a 0x-prefixed 64-hex topic0, or null when unknown.
// Unknown topics stay raw hex at the call site; the lookup never invents
// a name.
export function eventNameForTopic0(topic0: string): string | null {
  const want = topic0.toLowerCase();
  for (const [signature, name] of Object.entries(EVENT_TABLE)) {
    if (topic0Of(signature) === want) {
      return name;
    }
  }
  return null;
}
