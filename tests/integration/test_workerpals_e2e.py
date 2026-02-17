#!/usr/bin/env python3
"""PushPals end-to-end smoke test: start stack, run warmup + real LLM request.

Phase A: warmup.execute (fast, proves WorkerPals can claim + complete jobs)
Phase B: /requests/enqueue -> RemoteBuddy claims -> /jobs/enqueue -> WorkerPals executes (LLM) ->
         /jobs/:id/complete -> SourceControlManager processes completion -> final text asserted.

Run from repo root. Requires bun, git, node on PATH.
Optional: If LM Studio is running and `lms` CLI is on PATH, captures LM Studio logs.

This script is careful to:
- Keep isolation by default: fail fast if a server is already running at SERVER_URL.
- Kill processes it started on Ctrl+C / SIGTERM / normal exit (best-effort).

NOTE: This version prints EVERYTHING to stdout/stderr (no per-process log files).
"""

from __future__ import annotations

import atexit
import importlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPO_ROOT = Path(__file__).resolve().parents[2]

SERVER_URL = os.environ.get("PUSHPALS_SERVER_URL", "http://127.0.0.1:3001")
STREAM_LLM_SERVER_LOGS = (
    os.environ.get("WORKERPALS_E2E_STREAM_LLM_LOGS", "0").strip().lower()
    in {"1", "true", "yes", "on"}
)
SERVER_HEALTH_TIMEOUT_SEC = 60
WARMUP_TIMEOUT_SEC = 60
REQUEST_TIMEOUT_SEC = 10 * 60
POLL_INTERVAL_SEC = 0.5
HTTP_TIMEOUT_SEC = 15

REQUEST_PROMPT = os.environ.get(
    "WORKERPALS_E2E_PROMPT",
    "Append exactly one line 'WorkerPals E2E marker' to README.md and keep all other content unchanged.",
)
CLARIFICATION_RETRY_SUFFIX = (
    "\n\nClarification: apply the requested change to README.md in the repository root. "
    "Do not ask any other follow-up questions."
)

DEFAULT_PROFILE = os.environ.get("PUSHPALS_PROFILE", "dev")
DEFAULT_SESSION_ID = os.environ.get("PUSHPALS_SESSION_ID", "dev")
FAIL_IF_SERVER_RUNNING = (
    os.environ.get("WORKERPALS_E2E_FAIL_IF_SERVER_RUNNING", "1").strip().lower()
    in {"1", "true", "yes", "on"}
)
KILL_SERVER_IF_RUNNING = (
    os.environ.get("WORKERPALS_E2E_KILL_SERVER_IF_RUNNING", "1").strip().lower()
    in {"1", "true", "yes", "on"}
)

# Globals used by cleanup handlers
server_proc = None
worker_proc = None
remotebuddy_proc = None
scm_proc = None
started_server = False
started_worker = False
started_remotebuddy = False
started_scm = False
_CLEANED_UP = False


def _now() -> float:
    return time.perf_counter()


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


def _kill_existing_server_processes() -> None:
    if sys.platform == "win32":
        cmd = (
            "Get-CimInstance Win32_Process | "
            "Where-Object { "
            "  ($_.Name -ieq 'bun.exe' -or $_.Name -ieq 'node.exe') -and "
            "  ($_.CommandLine -match 'apps[\\\\/]server' -or $_.CommandLine -match 'server:only') "
            "} | "
            "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
        )
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", cmd],
            check=False,
            capture_output=True,
            text=True,
        )
    else:
        subprocess.run(
            ["pkill", "-f", "apps/server|server:only"],
            check=False,
            capture_output=True,
            text=True,
        )


def _docker_image_exists(image: str) -> bool:
    try:
        proc = subprocess.run(
            ["docker", "image", "inspect", image],
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
        )
        return proc.returncode == 0
    except Exception:
        return False


def _ensure_docker_image(image: str) -> None:
    if _docker_image_exists(image):
        print(f"[NOTICE] Docker image already present: {image}")
        return
    print(f"[NOTICE] Docker image not found locally; building: {image}")
    proc = subprocess.run(
        [
            "docker",
            "build",
            "-f",
            "apps/workerpals/Dockerfile.sandbox",
            "-t",
            image,
            ".",
        ],
        cwd=str(REPO_ROOT),
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
                env=DEFAULT_ENV,
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
                env=DEFAULT_ENV,
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
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = http_get("/healthz")
            if r.get("ok"):
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def wait_for_server_down(timeout=5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            http_get("/healthz")
        except Exception:
            return True
        time.sleep(0.25)
    return False


def get_job(job_id: str) -> dict | None:
    # Server doesn't appear to expose GET /jobs/:id; fall back to listing.
    try:
        jobs = http_get("/jobs?status=all&limit=200")
        for j in jobs.get("jobs", []):
            if j.get("id") == job_id:
                return j
    except Exception:
        pass
    return None


def get_request(request_id: str) -> dict | None:
    # Server doesn't appear to expose GET /requests/:id; fall back to listing.
    try:
        reqs = http_get("/requests?status=all&limit=200")
        for r in reqs.get("requests", []):
            if r.get("id") == request_id:
                return r
    except Exception:
        pass
    return None


def get_completion(completion_id: str) -> dict | None:
    # Server doesn't appear to expose GET /completions/:id; fall back to listing.
    try:
        cs = http_get("/completions?status=all&limit=200")
        for c in cs.get("completions", []):
            if c.get("id") == completion_id:
                return c
    except Exception:
        pass
    return None


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
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
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
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
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


def find_completion_for_request(request_id: str, task_id: str) -> dict | None:
    try:
        cs = http_get("/completions?status=all&limit=200")
        for c in cs.get("completions", []):
            if c.get("requestId") == request_id or c.get("request_id") == request_id:
                return c
            if c.get("taskId") == task_id or c.get("task_id") == task_id:
                return c
    except Exception:
        pass
    return None


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
def start_process(cmd, cwd=REPO_ROOT, env=None):
    """Start a process inheriting stdout/stderr (prints directly to console)."""
    run_env = DEFAULT_ENV.copy()
    if env:
        run_env.update(env)

    if sys.platform == "win32":
        cmd_str = cmd if isinstance(cmd, str) else " ".join(map(str, cmd))
        proc = subprocess.Popen(
            cmd_str,
            cwd=str(cwd),
            env=run_env,
            stdout=None,  # inherit
            stderr=None,  # inherit
            shell=True,
            text=True,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,  # type: ignore[attr-defined]
        )
    else:
        proc = subprocess.Popen(
            cmd,
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
    global server_proc, worker_proc, remotebuddy_proc, scm_proc
    global started_server, started_worker, started_remotebuddy, started_scm

    if _CLEANED_UP:
        return
    _CLEANED_UP = True

    # Stop in reverse-dependency order.
    if scm_proc and started_scm:
        kill_proc_tree(scm_proc)
        scm_proc = None

    if worker_proc and started_worker:
        kill_proc_tree(worker_proc)
        worker_proc = None

    if remotebuddy_proc and started_remotebuddy:
        kill_proc_tree(remotebuddy_proc)
        remotebuddy_proc = None

    if server_proc and started_server:
        kill_proc_tree(server_proc)
        server_proc = None
        wait_for_server_down(5.0)


def _handle_signal(signum, frame):
    cleanup()
    raise SystemExit(130)


def install_cleanup_handlers():
    atexit.register(cleanup)
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)


# -----------------------------
# Init env early
# -----------------------------
os.environ["PUSHPALS_REPO_PATH"] = str(REPO_ROOT)
os.environ["PYTHONIOENCODING"] = "utf-8"

_ensure_env_from_example(REPO_ROOT)
_load_dotenv(REPO_ROOT / ".env")
_load_dotenv(REPO_ROOT / ".env.local")
_load_local_toml_for_llm(REPO_ROOT / "config" / "local.toml")

E2E_USE_DOCKER = _is_truthy(os.environ.get("WORKERPALS_E2E_DOCKER", "1"))
E2E_DOCKER_IMAGE = (os.environ.get("WORKERPALS_E2E_DOCKER_IMAGE") or "").strip()
E2E_DOCKER_NETWORK = (os.environ.get("WORKERPALS_E2E_DOCKER_NETWORK") or "").strip()
E2E_DOCKER_TIMEOUT_MS = (os.environ.get("WORKERPALS_E2E_DOCKER_TIMEOUT_MS") or "").strip()
E2E_DOCKER_IDLE_TIMEOUT_MS = (os.environ.get("WORKERPALS_E2E_DOCKER_IDLE_TIMEOUT_MS") or "").strip()
E2E_DOCKER_IMAGE_EFFECTIVE = E2E_DOCKER_IMAGE or "pushpals-worker-sandbox:latest"

DEFAULT_ENV = os.environ.copy()


def main():
    global server_proc, worker_proc, remotebuddy_proc, scm_proc
    global started_server, started_worker, started_remotebuddy, started_scm

    install_cleanup_handlers()
    total_started_at = _now()

    run_session_id = f"{DEFAULT_SESSION_ID}-e2e-{int(time.time())}-{os.getpid()}"
    print("PushPals E2E test: starting server + remotebuddy + workerpals (no SCM)")
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
    failures: list[str] = []

    server_already_running = wait_for_server(2.0)
    started_server = False
    started_worker = False
    started_remotebuddy = False
    started_scm = False

    if server_already_running and KILL_SERVER_IF_RUNNING:
        print(f"[NOTICE] Server already running at {SERVER_URL}; killing existing server processes...")
        _kill_existing_server_processes()
        if not wait_for_server_down(8.0):
            raise RuntimeError(
                "Tried to kill existing server processes, but server still responds.\n"
                f"server={SERVER_URL}\n"
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
            server_proc = start_process(["bun", "run", "server:only"])
            started_server = True

        # Start RemoteBuddy (SCM intentionally omitted for this test).
        remotebuddy_proc = start_process(
            ["bun", "run", "remotebuddy:only", "--", "--sessionId", run_session_id],
        )
        started_remotebuddy = True

        print("Waiting for server health...")
        server_health_started_at = _now()
        deadline = time.time() + SERVER_HEALTH_TIMEOUT_SEC
        while time.time() < deadline:
            if server_proc:
                assert_proc_alive(server_proc, "server")
            assert_proc_alive(remotebuddy_proc, "remotebuddy")
            if wait_for_server(1.0):
                break
        else:
            raise RuntimeError(f"server start timeout (url={SERVER_URL})")
        _print_duration("server health wait", server_health_started_at)

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
        attempted = 0

        for backend in backends_to_try:
            backend_started_at = _now()
            attempted += 1
            print("\n==============================")
            print(f"RUNNING BACKEND: {backend}")
            print("==============================\n")

            worker_id = f"e2e-{backend}-{int(time.time() * 1000) % 100000000:08d}"
            worker_env = {"WORKERPALS_EXECUTOR": backend}
            worker_cmd = [
                "bun",
                "run",
                "workerpals:only",
                "--",
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
                assert_only_worker_online(worker_id)

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

                deadline = time.time() + WARMUP_TIMEOUT_SEC
                last = None
                warmup_ticker = _ElapsedTicker(f"{backend} warmup waiting", warmup_started_at)
                warmup_ticker.start()
                try:
                    while time.time() < deadline:
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

                completions_before = http_get("/completions?status=all&limit=500").get("completions", [])
                existing_completion_ids = {
                    str(c.get("id")) for c in completions_before if isinstance(c, dict) and c.get("id")
                }

                request_body = {
                    "sessionId": run_session_id,
                    "prompt": REQUEST_PROMPT,
                    "priority": "normal",
                    "forceWorker": True,
                    "forceLane": "worker",
                }
                print(f"Enqueueing request: {REQUEST_PROMPT!r}")
                enq_req = http_post("/requests/enqueue", request_body)
                request_id = enq_req.get("requestId")
                if not enq_req.get("ok") or not request_id:
                    raise RuntimeError(f"Failed to enqueue request: {enq_req}")
                print(f"Enqueued request {request_id}")
                clarification_retried = False

                deadline = time.time() + REQUEST_TIMEOUT_SEC
                last_request_status = None
                intercepted_completion: dict | None = None
                phase_b_ticker = _ElapsedTicker(f"{backend} phase B waiting", phase_b_started_at)
                phase_b_ticker.start()

                try:
                    while time.time() < deadline:
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
                                    retry_enq = http_post("/requests/enqueue", retry_body)
                                    retry_request_id = retry_enq.get("requestId")
                                    if not retry_enq.get("ok") or not retry_request_id:
                                        raise RuntimeError(
                                            f"Clarification retry enqueue failed ({backend}): {retry_enq}"
                                        )
                                    request_id = retry_request_id
                                    last_request_status = None
                                    print(f"Enqueued clarification retry request {request_id}")
                                    continue
                                raise RuntimeError(f"Request failed ({backend}): {req.get('error') or req}")

                        completions = http_get("/completions?status=all&limit=500").get("completions", [])
                        for c in completions:
                            if not isinstance(c, dict):
                                continue
                            completion_id = str(c.get("id") or "")
                            if not completion_id or completion_id in existing_completion_ids:
                                continue
                            if str(c.get("sessionId") or "") != run_session_id:
                                continue
                            intercepted_completion = c
                            break

                        if intercepted_completion:
                            break

                        time.sleep(POLL_INTERVAL_SEC)

                    if not intercepted_completion:
                        raise RuntimeError(
                            "Did not observe a new completion enqueue (SCM-bound payload).\n"
                            f"backend={backend} request_id={request_id} last_request_status={last_request_status}\n"
                        )
                finally:
                    phase_b_ticker.stop()

                print("\n===== INTERCEPTED COMPLETION (to SCM queue) =====")
                print(json.dumps(intercepted_completion, indent=2, ensure_ascii=False))
                print(f"[OK] Backend {backend} produced a completion enqueue for SCM.")
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

        print("Done — PushPals E2E intercepted SCM-bound completion payload(s)")
        _print_duration("overall test runtime", total_started_at)
    finally:
        cleanup()

        if lms_model_log_proc:
            stop_lms_log_stream(lms_model_log_proc)
        if lms_server_log_proc:
            stop_lms_log_stream(lms_server_log_proc)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("Error:", e)
        sys.exit(1)
