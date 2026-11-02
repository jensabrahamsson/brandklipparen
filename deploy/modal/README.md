# Brandklipparen demo on Modal

One Modal container serves the web UI, REST under `/v1`, `/health`,
`/ready`, and MCP at `/mcp` on one HTTPS origin. At most one container
runs (`max_containers=1`); `BK_MIN_CONTAINERS` (default `0`) controls
whether one stays warm.

## Access

The public cannot enter directly. The edge (`edge.mjs`) serves an
access page for every UI and keyless `/v1` request until the visitor
enters the access code from the Modal secret (`BK_ACCESS_CODE`; the
edge and `app.py` refuse to start without it). A correct code sets a
signed `HttpOnly; Secure; SameSite=Lax` cookie for 30 days. Codes
are trimmed and case-insensitive, compared in constant time on the
normalised value, and rate-limited per visitor (10 per 15 minutes,
form and one-click link share the limit). `/health` and `/ready`
stay open. REST and MCP clients with their own valid `x-api-key`
bypass the page; MCP also needs a personal key
(`BK_EDGE_MCP_ANON=0`).

Anonymous model use is capped at the edge: 500 model calls per day
globally and 25 per visitor, persisted on the Modal volume.

## Prerequisites

- A Modal account and the Modal CLI, logged in.
- A public (or clean local, see below) checkout at the commit to deploy.
- A dedicated Meta demo key for the model features.

## Create the secret

Create a Modal secret named `brandklipparen-demo`. Variable names
only; never put values in this repo, in shell history, or in logs:

- Required: `BK_ACCESS_CODE`, `BK_EDGE_WEB_API_KEY`,
  `BRANDKLIPPAREN_API_KEY_PEPPER`,
  `BRANDKLIPPAREN_ASSESSMENT_META_API_KEY`,
  `BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL`
- Optional: `BK_JUDGE_API_KEY`, `BK_JUDGE_API_KEYS`, `BK_EDGE_COOKIE_SECRET`,
  `ETHERSCAN_API_KEY`, `BRANDKLIPPAREN_RPC_URLS`,
  `BRANDKLIPPAREN_FEED_RPC_URL`

A judge key (`BK_JUDGE_API_KEY`, or a comma-separated
`BK_JUDGE_API_KEYS` list) is accepted like a personal key: it
bypasses the access page, uses the keyed rate limits, and is counted
in the same daily per-key model budget upstream (with the lower MCP
child caps).

## For judges (what goes in the submission notes)

Give judges these three items with placeholder values only (never
real values here):

- One-click link: `https://<workspace>--<label>.modal.run/?access=<access-code>`
  opens any UI path with `?access=<access-code>`; a correct code sets
  the cookie and 303-redirects to the same path without the code in
  the address bar. A wrong code shows the access page with a short
  error.
- Access code: `<access-code>` (typed entry also works; surrounding
  whitespace and letter case do not matter).
- Judge key for REST/MCP: `<judge-key>` as the `x-api-key` header
  (REST, for example `x-api-key: <judge-key>`) or the `x-api-key`
  header / `Authorization: Bearer <judge-key>` (MCP).

## Deploy

Deploy-time parameters are non-secret environment for the deploy
process. `BK_WETH_ADDRESS` is one of them: it stays a parameter and
is never hard-coded in the repo. Local mode (`BK_SOURCE=local` with
`BK_LOCAL_DIR`) stays available while the repo is private; it uploads
only git-tracked files from a clean checkout.

```sh
BK_PUBLIC_REPO=<https clone URL> BK_GIT_REF=<40-hex commit> \
BK_MODAL_WORKSPACE=<workspace> BK_WETH_ADDRESS=<operator value> \
BK_MIN_CONTAINERS=1 modal deploy deploy/modal/app.py
```

## Smoke

```sh
BK_SMOKE_ACCESS_CODE=<access code> \
deploy/modal/smoke.sh https://<workspace>--brandklipparen.modal.run <token address>
```

Add `BK_SMOKE_KEY=<personal key>` for keyed REST and MCP checks, and
`BK_SMOKE_MODEL=1` for one extra Meta model call.

## Budget notes

Scale to zero costs only active time plus the idle window. One warm
container costs roughly USD 1.52 per day at the prices noted when the
draft was written; check current Modal pricing before relying on it.
Set a workspace budget, keep `max_containers` at 1, and rotate the
Meta demo key after judging. `BK_MODEL_FEATURES=off` is the fast
kill switch: model features answer not-configured while the
deterministic analysis keeps working.
