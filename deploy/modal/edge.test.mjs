// Behavior tests for deploy/modal/edge.mjs (node:test, no packages).
// They spawn the real edge in front of a stub upstream and assert only
// rendered text, status codes, headers and what the upstream received.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const EDGE = fileURLToPath(new URL("./edge.mjs", import.meta.url));
const ACCESS_CODE = "test access code";
const WEB_KEY = `test-web-key-${"w".repeat(24)}`;
const OWN_KEY = `test-own-key-${"o".repeat(24)}`;

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

function waitForListening(child) {
  return new Promise((resolveWait, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes('"listening"')) resolveWait();
    });
    child.once("exit", (code) => reject(new Error(`edge exited early (${code}): ${out}`)));
    setTimeout(() => reject(new Error(`edge did not start: ${out}`)), 10000);
  });
}

let upstream;
let edge;
let base;
let upstreamKey = null;

before(async () => {
  upstream = createServer((req, res) => {
    upstreamKey = req.headers["x-api-key"] ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  const upstreamPort = await freePort();
  await new Promise((done) => upstream.listen(upstreamPort, "127.0.0.1", done));

  const root = mkdtempSync(join(tmpdir(), "bk-edge-"));
  const staticDir = join(root, "dist");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), '<!doctype html><div id="root">demo ui</div>');

  const edgePort = await freePort();
  base = `http://127.0.0.1:${edgePort}`;
  edge = spawn(process.execPath, [EDGE], {
    env: {
      PATH: process.env.PATH ?? "",
      BK_ACCESS_CODE: ACCESS_CODE,
      BK_EDGE_WEB_API_KEY: WEB_KEY,
      BK_JUDGE_API_KEYS: OWN_KEY,
      BK_EDGE_COOKIE_SECRET: `test-cookie-secret-${"c".repeat(16)}`,
      BK_EDGE_PORT: String(edgePort),
      BK_EDGE_HOST: "127.0.0.1",
      BK_EDGE_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      BK_EDGE_STATIC_DIR: staticDir,
      BK_EDGE_STATE_FILE: join(root, "edge-state.json"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await waitForListening(edge);
});

after(() => {
  edge?.kill("SIGTERM");
  upstream?.close();
});

function get(path, { ip, cookie, key } = {}) {
  const headers = {};
  if (ip) headers["x-forwarded-for"] = ip;
  if (cookie) headers.cookie = cookie;
  if (key) headers["x-api-key"] = key;
  return fetch(`${base}${path}`, { headers, redirect: "manual" });
}

function postCode(code, ip) {
  return fetch(`${base}/access`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body: new URLSearchParams({ code }),
  });
}

async function cookieFor(ip) {
  const res = await postCode(ACCESS_CODE, ip);
  assert.equal(res.status, 303);
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { setCookie, cookie: setCookie.split(";")[0] };
}

test("access page is shown for the UI and keyless /v1 without a cookie", async () => {
  const ui = await get("/", { ip: "203.0.113.10" });
  assert.equal(ui.status, 401);
  const uiBody = await ui.text();
  assert.match(uiBody, /<h1>Brandklipparen<\/h1>/);
  assert.match(uiBody, /<label for="code">Access code<\/label>/);
  assert.match(uiBody, /action="\/access"/);

  const api = await get("/v1/plugins", { ip: "203.0.113.10" });
  assert.equal(api.status, 401);
  assert.match(await api.text(), /Access code/);
});

test("right code sets a signed cookie, then UI and keyless /v1 pass", async () => {
  const { setCookie, cookie } = await cookieFor("203.0.113.20");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=604800/);

  const ui = await get("/", { ip: "203.0.113.20", cookie });
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /demo ui/);

  const api = await get("/v1/plugins", { ip: "203.0.113.20", cookie });
  assert.equal(api.status, 200);
  assert.match(await api.text(), /"ok":true/);
  assert.equal(upstreamKey, WEB_KEY);
});

test("/health stays open without a cookie", async () => {
  const res = await get("/health", { ip: "203.0.113.30" });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /"ok":true/);
});

test("a visitor with their own x-api-key bypasses the access page", async () => {
  const api = await get("/v1/plugins", { ip: "203.0.113.40", key: OWN_KEY });
  assert.equal(api.status, 200);
  assert.equal(upstreamKey, OWN_KEY);

  const ui = await get("/", { ip: "203.0.113.40", key: OWN_KEY });
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /demo ui/);
});

test("a forged cookie is rejected", async () => {
  const { cookie } = await cookieFor("203.0.113.50");
  const forged = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
  const ui = await get("/", { ip: "203.0.113.50", cookie: forged });
  assert.equal(ui.status, 401);
  assert.match(await ui.text(), /Access code/);
});

test("wrong codes are rejected and then rate-limited", async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = await postCode("wrong code", "203.0.113.60");
    assert.equal(res.status, 401);
    assert.match(await res.text(), /Access code not accepted\./);
  }
  const limited = await postCode("wrong code", "203.0.113.60");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.match(await limited.text(), /Too many attempts\./);
});

test("edge refuses to start without BK_ACCESS_CODE", async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), "bk-edge-nocode-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.html"), "x");
  const child = spawn(process.execPath, [EDGE], {
    env: {
      PATH: process.env.PATH ?? "",
      BK_EDGE_PORT: String(port),
      BK_EDGE_HOST: "127.0.0.1",
      BK_EDGE_STATIC_DIR: join(root, "dist"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
  assert.notEqual(code, 0);
});
