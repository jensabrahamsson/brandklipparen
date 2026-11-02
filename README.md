# Brandklipparen

Bytecode-only, deterministic, calibrated ERC-20 rug-pull risk assessment with evidence behind every score.

## Quick start

Prerequisites: Node 22 (the repo pins `>=22 <23` in `package.json` and
`22` in `.nvmrc`). Plain `npm run demo` works when a Node 22 binary
exists at `~/.local/node22` (checked as `$HOME/.local/node22/bin/node`)
or `NODE22_BIN` points at one: the demo re-runs itself under that
binary automatically. Only when neither is set, prefix the command with
the portable bin directory instead:

```sh
export PATH="$HOME/.local/node22/bin:$PATH"
```

Clone the private repo and enter it:

```sh
git clone https://github.com/jensabrahamsson/brandklipparen
cd brandklipparen
```

Install dependencies once (root and web UI):

```sh
npm install
npm --prefix apps/web install
```

Start the demo (REST API plus web UI together):

```sh
npm run demo
```

Then open [http://localhost:5173](http://localhost:5173) in a browser.
The page talks to the REST API through the dev-server proxy
(`apps/web/vite.config.ts` targets `http://127.0.0.1:8080` by default);
the demo prints the REST base URL on startup.

No API keys are needed: key-gated features stay off and report
`not-configured`, and the model-assisted assessment/investigation
feature is off by default.

Overrides (the demo only fills variables that are not already set, so
the environment always wins):

```sh
BRANDKLIPPAREN_RPC_URLS="https://eth.drpc.org" npm run demo
```

The default RPC is the key-free `https://ethereum-rpc.publicnode.com`.
Key-free alternatives include `https://eth.drpc.org`,
`https://gateway.tenderly.co/public/mainnet` and
`https://rpc.mevblocker.io`. Decompilation is internal: the in-process
engine needs no binary and no setup, so the deepening always runs.

While the demo runs, the start page also shows a live list of new
tokens: the backend watches Uniswap V2/V3 pair creations on mainnet
(Etherscan logs first, the RPC log adapter as fallback, WETH from
`BK_WETH_ADDRESS`), lists the newest first with age, pair, initial WETH
liquidity and the deterministic risk result, and refreshes every ~10 s.
Set `ETHERSCAN_API_KEY` (or `ETHERSCAN_API_KEY_FILE`) to turn it on;
without any feed source the list reports `not-configured` instead.

Optional local overrides live in a git-ignored `.env.local` file in the
repo root (simple `KEY=VALUE` lines, `#` comments, optional quotes).
Start from the documented names:

```sh
cp .env.example .env.local
```

Secrets are never written as values in `.env.local`: keys arrive only
through `*_FILE` pointer variables that name a file holding the key (for
example `BRANDKLIPPAREN_ASSESSMENT_META_API_KEY_FILE` or
`ETHERSCAN_API_KEY_FILE`, absolute or repo-relative); the demo reads the
file and sets the matching variable when it is not already set, so the
environment wins over `.env.local`, which wins over the demo defaults.
To try the model-assisted assessment through the Meta Model API, set
`BRANDKLIPPAREN_ASSESSMENT_PROVIDER=meta-model-api` together with
`BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL` (the API root,
for example ending in `/v1`; the adapter appends `/chat/completions`),
`BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID` and
`BRANDKLIPPAREN_ASSESSMENT_META_API_KEY`; the key may
instead be pointed to with
`BRANDKLIPPAREN_ASSESSMENT_META_API_KEY_FILE` (an absolute
path, or one relative to the repo root). Set
`BRANDKLIPPAREN_ASSESSMENT_PROVIDER=off` (or leave it unset without a
key) to keep the assessment off. Any secret also loads from a
`<NAME>_FILE` pointer the same way, including `ETHERSCAN_API_KEY_FILE`
for the optional LP feed (`lp feed: etherscan (key loaded)` when set,
`lp feed: off` otherwise). The demo also points
`BRANDKLIPPAREN_FEED_RPC_URL` at the same key-free public RPC, so the live
list falls back to RPC logs when the log source is rate limited or unset.

Optional model-assisted mapping via `BRANDKLIPPAREN_PERSONALIZE_PROVIDER`:
when unset, the demo defaults it to `meta-model-api` if a Meta key is
configured (`BRANDKLIPPAREN_ASSESSMENT_META_API_KEY` directly or via its
`*_FILE` pointer); an explicit `"off"` (or no key) leaves the feature
disabled with zero provider calls. The mapping reuses the assessment
connection settings (key, model id, base URL), so no second key
travels beside this variable. For the Meta setup, set
`BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID=muse-spark-1.3`. The risk score and evidence stay
deterministic and are never influenced by the model: scores and evidence
pass through untouched with and without the adapter (see
`k307_scores_and_evidence_identical_with_and_without_adapter` in
`docs/requirements.md`).

## REST API example

The REST API listens on `BRANDKLIPPAREN_HTTP_PORT` (default `8080`) at
`http://127.0.0.1:8080`; the web UI on `http://localhost:5173` talks to
it through the dev-server proxy. Analysis calls carry the API key only in
the `x-api-key` header, never in the URL or body. The demo generates a
per-run local key when `BRANDKLIPPAREN_API_KEYS` is unset and injects it
into the web UI automatically; set `BRANDKLIPPAREN_API_KEYS` in the
environment or `.env.local` to call the API directly:

```sh
KEY="<a value from BRANDKLIPPAREN_API_KEYS>"
curl -H "x-api-key: $KEY" \
  "http://127.0.0.1:8080/v1/analyze?address=0x0102030405060708090a0b0c0d0e0f1011121314"
```

Replace the synthetic address with any ERC-20 contract address on Ethereum mainnet.

`GET /v1/analyze` reads the address (plus an optional block) from the
query string; `POST /v1/analyze` takes the same fields as a JSON body.
`GET /health` is public and keyless.

The REST keys may instead be supplied with
`BRANDKLIPPAREN_API_KEYS_FILE` (an absolute path, or one relative to
the repo root), with the same rules as the other `*_FILE` keys: set
only one of `BRANDKLIPPAREN_API_KEYS` and its `*_FILE` pointer.
Rate limiting is per key and global; one key may use at most
`BRANDKLIPPAREN_RATE_LIMIT_PER_KEY_GLOBAL_SHARE_PERCENT` percent
(default 50) of the global minute window
(`BRANDKLIPPAREN_GLOBAL_RATE_PER_MINUTE`), so a single key cannot
exhaust the global budget for the other keys, while the per-key
minute and daily limits still apply.

## MCP server

```sh
npm run start:mcp
```

The MCP server speaks minimal JSON-RPC 2.0 over stdio
(newline-delimited frames on stdin, one response frame per line on
stdout). Point an MCP client at the command above as a stdio server; no
port is opened.

Tool calls carry the API key in the JSON-RPC `auth` field of each
frame. MCP hosts may log JSON-RPC frames, so a logged frame can expose
that key: use a host that does not persist frames (or that redacts the
`auth` field), and rotate the key if frames were logged. The server
itself receives its accepted keys only through the environment at
startup (`BRANDKLIPPAREN_API_KEYS`, or `BRANDKLIPPAREN_API_KEYS_FILE`
pointing at a file holding them), never through a file in the repo;
prefer that environment injection over putting a key in a client
configuration file that is checked in or shared.

## Tests and gates

```sh
npm test                # unit, integration and contract suites (vitest)
npm run test:web        # web UI unit tests
npm run e2e:web         # web UI end to end tests (builds, then Playwright)
npm run lint            # eslint
npm run typecheck       # root TypeScript check
npm run typecheck:web   # web UI TypeScript check
npm run check:english   # no Swedish letters in tracked files
npm run check:vendors   # no non-Meta AI vendor names in tracked files
npm run gate            # dependency-cruiser policy
npm run check           # lint, gate, check:vendors, check:english, typecheck, test
```

## Troubleshooting

If the web UI or the e2e tests fail with connection refused on
`127.0.0.1` (IPv6/IPv4 resolution), run with:

```sh
NODE_OPTIONS=--dns-result-order=ipv4first npm run demo
NODE_OPTIONS=--dns-result-order=ipv4first npm run e2e:web
```

## What it is

Brandklipparen assesses the rug-pull risk of ERC-20 tokens from contract
bytecode alone. Every score is shown together with the evidence that
produced it, so the result can be inspected and reproduced.

The same assessment is available through three interfaces:

- a web UI
- a REST API
- an MCP server

## Contract assessment with Muse

An optional add-on, "Contract assessment with Muse", provides a
plain-language explanation layer on top of the assessment. It is
offered separately from the score and never affects the score or
the evidence.

## Calibration and limits

The default risk artifact is 1.0.1. On the held-out test set it scores bad-AUC 0.556 (95 percent interval 0.49-0.62; rug-pull 0.50, honeypot 0.68) with holdout bad-AUC 0.59, so discrimination is near chance and every test and holdout score falls in 19-30 (Low under the applied 30/60 bands). Low from 1.0.1 must not be read as safe. On-chain signals ship at weight 0 under the default artifact and never change the score. See [docs/calibration/](docs/calibration/) for the full reports.

## Status

Work in progress during the hackathon. Interfaces and behaviour may
change as the project is built and evaluated.

## Documentation

- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [Infrastructure](docs/infrastructure.md)
- [Threat model](docs/threat-model.md)

## License

Licensed under Apache-2.0. See LICENSE and NOTICE.
