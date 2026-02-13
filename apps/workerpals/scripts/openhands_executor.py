#!/usr/bin/env python3
"""
PushPals -> OpenHands worker wrapper.

This script receives a base64-encoded JSON payload from the TS worker,
executes the requested job through OpenHands SDK workspace APIs, and prints
one structured result line:

  __PUSHPALS_OH_RESULT__ {"ok":true,...}
"""

from __future__ import annotations

import base64
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from contextlib import nullcontext
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple


RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ "
PROMPT_TOKEN_REGEX = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")
_PROMPT_TEMPLATE_CACHE: Dict[str, str] = {}
DEFAULT_LARGE_INSTRUCTION_CHARS = 1800
DEFAULT_OPENHANDS_MODEL = "local-model"
KNOWN_LITELLM_PROVIDER_PREFIXES: Set[str] = {
    "openai",
    "azure",
    "ollama",
    "openrouter",
    "anthropic",
    "google",
    "gemini",
    "vertex_ai",
    "bedrock",
    "cohere",
    "groq",
    "mistral",
    "huggingface",
    "replicate",
    "deepseek",
    "xai",
    "together_ai",
    "fireworks_ai",
}


class ManagedLocalAgentServer:
    """Minimal local OpenHands agent-server lifecycle manager."""

    def __init__(self, host: str = "127.0.0.1") -> None:
        self.host = host
        self.port = _find_free_port()
        self.base_url = f"http://{self.host}:{self.port}"
        self.process: Optional[subprocess.Popen[str]] = None

    def __enter__(self) -> "ManagedLocalAgentServer":
        self.process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "openhands.agent_server",
                "--port",
                str(self.port),
                "--host",
                self.host,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            env={"LOG_JSON": "true", **os.environ},
        )

        deadline = time.time() + 30.0
        health_url = f"{self.base_url}/health"
        while time.time() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError("OpenHands agent server exited before becoming ready")
            try:
                with urllib.request.urlopen(health_url, timeout=1.0) as res:
                    if res.status == 200:
                        return self
            except (urllib.error.URLError, TimeoutError, OSError):
                time.sleep(0.2)

        raise RuntimeError("Timed out waiting for OpenHands agent server health check")

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if not self.process:
            return
        try:
            self.process.terminate()
            self.process.wait(timeout=5)
        except Exception:
            try:
                self.process.kill()
                self.process.wait(timeout=2)
            except Exception:
                pass


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _emit(result: Dict[str, Any]) -> None:
    sys.stdout.write(f"{RESULT_PREFIX}{json.dumps(result, ensure_ascii=True)}\n")
    sys.stdout.flush()


def _fail(summary: str, stderr: Optional[str] = None, exit_code: int = 1) -> int:
    result: Dict[str, Any] = {
        "ok": False,
        "summary": summary,
        "stderr": stderr or "",
        "exitCode": exit_code,
    }
    _emit(result)
    return exit_code


def _decode_payload(raw: str) -> Dict[str, Any]:
    decoded = base64.b64decode(raw).decode("utf-8")
    payload = json.loads(decoded)
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    return payload


def _to_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _to_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _python_cmd(script: str) -> str:
    encoded = base64.b64encode(script.encode("utf-8")).decode("ascii")
    python_bin = shlex.quote(
        str((os.environ.get("WORKERPALS_OPENHANDS_WORKSPACE_PYTHON") or "python3"))
    )
    return (
        f"{python_bin} - <<'PY'\n"
        "import base64\n"
        f"exec(base64.b64decode('{encoded}').decode('utf-8'))\n"
        "PY"
    )


def _parse_workspace_result(result: Any) -> Tuple[int, str, str]:
    if isinstance(result, dict):
        exit_code = _to_int(result.get("exit_code", result.get("exitCode", 1)), 1)
        stdout = str(result.get("stdout", "") or "")
        stderr = str(result.get("stderr", "") or "")
        return exit_code, stdout, stderr

    exit_code = _to_int(getattr(result, "exit_code", 1), 1)
    stdout = str(getattr(result, "stdout", "") or "")
    stderr = str(getattr(result, "stderr", "") or "")
    return exit_code, stdout, stderr


def _extract_target_path_from_instruction(instruction: str) -> str:
    target_path = ""
    m = re.search(
        r"(?:file\s+(?:called|named)|create\s+(?:a\s+)?file|write\s+(?:to|into))\s+[\"'`]?(?P<path>[^\"'`\s]+)",
        instruction,
        flags=re.I,
    )
    if m:
        target_path = str(m.group("path") or "").strip().rstrip(".,!?;:")
    return target_path


def _normalize_base_url(raw: str) -> str:
    base = raw.strip()
    if not base:
        return ""
    base = base.rstrip("/")
    if base.endswith("/api/chat"):
        base = base[: -len("/api/chat")]
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    return base


def _model_is_provider_qualified(model: str) -> bool:
    if "/" not in model:
        return False
    provider = model.split("/", 1)[0].strip().lower()
    return provider in KNOWN_LITELLM_PROVIDER_PREFIXES


def _infer_litellm_provider(base_url: str) -> str:
    backend = (
        os.environ.get("WORKERPALS_LLM_BACKEND") or ""
    ).strip().lower()
    if backend in {"ollama", "ollama_chat"}:
        return "ollama"
    if backend in {"lmstudio", "openai", "openai_compatible"}:
        return "openai"

    lowered = base_url.lower()
    if "11434" in lowered:
        return "ollama"
    return "openai"


def _normalize_litellm_model(model: str, provider: str) -> str:
    normalized = model.strip()
    if not normalized:
        return normalized
    if _model_is_provider_qualified(normalized):
        return normalized
    if not provider:
        return normalized
    return f"{provider}/{normalized}"


def _normalize_base_url_for_provider(base_url: str, provider: str) -> str:
    normalized = _normalize_base_url(base_url)
    if not normalized:
        return normalized
    if provider != "openai":
        return normalized
    if re.match(r"^https?://[^/]+$", normalized, flags=re.I):
        return f"{normalized}/v1"
    return normalized


def _running_in_container() -> bool:
    return os.path.exists("/.dockerenv") or os.path.exists("/run/.containerenv")


def _rewrite_localhost_for_container(base_url: str) -> str:
    normalized = base_url.strip()
    if not normalized:
        return normalized

    try:
        parsed = urllib.parse.urlparse(normalized)
    except Exception:
        return normalized

    host = (parsed.hostname or "").lower()
    if host not in {"localhost", "127.0.0.1", "::1"}:
        return normalized

    user_info = ""
    if parsed.username:
        user_info = parsed.username
        if parsed.password:
            user_info += f":{parsed.password}"
        user_info += "@"

    netloc = f"{user_info}host.docker.internal"
    if parsed.port:
        netloc += f":{parsed.port}"

    rewritten = urllib.parse.urlunparse(
        (
            parsed.scheme,
            netloc,
            parsed.path,
            parsed.params,
            parsed.query,
            parsed.fragment,
        )
    )
    return rewritten or normalized


def _looks_local_base_url(base_url: str) -> bool:
    if not base_url:
        return False
    lowered = base_url.lower()
    return (
        "localhost" in lowered
        or "127.0.0.1" in lowered
        or "host.docker.internal" in lowered
    )


def _resolve_agent_server_url() -> str:
    return (os.environ.get("WORKERPALS_OPENHANDS_AGENT_SERVER_URL") or "").strip()


def _agent_health_url(base_url: str) -> str:
    return f"{base_url.rstrip('/')}/health"


def _agent_server_is_healthy(base_url: str, timeout: float = 1.0) -> bool:
    if not base_url:
        return False
    try:
        with urllib.request.urlopen(_agent_health_url(base_url), timeout=timeout) as res:
            return int(getattr(res, "status", 0)) == 200
    except Exception:
        return False


def _llm_probe_urls(base_url: str, model: str) -> List[str]:
    normalized = base_url.rstrip("/")
    provider = model.split("/", 1)[0].strip().lower() if "/" in model else ""

    if provider == "ollama":
        return [
            f"{normalized}/api/tags",
            f"{normalized}/tags",
            normalized,
        ]

    if normalized.endswith("/v1"):
        return [
            f"{normalized}/models",
            f"{normalized}/chat/completions",
            normalized,
        ]

    return [
        f"{normalized}/v1/models",
        f"{normalized}/models",
        normalized,
    ]


def _llm_endpoint_reachable(base_url: str, model: str, timeout: float = 2.0) -> Tuple[bool, str]:
    if not base_url:
        return True, ""

    last_error = "connection failed"
    for probe in _llm_probe_urls(base_url, model):
        try:
            with urllib.request.urlopen(probe, timeout=timeout) as res:
                return True, f"{probe} -> {getattr(res, 'status', '?')}"
        except urllib.error.HTTPError as exc:
            # HTTP response means endpoint is reachable, even if auth/path differs.
            return True, f"{probe} -> HTTP {exc.code}"
        except Exception as exc:
            last_error = f"{probe}: {exc}"
    return False, last_error


def _providerless_model_name(model: str) -> str:
    normalized = model.strip()
    if "/" not in normalized:
        return normalized
    provider = normalized.split("/", 1)[0].strip().lower()
    if provider in KNOWN_LITELLM_PROVIDER_PREFIXES:
        return normalized.split("/", 1)[1].strip()
    return normalized


def _is_embedding_model(model: str) -> bool:
    lowered = _providerless_model_name(model).lower()
    return (
        "embedding" in lowered
        or lowered.startswith("embed-")
        or "/embed" in lowered
        or "nomic-embed" in lowered
    )


def _chat_completion_url(base_url: str, provider: str) -> str:
    normalized = base_url.rstrip("/")
    if provider == "ollama":
        if normalized.endswith("/api/chat"):
            return normalized
        return f"{normalized}/api/chat"

    if normalized.endswith("/chat/completions"):
        return normalized
    if normalized.endswith("/v1"):
        return f"{normalized}/chat/completions"
    return f"{normalized}/v1/chat/completions"


def _llm_model_chat_preflight(
    base_url: str,
    provider: str,
    api_key: str,
    model: str,
    timeout: float = 10.0,
) -> Tuple[bool, str]:
    if not base_url:
        return True, "base URL unset"

    url = _chat_completion_url(base_url, provider)
    payload_model = _providerless_model_name(model)
    if provider == "ollama":
        body = {
            "model": payload_model,
            "messages": [{"role": "user", "content": "ping"}],
            "stream": False,
            "options": {"temperature": 0.0, "num_predict": 1},
        }
    else:
        body = {
            "model": payload_model,
            "messages": [{"role": "user", "content": "ping"}],
            "temperature": 0.0,
            "max_tokens": 1,
        }

    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if api_key and provider == "openai":
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as res:
            status = int(getattr(res, "status", 0))
            if 200 <= status < 300:
                return True, f"{url} -> {status}"
            return False, f"{url} -> HTTP {status}"
    except urllib.error.HTTPError as exc:
        try:
            body_text = exc.read().decode("utf-8", errors="replace")
        except Exception:
            body_text = ""
        detail = f"{url} -> HTTP {exc.code}{f' ({body_text[:180].strip()})' if body_text else ''}"
        if _is_model_load_failure(body_text):
            return False, detail
        lowered = body_text.lower()
        if "model" in lowered and "not found" in lowered:
            return False, detail
        if exc.code in {401, 403}:
            # Endpoint/model path is reachable; auth policy is separate.
            return True, detail
        return False, detail
    except Exception as exc:
        return False, f"{url}: {exc}"


def _model_candidates_url(base_url: str, provider: str) -> List[str]:
    normalized = base_url.rstrip("/")
    if not normalized:
        return []
    if provider == "ollama":
        return [f"{normalized}/api/tags", f"{normalized}/tags"]
    if normalized.endswith("/v1"):
        root = normalized[: -len("/v1")].rstrip("/")
        urls = [f"{normalized}/models"]
        if root:
            urls.append(f"{root}/models")
        return urls
    return [f"{normalized}/v1/models", f"{normalized}/models"]


def _extract_model_ids(payload: Any, provider: str) -> List[str]:
    ids: List[str] = []
    if provider == "ollama":
        models = payload.get("models") if isinstance(payload, dict) else None
        if isinstance(models, list):
            for item in models:
                if not isinstance(item, dict):
                    continue
                for key in ("name", "model", "id"):
                    value = item.get(key)
                    if isinstance(value, str) and value.strip():
                        ids.append(value.strip())
                        break
        return list(dict.fromkeys(ids))

    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            value = item.get("id")
            if isinstance(value, str) and value.strip():
                ids.append(value.strip())
    return list(dict.fromkeys(ids))


def _discover_available_models(
    base_url: str, provider: str, api_key: str, timeout: float = 2.0
) -> Tuple[List[str], str]:
    if not base_url:
        return [], "base URL is empty"

    headers = {"Accept": "application/json"}
    if api_key and provider == "openai":
        headers["Authorization"] = f"Bearer {api_key}"

    last_error = "model list probe failed"
    for url in _model_candidates_url(base_url, provider):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as res:
                raw = res.read().decode("utf-8", errors="replace")
                payload = json.loads(raw)
                ids = _extract_model_ids(payload, provider)
                if ids:
                    return ids, f"{url} -> {getattr(res, 'status', '?')}"
                last_error = f"{url}: no models found in payload"
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read().decode("utf-8", errors="replace")
            except Exception:
                body = ""
            hint = body[:120].strip() if body else ""
            last_error = f"{url}: HTTP {exc.code}{f' ({hint})' if hint else ''}"
        except Exception as exc:
            last_error = f"{url}: {exc}"
    return [], last_error


def _pick_configured_or_available_model(
    configured_model: str, available_models: List[str]
) -> Tuple[str, str]:
    configured = configured_model.strip()
    if available_models:
        if configured:
            wanted = _providerless_model_name(configured).lower()
            for candidate in available_models:
                if _providerless_model_name(candidate).lower() == wanted:
                    return candidate, "configured"
            return available_models[0], "available_fallback"
        return available_models[0], "available_default"

    if configured:
        return configured, "configured_unverified"

    return DEFAULT_OPENHANDS_MODEL, "default_local_model"


def _is_model_load_failure(error_text: str) -> bool:
    lowered = error_text.lower()
    return (
        "failed to load model" in lowered
        or "model loading was stopped" in lowered
        or "insufficient system resources" in lowered
        or "out of memory" in lowered
        or ("model" in lowered and "not found" in lowered)
    )


def _fallback_models_after_load_failure(
    base_url: str,
    provider: str,
    api_key: str,
    failed_model: str,
) -> Tuple[List[str], str]:
    available_models, probe_detail = _discover_available_models(base_url, provider, api_key)
    candidates: List[str] = []
    failed_norm = _normalize_litellm_model(failed_model, provider)

    for model in available_models:
        normalized = _normalize_litellm_model(model, provider)
        if normalized and normalized != failed_norm and not _is_embedding_model(normalized):
            candidates.append(normalized)

    default_fallback = _normalize_litellm_model(DEFAULT_OPENHANDS_MODEL, provider)
    if (
        default_fallback
        and default_fallback != failed_norm
        and not _is_embedding_model(default_fallback)
    ):
        candidates.append(default_fallback)

    return list(dict.fromkeys(candidates)), probe_detail


def _resolve_llm_config() -> Tuple[str, str, str]:
    raw_model = (
        os.environ.get("WORKERPALS_LLM_MODEL")
        or ""
    ).strip()
    api_key = (
        os.environ.get("WORKERPALS_LLM_API_KEY")
        or ""
    ).strip()
    raw_base_url = (
        (
            os.environ.get("WORKERPALS_LLM_ENDPOINT")
            or ""
        )
    )
    provider = _infer_litellm_provider(raw_base_url)
    configured_model = _normalize_litellm_model(raw_model, provider)
    base_url = _normalize_base_url_for_provider(raw_base_url, provider)
    if _running_in_container():
        rewritten = _rewrite_localhost_for_container(base_url)
        if rewritten != base_url:
            sys.stderr.write(
                f"[OpenHandsExecutor] Rewriting local LLM base URL for container networking: {base_url} -> {rewritten}\n"
            )
            sys.stderr.flush()
            base_url = rewritten
    available_models, probe_detail = _discover_available_models(base_url, provider, api_key)
    selected_model, selection_reason = _pick_configured_or_available_model(
        configured_model, available_models
    )
    model = _normalize_litellm_model(selected_model, provider)
    if selection_reason == "available_fallback":
        sys.stderr.write(
            "[OpenHandsExecutor] Configured model unavailable in LM Studio model list; "
            f"using discovered fallback model: {selected_model}\n"
        )
        sys.stderr.flush()
    elif selection_reason == "available_default":
        sys.stderr.write(
            "[OpenHandsExecutor] No model configured; using discovered model "
            f"from endpoint: {selected_model}\n"
        )
        sys.stderr.flush()
    elif selection_reason == "default_local_model":
        sys.stderr.write(
            "[OpenHandsExecutor] No configured/discovered model available; "
            f"falling back to default model: {DEFAULT_OPENHANDS_MODEL}\n"
        )
        sys.stderr.flush()
    elif selection_reason == "configured_unverified":
        sys.stderr.write(
            "[OpenHandsExecutor] Could not verify configured model against endpoint model list "
            f"({probe_detail}); continuing with configured model: {configured_model}\n"
        )
        sys.stderr.flush()
    return model, api_key, base_url


def _repo_root_for_prompt_loading() -> Path:
    explicit = (os.environ.get("PUSHPALS_REPO_PATH") or "").strip()
    if explicit:
        return Path(explicit)
    return Path(__file__).resolve().parents[3]


def _resolve_prompt_file(relative_path: str) -> Path:
    return _repo_root_for_prompt_loading() / "prompts" / relative_path


def _resolve_agent_prompt_profile(base_url: str) -> str:
    raw = (os.environ.get("WORKERPALS_OPENHANDS_PROMPT_PROFILE") or "").strip().lower()
    if raw in {"default", "full", "standard"}:
        return "default"
    if raw in {"minimal", "compact", "small"}:
        return "minimal"
    if _looks_local_base_url(base_url):
        # Local LM Studio/Ollama deployments often have smaller context windows.
        return "minimal"
    return "default"


def _resolve_agent_prompt_overrides(base_url: str) -> Dict[str, Any]:
    profile = _resolve_agent_prompt_profile(base_url)
    if profile != "minimal":
        return {}

    overrides: Dict[str, Any] = {}
    system_prompt = _resolve_prompt_file("workerpals/openhands_minimal_system_prompt.j2")
    security_prompt = _resolve_prompt_file("workerpals/openhands_minimal_security_policy.j2")
    if system_prompt.exists():
        overrides["system_prompt_filename"] = str(system_prompt)
    if security_prompt.exists():
        overrides["security_policy_filename"] = str(security_prompt)
    return overrides


def _load_prompt_template(
    relative_path: str, replacements: Optional[Dict[str, str]] = None
) -> str:
    prompt_path = _resolve_prompt_file(relative_path)
    prompt_key = str(prompt_path)

    template = _PROMPT_TEMPLATE_CACHE.get(prompt_key)
    if template is None:
        if not prompt_path.exists():
            raise FileNotFoundError(f"Prompt template not found: {prompt_path}")
        template = prompt_path.read_text(encoding="utf-8")
        _PROMPT_TEMPLATE_CACHE[prompt_key] = template

    if not replacements:
        return template

    def _replace(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in replacements:
            raise KeyError(f"Missing prompt replacement '{{{{{key}}}}}' for {prompt_path}")
        return replacements[key]

    return PROMPT_TOKEN_REGEX.sub(_replace, template)


def _summarize_git_changes(repo: str) -> List[str]:
    try:
        proc = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        if proc.returncode != 0:
            return []
        paths: List[str] = []
        for line in proc.stdout.splitlines():
            clean = line.strip()
            if not clean:
                continue
            path = clean[3:] if len(clean) > 3 else clean
            if " -> " in path:
                path = path.split(" -> ", 1)[1]
            if path:
                paths.append(path)
        return paths
    except Exception:
        return []


def _large_instruction_threshold() -> int:
    raw = (os.environ.get("WORKERPALS_OPENHANDS_LARGE_INSTRUCTION_CHARS") or "").strip()
    if not raw:
        return DEFAULT_LARGE_INSTRUCTION_CHARS
    try:
        parsed = int(raw)
    except Exception:
        return DEFAULT_LARGE_INSTRUCTION_CHARS
    if parsed <= 0:
        return 0
    return max(512, parsed)


def _execution_timeout_ms() -> int:
    raw = (os.environ.get("WORKERPALS_OPENHANDS_TIMEOUT_MS") or "").strip()
    default_ms = 1800000
    if not raw:
        return default_ms
    try:
        parsed = int(raw)
    except Exception:
        return default_ms
    return max(10000, parsed)


def _prepare_instruction_for_agent(repo: str, instruction: str) -> Tuple[str, str]:
    threshold = _large_instruction_threshold()
    if threshold <= 0 or len(instruction) <= threshold:
        return instruction, ""

    repo_root = Path(repo).resolve()
    handoff_dir = repo_root / "workspace" / "workerpal_requests"
    handoff_dir.mkdir(parents=True, exist_ok=True)
    handoff_name = (
        f"instruction-{int(time.time())}-{uuid.uuid4().hex[:8]}.md"
    )
    handoff_path = handoff_dir / handoff_name
    handoff_path.write_text(instruction, encoding="utf-8")

    try:
        display_path = handoff_path.relative_to(repo_root).as_posix()
    except Exception:
        display_path = handoff_path.as_posix()

    handoff_instruction = (
        "Important: the full user instruction is too large to inline and has been "
        f"written to `{display_path}`.\n"
        "Before doing anything else, read that file completely and treat its contents "
        "as the authoritative task request.\n"
        "After reading it, execute exactly what it asks."
    )
    return handoff_instruction, display_path


def _build_agent_user_message(instruction: str) -> str:
    """
    Build the message sent to OpenHands.

    Default behavior is instruction-only to minimize prompt/token overhead for
    small-context local runtimes (LM Studio/llama.cpp).
    """

    timeout_minutes = max(1, round(_execution_timeout_ms() / 60000))
    timeout_note = (
        f"Time limit: about {timeout_minutes} minute(s) for this task. "
        "If you cannot finish in time, stop and provide a concise status of what you checked, "
        "what remains, and the blocker."
    )

    mode = (os.environ.get("WORKERPALS_OPENHANDS_TASK_PROMPT_MODE") or "none").strip().lower()
    if mode in {"none", "off", "instruction_only", "instruction-only", "minimal"}:
        return f"{instruction}\n\n{timeout_note}"

    compact_agent_prompt = ""
    try:
        compact_agent_prompt = _load_prompt_template(
            "workerpals/openhands_task_execute_system_prompt.md"
        ).strip()
    except Exception:
        compact_agent_prompt = (
            "You are PushPals WorkerPal running inside OpenHands.\n"
            "Focus only on the task below.\n"
            "If the task asks a question, answer directly and do not edit files.\n"
            "If the task asks for code/file changes, implement minimal correct changes in-repo.\n"
            "Avoid unrelated docs or architecture summaries unless explicitly requested."
        )

    return f"{compact_agent_prompt}\n\nTask:\n{instruction}\n\n{timeout_note}"


def _run_agentic_task_execute(repo: str, instruction: str) -> Dict[str, Any]:
    try:
        from openhands.sdk import Agent, Conversation, LLM, Tool
        from openhands.tools.file_editor import FileEditorTool
        from openhands.tools.terminal import TerminalTool
    except Exception as exc:
        return {
            "ok": False,
            "summary": "OpenHands agent mode unavailable in worker runtime",
            "stderr": str(exc),
            "exitCode": 3,
        }

    model, api_key, base_url = _resolve_llm_config()
    if not model:
        return {
            "ok": False,
            "summary": (
                "task.execute requires an LLM model for agentic execution. "
                "Set WORKERPALS_LLM_MODEL."
            ),
            "stderr": "",
            "exitCode": 2,
        }

    if not api_key:
        if _looks_local_base_url(base_url):
            api_key = "local"
        else:
            return {
                "ok": False,
                "summary": (
                    "task.execute agent mode requires an API key. "
                    "Set WORKERPALS_LLM_API_KEY."
                ),
                "stderr": "",
                "exitCode": 2,
            }

    reachable, reachability_detail = _llm_endpoint_reachable(base_url, model)
    if not reachable:
        return {
            "ok": False,
            "summary": "OpenHands LLM endpoint is unreachable from worker runtime",
            "stderr": (
                f"Could not reach LLM endpoint for model {model} at {base_url}. "
                f"Last probe error: {reachability_detail}"
            ),
            "exitCode": 2,
        }

    llm_kwargs_base: Dict[str, Any] = {"api_key": api_key}
    if base_url:
        llm_kwargs_base["base_url"] = base_url
    if _looks_local_base_url(base_url):
        # Local model servers should fail fast on connectivity issues instead
        # of spending long retry windows that hit outer Docker timeouts.
        llm_kwargs_base["num_retries"] = max(
            0, _to_int(os.environ.get("WORKERPALS_OPENHANDS_LLM_NUM_RETRIES"), 2)
        )
        llm_kwargs_base["retry_multiplier"] = max(
            1.0, _to_float(os.environ.get("WORKERPALS_OPENHANDS_LLM_RETRY_MULTIPLIER"), 1.5)
        )
        llm_kwargs_base["retry_min_wait"] = max(
            1, _to_int(os.environ.get("WORKERPALS_OPENHANDS_LLM_RETRY_MIN_WAIT"), 1)
        )
        llm_kwargs_base["retry_max_wait"] = max(
            llm_kwargs_base["retry_min_wait"],
            _to_int(os.environ.get("WORKERPALS_OPENHANDS_LLM_RETRY_MAX_WAIT"), 4),
        )
        llm_kwargs_base["timeout"] = max(
            5, _to_int(os.environ.get("WORKERPALS_OPENHANDS_LLM_TIMEOUT_SEC"), 90)
        )
        # LM Studio/llama.cpp can fail with n_keep >= n_ctx when large prompts
        # are cache-pinned. Disable prompt caching for local endpoints.
        llm_kwargs_base["caching_prompt"] = False

    tools = [
        Tool(name=TerminalTool.name),
        Tool(name=FileEditorTool.name),
    ]
    agent_overrides = _resolve_agent_prompt_overrides(base_url)
    if agent_overrides:
        sys.stderr.write(
            "[OpenHandsExecutor] Using minimal OpenHands prompt profile for local context constraints.\n"
        )
        sys.stderr.flush()

    prepared_instruction, handoff_path = _prepare_instruction_for_agent(repo, instruction)
    if handoff_path:
        sys.stderr.write(
            f"[OpenHandsExecutor] Large instruction handoff enabled ({len(instruction)} chars): {handoff_path}\n"
        )
        sys.stderr.flush()
    user_message = _build_agent_user_message(prepared_instruction)
    max_steps = max(1, _to_int(os.environ.get("WORKERPALS_OPENHANDS_AGENT_MAX_STEPS"), 30))

    provider = _infer_litellm_provider(base_url)
    models_to_try: List[str] = [model]
    attempted_models: List[str] = []
    last_error_text = ""
    preflight_failures: List[str] = []
    model_probe_timeout_sec = max(
        3.0, _to_float(os.environ.get("WORKERPALS_OPENHANDS_MODEL_PROBE_TIMEOUT_SEC"), 10.0)
    )

    while models_to_try:
        active_model = models_to_try.pop(0)
        if active_model in attempted_models:
            continue
        attempted_models.append(active_model)

        if _is_embedding_model(active_model):
            sys.stderr.write(
                f"[OpenHandsExecutor] Skipping non-chat embedding model candidate: {active_model}\n"
            )
            sys.stderr.flush()
            continue

        preflight_ok, preflight_detail = _llm_model_chat_preflight(
            base_url, provider, api_key, active_model, model_probe_timeout_sec
        )
        if not preflight_ok:
            preflight_failures.append(f"{active_model}: {preflight_detail}")
            last_error_text = f"{active_model}: {preflight_detail}"
            lowered_preflight = preflight_detail.lower()
            if _is_model_load_failure(preflight_detail) or (
                "model" in lowered_preflight and "not found" in lowered_preflight
            ):
                fallback_models, probe_detail = _fallback_models_after_load_failure(
                    base_url, provider, api_key, active_model
                )
                pending = set(models_to_try)
                new_candidates = [
                    m for m in fallback_models if m not in attempted_models and m not in pending
                ]
                if new_candidates:
                    sys.stderr.write(
                        "[OpenHandsExecutor] Model preflight failed for "
                        f"{active_model}; retrying with fallback model(s): "
                        f"{', '.join(new_candidates)}\n"
                    )
                    sys.stderr.flush()
                    models_to_try.extend(new_candidates)
                    continue
                return {
                    "ok": False,
                    "summary": "OpenHands model preflight failed and no fallback model succeeded",
                    "stderr": (
                        f"{preflight_detail}\n"
                        f"Attempted models: {', '.join(attempted_models)}\n"
                        f"Model probe detail: {probe_detail}"
                    ),
                    "exitCode": 2,
                }

            # Transient preflight failure: skip this model and continue if alternatives exist.
            sys.stderr.write(
                "[OpenHandsExecutor] Model preflight failed; skipping candidate "
                f"{active_model}: {preflight_detail}\n"
            )
            sys.stderr.flush()
            continue

        llm_kwargs = dict(llm_kwargs_base)
        llm_kwargs["model"] = active_model

        try:
            llm = LLM(**llm_kwargs)
            try:
                agent = Agent(llm=llm, tools=tools, **agent_overrides)
            except TypeError:
                # Older SDK versions may not support explicit prompt override kwargs.
                if agent_overrides:
                    sys.stderr.write(
                        "[OpenHandsExecutor] Prompt profile overrides unsupported by installed OpenHands SDK; using defaults.\n"
                    )
                    sys.stderr.flush()
                agent = Agent(llm=llm, tools=tools)

            conversation = Conversation(agent=agent, workspace=repo)
            conversation.send_message(user_message)
            try:
                conversation.run(max_steps=max_steps)
            except TypeError:
                # SDK versions differ; fall back to default run() signature.
                conversation.run()

            changed_paths = _summarize_git_changes(repo)
            if changed_paths:
                listed = "\n".join(f"- {path}" for path in changed_paths[:40])
                if len(changed_paths) > 40:
                    listed += "\n- ..."
                return {
                    "ok": True,
                    "summary": f"Executed task and modified {len(changed_paths)} file(s)",
                    "stdout": f"Changed files:\n{listed}",
                    "stderr": "",
                    "exitCode": 0,
                }
            return {
                "ok": True,
                "summary": "Executed task via OpenHands agent (no file changes detected)",
                "stdout": "No modified files were detected after execution.",
                "stderr": "",
                "exitCode": 0,
            }
        except Exception as exc:
            err_text = str(exc)
            last_error_text = err_text
            lowered = err_text.lower()

            if _is_model_load_failure(err_text):
                fallback_models, probe_detail = _fallback_models_after_load_failure(
                    base_url, provider, api_key, active_model
                )
                pending = set(models_to_try)
                new_candidates = [
                    m for m in fallback_models if m not in attempted_models and m not in pending
                ]
                if new_candidates:
                    sys.stderr.write(
                        "[OpenHandsExecutor] Model load failure for "
                        f"{active_model}; retrying with fallback model(s): "
                        f"{', '.join(new_candidates)}\n"
                    )
                    sys.stderr.flush()
                    models_to_try.extend(new_candidates)
                    continue
                return {
                    "ok": False,
                    "summary": "OpenHands model failed to load and no fallback model succeeded",
                    "stderr": (
                        f"{err_text}\n"
                        f"Attempted models: {', '.join(attempted_models)}\n"
                        f"Model probe detail: {probe_detail}"
                    ),
                    "exitCode": 2,
                }

            if "connection error" in lowered or "connection refused" in lowered:
                return {
                    "ok": False,
                    "summary": "OpenHands could not connect to the configured local LLM endpoint",
                    "stderr": (
                        f"{err_text}\n"
                        f"Model: {active_model}\n"
                        f"Base URL: {base_url}\n"
                        "Verify the host LLM server is running and reachable from Docker."
                    ),
                    "exitCode": 2,
                }
            if "cannot truncate prompt with n_keep" in lowered and "n_ctx" in lowered:
                return {
                    "ok": False,
                    "summary": "OpenHands prompt exceeded LM Studio context window",
                    "stderr": (
                        f"{err_text}\n"
                        "Reduce overall prompt/context size, increase model context window, "
                        "or use a model/runtime with larger context support."
                    ),
                    "exitCode": 2,
                }
            return {
                "ok": False,
                "summary": "OpenHands agent task execution failed",
                "stderr": err_text,
                "exitCode": 1,
            }

    return {
        "ok": False,
        "summary": "OpenHands model selection exhausted with no successful execution",
        "stderr": (
            f"Attempted models: {', '.join(attempted_models) if attempted_models else '(none)'}\n"
            + (
                "Preflight failures:\n"
                + "\n".join(f"- {entry}" for entry in preflight_failures[-5:])
                + "\n"
                if preflight_failures
                else ""
            )
            + f"Last error: {last_error_text or '(none captured)'}"
        ),
        "exitCode": 2,
    }


def _job_to_command(
    kind: str, params: Dict[str, Any], repo: str
) -> Tuple[Optional[str], Optional[str]]:
    def req(name: str) -> Any:
        value = params.get(name)
        if value is None or value == "":
            raise ValueError(f"{kind} requires '{name}'")
        return value

    if kind == "bun.test":
        cmd = "bun test"
        if params.get("filter"):
            cmd += f" --filter {shlex.quote(str(params['filter']))}"
        return cmd, None

    if kind == "bun.lint":
        return "bun run lint", None

    if kind == "git.status":
        return "git status --porcelain", None

    if kind == "git.log":
        count = min(max(_to_int(params.get("count", 20), 20), 1), 100)
        cmd = f"git log --oneline --format=%h\\ %s\\ (%an,\\ %ar) -n {count}"
        if params.get("branch"):
            cmd += f" {shlex.quote(str(params['branch']))}"
        return cmd, None

    if kind == "git.branch":
        if bool(params.get("all")):
            return "git branch -a -v", None
        return "git branch -v", None

    if kind == "git.diff":
        return "git diff", None

    if kind == "file.read":
        path = req("path")
        return f"cat {shlex.quote(str(path))}", None

    if kind == "file.search":
        pattern = req("pattern")
        return (
            "rg --no-heading --line-number "
            f"{shlex.quote(str(pattern))} . || grep -rn {shlex.quote(str(pattern))} . || true"
        ), None

    if kind == "file.list":
        return "git ls-tree --name-only -r HEAD", None

    if kind == "ci.status":
        return (
            "gh run list --limit 5 "
            "--json status,conclusion,name,headBranch,createdAt,url"
        ), None

    if kind == "project.summary":
        instruction = str(
            params.get("instruction")
            or "Summarize repository architecture and key components."
        )
        recent_jobs_payload = base64.b64encode(
            json.dumps(params.get("recentJobs", []), ensure_ascii=True).encode("utf-8")
        ).decode("ascii")
        script = f"""
import base64
import json
from pathlib import Path

instruction = {json.dumps(instruction)}
lane = {json.dumps(lane)}
root = Path(".")

ignore = {{
    ".git",
    "node_modules",
    "outputs",
    ".worktrees",
    "workspace",
    ".venv",
    "dist",
    "build",
}}

def tree(base: Path, depth: int, prefix: str = ""):
    if depth < 0:
        return []
    lines = []
    try:
        entries = sorted(base.iterdir(), key=lambda p: p.name.lower())
    except Exception:
        return lines
    for entry in entries:
        name = entry.name
        if name.startswith(".") and name != ".env.example":
            continue
        if name in ignore:
            continue
        suffix = "/" if entry.is_dir() else ""
        lines.append(f"{{prefix}}- {{name}}{{suffix}}")
        if entry.is_dir() and depth > 0 and len(lines) < 120:
            lines.extend(tree(entry, depth - 1, prefix + "  "))
        if len(lines) >= 120:
            break
    return lines

readme_excerpt = ""
readme = root / "README.md"
if readme.exists():
    try:
        readme_excerpt = readme.read_text(encoding="utf-8")[:2400].strip()
    except Exception:
        readme_excerpt = ""

recent_jobs = []
try:
    recent_jobs = json.loads(base64.b64decode({json.dumps(recent_jobs_payload)}).decode("utf-8"))
except Exception:
    recent_jobs = []

lines = []
lines.append("# Repository Architecture")
lines.append("")
lines.append(f"Requested task: {{instruction}}")
lines.append("")
lines.append("## Top-level Structure")
lines.extend(tree(root, 1))
if readme_excerpt:
    lines.append("")
    lines.append("## README Excerpt")
    lines.append(readme_excerpt)

if isinstance(recent_jobs, list) and recent_jobs:
    lines.append("")
    lines.append("## Recent Worker Job Context")
    for row in recent_jobs[:6]:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("kind", "")).strip()
        status = str(row.get("status", "")).strip()
        summary = str(row.get("summary", "")).replace("\\n", " ").strip()
        error = str(row.get("error", "")).replace("\\n", " ").strip()
        tail = summary or error
        if tail:
            lines.append(f"- {{kind}} [{{status}}]: {{tail}}"[:220])
        elif kind or status:
            lines.append(f"- {{kind}} [{{status}}]")

lines.append("")
lines.append("Generated by worker project.summary from repository state. Review and refine as needed.")
print("\\n".join(lines).strip() + "\\n")
"""
        return _python_cmd(script), "Generated repository architecture summary"

    if kind == "shell.exec":
        return str(req("command")), None

    if kind == "task.execute":
        instruction = str(req("instruction"))
        lane = str(params.get("lane") or "openhands").strip().lower()
        target_path = str(params.get("targetPath") or params.get("path") or "").strip()
        if not target_path:
            target_path = _extract_target_path_from_instruction(instruction)

        recent_jobs_payload = base64.b64encode(
            json.dumps(params.get("recentJobs", []), ensure_ascii=True).encode("utf-8")
        ).decode("ascii")
        if not target_path:
            script = f"""
import base64
import json
from pathlib import Path

instruction = {json.dumps(instruction)}
root = Path(".")

ignore = {{
    ".git",
    "node_modules",
    "outputs",
    ".worktrees",
    "workspace",
    ".venv",
    "dist",
    "build",
}}

def tree(base: Path, depth: int, prefix: str = ""):
    if depth < 0:
        return []
    lines = []
    try:
        entries = sorted(base.iterdir(), key=lambda p: p.name.lower())
    except Exception:
        return lines
    for entry in entries:
        name = entry.name
        if name.startswith(".") and name != ".env.example":
            continue
        if name in ignore:
            continue
        suffix = "/" if entry.is_dir() else ""
        lines.append(f"{{prefix}}- {{name}}{{suffix}}")
        if entry.is_dir() and depth > 0 and len(lines) < 120:
            lines.extend(tree(entry, depth - 1, prefix + "  "))
        if len(lines) >= 120:
            break
    return lines

readme_excerpt = ""
readme = root / "README.md"
if readme.exists():
    try:
        readme_excerpt = readme.read_text(encoding="utf-8")[:2400].strip()
    except Exception:
        readme_excerpt = ""

recent_jobs = []
try:
    recent_jobs = json.loads(base64.b64decode({json.dumps(recent_jobs_payload)}).decode("utf-8"))
except Exception:
    recent_jobs = []

lines = []
lines.append("# Repository Architecture")
lines.append("")
lines.append(f"Requested task: {{instruction}}")
lines.append("")
lines.append("## Top-level Structure")
lines.extend(tree(root, 1))
if readme_excerpt:
    lines.append("")
    lines.append("## README Excerpt")
    lines.append(readme_excerpt)

if isinstance(recent_jobs, list) and recent_jobs:
    lines.append("")
    lines.append("## Recent Worker Job Context")
    for row in recent_jobs[:6]:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("kind", "")).strip()
        status = str(row.get("status", "")).strip()
        summary = str(row.get("summary", "")).replace("\\n", " ").strip()
        error = str(row.get("error", "")).replace("\\n", " ").strip()
        tail = summary or error
        if tail:
            lines.append(f"- {{kind}} [{{status}}]: {{tail}}"[:220])
        elif kind or status:
            lines.append(f"- {{kind}} [{{status}}]")

lines.append("")
lines.append(f"Generated by worker task.execute (lane={{lane}}) from repository state.")
print("\\n".join(lines).strip() + "\\n")
"""
            return _python_cmd(script), "Executed deterministic task summary (no targetPath provided)"

        script = f"""
import base64
import json
from pathlib import Path

instruction = {json.dumps(instruction)}
target = Path({json.dumps(target_path)})
target.parent.mkdir(parents=True, exist_ok=True)
root = Path(".")

ignore = {{
    ".git",
    "node_modules",
    "outputs",
    ".worktrees",
    "workspace",
    ".venv",
    "dist",
    "build",
}}

def tree(base: Path, depth: int, prefix: str = ""):
    if depth < 0:
        return []
    lines = []
    try:
        entries = sorted(base.iterdir(), key=lambda p: p.name.lower())
    except Exception:
        return lines
    for entry in entries:
        name = entry.name
        if name.startswith(".") and name != ".env.example":
            continue
        if name in ignore:
            continue
        suffix = "/" if entry.is_dir() else ""
        lines.append(f"{{prefix}}- {{name}}{{suffix}}")
        if entry.is_dir() and depth > 0 and len(lines) < 120:
            lines.extend(tree(entry, depth - 1, prefix + "  "))
        if len(lines) >= 120:
            break
    return lines

readme_excerpt = ""
readme = root / "README.md"
if readme.exists():
    try:
        readme_excerpt = readme.read_text(encoding="utf-8")[:2400].strip()
    except Exception:
        readme_excerpt = ""

recent_jobs = []
try:
    recent_jobs = json.loads(base64.b64decode({json.dumps(recent_jobs_payload)}).decode("utf-8"))
except Exception:
    recent_jobs = []

lines = []
lines.append("# Repository Architecture")
lines.append("")
lines.append(f"Requested task: {{instruction}}")
lines.append("")
lines.append("## Top-level Structure")
lines.extend(tree(root, 1))
if readme_excerpt:
    lines.append("")
    lines.append("## README Excerpt")
    lines.append(readme_excerpt)

if isinstance(recent_jobs, list) and recent_jobs:
    lines.append("")
    lines.append("## Recent Worker Job Context")
    for row in recent_jobs[:6]:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("kind", "")).strip()
        status = str(row.get("status", "")).strip()
        summary = str(row.get("summary", "")).replace("\\n", " ").strip()
        error = str(row.get("error", "")).replace("\\n", " ").strip()
        tail = summary or error
        if tail:
            lines.append(f"- {{kind}} [{{status}}]: {{tail}}"[:220])
        elif kind or status:
            lines.append(f"- {{kind}} [{{status}}]")

lines.append("")
lines.append("Generated by worker task.execute from repository state. Review and refine as needed.")
content = "\\n".join(lines).strip() + "\\n"
target.write_text(content, encoding="utf-8")
print(f"Wrote {{len(content)}} bytes to {{target}}")
"""
        return _python_cmd(script), f"Executed task and wrote {target_path}"

    if kind == "file.write":
        path = str(req("path"))
        content = str(req("content"))
        payload = base64.b64encode(content.encode("utf-8")).decode("ascii")
        repo_payload = json.dumps(str(Path(repo).resolve()))
        script = f"""
import base64
from pathlib import Path

repo_root = Path({repo_payload}).resolve()
path_in = Path({json.dumps(path)})
path = (path_in if path_in.is_absolute() else (repo_root / path_in)).resolve()
if repo_root not in path.parents and path != repo_root:
    raise SystemExit(f"Refusing to write outside repo: {{path}}")
path.parent.mkdir(parents=True, exist_ok=True)
content = base64.b64decode({json.dumps(payload)}).decode("utf-8")
path.write_text(content, encoding="utf-8")
display = path.relative_to(repo_root) if path != repo_root else Path(".")
print(f"Wrote {{len(content)}} bytes to {{display}}")
"""
        return _python_cmd(script), f"Wrote {len(content)} bytes to {path}"

    if kind == "file.patch":
        path = str(req("path"))
        old_text = str(req("oldText"))
        new_text = str(req("newText"))
        old_payload = base64.b64encode(old_text.encode("utf-8")).decode("ascii")
        new_payload = base64.b64encode(new_text.encode("utf-8")).decode("ascii")
        script = f"""
import base64
from pathlib import Path

path = Path({json.dumps(path)})
old_text = base64.b64decode({json.dumps(old_payload)}).decode("utf-8")
new_text = base64.b64decode({json.dumps(new_payload)}).decode("utf-8")

current = path.read_text(encoding="utf-8")
if old_text not in current:
    raise SystemExit("oldText not found in file")
updated = current.replace(old_text, new_text, 1)
path.write_text(updated, encoding="utf-8")
print(f"Patched {path}")
"""
        return _python_cmd(script), f"Patched {path}"

    if kind == "file.rename":
        src = str(req("from"))
        dst = str(req("to"))
        script = f"""
import shutil
from pathlib import Path

src = Path({json.dumps(src)})
dst = Path({json.dumps(dst)})
dst.parent.mkdir(parents=True, exist_ok=True)
shutil.move(str(src), str(dst))
print(f"Renamed {{src}} -> {{dst}}")
"""
        return _python_cmd(script), f"Renamed {src} -> {dst}"

    if kind == "file.delete":
        path = str(req("path"))
        script = f"""
import shutil
from pathlib import Path

path = Path({json.dumps(path)})
if path.is_dir():
    shutil.rmtree(path)
    print(f"Deleted directory {{path}}")
else:
    path.unlink()
    print(f"Deleted {{path}}")
"""
        return _python_cmd(script), f"Deleted {path}"

    if kind == "file.copy":
        src = str(req("from"))
        dst = str(req("to"))
        script = f"""
import shutil
from pathlib import Path

src = Path({json.dumps(src)})
dst = Path({json.dumps(dst)})
dst.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(src, dst)
print(f"Copied {{src}} -> {{dst}}")
"""
        return _python_cmd(script), f"Copied {src} -> {dst}"

    if kind == "file.append":
        path = str(req("path"))
        content = str(req("content"))
        payload = base64.b64encode(content.encode("utf-8")).decode("ascii")
        script = f"""
import base64
from pathlib import Path

path = Path({json.dumps(path)})
path.parent.mkdir(parents=True, exist_ok=True)
content = base64.b64decode({json.dumps(payload)}).decode("utf-8")
with path.open("a", encoding="utf-8") as f:
    f.write(content)
print(f"Appended {{len(content)}} bytes to {path}")
"""
        return _python_cmd(script), f"Appended {len(content)} bytes to {path}"

    if kind == "file.mkdir":
        path = str(req("path"))
        script = f"""
from pathlib import Path
path = Path({json.dumps(path)})
path.mkdir(parents=True, exist_ok=True)
print(f"Created directory {{path}}")
"""
        return _python_cmd(script), f"Created directory {path}"

    if kind == "web.fetch":
        url = str(req("url"))
        script = f"""
import re
import urllib.request

url = {json.dumps(url)}
req = urllib.request.Request(url, headers={{"User-Agent": "PushPals/1.0"}})
with urllib.request.urlopen(req, timeout=25) as res:
    body = res.read().decode("utf-8", errors="replace")
    content_type = (res.headers.get("content-type") or "").lower()

if "html" in content_type:
    body = re.sub(r"<script[^>]*>[\\s\\S]*?</script>", "", body, flags=re.I)
    body = re.sub(r"<style[^>]*>[\\s\\S]*?</style>", "", body, flags=re.I)
    body = re.sub(r"<[^>]+>", " ", body)
    body = re.sub(r"\\s+", " ", body).strip()

print(body)
"""
        return _python_cmd(script), f"Fetched {url}"

    if kind == "web.search":
        query = str(req("query"))
        script = f"""
import re
import urllib.parse
import urllib.request

query = {json.dumps(query)}
url = "https://lite.duckduckgo.com/lite/?q=" + urllib.parse.quote(query)
req = urllib.request.Request(url, headers={{"User-Agent": "PushPals/1.0"}})
with urllib.request.urlopen(req, timeout=20) as res:
    html = res.read().decode("utf-8", errors="replace")

links = re.findall(r'<a[^>]+href="(https?://[^"]+)"[^>]*>([^<]+)</a>', html, re.I)
rows = []
for href, title in links:
    if "duckduckgo.com" in href:
        continue
    rows.append(f"{{len(rows)+1}}. {{title.strip()}}\\n  {{href}}")
    if len(rows) >= 10:
        break
print("\\n\\n".join(rows) if rows else "No results found.")
"""
        return _python_cmd(script), f"Search results for {query}"

    return None, None


def main() -> int:
    if len(sys.argv) < 2:
        return _fail("Missing base64 job payload", exit_code=2)

    try:
        payload = _decode_payload(sys.argv[1])
    except Exception as exc:
        return _fail(f"Failed to decode job payload: {exc}", exit_code=2)

    kind = payload.get("kind")
    params = payload.get("params", {})
    repo = payload.get("repo")

    if not isinstance(kind, str) or not kind:
        return _fail("Invalid payload: missing 'kind'", exit_code=2)
    if not isinstance(params, dict):
        return _fail("Invalid payload: 'params' must be an object", exit_code=2)
    if not isinstance(repo, str) or not repo:
        return _fail("Invalid payload: missing 'repo'", exit_code=2)

    if kind != "task.execute":
        return _fail(
            f"Unsupported job kind '{kind}'. WorkerPal accepts only task.execute.",
            exit_code=2,
        )

    instruction = str(params.get("instruction") or "").strip()
    if not instruction:
        return _fail("task.execute requires 'instruction'", exit_code=2)
    lane = str(params.get("lane") or "openhands").strip().lower()
    if lane not in {"openhands", "deterministic"}:
        return _fail(
            "task.execute requires lane='openhands' or lane='deterministic'",
            exit_code=2,
        )
    if lane == "openhands":
        result = _run_agentic_task_execute(repo, instruction)
        _emit(result)
        return 0 if bool(result.get("ok")) else _to_int(result.get("exitCode"), 1)

    try:
        from openhands.sdk import Workspace
    except Exception as exc:
        return _fail(
            "OpenHands SDK is not available in worker runtime. "
            "Install openhands-sdk/openhands-agent-server/openhands-workspace "
            "and ensure imports are compatible.",
            stderr=str(exc),
            exit_code=3,
        )

    try:
        cmd, preferred_summary = _job_to_command(kind, params, repo)
    except Exception as exc:
        return _fail(str(exc), exit_code=2)

    if not cmd:
        return _fail(f"Unknown job kind: {kind}", exit_code=2)

    reusable_server = _resolve_agent_server_url()
    prefer_reusable = bool(reusable_server)
    if reusable_server and not _agent_server_is_healthy(reusable_server):
        # Warm container agent may have died; fall back to managed per-job server.
        prefer_reusable = False
        sys.stderr.write(
            "[OpenHandsExecutor] Shared agent server is unreachable; falling back to per-job server.\n"
        )
        sys.stderr.flush()

    def _execute_with_server(server_url: str) -> Tuple[int, str, str]:
        with Workspace(host=server_url, working_dir=repo) as workspace:
            raw = workspace.execute_command(cmd)
            return _parse_workspace_result(raw)

    try:
        if prefer_reusable and reusable_server:
            try:
                exit_code, stdout, stderr = _execute_with_server(reusable_server)
            except Exception as first_exc:
                # Retry with a managed ephemeral server if the shared one races or dies.
                first_error = str(first_exc)
                if "Connection refused" not in first_error and "[Errno 111]" not in first_error:
                    raise
                sys.stderr.write(
                    "[OpenHandsExecutor] Shared agent server refused connection; retrying with per-job server.\n"
                )
                sys.stderr.flush()
                with ManagedLocalAgentServer() as server:
                    exit_code, stdout, stderr = _execute_with_server(server.base_url)
        else:
            with ManagedLocalAgentServer() as server:
                exit_code, stdout, stderr = _execute_with_server(server.base_url)
    except Exception as exc:
        return _fail(
            f"OpenHands execution failed for {kind}",
            stderr=str(exc),
            exit_code=1,
        )

    ok = exit_code == 0
    summary = preferred_summary or (
        f"{kind} passed via OpenHands"
        if ok
        else f"{kind} failed via OpenHands (exit {exit_code})"
    )

    result: Dict[str, Any] = {
        "ok": ok,
        "summary": summary,
        "stdout": stdout,
        "stderr": stderr,
        "exitCode": exit_code,
    }
    _emit(result)
    return 0 if ok else exit_code or 1


if __name__ == "__main__":
    raise SystemExit(main())
