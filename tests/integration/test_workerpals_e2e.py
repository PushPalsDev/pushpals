#!/usr/bin/env python3
"""PushPals end-to-end smoke test: start stack, run warmup + real LLM request.

Phase A: warmup.execute (fast, proves WorkerPals can claim + complete jobs)
Phase B: /requests/enqueue -> RemoteBuddy claims -> /jobs/enqueue -> WorkerPals executes (LLM) ->
         /jobs/:id/complete -> completion enqueue observed and asserted.

Run from repo root. Requires bun, git, node on PATH.
Optional: If LM Studio is running and `lms` CLI is on PATH, captures LM Studio logs.

This script is careful to:
- Keep isolation by default: fail fast if a server is already running at SERVER_URL.
- Kill processes it started on Ctrl+C / SIGTERM / normal exit (best-effort).

NOTE: This version prints EVERYTHING to stdout/stderr (no per-process log files).
"""

from __future__ import annotations

import atexit
import ctypes
import hashlib
import importlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[2]


def _env_flag(name: str, default: str = "0") -> bool:
    raw = (os.environ.get(name, default) or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except Exception:
        return default


def _env_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(float(raw))
    except Exception:
        return default


def _canonicalize_server_url(raw_url: str) -> str:
    source = (raw_url or "").strip() or "http://127.0.0.1:3001"
    try:
        parsed = urlparse(source)
        host = (parsed.hostname or "").strip().lower()
        if host not in {"localhost", "::1"}:
            return source
        auth = ""
        if parsed.username:
            auth = parsed.username
            if parsed.password:
                auth += f":{parsed.password}"
            auth += "@"
        netloc = f"{auth}127.0.0.1"
        if parsed.port:
            netloc += f":{parsed.port}"
        return parsed._replace(netloc=netloc).geturl()
    except Exception:
        return source


SERVER_URL = _canonicalize_server_url(os.environ.get("PUSHPALS_SERVER_URL", "http://127.0.0.1:3001"))
STREAM_LLM_SERVER_LOGS = (
    os.environ.get("WORKERPALS_E2E_STREAM_LLM_LOGS", "0").strip().lower()
    in {"1", "true", "yes", "on"}
)
E2E_EVAL_MODE = _env_flag("WORKERPALS_E2E_EVAL", "0")
SERVER_HEALTH_TIMEOUT_SEC = 60
WARMUP_TIMEOUT_SEC = 60
REQUEST_TIMEOUT_SEC = _env_int(
    "WORKERPALS_E2E_REQUEST_TIMEOUT_SEC",
    12 * 60 if E2E_EVAL_MODE else 10 * 60,
)
POLL_INTERVAL_SEC = 0.5
HTTP_TIMEOUT_SEC = 15
E2E_EVAL_TOTAL_BUDGET_SEC = _env_float(
    "WORKERPALS_E2E_MAX_TOTAL_SEC",
    15 * 60 if E2E_EVAL_MODE else 0.0,
)
E2E_EVAL_BACKEND_BUDGET_SEC = _env_float(
    "WORKERPALS_E2E_MAX_BACKEND_SEC",
    20 * 60 if E2E_EVAL_MODE else 0.0,
)
E2E_EVAL_OUTPUT = (os.environ.get("WORKERPALS_E2E_EVAL_OUTPUT") or "").strip()
if E2E_EVAL_MODE and not E2E_EVAL_OUTPUT:
    E2E_EVAL_OUTPUT = str(REPO_ROOT / "outputs" / "workerpals_backend_eval.json")
LIST_SCAN_LIMIT = max(
    200,
    int((os.environ.get("WORKERPALS_E2E_LIST_SCAN_LIMIT") or "1000").strip() or "1000"),
)
E2E_DEBUG = (
    os.environ.get("WORKERPALS_E2E_DEBUG", "0").strip().lower()
    in {"1", "true", "yes", "on"}
)

REQUEST_PROMPT = os.environ.get(
    "WORKERPALS_E2E_PROMPT",
    "Append exactly one line 'WorkerPals E2E marker' to README.md and keep all other content unchanged.",
)
CLARIFICATION_RETRY_SUFFIX = (
    "\n\nClarification: apply the requested change to README.md in the repository root. "
    "Do not ask any other follow-up questions."
)
E2E_EVAL_SCENARIO_SUITE = (os.environ.get("WORKERPALS_E2E_EVAL_SCENARIO_SUITE") or "real-lite").strip().lower()
E2E_EVAL_SCENARIOS_FILE = (os.environ.get("WORKERPALS_E2E_SCENARIOS_FILE") or "").strip()
E2E_EVAL_SCENARIOS_PER_BACKEND = max(
    1,
    _env_int("WORKERPALS_E2E_SCENARIOS_PER_BACKEND", 1),
)
E2E_EVAL_SCENARIO_STRATEGY = (
    (os.environ.get("WORKERPALS_E2E_SCENARIO_STRATEGY") or "same").strip().lower()
)

DEFAULT_SESSION_ID = os.environ.get("PUSHPALS_SESSION_ID", "dev")
FAIL_IF_SERVER_RUNNING = (
    os.environ.get("WORKERPALS_E2E_FAIL_IF_SERVER_RUNNING", "1").strip().lower()
    in {"1", "true", "yes", "on"}
)
KILL_SERVER_IF_RUNNING = (
    os.environ.get("WORKERPALS_E2E_KILL_SERVER_IF_RUNNING", "1").strip().lower()
    in {"1", "true", "yes", "on"}
)
_single_worker_env = (os.environ.get("WORKERPALS_E2E_ENFORCE_SINGLE_WORKER") or "").strip().lower()
ENFORCE_SINGLE_WORKER = (
    _single_worker_env in {"1", "true", "yes", "on"}
    if _single_worker_env
    else KILL_SERVER_IF_RUNNING
)
_completion_poll_env = (os.environ.get("WORKERPALS_E2E_COMPLETION_POLL_SEC") or "").strip()
try:
    COMPLETION_POLL_INTERVAL_SEC = (
        max(0.25, float(_completion_poll_env)) if _completion_poll_env else 1.5
    )
except Exception:
    COMPLETION_POLL_INTERVAL_SEC = 1.5
_requested_backends_env = (os.environ.get("WORKERPALS_E2E_BACKENDS") or "").strip()
REQUESTED_BACKENDS = [
    item.strip().lower()
    for item in _requested_backends_env.split(",")
    if item.strip()
]
E2E_REMOTEBUDDY_FETCH_FAILURE_LOGS = (
    os.environ.get("WORKERPALS_E2E_REMOTEBUDDY_FETCH_FAILURE_LOGS", "0").strip() or "0"
)
E2E_WORKERPALS_DEBUG = (
    os.environ.get("WORKERPALS_E2E_WORKERPALS_DEBUG", "1").strip() or "0"
)

# Safe default for helper calls that may run before module-level env initialization.
DEFAULT_ENV = os.environ.copy()

# Globals used by cleanup handlers
server_proc = None
worker_proc = None
remotebuddy_proc = None
started_server = False
started_worker = False
started_remotebuddy = False
_CLEANED_UP = False
_INTERRUPTED = False

_WIN_JOB_OBJECT_HANDLE: int | None = None
_WIN_JOB_OBJECT_INIT_ATTEMPTED = False


def _now() -> float:
    return time.perf_counter()


def _mono_now() -> float:
    return time.monotonic()


_MONO_TO_EPOCH_OFFSET_SEC = time.time() - time.monotonic()


def _mono_to_epoch_seconds(mono_seconds: float) -> float:
    return float(mono_seconds) + _MONO_TO_EPOCH_OFFSET_SEC


def _debug(message: str) -> None:
    if E2E_DEBUG:
        print(f"[DEBUG] {message}")


def _one_line(value: object, max_chars: int = 300) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "..."


def _print_duration(label: str, started_at: float) -> None:
    print(f"[TIMER] {label}: {_fmt_elapsed(_now() - started_at)}")


def _fmt_elapsed(seconds: float) -> str:
    total = max(0, int(seconds))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h}h {m}min {s}s"
    if m > 0:
        return f"{m}min {s}s"
    return f"{s}s"


class _ElapsedTicker:
    def __init__(self, label: str, started_at: float):
        self.label = label
        self.started_at = started_at
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        def _run() -> None:
            while not self._stop.wait(1.0):
                elapsed = _fmt_elapsed(_now() - self.started_at)
                sys.stdout.write(f"\r[TIMER] {self.label}: {elapsed}")
                sys.stdout.flush()

        self._thread = threading.Thread(target=_run, name="e2e-elapsed-ticker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=0.5)
        elapsed = _fmt_elapsed(_now() - self.started_at)
        # Pad to clear remnants from longer previous values.
        sys.stdout.write(f"\r[TIMER] {self.label}: {elapsed}                     \n")
        sys.stdout.flush()


def _is_truthy(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _detect_available_backends() -> list[str]:
    available: list[str] = []
    try:
        importlib.import_module("openhands")
        available.append("openhands")
    except Exception:
        pass
    try:
        importlib.import_module("minisweagent")
        available.append("miniswe")
    except Exception:
        pass
    return available


def _require_docker_available() -> None:
    try:
        proc = subprocess.run(
            ["docker", "info"],
            env=_build_env(),
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
    except Exception as exc:
        raise RuntimeError(f"Docker CLI is required for docker E2E mode: {exc}") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"Docker daemon is unavailable for docker E2E mode: {detail}")


def _server_port() -> int:
    try:
        parsed = urlparse(SERVER_URL)
        if parsed.port:
            return int(parsed.port)
        if parsed.scheme == "https":
            return 443
        return 80
    except Exception:
        return 3001


def _windows_powershell_exe() -> str:
    for exe_name in ("powershell.exe", "powershell", "pwsh.exe", "pwsh"):
        resolved = shutil.which(exe_name)
        if resolved:
            return resolved
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    fallback = Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    if fallback.exists():
        return str(fallback)
    raise FileNotFoundError("Unable to locate PowerShell executable on PATH or in SystemRoot")


def _run_windows_powershell(command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [_windows_powershell_exe(), "-NoProfile", "-Command", command],
        env=_build_env(),
        check=False,
        capture_output=True,
        text=True,
    )


def _kill_existing_server_processes() -> None:
    port = _server_port()
    if sys.platform == "win32":
        port_kill_cmd = (
            f"$port = {port}; "
            "$pids = @(); "
            "try { "
            "  $pids += (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | "
            "    Select-Object -ExpandProperty OwningProcess) "
            "} catch {} "
            "$pids = $pids | Where-Object { $_ -and $_ -gt 0 } | Sort-Object -Unique; "
            "foreach ($pid in $pids) { "
            "  Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue "
            "} "
            '$pids -join "," '
        )
        port_kill = _run_windows_powershell(port_kill_cmd)
        _debug(
            "server preflight port kill "
            f"rc={port_kill.returncode} pids={_one_line(port_kill.stdout, 200)} "
            f"err={_one_line(port_kill.stderr, 200)}"
        )
        fallback_cmd = (
            "Get-CimInstance Win32_Process | "
            "Where-Object { "
            "  ($_.Name -ieq 'bun.exe' -or $_.Name -ieq 'node.exe') -and "
            "  ($_.CommandLine -match 'apps[\\\\/]server' -or "
            "   $_.CommandLine -match 'server:only' -or "
            "   $_.CommandLine -match 'server_main\\.ts') "
            "} | "
            "ForEach-Object { $_.ProcessId; Stop-Process -Id $_.ProcessId -Force }"
        )
        fallback_kill = _run_windows_powershell(fallback_cmd)
        _debug(
            "server fallback kill "
            f"rc={fallback_kill.returncode} pids={_one_line(fallback_kill.stdout, 200)} "
            f"err={_one_line(fallback_kill.stderr, 200)}"
        )
    else:
        pk = subprocess.run(
            # Broad process-name fallback is intentionally last-resort for leaked local daemons.
            ["pkill", "-f", "apps/server|server:only|server_main.ts"],
            env=_build_env(),
            check=False,
            capture_output=True,
            text=True,
        )
        _debug(
            f"server pkill rc={pk.returncode} out={_one_line(pk.stdout, 200)} "
            f"err={_one_line(pk.stderr, 200)}"
        )


def _list_server_listener_pids() -> list[str]:
    port = _server_port()
    if sys.platform == "win32":
        cmd = (
            f"$port = {port}; "
            "$pids = @(); "
            "try { "
            "  $pids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | "
            "    Select-Object -ExpandProperty OwningProcess "
            "} catch {} "
            "$pids = $pids | Where-Object { $_ -and $_ -gt 0 } | Sort-Object -Unique; "
            "$pids -join ','"
        )
        out = _run_windows_powershell(cmd)
        raw = (out.stdout or "").strip()
        if not raw:
            return []
        return [part.strip() for part in raw.split(",") if part.strip()]

    # Non-Windows fallback order: lsof -> ss -> netstat. Minimal environments may miss one or more.
    try:
        out = subprocess.run(
            ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
            env=_build_env(),
            check=False,
            capture_output=True,
            text=True,
        )
        lines = [line.strip() for line in (out.stdout or "").splitlines() if line.strip()]
        if lines:
            return lines
    except Exception:
        pass

    try:
        out = subprocess.run(
            ["ss", "-lptn"],
            env=_build_env(),
            check=False,
            capture_output=True,
            text=True,
        )
        pids = set()
        for line in (out.stdout or "").splitlines():
            if "LISTEN" not in line.upper():
                continue
            if not re.search(rf":{port}\b", line):
                continue
            for pid in re.findall(r"pid=(\d+)", line):
                if pid:
                    pids.add(pid.strip())
        if pids:
            return sorted(pids)
    except Exception:
        pass

    for netstat_cmd in (["netstat", "-lntp"], ["netstat", "-anp", "tcp"]):
        try:
            out = subprocess.run(
                netstat_cmd,
                env=_build_env(),
                check=False,
                capture_output=True,
                text=True,
            )
            pids = set()
            for line in (out.stdout or "").splitlines():
                upper = line.upper()
                if "LISTEN" not in upper and "LISTENING" not in upper:
                    continue
                if not re.search(rf":{port}\b", line):
                    continue
                for pid in re.findall(r"\b(\d+)/", line):
                    if pid:
                        pids.add(pid.strip())
            if pids:
                return sorted(pids)
        except Exception:
            pass

    _debug("listener PID probe unavailable or returned no results (lsof/ss/netstat).")
    return []


def _kill_existing_sidecar_processes() -> None:
    """Best-effort cleanup of leftover daemon processes from prior E2E runs."""
    if sys.platform == "win32":
        cmd = (
            "Get-CimInstance Win32_Process | "
            "Where-Object { "
            "  ($_.Name -ieq 'bun.exe' -or $_.Name -ieq 'node.exe') -and "
            "  ($_.CommandLine -match 'apps[\\\\/]remotebuddy' -or "
            "   $_.CommandLine -match 'apps[\\\\/]workerpals' -or "
            "   $_.CommandLine -match 'apps[\\\\/]source_control_manager' -or "
            "   $_.CommandLine -match 'remotebuddy:only' -or "
            "   $_.CommandLine -match 'workerpals:only' -or "
            "   $_.CommandLine -match 'source_control_manager:only') "
            "} | "
            "ForEach-Object { $_.ProcessId; Stop-Process -Id $_.ProcessId -Force }"
        )
        killed = _run_windows_powershell(cmd)
        _debug(
            "sidecar kill "
            f"rc={killed.returncode} pids={_one_line(killed.stdout, 200)} "
            f"err={_one_line(killed.stderr, 200)}"
        )
    else:
        pk = subprocess.run(
            # Broad process-name fallback is intentionally last-resort for leaked local daemons.
            ["pkill", "-f", "apps/remotebuddy|apps/workerpals|apps/source_control_manager|remotebuddy:only|workerpals:only|source_control_manager:only"],
            env=_build_env(),
            check=False,
            capture_output=True,
            text=True,
        )
        _debug(
            f"sidecar pkill rc={pk.returncode} out={_one_line(pk.stdout, 200)} "
            f"err={_one_line(pk.stderr, 200)}"
        )


def _create_isolated_worker_repo(source_repo: Path) -> tuple[Path, Path]:
    """Create an isolated git clone for WorkerPals so E2E edits never touch the source workspace."""
    temp_root = Path(tempfile.mkdtemp(prefix="pushpals-e2e-worker-repo-"))
    clone_path = temp_root / "repo"
    proc = subprocess.run(
        ["git", "clone", "--local", "--quiet", "--no-hardlinks", str(source_repo), str(clone_path)],
        cwd=str(source_repo),
        env=_build_env(),
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        shutil.rmtree(temp_root, ignore_errors=True)
        raise RuntimeError(f"Failed to create isolated worker repo clone: {detail}")
    return clone_path, temp_root


def _request_server_shutdown(timeout_sec: float = 8.0) -> bool:
    try:
        http_post("/admin/shutdown", {"reason": "workerpals e2e preflight reset"})
    except Exception as exc:
        print(f"[NOTICE] Graceful shutdown request failed: {exc}")
        return False
    return wait_for_server_down(timeout_sec)


def _docker_image_exists(image: str) -> bool:
    try:
        proc = subprocess.run(
            ["docker", "image", "inspect", image],
            env=_build_env(),
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
        )
        return proc.returncode == 0
    except Exception:
        return False


_DOCKER_IMAGE_MAIN_SHA_LABEL = "pushpals.main_sha"
_DOCKER_IMAGE_TREE_STATE_LABEL = "pushpals.tree_state"


def _git_workspace_commit_sha() -> str:
    # Prefer the currently checked out commit so image freshness tracks the active branch/worktree.
    refs_to_try = ("HEAD", "refs/heads/main", "refs/remotes/origin/main")
    for ref in refs_to_try:
        try:
            proc = subprocess.run(
                ["git", "rev-parse", "--verify", ref],
                cwd=str(REPO_ROOT),
                env=_build_env(),
                capture_output=True,
                text=True,
                check=False,
                timeout=10,
            )
        except Exception:
            continue
        if proc.returncode == 0:
            sha = (proc.stdout or "").strip()
            if sha:
                return sha
    raise RuntimeError("Unable to resolve git commit for HEAD/main when preparing Docker image.")


def _git_tree_state_token() -> str:
    """Fingerprint relevant local workspace changes so Docker image freshness tracks local edits."""
    paths = [
        "apps/workerpals",
        "apps/remotebuddy",
        "apps/server",
        "packages/shared",
        "packages/protocol",
        "tests/integration",
        "package.json",
    ]
    try:
        proc = subprocess.run(
            ["git", "status", "--porcelain", "--", *paths],
            cwd=str(REPO_ROOT),
            env=_build_env(),
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
    except Exception:
        return "unknown"
    if proc.returncode != 0:
        return "unknown"
    payload = (proc.stdout or "").strip()
    if not payload:
        return "clean"
    digest = hashlib.sha1(payload.encode("utf-8", errors="replace")).hexdigest()[:12]
    return f"dirty-{digest}"


def _docker_image_label(image: str, label: str) -> str | None:
    try:
        proc = subprocess.run(
            [
                "docker",
                "image",
                "inspect",
                "--format",
                f"{{{{ index .Config.Labels \"{label}\" }}}}",
                image,
            ],
            env=_build_env(),
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    value = (proc.stdout or "").strip()
    if not value or value == "<no value>":
        return None
    return value


def _ensure_docker_image(image: str) -> None:
    expected_main_sha = _git_workspace_commit_sha()
    expected_tree_state = _git_tree_state_token()
    image_exists = _docker_image_exists(image)
    current_label_sha = _docker_image_label(image, _DOCKER_IMAGE_MAIN_SHA_LABEL) if image_exists else None
    current_tree_state = _docker_image_label(image, _DOCKER_IMAGE_TREE_STATE_LABEL) if image_exists else None
    if (
        image_exists
        and current_label_sha == expected_main_sha
        and current_tree_state == expected_tree_state
    ):
        suffix = f" ({expected_tree_state})" if expected_tree_state != "clean" else ""
        print(
            f"[NOTICE] Docker image already present and current for HEAD@{expected_main_sha[:12]}{suffix}: {image}"
        )
        return
    if image_exists:
        if current_label_sha or current_tree_state:
            print(
                "[NOTICE] Docker image exists but is stale for workspace state; rebuilding.\n"
                f"  image={image}\n"
                f"  image_main_sha={(current_label_sha or '<none>')[:12]}\n"
                f"  expected_main_sha={expected_main_sha[:12]}\n"
                f"  image_tree_state={current_tree_state or '<none>'}\n"
                f"  expected_tree_state={expected_tree_state}"
            )
        else:
            print(
                "[NOTICE] Docker image exists without freshness labels; rebuilding.\n"
                f"  image={image}\n"
                f"  expected_main_sha={expected_main_sha[:12]}\n"
                f"  expected_tree_state={expected_tree_state}"
            )
    else:
        print(f"[NOTICE] Docker image not found locally; building: {image}")
    proc = subprocess.run(
        [
            "docker",
            "build",
            "-f",
            "apps/workerpals/Dockerfile.sandbox",
            "-t",
            image,
            "--label",
            f"{_DOCKER_IMAGE_MAIN_SHA_LABEL}={expected_main_sha}",
            "--label",
            f"{_DOCKER_IMAGE_TREE_STATE_LABEL}={expected_tree_state}",
            ".",
        ],
        cwd=str(REPO_ROOT),
        env=_build_env(),
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"Failed to build docker image {image}. "
            "Check Docker Hub/network access for base layers and retry."
        )


# -----------------------------
# Env loading helpers
# -----------------------------
def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip()
            if len(val) >= 2 and ((val[0] == val[-1] == '"') or (val[0] == val[-1] == "'")):
                val = val[1:-1]
            os.environ.setdefault(key, val)
    except Exception:
        pass


def _ensure_env_from_example(repo_root: Path) -> None:
    env_path = repo_root / ".env"
    example = repo_root / ".env.example"
    try:
        if not env_path.exists() and example.exists():
            env_path.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
            print(
                f"[NOTICE] Created {env_path} from .env.example. "
                f"Please set WORKERPALS_LLM_API_KEY in {env_path} if needed."
            )
    except Exception:
        pass


def _load_local_toml_for_llm(path: Path) -> None:
    if not path.exists():
        return
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return

    current_section = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current_section = line[1:-1].strip()
            continue

        if current_section in ("workerpals.llm", "workerpals"):
            if "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip()
            if len(val) >= 2 and ((val[0] == val[-1] == '"') or (val[0] == val[-1] == "'")):
                val = val[1:-1]

            if current_section == "workerpals.llm":
                if key.lower() == "model":
                    os.environ.setdefault("WORKERPALS_LLM_MODEL", val)
                elif key.lower() in ("endpoint", "base_url"):
                    os.environ.setdefault("WORKERPALS_LLM_ENDPOINT", val)
                elif key.lower() in ("apikey", "api_key", "apikey"):
                    os.environ.setdefault("WORKERPALS_LLM_API_KEY", val)
            elif current_section == "workerpals":
                if key.lower() == "miniswe_python":
                    os.environ.setdefault("WORKERPALS_MINISWE_PYTHON", val)


# -----------------------------
# LM Studio log capture helpers
# -----------------------------
def start_lms_log_stream(source: str, extra_args: list[str] | None = None):
    """Starts `lms log stream` and prints output to stdout. Returns proc or None."""
    if not STREAM_LLM_SERVER_LOGS:
        return None

    from shutil import which

    if which("lms") is None:
        print("[NOTICE] `lms` not found on PATH; skipping LM Studio log stream.")
        return None

    args = ["lms", "log", "stream", "--source", source]
    if extra_args:
        args += extra_args

    try:
        if sys.platform == "win32":
            # Use shell=False so proc.pid is the actual lms process.
            proc = subprocess.Popen(
                args,
                cwd=str(REPO_ROOT),
                env=_build_env(),
                stdout=None,  # inherit
                stderr=None,  # inherit
                shell=False,
                text=True,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,  # type: ignore[attr-defined]
            )
        else:
            proc = subprocess.Popen(
                args,
                cwd=str(REPO_ROOT),
                env=_build_env(),
                stdout=None,  # inherit
                stderr=None,  # inherit
                shell=False,
                text=True,
                start_new_session=True,
            )
    except Exception as e:
        print(f"[NOTICE] Failed to start `lms log stream` ({source}): {e}")
        return None

    print(f"[NOTICE] Streaming LM Studio {source} logs to stdout")
    return proc


def stop_lms_log_stream(proc):
    if not proc:
        return
    kill_proc_tree(proc)


# -----------------------------
# HTTP helpers
# -----------------------------
def _read_http_error(e: HTTPError) -> str:
    try:
        raw = e.read()
        if not raw:
            return ""
        text = raw.decode("utf-8", errors="replace")
        try:
            obj = json.loads(text)
            return json.dumps(obj, indent=2, ensure_ascii=False)
        except Exception:
            return text
    except Exception:
        return ""


def http_post(path: str, body: dict):
    url = SERVER_URL + path
    data = json.dumps(body).encode("utf-8")
    req = Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        details = _read_http_error(e)
        raise RuntimeError(f"HTTP {e.code} {e.reason} for POST {path}\nResponse:\n{details}") from e
    except URLError as e:
        raise RuntimeError(f"URLError for POST {path}: {e}") from e


def http_get(path: str):
    url = SERVER_URL + path
    req = Request(url, headers={"Content-Type": "application/json"}, method="GET")
    try:
        with urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        details = _read_http_error(e)
        raise RuntimeError(f"HTTP {e.code} {e.reason} for GET {path}\nResponse:\n{details}") from e
    except URLError as e:
        raise RuntimeError(f"URLError for GET {path}: {e}") from e


def wait_for_server(timeout=2.0) -> bool:
    deadline = _mono_now() + timeout
    while _mono_now() < deadline:
        try:
            r = http_get("/healthz")
            if r.get("ok"):
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def wait_for_server_down(timeout=5.0) -> bool:
    deadline = _mono_now() + timeout
    while _mono_now() < deadline:
        try:
            http_get("/healthz")
        except Exception:
            return True
        time.sleep(0.25)
    return False


def _http_get_optional(path: str) -> dict | None:
    try:
        payload = http_get(path)
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def get_job(job_id: str) -> dict | None:
    # Prefer direct endpoint if available, fall back to listing.
    direct = _http_get_optional(f"/jobs/{job_id}")
    if isinstance(direct, dict):
        item = direct.get("job")
        if isinstance(item, dict):
            return item
        if direct.get("id") == job_id:
            return direct
    try:
        jobs = http_get(f"/jobs?status=all&limit={LIST_SCAN_LIMIT}")
        for j in jobs.get("jobs", []):
            if j.get("id") == job_id:
                return j
    except Exception:
        pass
    return None


def get_request(request_id: str) -> dict | None:
    # Prefer direct endpoint if available, fall back to listing.
    direct = _http_get_optional(f"/requests/{request_id}")
    if isinstance(direct, dict):
        item = direct.get("request")
        if isinstance(item, dict):
            return item
        if direct.get("id") == request_id:
            return direct
    try:
        reqs = http_get(f"/requests?status=all&limit={LIST_SCAN_LIMIT}")
        for r in reqs.get("requests", []):
            if r.get("id") == request_id:
                return r
    except Exception:
        pass
    return None


def get_completion(completion_id: str) -> dict | None:
    # Prefer direct endpoint if available, fall back to listing.
    direct = _http_get_optional(f"/completions/{completion_id}")
    if isinstance(direct, dict):
        item = direct.get("completion")
        if isinstance(item, dict):
            return item
        if direct.get("id") == completion_id:
            return direct
    try:
        cs = http_get(f"/completions?status=all&limit={LIST_SCAN_LIMIT}")
        for c in cs.get("completions", []):
            if c.get("id") == completion_id:
                return c
    except Exception:
        pass
    return None


def _normalize_epoch_seconds(value: float) -> float:
    abs_value = abs(value)
    if abs_value >= 1e18:
        return value / 1_000_000_000.0
    if abs_value >= 1e15:
        return value / 1_000_000.0
    if abs_value >= 1e12:
        return value / 1_000.0
    return value


def _parse_timestamp_to_epoch_seconds(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return _normalize_epoch_seconds(float(value))

    text = str(value).strip()
    if not text:
        return None

    try:
        return _normalize_epoch_seconds(float(text))
    except Exception:
        pass

    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except Exception:
        return None


def _extract_completion_epoch_seconds(completion: dict) -> float | None:
    for key in ("createdAt", "created_at", "timestamp"):
        parsed = _parse_timestamp_to_epoch_seconds(completion.get(key))
        if parsed is not None:
            return parsed
    return None


def _normalize_repo_rel(path: object) -> str:
    text = str(path or "").strip().replace("\\", "/")
    while "//" in text:
        text = text.replace("//", "/")
    if text.startswith("./"):
        text = text[2:]
    return text.strip("/")


def _builtin_eval_scenarios() -> list[dict]:
    return [
        {
            "id": "readme_append_marker",
            "title": "Append marker to README",
            "prompt": "Append exactly one line 'WorkerPals E2E marker' to README.md and keep all other content unchanged.",
            "expected_paths": ["README.md"],
            "must_contain": {"README.md": r"(?m)^WorkerPals E2E marker$"},
            "max_files_changed": 1,
            "perf_target_ms": 360000,
            "difficulty": "easy",
        },
        {
            "id": "prompt_bundle_scoring_and_ideation",
            "title": "Harden autonomy prompt guidance across two files",
            "prompt": (
                "Apply both updates exactly and keep all other content unchanged: "
                "1) In prompts/remotebuddy/autonomy_scoring_system_prompt.md append the bullet line "
                "'- Prefer deterministic, evidence-backed scoring rationale with explicit evidence IDs.' "
                "2) In prompts/remotebuddy/autonomy_ideation_system_prompt.md append the bullet line "
                "'- Propose ideas only when acceptance criteria are measurable and testable.'"
            ),
            "expected_paths": [
                "prompts/remotebuddy/autonomy_scoring_system_prompt.md",
                "prompts/remotebuddy/autonomy_ideation_system_prompt.md",
            ],
            "must_contain": {
                "prompts/remotebuddy/autonomy_scoring_system_prompt.md": (
                    r"(?m)^- Prefer deterministic, evidence-backed scoring rationale with explicit evidence IDs\.$"
                ),
                "prompts/remotebuddy/autonomy_ideation_system_prompt.md": (
                    r"(?m)^- Propose ideas only when acceptance criteria are measurable and testable\.$"
                ),
            },
            "max_files_changed": 2,
            "perf_target_ms": 540000,
            "difficulty": "hard",
        },
        {
            "id": "config_and_readme_quality_note",
            "title": "Add quality-prioritization notes to config and README",
            "prompt": (
                "Apply both updates exactly and keep all other content unchanged: "
                "1) In config/local.example.toml append the comment line "
                "'# Guardrail: keep autonomy write scope narrow, explicit, and auditable.' "
                "2) In README.md append the bullet line "
                "'- Eval benchmarks prioritize correctness and code quality over raw speed.'"
            ),
            "expected_paths": ["config/local.example.toml", "README.md"],
            "must_contain": {
                "config/local.example.toml": (
                    r"(?m)^# Guardrail: keep autonomy write scope narrow, explicit, and auditable\.$"
                ),
                "README.md": (
                    r"(?m)^- Eval benchmarks prioritize correctness and code quality over raw speed\.$"
                ),
            },
            "max_files_changed": 2,
            "perf_target_ms": 600000,
            "difficulty": "hard",
        },
        {
            "id": "scoring_prompt_add_performance_clause",
            "title": "Add explicit performance tradeoff guidance",
            "prompt": (
                "In prompts/remotebuddy/autonomy_scoring_system_prompt.md append exactly one bullet line "
                "'- Penalize latency only lightly when correctness and safety are strong.' and keep all other content unchanged."
            ),
            "expected_paths": ["prompts/remotebuddy/autonomy_scoring_system_prompt.md"],
            "must_contain": {
                "prompts/remotebuddy/autonomy_scoring_system_prompt.md": (
                    r"(?m)^- Penalize latency only lightly when correctness and safety are strong\.$"
                ),
            },
            "max_files_changed": 1,
            "perf_target_ms": 480000,
            "difficulty": "medium",
        },
    ]


def _load_eval_scenarios_from_file(path: str) -> list[dict]:
    if not path:
        return []
    file_path = Path(path)
    if not file_path.is_absolute():
        file_path = REPO_ROOT / file_path
    if not file_path.exists():
        print(f"[WARN] Eval scenarios file not found: {file_path}")
        return []
    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[WARN] Failed to parse eval scenarios file ({file_path}): {exc}")
        return []
    if not isinstance(payload, list):
        print(f"[WARN] Eval scenarios file must contain a JSON array: {file_path}")
        return []

    scenarios: list[dict] = []
    for index, raw in enumerate(payload):
        if not isinstance(raw, dict):
            continue
        scenario_id = str(raw.get("id") or raw.get("instance_id") or f"custom-{index}").strip()
        prompt = str(raw.get("prompt") or raw.get("problem_statement") or "").strip()
        if not scenario_id or not prompt:
            continue
        expected_paths_raw = raw.get("expected_paths")
        expected_paths: list[str] = []
        if isinstance(expected_paths_raw, list):
            for path_item in expected_paths_raw:
                normalized = _normalize_repo_rel(path_item)
                if normalized:
                    expected_paths.append(normalized)
        must_contain_raw = raw.get("must_contain")
        must_contain: dict[str, str] = {}
        if isinstance(must_contain_raw, dict):
            for path_key, pattern in must_contain_raw.items():
                normalized_path = _normalize_repo_rel(path_key)
                pattern_text = str(pattern or "").strip()
                if normalized_path and pattern_text:
                    must_contain[normalized_path] = pattern_text
        scenarios.append(
            {
                "id": scenario_id,
                "title": str(raw.get("title") or scenario_id),
                "prompt": prompt,
                "expected_paths": expected_paths,
                "must_contain": must_contain,
                "max_files_changed": int(raw.get("max_files_changed") or 2),
                "perf_target_ms": int(raw.get("perf_target_ms") or 420000),
            }
        )
    return scenarios


def _select_eval_scenarios(
    all_scenarios: list[dict],
    backend_index: int,
    per_backend: int,
    strategy: str,
) -> list[dict]:
    if not all_scenarios:
        return []
    count = max(1, min(per_backend, len(all_scenarios)))
    if strategy == "round_robin":
        selected: list[dict] = []
        for offset in range(count):
            selected.append(all_scenarios[(backend_index + offset) % len(all_scenarios)])
        return selected
    return all_scenarios[:count]


def _compose_scenario_bundle(scenarios: list[dict]) -> dict | None:
    valid = [item for item in scenarios if isinstance(item, dict)]
    if not valid:
        return None
    if len(valid) == 1:
        return dict(valid[0])

    bundle_id = "+".join(str(item.get("id") or "scenario") for item in valid)
    bundle_title = " + ".join(str(item.get("title") or item.get("id") or "scenario") for item in valid)
    prompt_lines = []
    expected_paths: list[str] = []
    must_contain: dict[str, str] = {}
    max_files_changed = 0
    perf_target_ms = 0
    for idx, item in enumerate(valid, start=1):
        prompt = str(item.get("prompt") or "").strip()
        if prompt:
            prompt_lines.append(f"{idx}. {prompt}")
        for path in item.get("expected_paths") or []:
            norm = _normalize_repo_rel(path)
            if norm and norm not in expected_paths:
                expected_paths.append(norm)
        raw_must_contain = item.get("must_contain") or {}
        if isinstance(raw_must_contain, dict):
            for key, pattern in raw_must_contain.items():
                norm_key = _normalize_repo_rel(key)
                if norm_key and str(pattern or "").strip():
                    must_contain[norm_key] = str(pattern)
        max_files_changed += int(item.get("max_files_changed") or 0)
        perf_target_ms += int(item.get("perf_target_ms") or 0)

    if max_files_changed <= 0:
        max_files_changed = max(1, len(expected_paths))
    if perf_target_ms <= 0:
        perf_target_ms = 600000

    bundle_prompt = (
        "Complete all of the following repo updates in one request. "
        "Preserve formatting and keep unrelated content unchanged:\n"
        + "\n".join(prompt_lines)
    )
    return {
        "id": f"bundle:{bundle_id}",
        "title": f"Bundled scenario: {bundle_title}",
        "prompt": bundle_prompt,
        "expected_paths": expected_paths,
        "must_contain": must_contain,
        "max_files_changed": max_files_changed,
        "perf_target_ms": perf_target_ms,
        "difficulty": "hard",
    }


def _git_text(repo: Path, args: list[str]) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(repo),
            env=_build_env(),
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return int(proc.returncode), str(proc.stdout or ""), str(proc.stderr or "")
    except Exception as exc:
        return 1, "", str(exc)


def _collect_commit_artifacts(repo: Path, commit_sha: str) -> dict:
    commit = str(commit_sha or "").strip()
    if not commit:
        return {
            "commit_exists": False,
            "changed_files": [],
            "added_lines": [],
            "patch_text": "",
            "lines_added": 0,
            "lines_deleted": 0,
        }

    rc_files, out_files, _ = _git_text(repo, ["show", "--pretty=format:", "--name-only", commit])
    if rc_files != 0:
        return {
            "commit_exists": False,
            "changed_files": [],
            "added_lines": [],
            "patch_text": "",
            "lines_added": 0,
            "lines_deleted": 0,
        }
    changed_files = [
        _normalize_repo_rel(line)
        for line in out_files.splitlines()
        if _normalize_repo_rel(line)
    ]

    rc_num, out_num, _ = _git_text(repo, ["show", "--pretty=format:", "--numstat", commit])
    lines_added = 0
    lines_deleted = 0
    if rc_num == 0:
        for line in out_num.splitlines():
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            try:
                add_raw = parts[0].strip()
                del_raw = parts[1].strip()
                add_count = int(add_raw) if add_raw.isdigit() else 0
                del_count = int(del_raw) if del_raw.isdigit() else 0
            except Exception:
                add_count = 0
                del_count = 0
            lines_added += add_count
            lines_deleted += del_count

    rc_patch, out_patch, _ = _git_text(repo, ["show", "--pretty=format:", "--unified=0", commit])
    patch_text = out_patch if rc_patch == 0 else ""
    added_lines: list[str] = []
    for line in patch_text.splitlines():
        if not line.startswith("+"):
            continue
        if line.startswith("+++ "):
            continue
        added_lines.append(line[1:])

    return {
        "commit_exists": True,
        "changed_files": changed_files,
        "added_lines": added_lines,
        "patch_text": patch_text,
        "lines_added": lines_added,
        "lines_deleted": lines_deleted,
    }


def _read_file_at_commit(repo: Path, commit_sha: str, repo_rel_path: str) -> str:
    commit = str(commit_sha or "").strip()
    path = _normalize_repo_rel(repo_rel_path)
    if not commit or not path:
        return ""
    rc, out, _ = _git_text(repo, ["show", f"{commit}:{path}"])
    if rc != 0:
        return ""
    return out


def _score_from_dimensions(dimensions: dict, total_sec: float, clarification_retried: bool) -> float:
    correctness = float(dimensions.get("correctness") or 0.0)
    quality = float(dimensions.get("quality") or 0.0)
    readability = float(dimensions.get("readability") or 0.0)
    performance = float(dimensions.get("performance") or 0.0)
    base = (
        0.55 * correctness
        + 0.20 * quality
        + 0.15 * readability
        + 0.10 * performance
    )
    # Keep time impact intentionally tiny; quality/correctness dominate.
    time_penalty = min(2.0, max(0.0, total_sec - 180.0) * 0.0025)
    if clarification_retried:
        time_penalty += 0.75
    return round(max(0.0, min(100.0, base - time_penalty)), 2)


def _evaluate_backend_quality_dimensions(
    repo: Path,
    scenario: dict | None,
    commit_sha: str,
    backend_total_sec: float,
    clarification_retried: bool,
    job_duration_ms: int | None,
) -> dict:
    artifacts = _collect_commit_artifacts(repo, commit_sha)
    changed_files = [str(p) for p in artifacts.get("changed_files", []) if str(p)]
    added_lines = [str(line) for line in artifacts.get("added_lines", [])]
    lines_added = int(artifacts.get("lines_added") or 0)
    lines_deleted = int(artifacts.get("lines_deleted") or 0)
    total_line_delta = lines_added + lines_deleted

    expected_paths = []
    must_contain = {}
    max_files_changed = 2
    perf_target_ms = 420000
    if isinstance(scenario, dict):
        expected_paths = [
            _normalize_repo_rel(path)
            for path in (scenario.get("expected_paths") or [])
            if _normalize_repo_rel(path)
        ]
        raw_must_contain = scenario.get("must_contain") or {}
        if isinstance(raw_must_contain, dict):
            for key, pattern in raw_must_contain.items():
                norm_key = _normalize_repo_rel(key)
                if norm_key and str(pattern or "").strip():
                    must_contain[norm_key] = str(pattern)
        max_files_changed = int(scenario.get("max_files_changed") or max_files_changed)
        perf_target_ms = int(scenario.get("perf_target_ms") or perf_target_ms)

    touched_expected = 0
    for expected in expected_paths:
        if expected in changed_files:
            touched_expected += 1
    expected_paths_ok = (not expected_paths) or (touched_expected == len(expected_paths))

    must_contain_passed = 0
    must_contain_failed: list[str] = []
    for path_key, pattern in must_contain.items():
        file_content = _read_file_at_commit(repo, commit_sha, path_key)
        if file_content and re.search(pattern, file_content):
            must_contain_passed += 1
        else:
            must_contain_failed.append(path_key)
    must_contain_ok = (not must_contain) or (must_contain_passed == len(must_contain))

    unexpected_files = [
        path for path in changed_files if expected_paths and path not in set(expected_paths)
    ]
    unexpected_count = len(unexpected_files)

    correctness = 0.0
    if bool(artifacts.get("commit_exists")):
        correctness += 30.0
    if expected_paths_ok:
        correctness += 30.0
    else:
        coverage_ratio = (
            (float(touched_expected) / float(max(1, len(expected_paths)))) if expected_paths else 0.0
        )
        correctness += 30.0 * coverage_ratio
    if must_contain_ok:
        correctness += 25.0
    else:
        regex_ratio = (
            (float(must_contain_passed) / float(max(1, len(must_contain))))
            if must_contain
            else 0.0
        )
        correctness += 25.0 * regex_ratio
    if unexpected_count == 0:
        correctness += 15.0
    correctness = round(max(0.0, min(100.0, correctness)), 2)

    quality = 100.0
    if unexpected_count > 0:
        quality -= min(60.0, unexpected_count * 20.0)
    if len(changed_files) > max_files_changed:
        quality -= min(25.0, (len(changed_files) - max_files_changed) * 10.0)
    if total_line_delta > 80:
        quality -= min(20.0, (total_line_delta - 80) * 0.35)
    quality = round(max(0.0, min(100.0, quality)), 2)

    trailing_ws = 0
    long_lines = 0
    tab_lines = 0
    for line in added_lines:
        if line.rstrip(" \t") != line:
            trailing_ws += 1
        if len(line) > 120:
            long_lines += 1
        if "\t" in line:
            tab_lines += 1

    readability = 100.0
    readability -= min(30.0, trailing_ws * 10.0)
    readability -= min(30.0, long_lines * 2.5)
    readability -= min(20.0, tab_lines * 1.5)
    readability = round(max(0.0, min(100.0, readability)), 2)

    if job_duration_ms is None:
        performance = 60.0
    else:
        ratio = float(job_duration_ms) / float(max(1, perf_target_ms))
        if ratio <= 1.0:
            performance = 100.0
        elif ratio <= 2.0:
            performance = 100.0 - (ratio - 1.0) * 40.0
        else:
            performance = max(20.0, 60.0 - (ratio - 2.0) * 20.0)
    performance = round(max(0.0, min(100.0, performance)), 2)

    dimensions = {
        "correctness": correctness,
        "quality": quality,
        "readability": readability,
        "performance": performance,
    }
    final_score = _score_from_dimensions(
        dimensions=dimensions,
        total_sec=backend_total_sec,
        clarification_retried=clarification_retried,
    )
    return {
        "dimensions": dimensions,
        "score": final_score,
        "changed_files": changed_files,
        "unexpected_files": unexpected_files,
        "must_contain_failed": must_contain_failed,
        "line_delta": {"added": lines_added, "deleted": lines_deleted},
    }


def _extract_job_epoch_seconds(job: dict) -> float | None:
    for key in ("enqueuedAt", "createdAt", "updatedAt", "claimedAt", "startedAt"):
        parsed = _parse_timestamp_to_epoch_seconds(job.get(key))
        if parsed is not None:
            return parsed
    return None


def _job_params_object(job: dict) -> dict:
    params = job.get("params")
    if isinstance(params, dict):
        return params
    if isinstance(params, str):
        try:
            parsed = json.loads(params)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return {}
    return {}


def _extract_job_request_id(job: dict) -> str:
    params = _job_params_object(job)
    for key in ("requestId", "request_id"):
        value = str(params.get(key) or "").strip()
        if value:
            return value
    return ""


def _job_matches_request(
    job: dict,
    request_id: str,
    worker_id: str,
    enqueue_monotonic: float | None = None,
) -> bool:
    rid = str(request_id or "").strip()
    if not rid:
        return False
    if str(job.get("kind") or "").strip() != "task.execute":
        return False

    explicit_job_request_id = _extract_job_request_id(job)
    if explicit_job_request_id:
        return explicit_job_request_id == rid

    job_worker = str(job.get("workerId") or "").strip()
    target_worker = str(job.get("targetWorkerId") or "").strip()
    if worker_id and job_worker != worker_id and target_worker != worker_id:
        return False

    job_epoch = _extract_job_epoch_seconds(job)
    if job_epoch is None or enqueue_monotonic is None:
        return True
    enqueue_epoch = _mono_to_epoch_seconds(enqueue_monotonic)
    return job_epoch >= (enqueue_epoch - 2.0)


def _completion_matches_request(
    completion: dict,
    request_id: str,
    enqueue_monotonic: float | None = None,
) -> bool:
    """
    If completion payload carries request id fields, enforce a match.
    If request id fields are absent, use completion timestamp correlation when present;
    otherwise keep backward-compatible fallback behavior.
    """
    rid = str(request_id or "").strip()
    if not rid:
        return True
    seen_request_id_field = False
    for key in ("requestId", "request_id"):
        value = str(completion.get(key) or "").strip()
        if not value:
            continue
        seen_request_id_field = True
        if value == rid:
            return True
    if seen_request_id_field:
        return False

    completion_epoch = _extract_completion_epoch_seconds(completion)
    if completion_epoch is None or enqueue_monotonic is None:
        return True

    enqueue_epoch = _mono_to_epoch_seconds(enqueue_monotonic)
    # Allow slight skew for second-precision timestamps and clock drift.
    return completion_epoch >= (enqueue_epoch - 2.0)


def _to_int_or_none(value: object) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(round(value))
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(round(float(text)))
    except Exception:
        return None


def _duration_ms_between(start_value: object, end_value: object) -> int | None:
    start_epoch = _parse_timestamp_to_epoch_seconds(start_value)
    end_epoch = _parse_timestamp_to_epoch_seconds(end_value)
    if start_epoch is None or end_epoch is None:
        return None
    return max(0, int(round((end_epoch - start_epoch) * 1000.0)))


def _extract_request_eval_metrics(request_obj: dict | None) -> dict:
    if not isinstance(request_obj, dict):
        return {
            "request_queue_wait_ms": None,
            "request_duration_ms": None,
            "request_claim_to_complete_ms": None,
        }
    queue_wait = _duration_ms_between(request_obj.get("enqueuedAt"), request_obj.get("claimedAt"))
    request_duration = _to_int_or_none(request_obj.get("durationMs"))
    if request_duration is None:
        request_duration = _duration_ms_between(
            request_obj.get("enqueuedAt"),
            request_obj.get("completedAt") or request_obj.get("failedAt"),
        )
    claim_to_complete = _duration_ms_between(
        request_obj.get("claimedAt"),
        request_obj.get("completedAt") or request_obj.get("failedAt"),
    )
    return {
        "request_queue_wait_ms": queue_wait,
        "request_duration_ms": request_duration,
        "request_claim_to_complete_ms": claim_to_complete,
    }


def _extract_job_eval_metrics(job_obj: dict | None) -> dict:
    if not isinstance(job_obj, dict):
        return {
            "job_duration_ms": None,
            "job_queue_wait_ms": None,
            "job_claim_to_finish_ms": None,
        }
    job_duration = _to_int_or_none(job_obj.get("durationMs"))
    if job_duration is None:
        job_duration = _duration_ms_between(
            job_obj.get("enqueuedAt"),
            job_obj.get("completedAt") or job_obj.get("failedAt"),
        )
    job_queue_wait = _duration_ms_between(job_obj.get("enqueuedAt"), job_obj.get("claimedAt"))
    claim_to_finish = _duration_ms_between(
        job_obj.get("claimedAt"),
        job_obj.get("completedAt") or job_obj.get("failedAt"),
    )
    return {
        "job_duration_ms": job_duration,
        "job_queue_wait_ms": job_queue_wait,
        "job_claim_to_finish_ms": claim_to_finish,
    }


def _completion_planned_scope_is_root(completion: dict | None) -> bool:
    if not isinstance(completion, dict):
        return False
    pr_body = str(completion.get("prBody") or "")
    if not pr_body:
        return False
    pattern = r"### Planned Scope\s*[\r\n]+[\s\S]*?-\s*`\.`"
    return re.search(pattern, pr_body) is not None


def _score_backend_eval_row(row: dict) -> float:
    if str(row.get("status") or "").strip().lower() != "passed":
        return 0.0
    dimensions = row.get("dimensions")
    if isinstance(dimensions, dict):
        return _score_from_dimensions(
            dimensions=dimensions,
            total_sec=float(row.get("backend_total_sec") or 0.0),
            clarification_retried=bool(row.get("clarification_retried")),
        )
    # Fallback for older rows without dimension fields.
    checks = row.get("checks")
    if not isinstance(checks, dict):
        checks = {}
    correctness = 100.0 if bool(checks.get("completion_has_commit_sha")) else 60.0
    quality = 100.0 if bool(checks.get("completion_has_pr_metadata")) else 70.0
    readability = 95.0 if not bool(checks.get("planned_scope_root_dot")) else 75.0
    performance = 100.0 if bool(checks.get("job_duration_known")) else 60.0
    return _score_from_dimensions(
        dimensions={
            "correctness": correctness,
            "quality": quality,
            "readability": readability,
            "performance": performance,
        },
        total_sec=float(row.get("backend_total_sec") or 0.0),
        clarification_retried=bool(row.get("clarification_retried")),
    )


def _emit_eval_summary(
    results: list[dict],
    total_runtime_sec: float,
    output_path: str,
    total_budget_sec: float,
) -> dict:
    attempted = len(results)
    passed = [r for r in results if str(r.get("status") or "").lower() == "passed"]
    failed = [r for r in results if str(r.get("status") or "").lower() != "passed"]
    within_budget = total_budget_sec <= 0 or total_runtime_sec <= total_budget_sec
    avg_score = round(
        sum(float(r.get("score") or 0.0) for r in results) / float(max(1, attempted)),
        2,
    )
    summary = {
        "mode": "backend_eval",
        "attempted_backends": attempted,
        "passed_backends": len(passed),
        "failed_backends": len(failed),
        "all_passed": len(failed) == 0 and attempted > 0,
        "total_runtime_sec": round(total_runtime_sec, 3),
        "budget_sec": total_budget_sec,
        "within_budget": within_budget,
        "average_score": avg_score,
        "results": sorted(
            results,
            key=lambda r: (
                -float(r.get("score") or 0.0),
                float(r.get("backend_total_sec") or 0.0),
                str(r.get("backend") or ""),
            ),
        ),
    }

    print("\n==============================")
    print("BACKEND EVAL SUMMARY")
    print("==============================")
    print(
        "attempted={attempted} passed={passed} failed={failed} avg_score={avg_score} "
        "total={total} budget={budget} backend_budget={backend_budget} within_budget={within_budget}".format(
            attempted=summary["attempted_backends"],
            passed=summary["passed_backends"],
            failed=summary["failed_backends"],
            avg_score=summary["average_score"],
            total=_fmt_elapsed(total_runtime_sec),
            budget=_fmt_elapsed(total_budget_sec) if total_budget_sec > 0 else "unbounded",
            backend_budget=_fmt_elapsed(E2E_EVAL_BACKEND_BUDGET_SEC)
            if E2E_EVAL_BACKEND_BUDGET_SEC > 0
            else "unbounded",
            within_budget=summary["within_budget"],
        )
    )
    for row in summary["results"]:
        dims = row.get("dimensions")
        if not isinstance(dims, dict):
            dims = {}
        print(
            "- {backend}/{scenario}: status={status} score={score} total={total} warmup={warmup} "
            "phase_b={phase_b} request_ms={request_ms} job_ms={job_ms} "
            "corr={corr} qual={qual} read={read} perf={perf}".format(
                backend=row.get("backend"),
                scenario=row.get("scenario_id") or "default",
                status=row.get("status"),
                score=row.get("score"),
                total=_fmt_elapsed(float(row.get("backend_total_sec") or 0.0)),
                warmup=_fmt_elapsed(float(row.get("warmup_sec") or 0.0)),
                phase_b=_fmt_elapsed(float(row.get("phase_b_sec") or 0.0)),
                request_ms=row.get("request_duration_ms"),
                job_ms=row.get("job_duration_ms"),
                corr=dims.get("correctness"),
                qual=dims.get("quality"),
                read=dims.get("readability"),
                perf=dims.get("performance"),
            )
        )

    if output_path:
        try:
            out_path = Path(output_path)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"[NOTICE] Wrote backend eval summary JSON: {out_path}")
        except Exception as exc:
            print(f"[WARN] Failed to write backend eval summary JSON: {exc}")

    return summary


def list_workers(ttl_ms: int = 30000) -> list[dict]:
    try:
        payload = http_get(f"/workers?ttlMs={int(max(1000, ttl_ms))}")
        workers = payload.get("workers", [])
        if isinstance(workers, list):
            return [w for w in workers if isinstance(w, dict)]
    except Exception:
        pass
    return []


def wait_for_worker_online(worker_id: str, timeout_sec: float = 25.0) -> dict | None:
    deadline = _mono_now() + timeout_sec
    while _mono_now() < deadline:
        for worker in list_workers(ttl_ms=_WORKER_ONLINE_TTL_MS):
            if str(worker.get("workerId") or "") != worker_id:
                continue
            if bool(worker.get("isOnline")):
                return worker
        time.sleep(0.25)
    return None


# Heartbeat-based online TTL for the E2E test.  Workers send heartbeats every
# 2 s, so 8 s is generous enough to avoid false negatives while still letting
# a killed worker drop off quickly.
_WORKER_ONLINE_TTL_MS = 8_000


def wait_for_worker_offline(worker_id: str, timeout_sec: float = 20.0) -> bool:
    """Poll until a specific worker is no longer listed as online."""
    deadline = _mono_now() + timeout_sec
    while _mono_now() < deadline:
        online_ids = [
            str(w.get("workerId") or "")
            for w in list_workers(ttl_ms=_WORKER_ONLINE_TTL_MS)
            if bool(w.get("isOnline"))
        ]
        if worker_id not in online_ids:
            return True
        time.sleep(0.5)
    return False


def assert_only_worker_online(worker_id: str) -> None:
    online = [
        str(w.get("workerId") or "")
        for w in list_workers(ttl_ms=_WORKER_ONLINE_TTL_MS)
        if bool(w.get("isOnline")) and str(w.get("workerId") or "").strip()
    ]
    others = [wid for wid in online if wid != worker_id]
    if others:
        raise RuntimeError(
            "Multiple online WorkerPals detected; this test requires exactly one online worker.\n"
            f"expected={worker_id}\n"
            f"online={online}"
        )


# Kept for future content verification paths (not currently asserted in this script).
def extract_text_from_any(obj) -> str:
    if obj is None:
        return ""
    if isinstance(obj, str):
        return obj
    if isinstance(obj, (int, float, bool)):
        return str(obj)
    if isinstance(obj, list):
        return "\n".join(extract_text_from_any(x) for x in obj)
    if isinstance(obj, dict):
        for k in (
            "final",
            "finalText",
            "final_text",
            "answer",
            "output",
            "result",
            "text",
            "content",
            "message",
            "response",
        ):
            t = extract_text_from_any(obj.get(k))
            if t.strip():
                return t
        msgs = obj.get("messages")
        if isinstance(msgs, list):
            parts = []
            for m in msgs:
                if isinstance(m, dict) and "content" in m:
                    parts.append(str(m.get("content") or ""))
            if parts:
                return "\n".join(parts)
        try:
            return json.dumps(obj, ensure_ascii=False)
        except Exception:
            return str(obj)
    return str(obj)


def extract_final_text_from_completion(c: dict) -> str:
    for k in (
        "final",
        "finalText",
        "final_text",
        "answer",
        "output",
        "result",
        "text",
        "content",
        "response",
        "message",
        "messages",
    ):
        t = extract_text_from_any(c.get(k))
        if t.strip():
            return t
    return ""


def extract_text_from_job_result(j: dict) -> str:
    """Extract the agent's text output from a completed job's result/artifacts."""
    raw_result = j.get("result")
    if not raw_result:
        return ""
    # result may be a JSON string or already parsed dict
    if isinstance(raw_result, str):
        try:
            raw_result = json.loads(raw_result)
        except Exception:
            return raw_result
    if not isinstance(raw_result, dict):
        return str(raw_result)
    # Check artifacts for stdout text (where the executor puts agent output)
    artifacts = raw_result.get("artifacts")
    if isinstance(artifacts, list):
        for art in artifacts:
            if isinstance(art, dict) and art.get("kind") == "stdout":
                text = str(art.get("text") or "").strip()
                if text:
                    return text
    # Fallback: check summary and other keys
    for k in ("summary", "output", "text", "content", "message"):
        t = extract_text_from_any(raw_result.get(k))
        if t.strip():
            return t
    return ""


def _contains_clarification_signal(value: object) -> bool:
    text = str(value or "").lower()
    return (
        "clarification" in text
        or "clarify" in text
        or "follow-up question" in text
        or "requested clarification" in text
    )


def _request_failed_due_to_clarification(req: dict | None) -> bool:
    if not isinstance(req, dict):
        return False
    if _contains_clarification_signal(req.get("error")):
        return True
    if _contains_clarification_signal(req.get("result")):
        return True
    return _contains_clarification_signal(json.dumps(req, ensure_ascii=False))


# -----------------------------
# Process helpers (kill tree on Windows)
# -----------------------------
def _build_env(overrides: dict | None = None) -> dict[str, str]:
    env = DEFAULT_ENV.copy()
    if overrides:
        for key, value in overrides.items():
            env[str(key)] = str(value)
    return env


def _resolve_windows_argv(argv: list[str], env: dict[str, str]) -> list[str]:
    if not argv:
        raise ValueError("start_process received an empty command")
    resolved = list(argv)
    first = resolved[0]

    # Absolute/relative explicit paths can be used as-is.
    first_path = Path(first)
    if first_path.is_absolute() or first.startswith(".\\") or first.startswith("..\\"):
        return resolved

    found = shutil.which(first, path=env.get("PATH"))
    if found is None and not first_path.suffix:
        for ext in (".exe", ".cmd", ".bat"):
            found = shutil.which(first + ext, path=env.get("PATH"))
            if found:
                break
    if found is None:
        raise FileNotFoundError(f"Command not found on PATH: {first}")
    resolved[0] = found
    return resolved


def _ensure_windows_kill_on_close_job_object() -> int | None:
    """Create a Windows Job Object that auto-kills assigned child processes on exit."""
    global _WIN_JOB_OBJECT_HANDLE, _WIN_JOB_OBJECT_INIT_ATTEMPTED
    if sys.platform != "win32":
        return None
    if _WIN_JOB_OBJECT_INIT_ATTEMPTED:
        return _WIN_JOB_OBJECT_HANDLE
    _WIN_JOB_OBJECT_INIT_ATTEMPTED = True

    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", ctypes.c_uint32),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", ctypes.c_uint32),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", ctypes.c_uint32),
                ("SchedulingClass", ctypes.c_uint32),
            ]

        class _IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_uint64),
                ("WriteOperationCount", ctypes.c_uint64),
                ("OtherOperationCount", ctypes.c_uint64),
                ("ReadTransferCount", ctypes.c_uint64),
                ("WriteTransferCount", ctypes.c_uint64),
                ("OtherTransferCount", ctypes.c_uint64),
            ]

        class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", _IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
        kernel32.CreateJobObjectW.restype = ctypes.c_void_p
        kernel32.SetInformationJobObject.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint32,
        ]
        kernel32.SetInformationJobObject.restype = ctypes.c_int

        job_object = kernel32.CreateJobObjectW(None, None)
        if not job_object:
            raise OSError(f"CreateJobObjectW failed (winerr={ctypes.get_last_error()})")

        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
        JobObjectExtendedLimitInformation = 9
        info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = kernel32.SetInformationJobObject(
            job_object,
            JobObjectExtendedLimitInformation,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        if not ok:
            winerr = ctypes.get_last_error()
            kernel32.CloseHandle(job_object)
            raise OSError(f"SetInformationJobObject failed (winerr={winerr})")

        _WIN_JOB_OBJECT_HANDLE = int(job_object)
        _debug("Windows kill-on-close Job Object is active.")
    except Exception as exc:
        _WIN_JOB_OBJECT_HANDLE = None
        _debug(f"Windows Job Object unavailable: {_one_line(exc, 200)}")

    return _WIN_JOB_OBJECT_HANDLE


def _assign_process_to_windows_job_object(proc: subprocess.Popen) -> None:
    if sys.platform != "win32":
        return
    job_object = _ensure_windows_kill_on_close_job_object()
    if not job_object:
        return
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        kernel32.AssignProcessToJobObject.restype = ctypes.c_int
        ok = kernel32.AssignProcessToJobObject(
            ctypes.c_void_p(job_object),
            ctypes.c_void_p(int(proc._handle)),  # type: ignore[attr-defined]
        )
        if not ok:
            winerr = ctypes.get_last_error()
            # ERROR_ACCESS_DENIED can occur when nested jobs are disallowed.
            if winerr != 5:
                _debug(f"AssignProcessToJobObject failed for pid={proc.pid} (winerr={winerr})")
    except Exception as exc:
        _debug(f"AssignProcessToJobObject exception for pid={proc.pid}: {_one_line(exc, 200)}")


def _close_windows_kill_on_close_job_object() -> None:
    global _WIN_JOB_OBJECT_HANDLE
    if sys.platform != "win32" or _WIN_JOB_OBJECT_HANDLE is None:
        return
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int
        kernel32.CloseHandle(ctypes.c_void_p(_WIN_JOB_OBJECT_HANDLE))
    except Exception as exc:
        _debug(f"CloseHandle(JobObject) failed: {_one_line(exc, 200)}")
    finally:
        _WIN_JOB_OBJECT_HANDLE = None


def start_process(cmd, cwd=REPO_ROOT, env=None):
    """Start a process inheriting stdout/stderr (prints directly to console)."""
    run_env = _build_env(env)
    if isinstance(cmd, str):
        raise TypeError("start_process expects argv list/tuple, not a shell command string")
    popen_cmd = [str(part) for part in cmd]

    if sys.platform == "win32":
        _ensure_windows_kill_on_close_job_object()
        popen_cmd = _resolve_windows_argv(popen_cmd, run_env)
        proc = subprocess.Popen(
            popen_cmd,
            cwd=str(cwd),
            env=run_env,
            stdout=None,  # inherit
            stderr=None,  # inherit
            shell=False,
            text=True,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,  # type: ignore[attr-defined]
        )
        _assign_process_to_windows_job_object(proc)
    else:
        proc = subprocess.Popen(
            popen_cmd,
            cwd=str(cwd),
            env=run_env,
            stdout=None,  # inherit
            stderr=None,  # inherit
            shell=False,
            text=True,
            start_new_session=True,
        )

    return proc


def kill_proc_tree(proc):
    if not proc:
        return

    if sys.platform == "win32":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except Exception:
            pass
        return

    try:
        import signal as _sig

        os.killpg(proc.pid, _sig.SIGTERM)
    except Exception:
        pass
    try:
        proc.wait(timeout=5)
    except Exception:
        try:
            import signal as _sig

            os.killpg(proc.pid, _sig.SIGKILL)
        except Exception:
            pass


def assert_proc_alive(proc, name: str):
    if not proc:
        return
    rc = proc.poll()
    if rc is None:
        return
    raise RuntimeError(f"{name} exited early with code {rc}")


# -----------------------------
# Cleanup handlers (Ctrl+C etc.)
# -----------------------------
def cleanup():
    global _CLEANED_UP
    global _INTERRUPTED
    global server_proc, worker_proc, remotebuddy_proc
    global started_server, started_worker, started_remotebuddy

    if _CLEANED_UP:
        return
    _CLEANED_UP = True

    # Stop in reverse-dependency order.
    if worker_proc:
        kill_proc_tree(worker_proc)
        worker_proc = None

    if remotebuddy_proc:
        kill_proc_tree(remotebuddy_proc)
        remotebuddy_proc = None

    if server_proc:
        kill_proc_tree(server_proc)
        server_proc = None
        wait_for_server_down(5.0)

    started_worker = False
    started_remotebuddy = False
    started_server = False

    # If interrupted, run an aggressive sweep in case we were stopped mid-start.
    if _INTERRUPTED:
        try:
            _kill_existing_sidecar_processes()
        except Exception as exc:
            _debug(f"sidecar interrupt cleanup failed: {_one_line(exc, 200)}")
        try:
            _kill_existing_server_processes()
        except Exception as exc:
            _debug(f"server interrupt cleanup failed: {_one_line(exc, 200)}")
        wait_for_server_down(5.0)

    _close_windows_kill_on_close_job_object()


def _handle_signal(signum, frame):
    global _INTERRUPTED
    _INTERRUPTED = True
    cleanup()
    raise SystemExit(130)


def install_cleanup_handlers():
    atexit.register(cleanup)
    try:
        signal.signal(signal.SIGINT, _handle_signal)
    except Exception as exc:
        _debug(f"SIGINT handler registration failed: {_one_line(exc, 200)}")
    sigterm = getattr(signal, "SIGTERM", None)
    if sigterm is not None:
        try:
            signal.signal(sigterm, _handle_signal)
        except Exception as exc:
            _debug(f"SIGTERM handler registration failed: {_one_line(exc, 200)}")
    sigbreak = getattr(signal, "SIGBREAK", None)
    if sigbreak is not None:
        try:
            signal.signal(sigbreak, _handle_signal)
        except Exception as exc:
            _debug(f"SIGBREAK handler registration failed: {_one_line(exc, 200)}")


# -----------------------------
# Init env early
# -----------------------------
os.environ["PUSHPALS_REPO_PATH"] = str(REPO_ROOT)
os.environ["PYTHONIOENCODING"] = "utf-8"

_ensure_env_from_example(REPO_ROOT)
_load_dotenv(REPO_ROOT / ".env")
_load_dotenv(REPO_ROOT / ".env.local")
_load_local_toml_for_llm(REPO_ROOT / "config" / "local.toml")
# Keep all daemons on the exact same server URL/address family during this run.
os.environ["PUSHPALS_SERVER_URL"] = SERVER_URL

E2E_USE_DOCKER = _is_truthy(os.environ.get("WORKERPALS_E2E_DOCKER", "1"))
E2E_DOCKER_IMAGE = (os.environ.get("WORKERPALS_E2E_DOCKER_IMAGE") or "").strip()
E2E_DOCKER_NETWORK = (os.environ.get("WORKERPALS_E2E_DOCKER_NETWORK") or "").strip()
E2E_DOCKER_TIMEOUT_MS = (os.environ.get("WORKERPALS_E2E_DOCKER_TIMEOUT_MS") or "").strip()
E2E_DOCKER_IDLE_TIMEOUT_MS = (os.environ.get("WORKERPALS_E2E_DOCKER_IDLE_TIMEOUT_MS") or "").strip()
E2E_DOCKER_IMAGE_EFFECTIVE = E2E_DOCKER_IMAGE or "pushpals-worker-sandbox:latest"
E2E_ISOLATE_WORKER_REPO = _is_truthy(os.environ.get("WORKERPALS_E2E_ISOLATE_WORKER_REPO", "1"))

DEFAULT_ENV = os.environ.copy()


def main():
    global server_proc, worker_proc, remotebuddy_proc
    global started_server, started_worker, started_remotebuddy

    install_cleanup_handlers()
    total_started_at = _now()

    run_session_id = f"{DEFAULT_SESSION_ID}-e2e-{uuid4().hex[:12]}"
    print("PushPals E2E test: starting server + remotebuddy + workerpals")
    print(f"[NOTICE] E2E session: {run_session_id}")
    if E2E_USE_DOCKER:
        print("[NOTICE] WorkerPals E2E running in Docker executor mode.")
        docker_ready_started_at = _now()
        _require_docker_available()
        _ensure_docker_image(E2E_DOCKER_IMAGE_EFFECTIVE)
        _print_duration("docker readiness (daemon + image)", docker_ready_started_at)
    else:
        print("[NOTICE] WorkerPals E2E running in direct host executor mode.")

    repo = REPO_ROOT

    lms_server_log_proc = None
    lms_model_log_proc = None
    isolated_worker_repo_root: Path | None = None
    failures: list[str] = []
    backend_eval_results: list[dict] = []

    if E2E_ISOLATE_WORKER_REPO:
        repo, isolated_worker_repo_root = _create_isolated_worker_repo(REPO_ROOT)
        print(f"[NOTICE] Using isolated worker repo clone: {repo}")
    else:
        print("[NOTICE] Worker repo isolation disabled; using current workspace repo directly.")

    print("[NOTICE] Preflight cleanup: stopping any leftover RemoteBuddy/WorkerPals daemons...")
    _kill_existing_sidecar_processes()

    server_already_running = wait_for_server(2.0)
    started_server = False
    started_worker = False
    started_remotebuddy = False

    if server_already_running and KILL_SERVER_IF_RUNNING:
        print(f"[NOTICE] Server already running at {SERVER_URL}; requesting graceful shutdown...")
        stopped = _request_server_shutdown(timeout_sec=8.0)
        if not stopped:
            print("[NOTICE] Graceful shutdown unavailable or timed out; killing existing server processes...")
            _kill_existing_server_processes()
            _kill_existing_sidecar_processes()
            stopped = wait_for_server_down(8.0)
        if not stopped:
            remaining_pids = _list_server_listener_pids()
            raise RuntimeError(
                "Tried graceful shutdown and process kill, but server still responds.\n"
                f"server={SERVER_URL}\n"
                f"listening_pids={remaining_pids}\n"
                "Stop the existing stack manually, then rerun the integration test."
            )
        server_already_running = False

    if server_already_running and FAIL_IF_SERVER_RUNNING:
        online_workers = [str(w.get("workerId") or "") for w in list_workers() if bool(w.get("isOnline"))]
        raise RuntimeError(
            "Server is already running; refusing to reuse it for integration test isolation.\n"
            f"server={SERVER_URL}\n"
            f"online_workers={online_workers}\n"
            "Stop the existing stack, set WORKERPALS_E2E_KILL_SERVER_IF_RUNNING=1, "
            "or set WORKERPALS_E2E_FAIL_IF_SERVER_RUNNING=0."
        )

    try:
        # LM Studio logs (optional): stream to stdout
        if STREAM_LLM_SERVER_LOGS:
            lms_server_log_proc = start_lms_log_stream("server", extra_args=["--json"])
            lms_model_log_proc = start_lms_log_stream("model", extra_args=["--filter", "input,output", "--json"])

        if not server_already_running:
            # Use non-watch startup scripts in integration runs to avoid hot-reload restarts.
            server_proc = start_process(
                ["bun", "--cwd", "apps/server", "--env-file", "../../.env", "start"]
            )
            started_server = True

        print("Waiting for server health...")
        server_health_started_at = _now()
        deadline = _mono_now() + SERVER_HEALTH_TIMEOUT_SEC
        while _mono_now() < deadline:
            if server_proc:
                assert_proc_alive(server_proc, "server")
            if wait_for_server(1.0):
                break
        else:
            raise RuntimeError(f"server start timeout (url={SERVER_URL})")
        _print_duration("server health wait", server_health_started_at)

        # Start RemoteBuddy only after server health is confirmed.
        remotebuddy_env = {
            "REMOTEBUDDY_FETCH_FAILURE_LOGS": E2E_REMOTEBUDDY_FETCH_FAILURE_LOGS,
        }
        remotebuddy_proc = start_process(
            [
                "bun",
                "--cwd",
                "apps/remotebuddy",
                "--env-file",
                "../../.env",
                "start",
                "--",
                "--server",
                SERVER_URL,
                "--sessionId",
                run_session_id,
            ],
            env=remotebuddy_env,
        )
        started_remotebuddy = True
        assert_proc_alive(remotebuddy_proc, "remotebuddy")

        if E2E_USE_DOCKER:
            backends_to_try = ["openhands", "miniswe"]
        else:
            backends_to_try = _detect_available_backends()
            if not backends_to_try:
                raise RuntimeError(
                    "No supported executor dependencies found. Install at least one:\n"
                    "- OpenHands: pip install openhands-ai\n"
                    "- mini-swe-agent: pip install mini-swe-agent"
                )
        if REQUESTED_BACKENDS:
            filtered_backends = [backend for backend in backends_to_try if backend in REQUESTED_BACKENDS]
            if not filtered_backends:
                raise RuntimeError(
                    "WORKERPALS_E2E_BACKENDS did not match available backends.\n"
                    f"requested={REQUESTED_BACKENDS}\n"
                    f"available={backends_to_try}"
                )
            print(f"[NOTICE] Restricting backends via WORKERPALS_E2E_BACKENDS: {filtered_backends}")
            backends_to_try = filtered_backends

        eval_scenarios: list[dict] = []
        if E2E_EVAL_MODE:
            if E2E_EVAL_SCENARIOS_FILE:
                eval_scenarios = _load_eval_scenarios_from_file(E2E_EVAL_SCENARIOS_FILE)
            if not eval_scenarios:
                builtin = _builtin_eval_scenarios()
                if E2E_EVAL_SCENARIO_SUITE == "quick":
                    eval_scenarios = builtin[:1]
                elif E2E_EVAL_SCENARIO_SUITE == "real-lite":
                    eval_scenarios = [
                        item for item in builtin if str(item.get("difficulty") or "").lower() in {"medium", "hard"}
                    ] or builtin
                elif E2E_EVAL_SCENARIO_SUITE in {"real-hard", "hard"}:
                    eval_scenarios = [
                        item for item in builtin if str(item.get("difficulty") or "").lower() == "hard"
                    ] or builtin
                elif E2E_EVAL_SCENARIO_SUITE in {"real", "default"}:
                    eval_scenarios = builtin
                else:
                    eval_scenarios = builtin
            print(
                "[NOTICE] Eval scenarios loaded: "
                f"{[str(item.get('id')) for item in eval_scenarios]} "
                f"(suite={E2E_EVAL_SCENARIO_SUITE}, per_backend={E2E_EVAL_SCENARIOS_PER_BACKEND}, "
                f"strategy={E2E_EVAL_SCENARIO_STRATEGY})"
            )
        attempted = 0

        for backend in backends_to_try:
            if E2E_EVAL_TOTAL_BUDGET_SEC > 0:
                elapsed_total = _now() - total_started_at
                if elapsed_total >= E2E_EVAL_TOTAL_BUDGET_SEC:
                    failures.append(
                        "overall: runtime budget exceeded before backend start "
                        f"(elapsed={_fmt_elapsed(elapsed_total)} budget={_fmt_elapsed(E2E_EVAL_TOTAL_BUDGET_SEC)})"
                    )
                    print(
                        "[FAIL] Skipping remaining backends due to runtime budget exhaustion "
                        f"(elapsed={_fmt_elapsed(elapsed_total)} budget={_fmt_elapsed(E2E_EVAL_TOTAL_BUDGET_SEC)})"
                    )
                    break

            backend_started_at = _now()
            attempted += 1
            worker_id = f"e2e-{backend}-{uuid4().hex[:10]}"
            selected_scenarios = _select_eval_scenarios(
                all_scenarios=eval_scenarios,
                backend_index=attempted - 1,
                per_backend=E2E_EVAL_SCENARIOS_PER_BACKEND,
                strategy=E2E_EVAL_SCENARIO_STRATEGY,
            )
            active_scenario = _compose_scenario_bundle(selected_scenarios)
            request_prompt = (
                str(active_scenario.get("prompt") or REQUEST_PROMPT)
                if isinstance(active_scenario, dict)
                else REQUEST_PROMPT
            )

            print("\n==============================")
            print(f"RUNNING BACKEND: {backend}")
            print("==============================\n")
            if isinstance(active_scenario, dict):
                print(
                    "[NOTICE] Active eval scenario: "
                    f"{active_scenario.get('id')} - {active_scenario.get('title')}"
                )

            backend_eval: dict = {
                "backend": backend,
                "worker_id": worker_id,
                "scenario_id": (active_scenario or {}).get("id") if isinstance(active_scenario, dict) else None,
                "scenario_title": (active_scenario or {}).get("title") if isinstance(active_scenario, dict) else None,
                "prompt_excerpt": _one_line(request_prompt, 180),
                "status": "failed",
                "error": None,
                "request_id": None,
                "job_id": None,
                "completion_id": None,
                "clarification_retried": False,
                "warmup_sec": None,
                "phase_b_sec": None,
                "backend_total_sec": None,
                "request_queue_wait_ms": None,
                "request_duration_ms": None,
                "request_claim_to_complete_ms": None,
                "job_duration_ms": None,
                "job_queue_wait_ms": None,
                "job_claim_to_finish_ms": None,
                "dimensions": {},
                "quality_evidence": {},
                "checks": {},
                "score": 0.0,
            }
            warmup_started_at: float | None = None
            phase_b_started_at: float | None = None

            worker_env = {
                "WORKERPALS_EXECUTOR": backend,
                "WORKERPALS_DEBUG": E2E_WORKERPALS_DEBUG,
            }
            if backend == "miniswe":
                worker_env["WORKERPALS_MINISWE_TOOL_BROKER"] = os.environ.get(
                    "WORKERPALS_E2E_MINISWE_TOOL_BROKER", "1"
                )
            worker_cmd = [
                "bun",
                "--cwd",
                "apps/workerpals",
                "--env-file",
                "../../.env",
                "start",
                "--",
                "--server",
                SERVER_URL,
                "--repo",
                str(repo),
                "--base-ref",
                "HEAD",
                "--poll",
                "1000",
                "--heartbeat",
                "2000",
                "--workerId",
                worker_id,
            ]
            if E2E_USE_DOCKER:
                worker_cmd.extend(["--docker", "--require-docker"])
                worker_cmd.extend(["--docker-image", E2E_DOCKER_IMAGE_EFFECTIVE])
                if E2E_DOCKER_NETWORK:
                    worker_cmd.extend(["--docker-network", E2E_DOCKER_NETWORK])
                if E2E_DOCKER_TIMEOUT_MS:
                    worker_cmd.extend(["--docker-timeout", E2E_DOCKER_TIMEOUT_MS])
                if E2E_DOCKER_IDLE_TIMEOUT_MS:
                    worker_cmd.extend(["--docker-idle-timeout", E2E_DOCKER_IDLE_TIMEOUT_MS])

            worker_proc = start_process(worker_cmd, env=worker_env)
            started_worker = True

            try:
                worker_online = wait_for_worker_online(worker_id, timeout_sec=25.0)
                if not worker_online:
                    raise RuntimeError(f"Worker {worker_id} did not report online in time")
                if ENFORCE_SINGLE_WORKER:
                    assert_only_worker_online(worker_id)
                else:
                    online = [
                        str(w.get("workerId") or "")
                        for w in list_workers(ttl_ms=_WORKER_ONLINE_TTL_MS)
                        if bool(w.get("isOnline")) and str(w.get("workerId") or "").strip()
                    ]
                    others = [wid for wid in online if wid != worker_id]
                    if others:
                        print(
                            "[NOTICE] Multiple workers online; continuing because "
                            "WORKERPALS_E2E_ENFORCE_SINGLE_WORKER is disabled."
                        )
                        _debug(f"online_workers={online}")

                warmup_started_at = _now()
                print(f"Server healthy â€” enqueueing warmup job ({backend})")
                warmup_body = {
                    "taskId": f"test-workerpal-e2e-warmup-{backend}-{worker_id}",
                    "sessionId": run_session_id,
                    "kind": "warmup.execute",
                    "params": {},
                    "targetWorkerId": worker_id,
                }
                enq = http_post("/jobs/enqueue", warmup_body)
                if not enq.get("ok") or not enq.get("jobId"):
                    raise RuntimeError(f"Failed to enqueue warmup job: {enq}")
                warmup_job_id = enq["jobId"]
                print(f"Enqueued job {warmup_job_id}")

                deadline = _mono_now() + WARMUP_TIMEOUT_SEC
                last = None
                warmup_ticker = _ElapsedTicker(f"{backend} warmup waiting", warmup_started_at)
                warmup_ticker.start()
                try:
                    while _mono_now() < deadline:
                        if (
                            E2E_EVAL_BACKEND_BUDGET_SEC > 0
                            and (_now() - backend_started_at) >= E2E_EVAL_BACKEND_BUDGET_SEC
                        ):
                            raise RuntimeError(
                                "Per-backend eval budget exceeded during warmup "
                                f"(budget={_fmt_elapsed(E2E_EVAL_BACKEND_BUDGET_SEC)})"
                            )
                        if (
                            E2E_EVAL_TOTAL_BUDGET_SEC > 0
                            and (_now() - total_started_at) >= E2E_EVAL_TOTAL_BUDGET_SEC
                        ):
                            raise RuntimeError(
                                "Global eval budget exceeded during warmup "
                                f"(budget={_fmt_elapsed(E2E_EVAL_TOTAL_BUDGET_SEC)})"
                            )
                        if server_proc:
                            assert_proc_alive(server_proc, "server")
                        assert_proc_alive(remotebuddy_proc, "remotebuddy")
                        assert_proc_alive(worker_proc, "workerpals")

                        j = get_job(warmup_job_id)
                        if j:
                            st = j.get("status")
                            if st != last:
                                print(f"  job status: {st}")
                                last = st
                            if st == "failed":
                                raise RuntimeError(f"Warmup job failed ({backend}): {j.get('error') or j}")
                            if st == "completed":
                                print("[OK] warmup.execute completed")
                                _print_duration(f"{backend} warmup.execute", warmup_started_at)
                                break
                        time.sleep(POLL_INTERVAL_SEC)
                    else:
                        raise RuntimeError(f"Warmup job did not complete in time ({backend})")
                finally:
                    warmup_ticker.stop()
                backend_eval["warmup_sec"] = round(_now() - warmup_started_at, 3)

                print("\n==============================")
                print(f"PHASE B: REMOTEBUDDY REQUEST -> COMPLETION INTERCEPT ({backend})")
                print("==============================\n")
                phase_b_started_at = _now()

                completions_before = http_get(
                    f"/completions?status=all&limit={LIST_SCAN_LIMIT}"
                ).get("completions", [])
                existing_completion_ids = {
                    str(c.get("id")) for c in completions_before if isinstance(c, dict) and c.get("id")
                }
                jobs_before = http_get(f"/jobs?status=all&limit={LIST_SCAN_LIMIT}").get("jobs", [])
                existing_job_ids = {
                    str(j.get("id")) for j in jobs_before if isinstance(j, dict) and j.get("id")
                }

                request_body = {
                    "sessionId": run_session_id,
                    "prompt": request_prompt,
                    "priority": "normal",
                    "forceWorker": True,
                    "forceLane": "worker",
                }
                print(f"Enqueueing request: {request_prompt!r}")
                request_enqueue_monotonic = _mono_now()
                enq_req = http_post("/requests/enqueue", request_body)
                request_id = enq_req.get("requestId")
                if not enq_req.get("ok") or not request_id:
                    raise RuntimeError(f"Failed to enqueue request: {enq_req}")
                print(f"Enqueued request {request_id}")
                clarification_retried = False

                deadline = _mono_now() + REQUEST_TIMEOUT_SEC
                last_request_status = None
                intercepted_completion: dict | None = None
                matched_failed_job: dict | None = None
                next_completion_poll_at = 0.0
                next_job_poll_at = 0.0
                phase_b_ticker = _ElapsedTicker(f"{backend} phase B waiting", phase_b_started_at)
                phase_b_ticker.start()

                try:
                    while _mono_now() < deadline:
                        if (
                            E2E_EVAL_BACKEND_BUDGET_SEC > 0
                            and (_now() - backend_started_at) >= E2E_EVAL_BACKEND_BUDGET_SEC
                        ):
                            raise RuntimeError(
                                "Per-backend eval budget exceeded during request/completion phase "
                                f"(budget={_fmt_elapsed(E2E_EVAL_BACKEND_BUDGET_SEC)})"
                            )
                        if (
                            E2E_EVAL_TOTAL_BUDGET_SEC > 0
                            and (_now() - total_started_at) >= E2E_EVAL_TOTAL_BUDGET_SEC
                        ):
                            raise RuntimeError(
                                "Global eval budget exceeded during request/completion phase "
                                f"(budget={_fmt_elapsed(E2E_EVAL_TOTAL_BUDGET_SEC)})"
                            )
                        if server_proc:
                            assert_proc_alive(server_proc, "server")
                        assert_proc_alive(remotebuddy_proc, "remotebuddy")
                        assert_proc_alive(worker_proc, "workerpals")

                        req = get_request(str(request_id))
                        if req:
                            req_status = req.get("status")
                            if req_status != last_request_status:
                                print(f"  request status: {req_status}")
                                last_request_status = req_status
                            if req_status == "failed":
                                if (not clarification_retried) and _request_failed_due_to_clarification(req):
                                    clarification_retried = True
                                    clarification_prompt = request_prompt + CLARIFICATION_RETRY_SUFFIX
                                    retry_body = {
                                        "sessionId": run_session_id,
                                        "prompt": clarification_prompt,
                                        "priority": "normal",
                                        "forceWorker": True,
                                        "forceLane": "worker",
                                    }
                                    print(
                                        "[NOTICE] Clarification requested by worker. "
                                        "Sending one clarification retry with explicit instruction."
                                    )
                                    request_enqueue_monotonic = _mono_now()
                                    retry_enq = http_post("/requests/enqueue", retry_body)
                                    retry_request_id = retry_enq.get("requestId")
                                    if not retry_enq.get("ok") or not retry_request_id:
                                        raise RuntimeError(
                                            f"Clarification retry enqueue failed ({backend}): {retry_enq}"
                                        )
                                    request_id = retry_request_id
                                    last_request_status = None
                                    completions_after_retry = http_get(
                                        f"/completions?status=all&limit={LIST_SCAN_LIMIT}"
                                    ).get("completions", [])
                                    existing_completion_ids = {
                                        str(c.get("id"))
                                        for c in completions_after_retry
                                        if isinstance(c, dict) and c.get("id")
                                    }
                                    jobs_after_retry = http_get(
                                        f"/jobs?status=all&limit={LIST_SCAN_LIMIT}"
                                    ).get("jobs", [])
                                    existing_job_ids = {
                                        str(j.get("id"))
                                        for j in jobs_after_retry
                                        if isinstance(j, dict) and j.get("id")
                                    }
                                    next_completion_poll_at = 0.0
                                    next_job_poll_at = 0.0
                                    print(f"Enqueued clarification retry request {request_id}")
                                    continue
                                raise RuntimeError(f"Request failed ({backend}): {req.get('error') or req}")

                        now = _mono_now()
                        if now >= next_completion_poll_at:
                            completions = http_get(
                                f"/completions?status=all&limit={LIST_SCAN_LIMIT}"
                            ).get("completions", [])
                            for c in completions:
                                if not isinstance(c, dict):
                                    continue
                                completion_id = str(c.get("id") or "")
                                if not completion_id or completion_id in existing_completion_ids:
                                    continue
                                if str(c.get("sessionId") or "") != run_session_id:
                                    continue
                                if not _completion_matches_request(
                                    c,
                                    str(request_id),
                                    enqueue_monotonic=request_enqueue_monotonic,
                                ):
                                    continue
                                intercepted_completion = c
                                break
                            next_completion_poll_at = now + COMPLETION_POLL_INTERVAL_SEC

                        if now >= next_job_poll_at:
                            jobs = http_get(f"/jobs?status=all&limit={LIST_SCAN_LIMIT}").get("jobs", [])
                            for j in jobs:
                                if not isinstance(j, dict):
                                    continue
                                job_id = str(j.get("id") or "")
                                if not job_id or job_id in existing_job_ids:
                                    continue
                                if str(j.get("sessionId") or "") != run_session_id:
                                    continue
                                if str(j.get("status") or "").strip().lower() != "failed":
                                    continue
                                if not _job_matches_request(
                                    j,
                                    str(request_id),
                                    worker_id=worker_id,
                                    enqueue_monotonic=request_enqueue_monotonic,
                                ):
                                    continue
                                matched_failed_job = j
                                break
                            next_job_poll_at = now + COMPLETION_POLL_INTERVAL_SEC

                        if matched_failed_job:
                            job_id = str(matched_failed_job.get("id") or "")
                            job_error = _one_line(matched_failed_job.get("error"), 400)
                            raise RuntimeError(
                                "Observed failed worker job before completion interception.\n"
                                f"backend={backend} request_id={request_id} job_id={job_id}\n"
                                f"job_error={job_error}"
                            )

                        if intercepted_completion:
                            break

                        time.sleep(POLL_INTERVAL_SEC)

                    if not intercepted_completion:
                        raise RuntimeError(
                            "Did not observe a new completion enqueue payload.\n"
                            f"backend={backend} request_id={request_id} last_request_status={last_request_status}\n"
                        )
                finally:
                    phase_b_ticker.stop()

                print("\n===== INTERCEPTED COMPLETION PAYLOAD =====")
                print(json.dumps(intercepted_completion, indent=2, ensure_ascii=False))
                print(f"[OK] Backend {backend} produced a completion enqueue payload.")
                _print_duration(f"{backend} phase B completion intercept", phase_b_started_at)
                backend_eval["phase_b_sec"] = round(_now() - phase_b_started_at, 3)
                backend_eval["status"] = "passed"
                backend_eval["clarification_retried"] = clarification_retried
                backend_eval["request_id"] = str(request_id)
                backend_eval["completion_id"] = str(intercepted_completion.get("id") or "")

                completion_job_id = str(intercepted_completion.get("jobId") or "")
                backend_eval["job_id"] = completion_job_id or None
                completion_commit_sha = str(intercepted_completion.get("commitSha") or "")
                completion_pr_title = str(intercepted_completion.get("prTitle") or "")
                completion_pr_body = str(intercepted_completion.get("prBody") or "")

                request_snapshot = get_request(str(request_id))
                backend_eval.update(_extract_request_eval_metrics(request_snapshot))
                job_snapshot = get_job(completion_job_id) if completion_job_id else None
                backend_eval.update(_extract_job_eval_metrics(job_snapshot))

                quality_eval = _evaluate_backend_quality_dimensions(
                    repo=Path(repo),
                    scenario=active_scenario if isinstance(active_scenario, dict) else None,
                    commit_sha=completion_commit_sha,
                    backend_total_sec=float(_now() - backend_started_at),
                    clarification_retried=clarification_retried,
                    job_duration_ms=backend_eval.get("job_duration_ms"),
                )
                backend_eval["dimensions"] = quality_eval.get("dimensions", {})
                backend_eval["quality_evidence"] = {
                    "changed_files": quality_eval.get("changed_files", []),
                    "unexpected_files": quality_eval.get("unexpected_files", []),
                    "must_contain_failed": quality_eval.get("must_contain_failed", []),
                    "line_delta": quality_eval.get("line_delta", {}),
                }
                backend_eval["score"] = quality_eval.get("score", 0.0)

                checks = {
                    "completion_has_commit_sha": bool(completion_commit_sha),
                    "completion_has_pr_metadata": bool(completion_pr_title and completion_pr_body),
                    "planned_scope_root_dot": _completion_planned_scope_is_root(intercepted_completion),
                    "job_duration_known": backend_eval.get("job_duration_ms") is not None,
                }
                backend_eval["checks"] = checks

            except Exception as backend_exc:
                failures.append(f"{backend}: {backend_exc}")
                print(f"[FAIL] Backend {backend}: {backend_exc}")
                backend_eval["status"] = "failed"
                backend_eval["error"] = str(backend_exc)
            finally:
                backend_eval["backend_total_sec"] = round(_now() - backend_started_at, 3)
                if (
                    E2E_EVAL_BACKEND_BUDGET_SEC > 0
                    and float(backend_eval.get("backend_total_sec") or 0.0) > E2E_EVAL_BACKEND_BUDGET_SEC
                ):
                    budget_message = (
                        f"{backend}: exceeded per-backend budget "
                        f"(total={_fmt_elapsed(float(backend_eval.get('backend_total_sec') or 0.0))} "
                        f"budget={_fmt_elapsed(E2E_EVAL_BACKEND_BUDGET_SEC)})"
                    )
                    if budget_message not in failures:
                        failures.append(budget_message)
                    backend_eval["status"] = "failed"
                    backend_eval["error"] = str(backend_eval.get("error") or budget_message)
                if backend_eval.get("warmup_sec") is None and warmup_started_at is not None:
                    backend_eval["warmup_sec"] = round(max(0.0, _now() - warmup_started_at), 3)
                if backend_eval.get("phase_b_sec") is None and phase_b_started_at is not None:
                    backend_eval["phase_b_sec"] = round(max(0.0, _now() - phase_b_started_at), 3)
                backend_eval["score"] = _score_backend_eval_row(backend_eval)
                backend_eval_results.append(backend_eval)
                _print_duration(f"{backend} total runtime", backend_started_at)
                if worker_proc and started_worker:
                    kill_proc_tree(worker_proc)
                    worker_proc = None
                    started_worker = False
                    # Wait for the server to detect the killed worker as offline
                    # before starting the next backend (prevents "multiple workers" error).
                    if not wait_for_worker_offline(worker_id, timeout_sec=20.0):
                        print(f"[WARN] Worker {worker_id} still appears online after kill; proceeding anyway")

        if attempted == 0:
            raise RuntimeError("No executor backends were attempted. Install OpenHands or configure mini-swe.")
        eval_summary = _emit_eval_summary(
            backend_eval_results,
            total_runtime_sec=_now() - total_started_at,
            output_path=E2E_EVAL_OUTPUT,
            total_budget_sec=E2E_EVAL_TOTAL_BUDGET_SEC,
        )
        if E2E_EVAL_MODE and not bool(eval_summary.get("within_budget")):
            failures.append(
                "overall: runtime budget exceeded "
                f"(total={_fmt_elapsed(float(eval_summary.get('total_runtime_sec') or 0.0))} "
                f"budget={_fmt_elapsed(E2E_EVAL_TOTAL_BUDGET_SEC)})"
            )
        if failures:
            raise RuntimeError("One or more backend runs failed:\n- " + "\n- ".join(failures))

        print("Done - PushPals E2E intercepted completion enqueue payload(s)")
        _print_duration("overall test runtime", total_started_at)
    finally:
        cleanup()

        if lms_model_log_proc:
            stop_lms_log_stream(lms_model_log_proc)
        if lms_server_log_proc:
            stop_lms_log_stream(lms_server_log_proc)
        if isolated_worker_repo_root is not None:
            shutil.rmtree(isolated_worker_repo_root, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        _INTERRUPTED = True
        cleanup()
        raise SystemExit(130)
    except Exception as e:
        print("Error:", e)
        sys.exit(1)

