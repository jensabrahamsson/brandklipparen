# Brandklipparen

**Scan before you swap.** A deterministic risk scanner for ERC-20 tokens
on Ethereum mainnet: paste a token address and see what the contract's
owner can do to you, proven from the bytecode.

Live demo: https://jensmannen--brandklipparen.us-east.modal.run. Judges: the access code and API key are in the submission form.

*The name: Brandklipparen was the royal horse of Sweden's Charles XI and
XII, a horse that never flinched at fire. The tool does the same: it
stays calm and reads the contract while the market is on fire.*

How it was built: one person, a team of agents — see [docs/HOW-IT-WAS-BUILT.md](docs/HOW-IT-WAS-BUILT.md).

Demo video: https://youtu.be/_Uml8aa4kKc

Meta Global AI Developer Hackathon entry · Indie Developer track ·
"Build for Your World".

## What it does

- **Reads the contract, not the hype.** For a new token (a memecoin
  launched ten minutes ago, say) it lists the owner powers written into
  the code: pause transfers, mint, blacklist wallets, change the transfer
  fee, cap wallets, block sells, upgrade the code.
- **Its own EVM decompiler.** Written in this project and run
  in-process (no external binary): disassembly, control-flow graph, a
  symbolic pass over storage slots and caller guards, then readable
  pseudo-Solidity. Verified source is shown beside it when published.
- **Proof, not a verdict.** Every finding is pinned to the function,
  selector and byte offset. Pause, blacklist, transfer fee, transfer
  limits and mint also get a step-by-step proof trace that shows each
  check and where a failed proof stopped.
- **Meta Muse explains, never decides.** Optional Explain, Ask, Explain
  this code and Investigate run on the Meta Model API (Muse,
  `muse-spark-1.3`). Every claim must cite evidence the analysis
  collected, or it is dropped. Model output never changes the score or
  the evidence.
- **For people and for agents.** The web UI, the versioned REST API
  (`/v1`) and the MCP server over stdio return the same deterministic
  result: same bytecode, same pinned block, same answer.
- **Honest about what it can't see.** A check that cannot finish reads
  "Can't tell", never "safe". The model score is weak and labelled
  so (see [Calibration and limits](#calibration-and-limits)). Bytecode
  says nothing about liquidity locks, insider holdings or the team.

## What it is

Brandklipparen assesses the rug-pull risk of ERC-20 tokens from
contract bytecode, paired with point-in-time on-chain context. The
proofs are derived deterministically from bytecode. The score is a
calibrated model score plus an evidence floor. The scanner reads the
owner live, and the floor can raise the score. Other on-chain context
and verified source are shown beside them and never change the score.
Every score is shown together with the evidence that produced it, so
the result can be inspected and reproduced.

- **Deterministic core.** Pure TypeScript with no I/O. Runtime
  bytecode is read with `eth_getCode` at a pinned block, and proxies are
  followed to their implementation.
- **Plugins.** Thirteen detector plugins are statically registered:
  nine owner-power detectors (mint, pause, blacklist, transfer fee,
  transfer limits, sell block, transfer hooks, ownership, proxy upgrade)
  and four analysis plugins (capability, decompiler, clone match, hard
  to analyze). The on-chain plugins (age, concentration, deployer,
  liquidity, LP, owner) are shown for context and carry weight 0 in the
  model score. The owner state the scanner reads live also feeds the
  evidence floor. One assessment plugin, `meta-model-api`, provides the
  "Contract assessment with Muse".
- **Score.** A frozen, checksummed model artifact (1.0.1) maps findings
  to a calibrated 0-100 score. A deterministic evidence floor is then
  applied. It can raise the score and never lowers it (see
  [Calibration and limits](#calibration-and-limits)).
- **Muse layer (optional).** Explain, Ask, Explain this code,
  Investigate, the contract assessment and personalization all run on
  the Meta Model API. They read the frozen result only, are offered
  separately from the score, and are labelled with their model id.
  Without a key each one reports `not-configured` and the rest of the
  product works unchanged.
- **Three interfaces.** A web UI, a REST API and an MCP server, all
  over the same services.

All code was written during the hackathon window (from Oct 26, 13:00 ET).
Planning notes and design sketches were drafted before kickoff.

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

Clone the repo and enter it:

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

## API

Every versioned route takes the API key solely in the `x-api-key`
header, never in the URL or body. `GET /health` is public and keyless.
`GET` routes read parameters from the query string; `POST` routes take
the same fields as a JSON body. Model-assisted overlays (`assessment`,
`explain`, `explain-code`, `chat`, `rug`) run solely on request and
never change the score or the evidence.

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness plus per-feature availability and cost units. |
| `GET /ready` | Deploy readiness: artifact checksum and feed wiring. |
| `GET,POST /v1/analyze` | Deterministic risk assessment with evidence. |
| `GET /v1/analyze/stream` | Same assessment as one server-sent event body. |
| `GET,POST /v1/assessment` | Opt-in Muse contract assessment beside the score. |
| `GET,POST /v1/investigate` | Opt-in investigation loop with a cited narrative. |
| `GET /v1/investigate/events` | Step events for one investigation. |
| `GET,POST /v1/explain` | Sentence-level explanation with citations. |
| `POST /v1/explain-code` | Per-function code explanation (decompiled or source). |
| `GET,POST /v1/chat` | Follow-up questions over the frozen analysis. |
| `GET,POST /v1/rug` | Top-risk capability summary. |
| `POST /v1/naming` | Suggested display names for selectors. |
| `GET /v1/personalize/status`, `POST /v1/personalize` | Experimental layout mapping for visitor priorities. |
| `GET,POST /v1/snippet` | Decompiled source block for one selector. |
| `GET /v1/proof` | Per-detector proof steps with code locations. |
| `GET /v1/source` | Verified contract sources and located functions. |
| `GET /v1/onchain-features` | Point-in-time on-chain features, display only. |
| `GET /v1/plugins`, `GET /v1/plugins/:id[/docs,/audit]` | Detector registry, docs and stored audit reports. |
| `GET /v1/calibration` | Frozen calibration snapshot. |
| `GET /v1/live-tokens` | Newest on-chain pairs first. |
| `GET /v1/market-new?chain=ethereum` | Market listing promotions. |

Analyze example (see above for `KEY`); explain-code example:

```sh
curl -X POST -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"address":"0x0102030405060708090a0b0c0d0e0f1011121314","selector":"0xa9059cbb","view":"decompiled"}' \
  "http://127.0.0.1:8080/v1/explain-code"
```

Replace the synthetic address with any ERC-20 contract address on Ethereum mainnet.

## MCP

```sh
npm --silent run start:mcp
```

The MCP server speaks minimal JSON-RPC 2.0 over stdio
(newline-delimited frames on stdin, one response frame per line on
stdout). Point an MCP client at the command above as a stdio server; no
port is opened. List tools first (`tools/list`), then call one per
frame (`tools/call` with `name` and `arguments`).

The deployed demo also serves this MCP server over HTTPS at `POST /mcp`
on the demo origin (`https://jensmannen--brandklipparen.us-east.modal.run/mcp`).
Send one JSON-RPC message, or a batch of up to 16, as the body, with your
key in the `x-api-key` header or as `Authorization: Bearer <key>`; without
a key the demo answers 401.

Generic MCP client configuration (copy, then replace the `<...>`
values). `npm --silent run start:mcp` applies the same safe defaults as
`npm run demo` (the demo default helpers), so only the RPC URL and the
optional key pointers below are needed; the user environment always
wins and no values are printed (applied names go to stderr only, and
stdout stays the JSON-RPC channel). The `--silent` flag keeps npm
lifecycle banners off stdout, which is the JSON-RPC channel.
`npm --silent run start:mcp` does not read
`.env.local`. Node 22 must be first on the `PATH` the client launches
`npm` with.

```json
{
  "mcpServers": {
    "brandklipparen": {
      "command": "npm",
      "args": ["--silent", "run", "start:mcp"],
      "cwd": "<path to repo>",
      "env": {
        "BRANDKLIPPAREN_RPC_URLS": "https://ethereum-rpc.publicnode.com",
        "BRANDKLIPPAREN_API_KEYS_FILE": "<path to a file with your keys>",
        "BRANDKLIPPAREN_MCP_API_KEY_FILE": "<path to a file with one of those keys>"
      }
    }
  }
}
```

Both key pointers are optional: drop them to run without the key gate.
The server checks at startup that the RPC endpoint answers Ethereum
mainnet. The `initialize` handshake accepts the client's MCP protocol
version when supported (`2025-06-18`, `2025-03-26` or `2024-11-05`);
otherwise it answers with the server's latest supported version
(`2025-06-18`) instead of failing. The Muse tools stay
`not-configured` until their `BRANDKLIPPAREN_*_PROVIDER` and
`*_META_*` variables are added to `env` (names in `.env.example`;
keys only through `*_FILE` pointers).

In stdio mode the user's own client launches the server process, so a
standard client needs no project-specific frame field: when
`BRANDKLIPPAREN_API_KEYS` (or its `*_FILE` pointer) is set, point
`BRANDKLIPPAREN_MCP_API_KEY_FILE` at a file holding one accepted key
(the same `*_FILE` rules as the other keys: set only one of
`BRANDKLIPPAREN_MCP_API_KEY` and its pointer; an unreadable or
oversized file is a startup error). A `tools/call` frame without a
top-level `auth` field then uses that env key, with the same per-key
rate and quota caps as any other key. A frame `auth` field, when a
client does send one, still wins over the env key. With neither
`BRANDKLIPPAREN_API_KEYS` nor its `*_FILE` pointer set, the MCP server
runs without the key gate.

A frame `auth` value can still be sent as an override, but MCP hosts
may log JSON-RPC frames, so a logged frame can expose that key: use a
host that does not persist frames (or that redacts the `auth` field),
and rotate the key if frames were logged. Prefer the
`BRANDKLIPPAREN_MCP_API_KEY_FILE` pointer for standard clients, and
never put a key value in a client configuration file that is checked
in or shared.

Reading tools, one per REST feature, all read-only through the same
services, guards, per-key caps and caches as the REST routes. The
server registers 26 tools: the 13 named below plus one `plugin_*` tool
for each of the 13 detector plugins:

- `assess_token`, `request_assessment`, `investigate_token`,
  `onchain_features`
- `explain_token`, `explain_function`, `get_decompiled_function`,
  `get_proof_trace`, `get_verified_source`, `list_new_tokens`
- `list_plugins`, `get_plugin_docs`, `get_plugin_audit`, plus one
  `plugin_*` tool per registered detector

Example call (one frame on stdin, no `auth` field needed when
`BRANDKLIPPAREN_MCP_API_KEY_FILE` is set):

```json
{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
 "params": {"name": "explain_token",
 "arguments": {"address": "0x0102030405060708090a0b0c0d0e0f1011121314"}}}
```

The response carries one text content block with the same body the
matching REST route returns; replace the synthetic address with any
ERC-20 contract address on Ethereum mainnet.

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

## Calibration and limits

The score is a calibrated model score plus an evidence floor. The model (artifact 1.0.1) is weak: bad-AUC about 0.56, near chance. The floor is applied after the model and never lowers a score:

- Owner not renounced, and a proven power to stop holders selling or moving tokens (blacklist, pause, sell block): at least 60 (High).
- Owner not renounced, and a proven risky capability (owner mint, owner-settable fee or limits, owner-controlled upgradeable proxy): at least 30 (Elevated).
- Owner renounced: no floor.

The result records which rule applied (`scoreFloor`) and the owner state (`ownerState`). REST, MCP and the UI show the same number.

On 30 unseen mainnet tokens, never used during development, the blacklist detector had 12 true positives, 3 false alarms and 1 miss. The pause detector had 9 true positives, 3 false alarms and 4 misses. Tokens with an active owner and a proven blocking power all scored High; tokens with a renounced owner scored Low.

Low does not mean safe. See [docs/calibration/](docs/calibration/) for the full reports.

## Documentation

- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [Infrastructure](docs/infrastructure.md)
- [Threat model](docs/threat-model.md)

A separate multi-agent, source-level security audit found 0 confirmed vulnerabilities. Its three open leads (demo key in web bundles, shared rate budget, one-time chain id check) were fixed and covered by tests.

## License

Licensed under Apache-2.0. See LICENSE and NOTICE.
