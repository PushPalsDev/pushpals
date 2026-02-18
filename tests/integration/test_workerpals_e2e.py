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
SERVER_HEALTH_TIMEOUT_SEC = 60
WARMUP_TIMEOUT_SEC = 60
REQUEST_TIMEOUT_SEC = 10 * 60
POLL_INTERVAL_SEC = 0.5
HTTP_TIMEOUT_SEC = 15
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


def _git_main_commit_sha() -> str:
    refs_to_try = ("refs/heads/main", "refs/remotes/origin/main", "HEAD")
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
    raise RuntimeError("Unable to resolve git commit for main/HEAD when preparing Docker image.")


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
    expected_main_sha = _git_main_commit_sha()
    image_exists = _docker_image_exists(image)
    current_label_sha = _docker_image_label(image, _DOCKER_IMAGE_MAIN_SHA_LABEL) if image_exists else None
    if image_exists and current_label_sha == expected_main_sha:
        print(f"[NOTICE] Docker image already present and current for main@{expected_main_sha[:12]}: {image}")
        return
    if image_exists:
        if current_label_sha:
            print(
                "[NOTICE] Docker image exists but is stale for main branch; rebuilding.\n"
                f"  image={image}\n"
                f"  image_main_sha={current_label_sha[:12]}\n"
                f"  expected_main_sha={expected_main_sha[:12]}"
            )
        else:
            print(
                "[NOTICE] Docker image exists without main-sha label; rebuilding.\n"
                f"  image={image}\n"
                f"  expected_main_sha={expected_main_sha[:12]}"
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
        attempted = 0

        for backend in backends_to_try:
            backend_started_at = _now()
            attempted += 1
            print("\n==============================")
            print(f"RUNNING BACKEND: {backend}")
            print("==============================\n")

            worker_id = f"e2e-{backend}-{uuid4().hex[:10]}"
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
                print(f"Server healthy — enqueueing warmup job ({backend})")
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
                    "prompt": REQUEST_PROMPT,
                    "priority": "normal",
                    "forceWorker": True,
                    "forceLane": "worker",
                }
                print(f"Enqueueing request: {REQUEST_PROMPT!r}")
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
                                    clarification_prompt = REQUEST_PROMPT + CLARIFICATION_RETRY_SUFFIX
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

            except Exception as backend_exc:
                failures.append(f"{backend}: {backend_exc}")
                print(f"[FAIL] Backend {backend}: {backend_exc}")
            finally:
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
        if failures:
            raise RuntimeError("One or more backend runs failed:\n- " + "\n- ".join(failures))

        print("Done — PushPals E2E intercepted completion enqueue payload(s)")
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
