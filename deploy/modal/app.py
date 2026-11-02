"""Brandklipparen public demo on Modal (deploy/modal/app.py).

One container, one HTTPS origin (https://<workspace>--<label>.modal.run):

  deploy/modal/edge.mjs   0.0.0.0:8000    web UI (apps/web/dist), proxy for /v1,
                                          /health and /ready, POST /mcp bridge
  src/main.ts rest        127.0.0.1:8080  REST API, BRANDKLIPPAREN_ENV=demo
  src/main.ts mcp         stdio child of the edge (its own, lower daily caps)

The image is built from the PUBLIC repository at one exact commit, so the demo
runs exactly the published code. Nothing in this file is secret: keys arrive
only from the Modal secret named by BK_MODAL_SECRET, as environment variables.
BK_ACCESS_CODE (also only from that secret) gates the UI and keyless /v1
traffic at the edge; clients with their own API key bypass that page.

Deploy (owner, from any checkout; nothing local is uploaded in git mode):

  BK_PUBLIC_REPO=https://github.com/<owner>/<repo>.git \
  BK_GIT_REF=<40-hex commit of the public repo> \
  BK_MODAL_WORKSPACE=<modal workspace name> \
  modal deploy deploy/modal/app.py

Deploy-time parameters (environment of the `modal deploy` process):
  BK_GIT_REF            required, full commit id to build from
  BK_PUBLIC_REPO        required in git mode, https clone URL of the public repo
  BK_MODAL_WORKSPACE    workspace name, used to derive the public URL
  BK_PUBLIC_URL         optional override of the public https URL
  BK_SOURCE             "git" (default) or "local" (upload BK_LOCAL_DIR instead)
  BK_LOCAL_DIR          clean checkout to upload in local mode (guarded below)
  BK_NODE_IMAGE         base image, pin as node:22.x.y-bookworm-slim@sha256:...
  BK_MIN_CONTAINERS     0 = scale to zero (default), 1 = always warm
  BK_SCALEDOWN_WINDOW   idle seconds before scale-down (default 900, max 1200)
  BK_PREWARM_ADDRESSES  comma-separated token addresses analysed after start
  BK_WETH_ADDRESS       canonical WETH contract for the new-pairs feed (operator value)
  BK_MODEL_FEATURES     "on" (default) or "off": off removes every model key from the
                        processes, so all model features answer not-configured
  BK_MODAL_APP, BK_MODAL_LABEL, BK_MODAL_SECRET, BK_MODAL_VOLUME  names
"""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import modal


def _param(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


APP_NAME = _param("BK_MODAL_APP", "brandklipparen-demo")
LABEL = _param("BK_MODAL_LABEL", "brandklipparen")
SECRET_NAME = _param("BK_MODAL_SECRET", "brandklipparen-demo")
VOLUME_NAME = _param("BK_MODAL_VOLUME", "brandklipparen-demo-data")
SOURCE = _param("BK_SOURCE", "git")
PUBLIC_REPO = _param("BK_PUBLIC_REPO")
GIT_REF = _param("BK_GIT_REF")
LOCAL_DIR = _param("BK_LOCAL_DIR")
NODE_IMAGE = _param("BK_NODE_IMAGE", "node:22-bookworm-slim")
WORKSPACE = _param("BK_MODAL_WORKSPACE")
PUBLIC_URL = _param("BK_PUBLIC_URL") or (f"https://{WORKSPACE}--{LABEL}.modal.run" if WORKSPACE else "")
MIN_CONTAINERS = int(_param("BK_MIN_CONTAINERS", "0"))
SCALEDOWN_WINDOW = int(_param("BK_SCALEDOWN_WINDOW", "900"))
PREWARM = _param("BK_PREWARM_ADDRESSES")
WETH = _param("BK_WETH_ADDRESS")  # operator configuration, never hard-coded in the repo
MODEL_FEATURES = _param("BK_MODEL_FEATURES", "on")  # "off" = emergency brake for model spend

APP_DIR = "/app"
REST_PORT = 8080
EDGE_PORT = 8000

# Local mode uploads only files tracked by git in BK_LOCAL_DIR, so untracked
# local tooling, key files and .env.local can never reach the image; tracked
# files must not include private material either (checked before deploy).
FORBIDDEN_TRACKED = re.compile(
    r"^(kontext|kunskap|prompter|beslut|design|docs/decisions)(/|$)|^KONTEXT\.md$"
    r"|(^|/)\.env($|\.(?!example$))|\.(key|pem|p12)$"
)
_TRACKED: set[str] = set()
_TRACKED_DIRS: set[str] = set()


def _load_tracked(root: Path) -> None:
    listing = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], capture_output=True, check=True).stdout
    for name in listing.decode("utf-8").split("\0"):
        if name:
            _TRACKED.add(name)
            parts = name.split("/")
            for depth in range(1, len(parts)):
                _TRACKED_DIRS.add("/".join(parts[:depth]))


def _excluded(path: Path) -> bool:
    """Upload filter for local mode: True for anything git does not track."""
    relative = path
    if path.is_absolute():
        try:
            relative = path.relative_to(Path(LOCAL_DIR).resolve())
        except ValueError:
            return True
    name = relative.as_posix()
    return name not in _TRACKED and name not in _TRACKED_DIRS


# Non-secret runtime configuration for BRANDKLIPPAREN_ENV=demo. Values in the
# Modal secret (or the container environment) override these. Only variable
# names the current loader (src/adapters/config/loader.ts) reads are set.
DEMO_DEFAULTS: dict[str, str] = {
    "BRANDKLIPPAREN_ENV": "demo",
    "BRANDKLIPPAREN_HTTP_PORT": str(REST_PORT),
    "BRANDKLIPPAREN_LOG_LEVEL": "info",
    "BRANDKLIPPAREN_CHAIN_ID": "1",
    "BRANDKLIPPAREN_RPC_URLS": "https://ethereum-rpc.publicnode.com",
    "BRANDKLIPPAREN_FEED_RPC_URL": "https://ethereum-rpc.publicnode.com",
    "BRANDKLIPPAREN_MODEL_VERSION": "1.0.1",
    "BRANDKLIPPAREN_MODEL_ARTIFACT_PATH": "model/artifact-1.0.1.json",
    "BRANDKLIPPAREN_CLONE_INDEX_VERSION": "1.0.0",
    "BRANDKLIPPAREN_CACHE_DIR": "/data/cache",
    "BRANDKLIPPAREN_DEMO_PUBLIC_URL": PUBLIC_URL,
    "BK_WETH_ADDRESS": WETH,
    "BRANDKLIPPAREN_RPC_DEADLINE_MS": "15000",
    "BRANDKLIPPAREN_RPC_MAX_CONCURRENCY": "8",
    "BRANDKLIPPAREN_RPC_RETRY_BUDGET": "2",
    "BRANDKLIPPAREN_RPC_MAX_RESPONSE_BYTES": "1048576",
    # Enforced REST limits. All anonymous visitors share the web key, so the
    # per-key values are the anonymous totals; judge keys get the same each.
    "BRANDKLIPPAREN_RATE_LIMIT_PER_KEY_PER_MINUTE": "600",
    "BRANDKLIPPAREN_QUOTA_PER_KEY_PER_DAY": "40000",
    "BRANDKLIPPAREN_GLOBAL_RATE_PER_MINUTE": "1200",
    "BRANDKLIPPAREN_BUDGET_PER_KEY_DAILY_CAP_ASSESSMENT_CALLS": "200",
    "BRANDKLIPPAREN_INVESTIGATE_DAILY_CAP_PER_KEY": "30",
    "BRANDKLIPPAREN_EXPLAIN_DAILY_CAP_PER_KEY": "300",
    "BRANDKLIPPAREN_CHAT_DAILY_CAP_PER_KEY": "300",
    "BRANDKLIPPAREN_RUG_DAILY_CAP_PER_KEY": "150",
    "BRANDKLIPPAREN_EXPLAIN_CODE_DAILY_CAP_PER_KEY": "300",
    # Model features: Meta Model API with the configured model id.
    "BRANDKLIPPAREN_ASSESSMENT_PROVIDER": "meta-model-api",
    "BRANDKLIPPAREN_ASSESSMENT_PROMPT_VERSION": "1.0.0",
    "BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID": "muse-spark-1.3",
    "BRANDKLIPPAREN_ASSESSMENT_DEADLINE_MS": "60000",
    "BRANDKLIPPAREN_ASSESSMENT_MAX_INPUT_BYTES": "65536",
    "BRANDKLIPPAREN_ASSESSMENT_MAX_OUTPUT_BYTES": "65536",
    "BRANDKLIPPAREN_ASSESSMENT_MAX_CONCURRENCY": "4",
    "BRANDKLIPPAREN_INVESTIGATE_PROVIDER": "meta-model-api",
    "BRANDKLIPPAREN_INVESTIGATE_DEADLINE_MS": "120000",
    "BRANDKLIPPAREN_INVESTIGATE_MAX_STEPS": "8",
    "BRANDKLIPPAREN_INVESTIGATE_MAX_TOKENS": "64000",
    "BRANDKLIPPAREN_INVESTIGATE_TOOL_TIMEOUT_MS": "5000",
    "BRANDKLIPPAREN_INVESTIGATE_MAX_INPUT_BYTES": "65536",
    "BRANDKLIPPAREN_INVESTIGATE_MAX_OUTPUT_BYTES": "65536",
    "BRANDKLIPPAREN_INVESTIGATE_PROMPT_VERSION": "1.0.0",
    "BRANDKLIPPAREN_EXPLAIN_PROVIDER": "meta-model-api",
    "BRANDKLIPPAREN_CHAT_PROVIDER": "meta-model-api",
    "BRANDKLIPPAREN_RUG_PROVIDER": "meta-model-api",
    "BRANDKLIPPAREN_EXPLAIN_CODE_PROVIDER": "meta-model-api",
    "BRANDKLIPPAREN_PERSONALIZE_PROVIDER": "off",
    "BRANDKLIPPAREN_MARKET_PROVIDER": "dexscreener",
    "BRANDKLIPPAREN_SOURCE_PROVIDER": "sourcify",
}

# The MCP child is a separate process with its own in-memory counters, so its
# per-key caps are set lower to keep the combined daily total bounded.
MCP_CAP_OVERRIDES: dict[str, str] = {
    "BRANDKLIPPAREN_BUDGET_PER_KEY_DAILY_CAP_ASSESSMENT_CALLS": "50",
    "BRANDKLIPPAREN_INVESTIGATE_DAILY_CAP_PER_KEY": "10",
    "BRANDKLIPPAREN_EXPLAIN_DAILY_CAP_PER_KEY": "50",
    "BRANDKLIPPAREN_CHAT_DAILY_CAP_PER_KEY": "50",
    "BRANDKLIPPAREN_RUG_DAILY_CAP_PER_KEY": "50",
    "BRANDKLIPPAREN_EXPLAIN_CODE_DAILY_CAP_PER_KEY": "50",
    "BRANDKLIPPAREN_RATE_LIMIT_PER_KEY_PER_MINUTE": "60",
}

# Edge limits for anonymous browser traffic (see edge.mjs for the semantics).
EDGE_DEFAULTS: dict[str, str] = {
    "BK_EDGE_PORT": str(EDGE_PORT),
    "BK_EDGE_UPSTREAM": f"http://127.0.0.1:{REST_PORT}",
    "BK_EDGE_STATIC_DIR": f"{APP_DIR}/apps/web/dist",
    "BK_EDGE_STATE_FILE": "/data/edge-state.json",
    "BK_EDGE_RATE_PER_CLIENT_PER_MIN": "120",
    "BK_EDGE_KEYED_RATE_PER_CLIENT_PER_MIN": "240",
    "BK_EDGE_GLOBAL_ANON_PER_MIN": "900",
    "BK_EDGE_MODEL_CALLS_PER_CLIENT_PER_DAY": "25",
    "BK_EDGE_MODEL_CALLS_GLOBAL_PER_DAY": "500",
    "BK_EDGE_INVESTIGATE_PER_CLIENT_PER_DAY": "3",
    "BK_EDGE_MAX_BODY_BYTES": "65536",
    "BK_EDGE_MCP_ANON": "0",
    "BK_EDGE_MCP_CWD": APP_DIR,
    "BK_EDGE_MCP_CMD": json.dumps(["node", "--experimental-strip-types", "src/main.ts", "mcp"]),
}

META_FAN_OUT = ("INVESTIGATE", "EXPLAIN", "CHAT", "RUG", "EXPLAIN_CODE")
ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")


def build_runtime_env(container_env: dict[str, str]) -> dict[str, str]:
    """Defaults, then the container environment (Modal secret included) on top."""
    env = dict(DEMO_DEFAULTS)
    env.update(EDGE_DEFAULTS)
    env.update({k: v for k, v in container_env.items() if v != ""})
    if not env.get("BK_ACCESS_CODE", ""):
        raise RuntimeError("BK_ACCESS_CODE is missing from the Modal secret")
    web_key = env.get("BK_EDGE_WEB_API_KEY", "")
    if len(web_key) < 32:
        raise RuntimeError("BK_EDGE_WEB_API_KEY is missing or shorter than 32 characters")
    if len(env.get("BRANDKLIPPAREN_API_KEY_PEPPER", "")) < 32:
        raise RuntimeError("BRANDKLIPPAREN_API_KEY_PEPPER is missing or shorter than 32 characters")
    judges = [k.strip() for k in env.get("BK_JUDGE_API_KEYS", "").split(",") if k.strip()]
    env["BRANDKLIPPAREN_API_KEYS"] = ",".join([web_key, *judges])
    # One Meta key, model id and base URL serve every model feature, as in
    # scripts/demo.ts; an explicit per-feature value always wins. The MCP
    # child (src/main.ts mcp) receives its key per JSON-RPC frame as the
    # top-level auth field from the edge, so no MCP key file is set here.
    for feature in META_FAN_OUT:
        for suffix in ("API_KEY", "MODEL_ID", "BASE_URL"):
            source = env.get(f"BRANDKLIPPAREN_ASSESSMENT_META_{suffix}", "")
            target = f"BRANDKLIPPAREN_{feature}_META_{suffix}"
            if source and not env.get(target):
                env[target] = source
    if MODEL_FEATURES == "off":
        for name in [n for n in env if n.startswith("BRANDKLIPPAREN_") and n.endswith("_API_KEY")]:
            del env[name]
        env["BK_EDGE_MODEL_CALLS_GLOBAL_PER_DAY"] = "0"
    env["BK_EDGE_PUBLIC_ORIGIN"] = env.get("BRANDKLIPPAREN_DEMO_PUBLIC_URL", "").rstrip("/")
    env["BK_EDGE_MCP_ENV_JSON"] = json.dumps(MCP_CAP_OVERRIDES)
    env.setdefault("BK_EDGE_SALT", secrets.token_hex(16))
    env.setdefault("BK_EDGE_COOKIE_SECRET", secrets.token_hex(32))
    return env


def _log(event: str, **fields: object) -> None:
    print(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "service": "modal", "event": event, **fields}), flush=True)


def _wait_http(url: str, seconds: float, process: subprocess.Popen) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"process exited with code {process.returncode} during startup")
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.5)
    raise RuntimeError(f"{url} did not answer within {seconds} s")


def _watch(processes: dict[str, subprocess.Popen]) -> None:
    while True:
        for name, process in processes.items():
            if process.poll() is not None:
                _log("child-exited", child=name, code=process.returncode)
                os._exit(1)  # Modal replaces the container on the next request
        time.sleep(2)


def _prewarm(addresses: list[str], web_key: str) -> None:
    for address in addresses:
        request = urllib.request.Request(
            f"http://127.0.0.1:{REST_PORT}/v1/analyze?address={address}", headers={"x-api-key": web_key}
        )
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code
        except (urllib.error.URLError, OSError):
            status = 0
        _log("prewarm", address=address, status=status, ms=int((time.monotonic() - started) * 1000))
        time.sleep(1)


def start_services(container_env: dict[str, str]) -> None:
    env = build_runtime_env(container_env)
    Path("/data/cache").mkdir(parents=True, exist_ok=True)
    rest_env = {
        k: v for k, v in env.items()
        if not k.startswith("BK_EDGE_") and k not in ("BK_JUDGE_API_KEYS", "BK_ACCESS_CODE")
    }
    rest = subprocess.Popen(["node", "--experimental-strip-types", "src/main.ts", "rest"], cwd=APP_DIR, env=rest_env)
    _wait_http(f"http://127.0.0.1:{REST_PORT}/health", 120, rest)
    edge = subprocess.Popen(["node", "deploy/modal/edge.mjs"], cwd=APP_DIR, env=env)
    threading.Thread(target=_watch, args=({"rest": rest, "edge": edge},), daemon=True).start()
    commit = Path(f"{APP_DIR}/.deployed-commit")
    _log("started", commit=commit.read_text().strip() if commit.exists() else "unknown", url=env["BK_EDGE_PUBLIC_ORIGIN"])
    addresses = [a.strip() for a in PREWARM.split(",") if ADDRESS.match(a.strip())]
    if addresses:
        threading.Thread(target=_prewarm, args=(addresses, env["BK_EDGE_WEB_API_KEY"]), daemon=True).start()


def _check_deploy_parameters() -> None:
    problems = []
    if SOURCE == "git" and not re.fullmatch(r"[0-9a-f]{40}", GIT_REF):
        problems.append("BK_GIT_REF must be the full 40-hex commit id of the public repo")
    if SOURCE == "local" and GIT_REF and not re.fullmatch(r"[0-9a-f]{40}", GIT_REF):
        problems.append("BK_GIT_REF must be the full 40-hex commit id when set")
    if not PUBLIC_URL.startswith("https://"):
        problems.append("set BK_MODAL_WORKSPACE (or BK_PUBLIC_URL) so the public https URL is known")
    if MODEL_FEATURES not in ("on", "off"):
        problems.append("BK_MODEL_FEATURES must be on or off")
    if WETH and not ADDRESS.match(WETH):
        problems.append("BK_WETH_ADDRESS must be 0x followed by 40 hex characters")
    if SOURCE not in ("git", "local"):
        problems.append("BK_SOURCE must be git or local")
    if SOURCE == "git" and not PUBLIC_REPO.startswith("https://"):
        problems.append("BK_PUBLIC_REPO must be the https clone URL of the public repo")
    if SOURCE == "local":
        root = Path(LOCAL_DIR)
        if not LOCAL_DIR or not (root / ".git").exists() or not (root / "package.json").exists():
            problems.append("BK_LOCAL_DIR must be a git checkout of the public repo")
        else:
            _load_tracked(root)
            bad = sorted(name for name in _TRACKED if FORBIDDEN_TRACKED.search(name))
            if bad:
                problems.append(f"BK_LOCAL_DIR tracks files that must not ship: {bad[:10]}")
    if problems:
        raise SystemExit("deploy refused:\n  - " + "\n  - ".join(problems))


if modal.is_local():
    _check_deploy_parameters()

_BUILD = (
    "cd /app && npm ci --omit=dev --ignore-scripts --no-audit --no-fund",
    "cd /app/apps/web && npm ci --ignore-scripts --no-audit --no-fund && npm run build && rm -rf node_modules",
    "test -f /app/apps/web/dist/index.html && test -f /app/deploy/modal/edge.mjs && test -f /app/model/artifact-1.0.1.json",
)
_base = modal.Image.from_registry(NODE_IMAGE, add_python="3.12").apt_install("git", "ca-certificates")
if SOURCE == "local":
    _source = _base.add_local_dir(
        LOCAL_DIR or ".", APP_DIR, copy=True,
        ignore=_excluded,
    ).run_commands(f"echo {GIT_REF or 'local'} > /app/.deployed-commit")
else:
    _source = _base.run_commands(
        f"git clone --filter=blob:none --no-checkout {PUBLIC_REPO} /app",
        f"git -C /app checkout --detach {GIT_REF}",
        "git -C /app rev-parse HEAD > /app/.deployed-commit",
        "rm -rf /app/.git",
    )
image = (
    _source.run_commands(*_BUILD)
    .workdir(APP_DIR)
    .env({
        "BK_GIT_REF": GIT_REF, "BK_PUBLIC_REPO": PUBLIC_REPO, "BK_SOURCE": SOURCE,
        "BK_MODAL_WORKSPACE": WORKSPACE, "BK_PUBLIC_URL": PUBLIC_URL, "BK_NODE_IMAGE": NODE_IMAGE,
        "BK_MIN_CONTAINERS": str(MIN_CONTAINERS), "BK_SCALEDOWN_WINDOW": str(SCALEDOWN_WINDOW),
        "BK_PREWARM_ADDRESSES": PREWARM, "BK_WETH_ADDRESS": WETH, "BK_MODEL_FEATURES": MODEL_FEATURES,
        "BK_MODAL_APP": APP_NAME, "BK_MODAL_LABEL": LABEL,
        "BK_MODAL_SECRET": SECRET_NAME, "BK_MODAL_VOLUME": VOLUME_NAME,
    })
)

app = modal.App(APP_NAME)
data = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)


@app.function(
    image=image,
    secrets=[modal.Secret.from_name(SECRET_NAME)],
    volumes={"/data": data},
    cpu=1.0,
    memory=2048,
    min_containers=MIN_CONTAINERS,
    max_containers=1,
    scaledown_window=SCALEDOWN_WINDOW,
    timeout=600,
)
@modal.concurrent(max_inputs=64)
@modal.web_server(EDGE_PORT, startup_timeout=180, label=LABEL)
def web() -> None:
    start_services(dict(os.environ))
