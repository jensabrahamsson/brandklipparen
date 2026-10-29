// ERC-20 token metadata reader (E-11 follow-up): name() and symbol()
// over the shared RpcPort, so the live list shows a human label beside
// the short address. Both calls are read-only eth_call at latest; any
// failure answers null and the list renders the address instead —
// metadata never blocks the list or the analysis. Decoding accepts the
// ABI string form (offset, length, bytes) and the compact bytes32 form;
// anything else reads as absent.
import { randomUUID } from "node:crypto";
import { Address, CallData, RequestId, Timestamp } from "../../domain/types.ts";
import type { RpcPort } from "../../ports/rpc.ts";
import type { LiveTokensMetadata } from "../../ports/liveTokens.ts";

const NAME_SELECTOR = "0x06fdde03";
const SYMBOL_SELECTOR = "0x95d89b41";
const MAX_TEXT_LENGTH = 64;

function wordsOf(bytes: Uint8Array): bigint[] {
  const words: bigint[] = [];
  for (let offset = 0; offset + 32 <= bytes.length; offset += 32) {
    let value = 0n;
    for (let index = offset; index < offset + 32; index += 1) {
      value = (value << 8n) + BigInt(bytes[index] ?? 0);
    }
    words.push(value);
  }
  return words;
}

function cleanText(raw: string): string | null {
  const text = raw.replace(/\0+$/, "").trim();
  if (text.length === 0 || text.length > MAX_TEXT_LENGTH) {
    return null;
  }
  return text;
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.length === 32) {
    try {
      return cleanText(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }
  if (bytes.length < 96) {
    return null;
  }
  const words = wordsOf(bytes);
  if (words[0] !== 32n) {
    return null;
  }
  const length = words[1] ?? 0n;
  if (length <= 0n || length > BigInt(MAX_TEXT_LENGTH) || 64 + Number(length) > bytes.length) {
    return null;
  }
  try {
    return cleanText(new TextDecoder().decode(bytes.slice(64, 64 + Number(length))));
  } catch {
    return null;
  }
}

export function createTokenMetadataReader(
  rpc: RpcPort,
): (tokenAddress: string) => Promise<LiveTokensMetadata | null> {
  return async (tokenAddress: string): Promise<LiveTokensMetadata | null> => {
    const address = Address.parse(tokenAddress);
    if (!address.ok) {
      return null;
    }
    const parsedRequestId = RequestId.parse(randomUUID());
    if (!parsedRequestId.ok) {
      return null;
    }
    const requestId = parsedRequestId.value;
    const deadline = Timestamp.of(Date.now() + 15_000);
    if (!deadline.ok) {
      return null;
    }
    const read = async (selector: string): Promise<string | null> => {
      const data = CallData.parse(selector);
      if (!data.ok) {
        return null;
      }
      const called = await rpc.call(address.value, data.value, {
        requestId,
        deadline: deadline.value,
        block: "latest",
      });
      if (!called.ok) {
        return null;
      }
      return decodeText(called.value);
    };
    const [symbol, name] = await Promise.all([read(SYMBOL_SELECTOR), read(NAME_SELECTOR)]);
    if (symbol === null && name === null) {
      return null;
    }
    return { symbol, name };
  };
}
