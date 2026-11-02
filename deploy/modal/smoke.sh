#!/usr/bin/env bash
# Post-deploy smoke test for the public demo (deploy/modal/smoke.sh).
# Usage:  deploy/modal/smoke.sh https://<workspace>--brandklipparen.modal.run 0x<token contract address>
# The token address is a mainnet ERC-20 contract you choose at run time; the repo
# itself carries only invented example data.
# Optional environment:
#   BK_SMOKE_ACCESS_CODE=<access code>  enter the demo through the access gate
#   BK_SMOKE_KEY=<a judge key>   also checks keyed REST and the MCP endpoint
#   BK_SMOKE_MODEL=1             also makes ONE model call (explain) to prove the Meta wiring
# Read-only against the demo except for the analysis and model calls it makes.
set -euo pipefail
BASE="${1:?usage: smoke.sh <public demo URL> <token contract address>}"
BASE="${BASE%/}"
ADDR="${2:?usage: smoke.sh <public demo URL> <token contract address>}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
JAR="$TMP/cookies.txt"
pass=0; fail=0
ok()   { echo "PASS  $*"; pass=$((pass + 1)); }
bad()  { echo "FAIL  $*"; fail=$((fail + 1)); }
code() { curl -sS -b "$JAR" -c "$JAR" -o "$TMP/body" -D "$TMP/head" -w '%{http_code}' --max-time "${T:-60}" "$@" || echo 000; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1" < "$TMP/body"; }

c=$(code "$BASE/health")
if [ "$c" = 200 ]; then ok "/health 200 status=$(json 'v.status') assessment=$(json 'JSON.stringify(v.assessment ?? v.capabilities?.assessment ?? null)')"; else bad "/health $c"; fi
if grep -qiE '(api[_-]?key|bearer)[^,]{0,20}[A-Za-z0-9_-]{24,}' "$TMP/body"; then bad "/health body looks like it carries a key"; else ok "/health carries no key-like value"; fi
c=$(code "$BASE/ready"); [ "$c" = 200 ] && ok "/ready 200" || bad "/ready $c (503 means artifact checksum or wiring problem)"
c=$(code "$BASE/")
if grep -q 'name="code"' "$TMP/body"; then ok "UI without access cookie shows the access page"; else bad "UI without access cookie gave $c without an access page"; fi
if [ -n "${BK_SMOKE_ACCESS_CODE:-}" ]; then
  c=$(code -X POST --data-urlencode "code=$BK_SMOKE_ACCESS_CODE" "$BASE/access")
  [ "$c" = 303 ] && ok "access code accepted (303, cookie set)" || bad "access code gave $c (expected 303)"
fi
c=$(code "$BASE/")
if [ "$c" = 200 ] && grep -q 'id="root"' "$TMP/body" && grep -qi "^content-security-policy: default-src 'self'" "$TMP/head"; then ok "web UI 200 with CSP"; else bad "web UI $c or CSP missing"; fi
c=$(code "$BASE/v1/plugins"); [ "$c" = 200 ] && ok "anonymous /v1/plugins 200 (edge supplies the web key)" || bad "anonymous /v1/plugins $c"
grep -qi '^x-api-key' "$TMP/head" && bad "response echoes an x-api-key header" || ok "no key header in responses"
T=120 c=$(code "$BASE/v1/analyze?address=$ADDR")
if [ "$c" = 200 ]; then ok "anonymous analyze 200 score=$(json 'v.score ?? v.result?.score ?? "?"') model=$(json 'v.modelVersion ?? v.model?.version ?? "?"')"; else bad "anonymous analyze $c $(head -c 200 "$TMP/body")"; fi
curl -sN -b "$JAR" --max-time 60 "$BASE/v1/analyze/stream?address=$ADDR" > "$TMP/sse" 2>/dev/null || true
if grep -q '^data:\|^event:' "$TMP/sse"; then ok "SSE stream delivers events"; else bad "SSE stream gave no events within 60 s"; fi
c=$(code -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$BASE/mcp")
[ "$c" = 401 ] && ok "MCP without key is refused (401)" || bad "MCP without key gave $c (expected 401)"
if [ -n "${BK_SMOKE_KEY:-}" ]; then
  c=$(code -H "x-api-key: $BK_SMOKE_KEY" "$BASE/v1/plugins"); [ "$c" = 200 ] && ok "keyed /v1/plugins 200" || bad "keyed /v1/plugins $c"
  c=$(code -X POST -H "authorization: Bearer $BK_SMOKE_KEY" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":"i","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' "$BASE/mcp")
  [ "$c" = 200 ] && [ "$(json 'v.result?.protocolVersion')" = "2025-06-18" ] && ok "MCP initialize" || bad "MCP initialize $c $(head -c 200 "$TMP/body")"
  c=$(code -X POST -H "authorization: Bearer $BK_SMOKE_KEY" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "$BASE/mcp")
  [ "$c" = 200 ] && ok "MCP tools/list: $(json '(v.result?.tools ?? []).map(t => t.name).join(" ")')" || bad "MCP tools/list $c"
fi
if [ "${BK_SMOKE_MODEL:-0}" = 1 ]; then
  T=120 c=$(code "$BASE/v1/explain?address=$ADDR")
  [ "$c" = 200 ] && ok "one model call (explain) 200" || bad "explain $c $(head -c 200 "$TMP/body")"
fi
echo "smoke: $pass passed, $fail failed against $BASE"
[ "$fail" -eq 0 ]
