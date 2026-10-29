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
extdecomp_BIN="$HOME/.bifrost/bin/extdecomp" npm run demo
```

The default RPC is the key-free `https://ethereum-rpc.publicnode.com`.
Key-free alternatives include `https://eth.drpc.org`,
`https://gateway.tenderly.co/public/mainnet` and
`https://rpc.mevblocker.io`. extdecomp discovery order is `extdecomp_BIN`,
then `extdecomp` on `PATH`, then `$HOME/.bifrost/bin/extdecomp`; when none
is found the decompiler stays unset and reports that it cannot tell.

While the demo runs, the start page also shows a live list of new
tokens: the backend watches Uniswap V2/V3 pair creations on mainnet
(Etherscan logs first, the RPC log adapter as fallback, WETH from
`BK_WETH_ADDRESS`), lists the newest first with age, pair, initial WETH
liquidity and the deterministic risk result, and refreshes every ~10 s.
Set `ETHERSCAN_API_KEY` (or `ETHERSCAN_API_KEY_FILE`) to turn it on;
without any feed source the list reports `not-configured` instead.

Optional local overrides live in a git-ignored `.env.local` file in the
repo root (simple `KEY=VALUE` lines, `#` comments, optional quotes). The
demo reads it for variables not already set in the environment, so the
environment wins over `.env.local`, which wins over the demo defaults.
To try the model-assisted assessment against a temporary local
chat-completions endpoint during development, set
`BRANDKLIPPAREN_ASSESSMENT_PROVIDER=generic-compatible` together with
`BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_BASE_URL` (the API root,
for example ending in `/v1`; the adapter appends `/chat/completions`),
`BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MODEL_ID` and
`BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY`; the key may
instead be pointed to with
`BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY_FILE` (an absolute
path, or one relative to the repo root). Without `.env.local` the
assessment stays off, exactly as before. Two optional variables tune the
vendor-neutral request: `BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_TEMPERATURE`
(a number in [0, 1]; when unset the request sends no sampling parameter
at all, neither temperature nor top_p) and
`BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MAX_TOKENS` (a bounded
integer, default 4096 so a thinking model is not cut off). Any secret also loads from a
`<NAME>_FILE` pointer the same way, including `ETHERSCAN_API_KEY_FILE`
for the optional LP feed (`lp feed: etherscan (key loaded)` when set,
`lp feed: off` otherwise). The demo also points
`BRANDKLIPPAREN_FEED_RPC_URL` at the same key-free public RPC, so the live
list falls back to RPC logs when the log source is rate limited or unset.

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
