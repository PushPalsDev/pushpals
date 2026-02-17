#!/usr/bin/env python3
"""PushPals end-to-end smoke test: start stack, run warmup + real LLM request.

Phase A: warmup.execute (fast, proves WorkerPals can claim + complete jobs)
Phase B: /requests/enqueue -> RemoteBuddy claims -> /jobs/enqueue -> WorkerPals executes (LLM) ->
         /jobs/:id/complete -> SourceControlManager processes completion -> final text asserted.

Run from repo root. Requires bun, git, node on PATH.
Optional: If LM Studio is running and `lms` CLI is on PATH, captures LM Studio logs.

This script is careful to:
- Avoid EADDRINUSE: if a server is already running at SERVER_URL, reuse it.
- Kill processes it started on Ctrl+C / SIGTERM / normal exit (best-effort).

NOTE: This version prints EVERYTHING to stdout/stderr (no per-process log files).
"""

from __future__ import annotations

import atexit
import importlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPO_ROOT = Path(__file__).resolve().parents[2]

SERVER_URL = os.environ.get("PUSHPALS_SERVER_URL", "http://127.0.0.1:3001")
STREAM_LLM_SERVER_LOGS = False
SERVER_HEALTH_TIMEOUT_SEC = 60
WARMUP_TIMEOUT_SEC = 60
REQUEST_TIMEOUT_SEC = 10 * 60
POLL_INTERVAL_SEC = 0.5
HTTP_TIMEOUT_SEC = 15

REQUEST_PROMPT = os.environ.get(
    "WORKERPALS_E2E_PROMPT",
    "Append exactly one line 'WorkerPals E2E marker' to README.md and keep all other content unchanged.",
)

DEFAULT_PROFILE = os.environ.get("PUSHPALS_PROFILE", "dev")
DEFAULT_SESSION_ID = os.environ.get("PUSHPALS_SESSION_ID", "dev")

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
    if STREAM_LLM_SERVER_LOGS:
        print(f"[NOTICE] Not starting LM Studio log stream for {source}...")
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
            cmd_str = " ".join(map(str, args))
            proc = subprocess.Popen(
                cmd_str,
                cwd=str(REPO_ROOT),
                env=DEFAULT_ENV,
                stdout=None,  # inherit
                stderr=None,  # inherit
                shell=True,
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
    try:
        proc.terminate()
        proc.wait(timeout=3)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


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

    print("PushPals E2E test: starting server + remotebuddy + workerpals (no SCM)")
    if E2E_USE_DOCKER:
        print("[NOTICE] WorkerPals E2E running in Docker executor mode.")
        _require_docker_available()
        _ensure_docker_image(E2E_DOCKER_IMAGE_EFFECTIVE)
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

    if server_already_running:
        print(f"[NOTICE] Server already running at {SERVER_URL}; will not start a new server process.")

    try:
        # LM Studio logs (optional): stream to stdout
        lms_server_log_proc = start_lms_log_stream("server", extra_args=["--json"])
        lms_model_log_proc = start_lms_log_stream("model", extra_args=["--filter", "input,output", "--json"])

        if not server_already_running:
            server_proc = start_process(["bun", "run", "server:only"])
            started_server = True

        # Start RemoteBuddy (SCM intentionally omitted for this test).
        remotebuddy_proc = start_process(
            ["bun", "run", "remotebuddy:only", "--", "--sessionId", DEFAULT_SESSION_ID],
        )
        started_remotebuddy = True

        print("Waiting for server health...")
        deadline = time.time() + SERVER_HEALTH_TIMEOUT_SEC
        while time.time() < deadline:
            if server_proc:
                assert_proc_alive(server_proc, "server")
            assert_proc_alive(remotebuddy_proc, "remotebuddy")
            if wait_for_server(1.0):
                break
        else:
            raise RuntimeError(f"server start timeout (url={SERVER_URL})")

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
            attempted += 1
            print("\n==============================")
            print(f"RUNNING BACKEND: {backend}")
            print("==============================\n")

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
                print(f"Server healthy — enqueueing warmup job ({backend})")
                warmup_body = {
                    "taskId": f"test-workerpal-e2e-warmup-{backend}",
                    "kind": "warmup.execute",
                    "params": {},
                }
                enq = http_post("/jobs/enqueue", warmup_body)
                if not enq.get("ok") or not enq.get("jobId"):
                    raise RuntimeError(f"Failed to enqueue warmup job: {enq}")
                warmup_job_id = enq["jobId"]
                print(f"Enqueued job {warmup_job_id}")

                deadline = time.time() + WARMUP_TIMEOUT_SEC
                last = None
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
                            break
                    time.sleep(POLL_INTERVAL_SEC)
                else:
                    raise RuntimeError(f"Warmup job did not complete in time ({backend})")

                print("\n==============================")
                print(f"PHASE B: REMOTEBUDDY REQUEST -> COMPLETION INTERCEPT ({backend})")
                print("==============================\n")

                completions_before = http_get("/completions?status=all&limit=500").get("completions", [])
                existing_completion_ids = {
                    str(c.get("id")) for c in completions_before if isinstance(c, dict) and c.get("id")
                }

                request_body = {
                    "sessionId": DEFAULT_SESSION_ID,
                    "prompt": REQUEST_PROMPT,
                    "priority": "normal",
                    "forceWorker": True,
                    "forceLane": "openhands",
                }
                print(f"Enqueueing request: {REQUEST_PROMPT!r}")
                enq_req = http_post("/requests/enqueue", request_body)
                request_id = enq_req.get("requestId")
                if not enq_req.get("ok") or not request_id:
                    raise RuntimeError(f"Failed to enqueue request: {enq_req}")
                print(f"Enqueued request {request_id}")

                deadline = time.time() + REQUEST_TIMEOUT_SEC
                last_request_status = None
                intercepted_completion: dict | None = None

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
                            raise RuntimeError(f"Request failed ({backend}): {req.get('error') or req}")

                    completions = http_get("/completions?status=all&limit=500").get("completions", [])
                    for c in completions:
                        if not isinstance(c, dict):
                            continue
                        completion_id = str(c.get("id") or "")
                        if not completion_id or completion_id in existing_completion_ids:
                            continue
                        if str(c.get("sessionId") or "") != DEFAULT_SESSION_ID:
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

                print("\n===== INTERCEPTED COMPLETION (to SCM queue) =====")
                print(json.dumps(intercepted_completion, indent=2, ensure_ascii=False))
                print(f"[OK] Backend {backend} produced a completion enqueue for SCM.")

            except Exception as backend_exc:
                failures.append(f"{backend}: {backend_exc}")
                print(f"[FAIL] Backend {backend}: {backend_exc}")
            finally:
                if worker_proc and started_worker:
                    kill_proc_tree(worker_proc)
                    worker_proc = None
                    started_worker = False
                    time.sleep(0.5)

        if attempted == 0:
            raise RuntimeError("No executor backends were attempted. Install OpenHands or configure mini-swe.")
        if failures:
            raise RuntimeError("One or more backend runs failed:\n- " + "\n- ".join(failures))

        print("Done — PushPals E2E intercepted SCM-bound completion payload(s)")
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
