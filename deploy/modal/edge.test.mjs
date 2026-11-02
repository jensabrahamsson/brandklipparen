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
let edgeLogs = "";

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
  edge.stdout.on("data", (chunk) => {
    edgeLogs += chunk.toString();
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
  assert.match(uiBody, /<title>Brandklipparen<\/title>/);
  assert.match(uiBody, /<h1>Brandklipparen<\/h1>/);
  assert.match(uiBody, /contract risk scanner · judge preview/);
  assert.match(uiBody, /Enter the access code from the submission notes\./);
  assert.match(uiBody, /<label for="code">Access code<\/label>/);
  assert.match(uiBody, /action="\/access"/);
  assert.match(uiBody, /autofocus/);
  assert.match(uiBody, /autocomplete="off"/);
  assert.match(uiBody, />Enter<\/button>/);

  const api = await get("/v1/plugins", { ip: "203.0.113.10" });
  assert.equal(api.status, 401);
  assert.match(await api.text(), /Access code/);
});

test("right code sets a signed cookie, then UI and keyless /v1 pass", async () => {
  const { setCookie, cookie } = await cookieFor("203.0.113.20");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=2592000/);

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

test("one-click link sets the cookie and redirects without the code", async () => {
  const ip = "203.0.113.70";
  const res = await get(`/?access=${encodeURIComponent(ACCESS_CODE)}`, { ip });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /Max-Age=2592000/);
  const cookie = setCookie.split(";")[0];
  const ui = await get("/", { ip, cookie });
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /demo ui/);
});

test("one-click link keeps the path and drops only the access parameter", async () => {
  const ip = "203.0.113.71";
  const res = await get(`/index.html?next=%2F&access=${encodeURIComponent(ACCESS_CODE)}`, { ip });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/index.html?next=%2F");
});

test("one-click link with a wrong code shows the access page error", async () => {
  const res = await get("/?access=wrong-code", { ip: "203.0.113.72" });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /Access code not accepted\./);
});

test("one-click links never log the query string", async () => {
  const marker = `zqx-one-click-${Date.now().toString(36)}`;
  await get(`/?access=${encodeURIComponent(marker)}`, { ip: "203.0.113.76" });
  await new Promise((done) => setTimeout(done, 200));
  assert.ok(!edgeLogs.includes(marker), "edge logs must not contain the access query value");
});

test("one-click failures share the form rate limit", async () => {
  const ip = "203.0.113.73";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = await get("/?access=wrong-code", { ip });
    assert.equal(res.status, 401);
  }
  const viaForm = await postCode("wrong code", ip);
  assert.equal(viaForm.status, 429);
  assert.match(await viaForm.text(), /Too many attempts\./);
});

test("codes are trimmed and case-insensitive on the form and the link", async () => {
  const mixed = `  ${ACCESS_CODE.toUpperCase()}  `;
  const formRes = await postCode(mixed, "203.0.113.74");
  assert.equal(formRes.status, 303);
  const linkRes = await get(`/?access=${encodeURIComponent(mixed)}`, { ip: "203.0.113.75" });
  assert.equal(linkRes.status, 303);
  assert.equal(linkRes.headers.get("location"), "/");
});

test("BK_JUDGE_API_KEY (singular) is accepted like a personal key", async () => {
  const singlePort = await freePort();
  const root = mkdtempSync(join(tmpdir(), "bk-edge-judge-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.html"), '<!doctype html><div id="root">demo ui</div>');
  const singleUpstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, key: req.headers["x-api-key"] ?? null }));
  });
  await new Promise((done) => singleUpstream.listen(0, "127.0.0.1", done));
  const singleUpstreamPort = singleUpstream.address().port;
  const judgeKey = `test-judge-key-${"j".repeat(24)}`;
  const child = spawn(process.execPath, [EDGE], {
    env: {
      PATH: process.env.PATH ?? "",
      BK_ACCESS_CODE: ACCESS_CODE,
      BK_EDGE_WEB_API_KEY: WEB_KEY,
      BK_JUDGE_API_KEY: judgeKey,
      BK_EDGE_COOKIE_SECRET: `test-cookie-secret-${"c".repeat(16)}`,
      BK_EDGE_PORT: String(singlePort),
      BK_EDGE_HOST: "127.0.0.1",
      BK_EDGE_UPSTREAM: `http://127.0.0.1:${singleUpstreamPort}`,
      BK_EDGE_STATIC_DIR: join(root, "dist"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await waitForListening(child);
  try {
    const singleBase = `http://127.0.0.1:${singlePort}`;
    const api = await fetch(`${singleBase}/v1/plugins`, { headers: { "x-api-key": judgeKey }, redirect: "manual" });
    assert.equal(api.status, 200);
    assert.equal((await api.json()).key, judgeKey);
    const ui = await fetch(`${singleBase}/`, { headers: { "x-api-key": judgeKey }, redirect: "manual" });
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /demo ui/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((done) => singleUpstream.close(done));
  }
});

test("access page uses an external stylesheet with no inline style or script", async () => {
  const page = await get("/", { ip: "203.0.113.80" });
  assert.equal(page.status, 401);
  const body = await page.text();
  assert.match(body, /<link rel="stylesheet" href="\/__access\/access\.css">/);
  assert.doesNotMatch(body, /<style/i);
  assert.doesNotMatch(body, /<script/i);
  assert.doesNotMatch(body, /style=/i);
  assert.match(body, /<img src="\/__access\/logo\.svg"/);
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.ok(csp.includes("style-src 'self'"), "CSP keeps style-src 'self'");
  assert.ok(!csp.includes("unsafe-inline"), "CSP has no unsafe-inline");
});

test("access stylesheet and logo are served with cache headers before the cookie", async () => {
  for (const path of ["/__access/access.css", "/__access/logo.svg"]) {
    const res = await get(path, { ip: "203.0.113.81" });
    assert.equal(res.status, 200);
    const cache = res.headers.get("cache-control") ?? "";
    assert.match(cache, /public/);
    assert.match(cache, /max-age=/);
  }
  const css = await get("/__access/access.css", { ip: "203.0.113.81" });
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  const cssBody = await css.text();
  assert.match(cssBody, /--phosphor:#8dffb6/);
  assert.match(cssBody, /--void:#010402/);
  assert.doesNotMatch(cssBody, /transform|transition|animation/i);
  const logo = await get("/__access/logo.svg", { ip: "203.0.113.81" });
  assert.match(logo.headers.get("content-type") ?? "", /image\/svg\+xml/);
  assert.match(await logo.text(), /<svg/);
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
