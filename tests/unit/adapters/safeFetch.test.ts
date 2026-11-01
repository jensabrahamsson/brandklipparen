// Bounded HTTP fetch shared by the driven adapters (C-24, F-28).
// Loopback servers only: no test traffic leaves the process.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import { SafeFetchError, safeFetchText } from "../../../src/adapters/http/safeFetch.ts";

type Handler = Parameters<typeof createServer>[1];

async function listen(handler: Handler): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

describe("safeFetchText", () => {
  test("c24_redirect_refused_and_target_never_hit", async () => {
    let targetHits = 0;
    const running = await listen((req, res) => {
      if (req.url === "/target") {
        targetHits += 1;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("target");
        return;
      }
      res.writeHead(302, { location: "/target" });
      res.end();
    });
    try {
      const error = await safeFetchText(`http://127.0.0.1:${running.port}/start`, {
        timeoutMs: 2000,
        maxBytes: 65536,
        allowedProtocols: ["http:"],
      }).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(SafeFetchError);
      expect((error as SafeFetchError).kind).toBe("network");
      expect(targetHits).toBe(0);
    } finally {
      await running.close();
    }
  });

  test("c24_content_length_over_cap_rejected", async () => {
    const running = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "1048576" });
      res.end("tiny");
    });
    try {
      const error = await safeFetchText(`http://127.0.0.1:${running.port}/big`, {
        timeoutMs: 2000,
        maxBytes: 1024,
        allowedProtocols: ["http:"],
      }).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(SafeFetchError);
      expect((error as SafeFetchError).kind).toBe("too-large");
    } finally {
      await running.close();
    }
  });

  test("c24_chunked_body_over_cap_aborts", async () => {
    let closed = false;
    const running = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const timer = setInterval(() => {
        res.write(Buffer.alloc(65536, 0x61));
      }, 5);
      res.on("close", () => {
        closed = true;
        clearInterval(timer);
      });
    });
    try {
      const started = Date.now();
      const error = await safeFetchText(`http://127.0.0.1:${running.port}/stream`, {
        timeoutMs: 5000,
        maxBytes: 100 * 1024,
        allowedProtocols: ["http:"],
      }).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(Date.now() - started).toBeLessThan(1000);
      expect(error).toBeInstanceOf(SafeFetchError);
      expect((error as SafeFetchError).kind).toBe("too-large");
      const deadline = Date.now() + 1000;
      while (!closed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(closed).toBe(true);
    } finally {
      await running.close();
    }
  });

  test("c24_stalled_body_times_out", async () => {
    const running = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      // Headers flush, then the body never arrives.
    });
    try {
      const error = await safeFetchText(`http://127.0.0.1:${running.port}/stall`, {
        timeoutMs: 200,
        maxBytes: 65536,
        allowedProtocols: ["http:"],
      }).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(SafeFetchError);
      expect((error as SafeFetchError).kind).toBe("timeout");
    } finally {
      await running.close();
    }
  });

  test("c24_https_only_by_default", async () => {
    const error = await safeFetchText("http://127.0.0.1:1/unused", {
      timeoutMs: 1000,
      maxBytes: 1024,
    }).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(SafeFetchError);
    expect((error as SafeFetchError).kind).toBe("protocol");
  });

  test("c24_post_body_sent_once", async () => {
    let hits = 0;
    let seenBody = "";
    const running = await listen((req, res) => {
      hits += 1;
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      req.on("end", () => {
        seenBody = raw;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    try {
      const sent = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: [] });
      const out = await safeFetchText(`http://127.0.0.1:${running.port}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: sent,
        timeoutMs: 2000,
        maxBytes: 65536,
        allowedProtocols: ["http:"],
      });
      expect(out.status).toBe(200);
      expect(JSON.parse(out.bodyText) as unknown).toEqual({ ok: true });
      expect(hits).toBe(1);
      expect(seenBody).toBe(sent);
    } finally {
      await running.close();
    }
  });
});
