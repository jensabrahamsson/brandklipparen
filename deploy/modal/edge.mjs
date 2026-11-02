// Public demo edge for Brandklipparen (deploy/modal, Node 22, no
// dependencies). One HTTPS origin in front of the unchanged app:
//   GET  /, /assets/*, /logo.svg   static web UI from apps/web/dist with
//                                  the same content policy as vite preview
//   GET  /health, /ready           proxied to the REST API, keyless
//   ANY  /v1/*                     proxied to the REST API on 127.0.0.1
//   POST /mcp                      JSON-RPC over HTTP, bridged to the stdio
//                                  MCP server (src/main.ts mcp)
// Access gate: until a visitor enters the access code (BK_ACCESS_CODE,
// only from the Modal secret) the edge serves only an access page for
// the UI and for keyless /v1 requests. A correct code sets a signed,
// HttpOnly cookie for 30 days. REST and MCP clients carrying their own
// x-api-key bypass the page; the upstream API validates that key.
// Browser visitors then carry no API key: when a /v1 request has no
// x-api-key header, the edge adds the server-held web key (never sent
// to browsers) and applies per-client and global limits plus daily
// caps on the routes that call the model. Client identity is a salted
// hash of the first X-Forwarded-For entry (or the socket address);
// raw addresses are never logged. Daily counters survive restarts
// through BK_EDGE_STATE_FILE (a Modal volume path in the demo).
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest, createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

const env = process.env;
const int = (name, fallback) => {
  const value = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const CONFIG = Object.freeze({
  host: env.BK_EDGE_HOST ?? "0.0.0.0",
  port: int("BK_EDGE_PORT", 8000),
  upstream: new URL(env.BK_EDGE_UPSTREAM ?? "http://127.0.0.1:8080"),
  staticDir: resolve(env.BK_EDGE_STATIC_DIR ?? "apps/web/dist"),
  webKey: env.BK_EDGE_WEB_API_KEY ?? "",
  accessCode: env.BK_ACCESS_CODE ?? "",
  judgeKeys: [env.BK_JUDGE_API_KEY ?? "", ...(env.BK_JUDGE_API_KEYS ?? "").split(",")].map((k) => k.trim()).filter(Boolean),
  publicOrigin: env.BK_EDGE_PUBLIC_ORIGIN ?? "",
  stateFile: env.BK_EDGE_STATE_FILE ?? "",
  maxBodyBytes: int("BK_EDGE_MAX_BODY_BYTES", 65536),
  upstreamTimeoutMs: int("BK_EDGE_UPSTREAM_TIMEOUT_MS", 180000),
  perClientPerMinute: int("BK_EDGE_RATE_PER_CLIENT_PER_MIN", 120),
  keyedPerClientPerMinute: int("BK_EDGE_KEYED_RATE_PER_CLIENT_PER_MIN", 240),
  anonGlobalPerMinute: int("BK_EDGE_GLOBAL_ANON_PER_MIN", 900),
  modelPerClientPerDay: int("BK_EDGE_MODEL_CALLS_PER_CLIENT_PER_DAY", 25),
  modelGlobalPerDay: int("BK_EDGE_MODEL_CALLS_GLOBAL_PER_DAY", 500),
  investigatePerClientPerDay: int("BK_EDGE_INVESTIGATE_PER_CLIENT_PER_DAY", 3),
  mcpCommand: env.BK_EDGE_MCP_CMD ? JSON.parse(env.BK_EDGE_MCP_CMD) : null,
  mcpCwd: env.BK_EDGE_MCP_CWD ?? process.cwd(),
  mcpAnonymous: env.BK_EDGE_MCP_ANON === "1",
  mcpTimeoutMs: int("BK_EDGE_MCP_TIMEOUT_MS", 130000),
});
const SALT = env.BK_EDGE_SALT || randomBytes(16).toString("hex");
const COOKIE_SECRET = env.BK_EDGE_COOKIE_SECRET || env.BK_EDGE_SALT || randomBytes(32).toString("hex");
const ACCESS_COOKIE = "bk_access";
const ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60;
const ACCESS_MAX_FAILURES = 10;
const ACCESS_WINDOW_MS = 15 * 60 * 1000;

// Routes that reach the model API. Each anonymous request to one of them
// counts once against the daily caps, whether or not the answer is cached.
const MODEL_ROUTES = new Set([
  "/v1/assessment", "/v1/investigate", "/v1/explain", "/v1/chat", "/v1/rug",
  "/v1/explain-code", "/v1/personalize", "/v1/naming",
]);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const STATIC_HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "strict-transport-security": "max-age=31536000",
};
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "content-length"]);

// Public access assets: same-origin files served before the access
// cookie so the access page renders under the strict CSP
// (style-src 'self', no inline style or script).
const ACCESS_CSS_PATH = "/__access/access.css";
const ACCESS_LOGO_PATH = "/__access/logo.svg";
const ACCESS_CSS = `:root{color-scheme:dark;--void:#010402;--glass:#03110a;--glass-2:#062016;--phosphor:#8dffb6;--phosphor-hi:#d6ffe6;--dim:#4fb27a;--edge:#2e7a4f;--amber:#ffc14d}` + "\n" +
  `*{box-sizing:border-box}` + "\n" +
  `html{background:var(--void)}` + "\n" +
  `body{margin:0;min-height:100vh;padding:24px 16px;background:var(--void);color:var(--phosphor);font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:16px;line-height:1.5}` + "\n" +
  `main{max-width:34rem;margin:10vh auto 0;padding:24px;background:var(--glass);border:1px solid var(--edge);border-radius:14px}` + "\n" +
  `.brandrow{display:flex;align-items:center;gap:12px}` + "\n" +
  `.brandrow img{width:40px;height:40px;border-radius:8px}` + "\n" +
  `h1{margin:0;color:var(--phosphor-hi);font-size:1.5rem;line-height:1.2;letter-spacing:0.02em}` + "\n" +
  `.sub{margin:4px 0 0;color:var(--dim);font-size:0.95rem}` + "\n" +
  `p{color:var(--phosphor)}` + "\n" +
  `label{display:block;margin-top:16px;color:var(--phosphor-hi)}` + "\n" +
  `input,button{font:inherit}` + "\n" +
  `input{display:block;width:100%;min-height:48px;margin-top:8px;padding:12px;background:var(--void);color:var(--phosphor-hi);border:1px solid var(--dim);border-radius:6px}` + "\n" +
  `button{display:inline-block;min-width:48px;min-height:48px;margin-top:16px;padding:12px 24px;background:var(--glass-2);color:var(--phosphor-hi);border:1px solid var(--dim);border-radius:6px;cursor:pointer}` + "\n" +
  `button:hover{background:var(--glass)}` + "\n" +
  `input:focus-visible,button:focus-visible{outline:3px solid var(--phosphor-hi);outline-offset:2px}` + "\n" +
  `p[role="alert"]{color:var(--amber);border:1px solid var(--amber);border-radius:6px;padding:8px 12px}` + "\n" +
  `@media (max-width:400px){body{padding:16px 12px}main{margin-top:6vh;padding:20px 16px}}` + "\n";
const ACCESS_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="40" height="40"><title>Brandklipparen mark</title><rect width="120" height="120" rx="26" fill="#03110a"/><g transform="translate(10 10)"><path d="M40 30 L48 8 L56 25 L64 27 L58 66 L66 96 L24 96 Q26 56 40 30 Z" fill="#4fb27a"/><path d="M56 25 L64 27 L90 55 L92 65 L84 71 L70 65 L58 66 L52 44 Z" fill="#8dffb6"/><path d="M62 37 L68 40 L62 43 Z" fill="#010402"/></g></svg>` + "\n";

// ---------- access gate ----------
function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}
function normalizeCode(value) {
  return String(value ?? "").trim().toLowerCase();
}
function sameSecret(candidate, expected) {
  return timingSafeEqual(digest(normalizeCode(candidate)), digest(normalizeCode(expected)));
}
function isKnownKey(key) {
  if (!key) return false;
  return [CONFIG.webKey, ...CONFIG.judgeKeys].some((known) => known && sameSecret(key, known));
}
function signAccess(expires) {
  return createHmac("sha256", COOKIE_SECRET).update(`${ACCESS_COOKIE}.${expires}`).digest("base64url");
}
function hasAccessCookie(req) {
  const header = String(req.headers.cookie ?? "");
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== ACCESS_COOKIE) continue;
    const [expires, signature] = rest.join("=").split(".");
    if (!expires || !signature) return false;
    if (!/^\d+$/.test(expires) || Number(expires) <= Math.floor(Date.now() / 1000)) return false;
    const expected = Buffer.from(signAccess(expires), "utf8");
    const given = Buffer.from(signature, "utf8");
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
  return false;
}
function hasAccess(req) {
  const ownKey = String(req.headers["x-api-key"] ?? "").trim();
  return hasAccessCookie(req) || isKnownKey(ownKey);
}
const accessFailures = new Map();
function accessRetryAfter(client) {
  const now = Date.now();
  const hits = (accessFailures.get(client) ?? []).filter((t) => t > now - ACCESS_WINDOW_MS);
  accessFailures.set(client, hits);
  if (hits.length < ACCESS_MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((hits[0] + ACCESS_WINDOW_MS - now) / 1000));
}
function recordAccessFailure(client) {
  const hits = accessFailures.get(client) ?? [];
  hits.push(Date.now());
  accessFailures.set(client, hits);
}
function accessPage(message) {
  const note = message ? `<p role="alert">${message}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brandklipparen</title>
<link rel="stylesheet" href="${ACCESS_CSS_PATH}">
</head>
<body>
<main>
<div class="brandrow"><img src="${ACCESS_LOGO_PATH}" alt="" width="40" height="40"><div><h1>Brandklipparen</h1><p class="sub">contract risk scanner · judge preview</p></div></div>
<p>Enter the access code from the submission notes.</p>
${note}
<form method="post" action="/access">
<label for="code">Access code</label>
<input id="code" name="code" type="password" autocomplete="off" autofocus required>
<button type="submit">Enter</button>
</form>
</main>
</body>
</html>
`;
}
function serveAccessAsset(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return 405;
  }
  const isCss = (req.url ?? "").split("?")[0] === ACCESS_CSS_PATH;
  const body = isCss ? ACCESS_CSS : ACCESS_LOGO_SVG;
  res.writeHead(200, {
    ...STATIC_HEADERS,
    "content-type": isCss ? "text/css; charset=utf-8" : "image/svg+xml",
    "cache-control": "public, max-age=31536000, immutable",
  });
  if (req.method === "HEAD") res.end();
  else res.end(body);
  return 200;
}
function serveAccessPage(res, status, message, retryAfterSec) {
  const headers = {
    ...STATIC_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
  };
  if (retryAfterSec !== undefined) headers["retry-after"] = String(retryAfterSec);
  res.writeHead(status, headers);
  res.end(accessPage(message));
  return status;
}
async function handleAccess(req, res, client) {
  if (req.method === "GET" || req.method === "HEAD") {
    if (hasAccessCookie(req)) {
      res.writeHead(303, { location: "/" });
      res.end();
      return 303;
    }
    return serveAccessPage(res, 401, "");
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, HEAD, POST" });
    res.end();
    return 405;
  }
  const retry = accessRetryAfter(client);
  if (retry > 0) return serveAccessPage(res, 429, "Too many attempts. Try again later.", retry);
  let body;
  try {
    body = await readBody(req, CONFIG.maxBodyBytes);
  } catch {
    return serveAccessPage(res, 413, "Request too large.");
  }
  const code = new URLSearchParams(body.toString("utf8")).get("code") ?? "";
  if (!sameSecret(code, CONFIG.accessCode)) {
    recordAccessFailure(client);
    return serveAccessPage(res, 401, "Access code not accepted.");
  }
  accessFailures.delete(client);
  return grantAccess(res, "/");
}
function grantAccess(res, location) {
  const expires = Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS;
  res.writeHead(303, {
    location,
    "cache-control": "no-store",
    "set-cookie": `${ACCESS_COOKIE}=${expires}.${signAccess(String(expires))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ACCESS_TTL_SECONDS}`,
  });
  res.end();
  return 303;
}
function handleOneClick(req, res, client, rawUrl) {
  let accessValue = null;
  let pathname = "/";
  try {
    const parsed = new URL(rawUrl ?? "/", "http://edge");
    accessValue = parsed.searchParams.get("access");
    pathname = parsed.pathname || "/";
    parsed.searchParams.delete("access");
    const rest = parsed.searchParams.toString();
    pathname = rest ? `${pathname}?${rest}` : pathname;
  } catch {
    return null;
  }
  if (accessValue === null) return null;
  const retry = accessRetryAfter(client);
  if (retry > 0) return serveAccessPage(res, 429, "Too many attempts. Try again later.", retry);
  if (!sameSecret(accessValue, CONFIG.accessCode)) {
    recordAccessFailure(client);
    return serveAccessPage(res, 401, "Access code not accepted.");
  }
  accessFailures.delete(client);
  return grantAccess(res, pathname);
}

// ---------- limits ----------
const today = () => new Date().toISOString().slice(0, 10);
let day = { date: today(), modelGlobal: 0, model: {}, investigate: {} };
let dirty = false;
if (CONFIG.stateFile && existsSync(CONFIG.stateFile)) {
  try {
    const saved = JSON.parse(readFileSync(CONFIG.stateFile, "utf8"));
    if (saved && saved.date === day.date) day = saved;
  } catch {
    // A damaged state file starts a fresh day; the REST caps still hold.
  }
}
function persist() {
  if (!CONFIG.stateFile || !dirty) return;
  try {
    writeFileSync(`${CONFIG.stateFile}.tmp`, JSON.stringify(day));
    renameSync(`${CONFIG.stateFile}.tmp`, CONFIG.stateFile);
    dirty = false;
  } catch (error) {
    log({ event: "state-write-failed", error: String(error) });
  }
}
setInterval(persist, 15000).unref();

const windows = new Map();
function hitWindow(key, limit) {
  const now = Date.now();
  const hits = (windows.get(key) ?? []).filter((t) => t > now - 60000);
  if (hits.length >= limit) {
    windows.set(key, hits);
    return Math.max(1, Math.ceil((hits[0] + 60000 - now) / 1000));
  }
  hits.push(now);
  windows.set(key, hits);
  return 0;
}
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [key, hits] of windows) if (hits.every((t) => t <= cutoff)) windows.delete(key);
}, 60000).unref();
function secondsToUtcMidnight() {
  const now = new Date();
  return Math.max(1, Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now) / 1000));
}
function takeModelCall(client, isInvestigation) {
  if (day.date !== today()) { day = { date: today(), modelGlobal: 0, model: {}, investigate: {} }; dirty = true; }
  if (day.modelGlobal >= CONFIG.modelGlobalPerDay) return "the demo's daily model budget is used up";
  if ((day.model[client] ?? 0) >= CONFIG.modelPerClientPerDay) return "your daily model budget on this demo is used up";
  if (isInvestigation && (day.investigate[client] ?? 0) >= CONFIG.investigatePerClientPerDay) {
    return "your daily investigation budget on this demo is used up";
  }
  day.modelGlobal += 1;
  day.model[client] = (day.model[client] ?? 0) + 1;
  if (isInvestigation) day.investigate[client] = (day.investigate[client] ?? 0) + 1;
  dirty = true;
  return null;
}

// ---------- helpers ----------
function log(entry) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), service: "edge", ...entry })}\n`);
}
function clientOf(req) {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  const raw = forwarded || req.socket.remoteAddress || "unknown";
  return createHash("sha256").update(SALT).update(raw).digest("hex").slice(0, 16);
}
function sendError(res, status, code, message, retryAfterSec) {
  const requestId = randomUUID();
  const headers = { "content-type": "application/json", "cache-control": "no-store", "x-request-id": requestId };
  if (retryAfterSec !== undefined) headers["retry-after"] = String(retryAfterSec);
  if (status === 401) headers["www-authenticate"] = "Bearer";
  res.writeHead(status, headers);
  res.end(JSON.stringify({ status, code, message, requestId }));
}
function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------- static web UI ----------
function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return 405;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://edge").pathname);
  } catch {
    sendError(res, 400, "validation-error", "Malformed URL.");
    return 400;
  }
  const wanted = pathname === "/" ? "/index.html" : pathname;
  let file = normalize(join(CONFIG.staticDir, wanted));
  if (!file.startsWith(CONFIG.staticDir + sep)) {
    sendError(res, 404, "not-found", "Not found.");
    return 404;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (extname(wanted) !== "") {
      sendError(res, 404, "not-found", "Not found.");
      return 404;
    }
    file = join(CONFIG.staticDir, "index.html");
  }
  const immutable = file.startsWith(join(CONFIG.staticDir, "assets") + sep);
  res.writeHead(200, {
    ...STATIC_HEADERS,
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
  return 200;
}

// ---------- REST proxy ----------
function proxy(req, res, injectKey, done) {
  let status = 502;
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > CONFIG.maxBodyBytes) {
    sendError(res, 413, "request-too-large", "Request body too large.");
    done(413);
    return;
  }
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP.has(name) && !name.startsWith("x-forwarded-") && name !== "cookie") headers[name] = value;
  }
  if (injectKey) headers["x-api-key"] = CONFIG.webKey;
  const upstream = httpRequest({
    host: CONFIG.upstream.hostname,
    port: CONFIG.upstream.port,
    method: req.method,
    path: req.url,
    headers,
    timeout: CONFIG.upstreamTimeoutMs,
  }, (up) => {
    status = up.statusCode ?? 502;
    const out = {};
    for (const [name, value] of Object.entries(up.headers)) if (!HOP.has(name)) out[name] = value;
    res.writeHead(status, out);
    up.pipe(res);
  });
  let received = 0;
  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > CONFIG.maxBodyBytes) {
      status = 413;
      req.unpipe(upstream);
      upstream.destroy();
      if (!res.headersSent) sendError(res, 413, "request-too-large", "Request body too large.");
    }
  });
  upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
  upstream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (status !== 413) {
      status = 502;
      sendError(res, 502, "upstream-unavailable", "The analysis service is not reachable right now.");
    }
  });
  res.on("close", () => {
    upstream.destroy();
    done(status);
  });
  req.pipe(upstream);
}

// ---------- MCP bridge ----------
const pending = new Map();
let mcp = null;
let mcpRestarts = [];
let sequence = 0;
function startMcp() {
  if (!CONFIG.mcpCommand) return;
  const [command, ...args] = CONFIG.mcpCommand;
  const childEnv = { ...process.env, ...JSON.parse(env.BK_EDGE_MCP_ENV_JSON ?? "{}") };
  for (const name of Object.keys(childEnv)) {
    if (name.startsWith("BK_EDGE_") || name === "BK_ACCESS_CODE" || name === "BK_JUDGE_API_KEY" || name === "BK_JUDGE_API_KEYS") delete childEnv[name];
  }
  mcp = spawn(command, args, { cwd: CONFIG.mcpCwd, env: childEnv, stdio: ["pipe", "pipe", "inherit"] });
  mcp.on("error", (error) => log({ event: "mcp-spawn-failed", error: String(error) }));
  mcp.stdin.on("error", () => {
    // EPIPE while the child restarts; pending calls are answered on exit.
  });
  createInterface({ input: mcp.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(String(message.id));
    if (waiter) {
      pending.delete(String(message.id));
      clearTimeout(waiter.timer);
      waiter.resolve({ ...message, id: waiter.originalId });
    }
  });
  mcp.on("exit", (code) => {
    log({ event: "mcp-exit", code });
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.resolve({ jsonrpc: "2.0", id: waiter.originalId, error: { code: -32603, message: "MCP server restarted." } });
      pending.delete(id);
    }
    mcp = null;
    const now = Date.now();
    mcpRestarts = mcpRestarts.filter((t) => t > now - 600000);
    if (mcpRestarts.length < 5) {
      mcpRestarts.push(now);
      setTimeout(startMcp, 2000);
    }
  });
}
function callMcp(message, key) {
  return new Promise((resolveCall) => {
    if (!mcp) {
      resolveCall({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32603, message: "MCP server unavailable." } });
      return;
    }
    const isNotification = message.id === undefined;
    const internalId = `edge-${(sequence += 1)}`;
    const outgoing = { ...message, auth: key };
    if (!isNotification) {
      outgoing.id = internalId;
      const timer = setTimeout(() => {
        pending.delete(internalId);
        resolveCall({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "MCP call timed out." } });
      }, CONFIG.mcpTimeoutMs);
      pending.set(internalId, { originalId: message.id, resolve: resolveCall, timer });
    }
    mcp.stdin.write(`${JSON.stringify(outgoing)}\n`);
    if (isNotification) resolveCall(null);
  });
}
async function handleMcp(req, res, client) {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return 405;
  }
  if (CONFIG.publicOrigin && req.headers.origin && req.headers.origin !== CONFIG.publicOrigin) {
    sendError(res, 403, "validation-error", "Cross-origin MCP requests are not accepted.");
    return 403;
  }
  const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  const ownKey = String(req.headers["x-api-key"] ?? "").trim() || bearer;
  if (!ownKey && !CONFIG.mcpAnonymous) {
    sendError(res, 401, "missing-api-key", "Pass your demo API key in the x-api-key header or as a Bearer token.");
    return 401;
  }
  const retry = hitWindow(`mcp:${client}`, ownKey ? CONFIG.keyedPerClientPerMinute : CONFIG.perClientPerMinute);
  if (retry > 0) {
    sendError(res, 429, "rate-limited", `Rate limit exceeded; retry after ${retry} seconds.`, retry);
    return 429;
  }
  let parsed;
  try {
    parsed = JSON.parse((await readBody(req, CONFIG.maxBodyBytes)).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === "too-large") sendError(res, 413, "request-too-large", "Request body too large.");
    else sendError(res, 400, "validation-error", "Expected a JSON-RPC 2.0 message or batch.");
    return 400;
  }
  const batch = Array.isArray(parsed) ? parsed : [parsed];
  if (batch.length === 0 || batch.length > 16 || batch.some((m) => !m || typeof m !== "object" || typeof m.method !== "string")) {
    sendError(res, 400, "validation-error", "Expected a JSON-RPC 2.0 message or batch.");
    return 400;
  }
  if (!ownKey) {
    for (const message of batch) {
      if (message.method === "tools/call") {
        const denied = takeModelCall(client, false);
        if (denied) {
          sendError(res, 429, "rate-limited", `Limit reached: ${denied}.`, secondsToUtcMidnight());
          return 429;
        }
      }
    }
  }
  const replies = (await Promise.all(batch.map((m) => callMcp(m, ownKey || CONFIG.webKey)))).filter((r) => r !== null);
  if (replies.length === 0) {
    res.writeHead(202);
    res.end();
    return 202;
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
  return 200;
}

// ---------- server ----------
const server = createServer((req, res) => {
  try {
    route(req, res);
  } catch (error) {
    log({ event: "handler-error", error: String(error) });
    if (!res.headersSent) sendError(res, 500, "internal-error", "Internal error.");
    else res.destroy();
  }
});
function route(req, res) {
  const started = Date.now();
  const client = clientOf(req);
  const path = new URL(req.url ?? "/", "http://edge").pathname;
  let logged = false;
  const finish = (status, anonymous) => {
    if (logged) return;
    logged = true;
    log({ m: req.method, p: path, s: status, ms: Date.now() - started, c: client.slice(0, 8), anon: anonymous });
  };
  if (path === "/health" || path === "/ready") {
    proxy(req, res, false, (status) => finish(status, undefined));
    return;
  }
  if (path === "/access") {
    handleAccess(req, res, client).then((status) => finish(status, undefined), (error) => {
      log({ event: "access-error", error: String(error) });
      if (!res.headersSent) sendError(res, 500, "internal-error", "Internal error.");
      finish(500, undefined);
    });
    return;
  }
  if (path === "/mcp") {
    handleMcp(req, res, client).then((status) => finish(status, undefined), (error) => {
      log({ event: "mcp-error", error: String(error) });
      if (!res.headersSent) sendError(res, 500, "internal-error", "Internal error.");
      finish(500, undefined);
    });
    return;
  }
  if (path.startsWith("/v1/")) {
    const ownKey = String(req.headers["x-api-key"] ?? "").trim();
    const anonymous = ownKey === "";
    if (anonymous && !hasAccessCookie(req)) {
      finish(serveAccessPage(res, 401, ""), true);
      return;
    }
    if (anonymous && !CONFIG.webKey) {
      sendError(res, 503, "service-unavailable", "The demo key is not configured.");
      finish(503, true);
      return;
    }
    let retry = hitWindow(`v1:${client}`, anonymous ? CONFIG.perClientPerMinute : CONFIG.keyedPerClientPerMinute);
    if (retry === 0 && anonymous) retry = hitWindow("v1:anonymous", CONFIG.anonGlobalPerMinute);
    if (retry > 0) {
      sendError(res, 429, "rate-limited", `Rate limit exceeded; retry after ${retry} seconds.`, retry);
      finish(429, anonymous);
      return;
    }
    if (anonymous && MODEL_ROUTES.has(path)) {
      const denied = takeModelCall(client, path === "/v1/investigate");
      if (denied) {
        sendError(res, 429, "rate-limited", `Limit reached: ${denied}. It resets at 00:00 UTC.`, secondsToUtcMidnight());
        finish(429, anonymous);
        return;
      }
    }
    proxy(req, res, anonymous, (status) => finish(status, anonymous));
    return;
  }
  if (path === ACCESS_CSS_PATH || path === ACCESS_LOGO_PATH) {
    finish(serveAccessAsset(req, res), undefined);
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    const oneClick = handleOneClick(req, res, client, req.url);
    if (oneClick !== null) {
      finish(oneClick, undefined);
      return;
    }
  }
  if (!hasAccess(req)) {
    finish(serveAccessPage(res, 401, ""), undefined);
    return;
  }
  finish(serveStatic(req, res), undefined);
}
server.headersTimeout = 20000;
server.requestTimeout = 0;
server.keepAliveTimeout = 65000;

function shutdown() {
  persist();
  if (mcp) mcp.kill("SIGTERM");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

if (!CONFIG.accessCode) {
  log({ event: "access-code-missing" });
  process.exit(1);
}
if (!existsSync(join(CONFIG.staticDir, "index.html"))) {
  log({ event: "static-missing", dir: CONFIG.staticDir });
  process.exit(1);
}
startMcp();
server.listen(CONFIG.port, CONFIG.host, () => log({ event: "listening", port: CONFIG.port, mcp: Boolean(CONFIG.mcpCommand) }));
