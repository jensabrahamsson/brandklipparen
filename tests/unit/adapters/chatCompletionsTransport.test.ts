import { describe, expect, test, vi } from "vitest";
import { createFetchChatCompletionsTransport } from "../../../src/adapters/assessment/chatCompletions/chatCompletionsAdapter.ts";

describe("fetch chat-completions transport limits", () => {
  test("uses the configured response cap, not the request cap", async () => {
    const big = "x".repeat(50000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(big, { status: 200 })),
    );
    try {
      const transport = createFetchChatCompletionsTransport({ timeoutMs: 60000, maxBytes: 1048576 });
      const result = await transport("https://api.example.invalid/v1/chat/completions", {
        body: "{}",
        headers: {},
        signal: new AbortController().signal,
      });
      expect(result.status).toBe(200);
      expect(result.bodyText.length).toBe(50000);
      const small = createFetchChatCompletionsTransport({ timeoutMs: 60000, maxBytes: 100 });
      await expect(
        small("https://api.example.invalid/v1/chat/completions", {
          body: "{}",
          headers: {},
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ kind: "too-large" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
