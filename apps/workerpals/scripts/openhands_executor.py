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
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from contextlib import nullcontext, redirect_stderr
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

try:
    import tomllib
except Exception:  # pragma: no cover - python <3.11 fallback
    tomllib = None  # type: ignore[assignment]


RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ "
PROMPT_TOKEN_REGEX = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")
_PROMPT_TEMPLATE_CACHE: Dict[str, str] = {}
DEFAULT_LARGE_INSTRUCTION_CHARS = 1800
DEFAULT_OPENHANDS_MODEL = "local-model"
DEFAULT_LLM_MAX_MESSAGE_CHARS = 12000
DEFAULT_LLM_TIMEOUT_RECOVERY_ATTEMPTS = 1
DEFAULT_LLM_TIMEOUT_RECOVERY_BACKOFF_SEC = 2.0
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

_CONFIG_CACHE: Optional[Dict[str, Any]] = None


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


def _executor_log(message: str) -> None:
    line = message if message.endswith("\n") else f"{message}\n"
    sys.stdout.write(line)


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


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        existing = out.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            out[key] = _deep_merge(existing, value)
        else:
            out[key] = value
    return out


def _repo_root_for_runtime_config() -> Path:
    explicit = (os.environ.get("PUSHPALS_REPO_PATH") or "").strip()
    if explicit:
        return Path(explicit)
    return Path(__file__).resolve().parents[3]


def _parse_toml_file(path: Path) -> Dict[str, Any]:
    if not path.exists() or not tomllib:
        return {}
    try:
        parsed = tomllib.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _runtime_config() -> Dict[str, Any]:
    global _CONFIG_CACHE
    if _CONFIG_CACHE is not None:
        return _CONFIG_CACHE

    repo_root = _repo_root_for_runtime_config()
    config_dir = repo_root / "config"
    default_cfg = _parse_toml_file(config_dir / "default.toml")
    profile = (
        (os.environ.get("PUSHPALS_PROFILE") or "").strip()
        or str(default_cfg.get("profile") or "").strip()
        or "dev"
    )
    profile_cfg = _parse_toml_file(config_dir / f"{profile}.toml")
    local_cfg = _parse_toml_file(config_dir / "local.toml")
    _CONFIG_CACHE = _deep_merge(_deep_merge(default_cfg, profile_cfg), local_cfg)
    return _CONFIG_CACHE


def _config_get(path: str, default: Any = None) -> Any:
    node: Any = _runtime_config()
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node


def _setting_str(name: str, config_path: str, default: str = "") -> str:
    raw = (os.environ.get(name) or "").strip()
    if raw:
        return raw
    cfg = _config_get(config_path)
    if cfg is None:
        return default
    if isinstance(cfg, str):
        trimmed = cfg.strip()
        return trimmed if trimmed else default
    return str(cfg).strip() or default


def _setting_int(name: str, config_path: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if raw:
        return _to_int(raw, default)
    cfg = _config_get(config_path, default)
    return _to_int(cfg, default)


def _setting_float(name: str, config_path: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    if raw:
        return _to_float(raw, default)
    cfg = _config_get(config_path, default)
    return _to_float(cfg, default)


def _setting_bool(name: str, config_path: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is not None:
        text = raw.strip().lower()
        if text in {"1", "true", "yes", "on"}:
            return True
        if text in {"0", "false", "no", "off"}:
            return False
        return default

    cfg = _config_get(config_path, default)
    if isinstance(cfg, bool):
        return cfg
    if isinstance(cfg, (int, float)):
        return bool(cfg)
    if isinstance(cfg, str):
        text = cfg.strip().lower()
        if text in {"1", "true", "yes", "on"}:
            return True
        if text in {"0", "false", "no", "off"}:
            return False
    return default


def _is_truthy_env(name: str, default: bool = False, config_path: str = "") -> bool:
    if config_path:
        return _setting_bool(name, config_path, default)
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _safe_session_component(value: Any, fallback: str = "unknown") -> str:
    text = str(value or "").strip().lower()
    if not text:
        text = fallback
    text = re.sub(r"[^a-z0-9._:-]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    if not text:
        text = fallback
    return text[:64]


def _stable_llm_session_user(payload: Optional[Dict[str, Any]]) -> str:
    override = _setting_str("WORKERPALS_LLM_SESSION_ID", "workerpals.llm.session_id", "")
    if override:
        return _safe_session_component(override, "pushpals-worker")

    session_id = _safe_session_component(
        _setting_str("PUSHPALS_SESSION_ID", "session_id", ""), "session"
    )
    worker_id = _safe_session_component((payload or {}).get("workerId"), "worker")
    task_id = _safe_session_component((payload or {}).get("taskId"), "task")
    return f"pushpals-{session_id}-{worker_id}-{task_id}"


def _session_hint_headers(session_user: str) -> Dict[str, str]:
    if not session_user:
        return {}
    return {
        "X-PushPals-Session-Id": session_user,
        "X-Session-Id": session_user,
        "X-Conversation-Id": session_user,
    }


def _lmstudio_slot_id() -> Optional[int]:
    raw = _setting_str("WORKERPALS_LMSTUDIO_SLOT_ID", "workerpals.openhands.lmstudio_slot_id", "")
    if not raw:
        return None
    try:
        slot_id = int(raw)
    except Exception:
        return None
    return slot_id if slot_id >= 0 else None


def _session_hint_body_variants(
    body: Dict[str, Any], provider: str, session_user: str
) -> List[Dict[str, Any]]:
    if provider != "openai" or not session_user:
        return [body]
    variants: List[Dict[str, Any]] = [
        {
            **body,
            "user": session_user,
            "session_id": session_user,
            "conversation_id": session_user,
        },
        {
            **body,
            "user": session_user,
        },
        {
            **body,
        },
    ]
    slot_id = _lmstudio_slot_id()
    if slot_id is None:
        return variants
    slotted: List[Dict[str, Any]] = []
    for variant in variants:
        slotted.append({**variant, "id_slot": slot_id})
        slotted.append(variant)
    return slotted


def _json_object_from_env(name: str) -> Tuple[Optional[Dict[str, Any]], str]:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return None, ""
    try:
        parsed = json.loads(raw)
    except Exception as exc:
        return None, f"{name}: invalid JSON ({exc})"
    if not isinstance(parsed, dict):
        return None, f"{name}: expected a JSON object"
    return parsed, ""


def _python_cmd(script: str) -> str:
    encoded = base64.b64encode(script.encode("utf-8")).decode("ascii")
    python_bin = shlex.quote(
        _setting_str(
            "WORKERPALS_OPENHANDS_WORKSPACE_PYTHON",
            "workerpals.openhands.workspace_python",
            "python3",
        )
    )
    return (
        f"{python_bin} - <<'PY'\n"
        "import base64\n"
        f"exec(base64.b64decode('{encoded}').decode('utf-8'))\n"
        "PY"
    )


def _python_script_cmd(repo: str, script_rel: str, payload: Dict[str, Any]) -> str:
    payload_b64 = base64.b64encode(
        json.dumps(payload, ensure_ascii=True).encode("utf-8")
    ).decode("ascii")
    repo_resolved = str(Path(repo).resolve())
    runner = f"""
import runpy
import sys
from pathlib import Path

repo_root = Path({json.dumps(repo_resolved)}).resolve()
script_path = (repo_root / {json.dumps(script_rel)}).resolve()
if not script_path.exists():
    raise SystemExit(f"Script not found: {{script_path}}")
sys.argv = [str(script_path), {json.dumps(payload_b64)}]
runpy.run_path(str(script_path), run_name="__main__")
"""
    return _python_cmd(runner)


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
    backend = _setting_str("WORKERPALS_LLM_BACKEND", "workerpals.llm.backend", "").lower()
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
    return _setting_str(
        "WORKERPALS_OPENHANDS_AGENT_SERVER_URL",
        "workerpals.openhands.agent_server_url",
        "",
    )


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


def _resolve_llm_config() -> Tuple[str, str, str]:
    raw_model = _setting_str("WORKERPALS_LLM_MODEL", "workerpals.llm.model", "")
    api_key = _setting_str("WORKERPALS_LLM_API_KEY", "workerpals.llm.api_key", "")
    raw_base_url = _setting_str("WORKERPALS_LLM_ENDPOINT", "workerpals.llm.endpoint", "")
    provider = _infer_litellm_provider(raw_base_url)
    configured_model = _normalize_litellm_model(raw_model or DEFAULT_OPENHANDS_MODEL, provider)
    base_url = _normalize_base_url_for_provider(raw_base_url, provider)
    if _running_in_container():
        rewritten = _rewrite_localhost_for_container(base_url)
        if rewritten != base_url:
            _executor_log(
                f"[OpenHandsExecutor] Rewriting local LLM base URL for container networking: {base_url} -> {rewritten}\n"
            )
            base_url = rewritten
    if not raw_model.strip():
        _executor_log(
            "[OpenHandsExecutor] No explicit model configured; using default model "
            f"{DEFAULT_OPENHANDS_MODEL}.\n"
        )
    return configured_model, api_key, base_url


def _repo_root_for_prompt_loading() -> Path:
    return _repo_root_for_runtime_config()


def _resolve_prompt_file(relative_path: str) -> Path:
    return _repo_root_for_prompt_loading() / "prompts" / relative_path


def _resolve_agent_prompt_profile(base_url: str) -> str:
    raw = _setting_str(
        "WORKERPALS_OPENHANDS_PROMPT_PROFILE",
        "workerpals.openhands.prompt_profile",
        "",
    ).lower()
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


def _resolve_mcp_config() -> Tuple[Optional[Dict[str, Any]], List[str]]:
    notes: List[str] = []
    mcp_config_raw = _setting_str(
        "WORKERPALS_OPENHANDS_MCP_CONFIG_JSON",
        "workerpals.openhands.mcp_config_json",
        "",
    )
    config, config_error = (None, "")
    if mcp_config_raw:
        try:
            parsed = json.loads(mcp_config_raw)
            if isinstance(parsed, dict):
                config = parsed
            else:
                config_error = "expected a JSON object"
        except Exception as exc:
            config_error = f"invalid JSON ({exc})"
    if config_error:
        notes.append(
            "[OpenHandsExecutor] Ignoring WORKERPALS_OPENHANDS_MCP_CONFIG_JSON "
            f"because it is invalid: {config_error}"
        )
        config = None

    if not _is_truthy_env(
        "WORKERPALS_OPENHANDS_ENABLE_WEB_MCP",
        False,
        "workerpals.openhands.enable_web_mcp",
    ):
        return config, notes

    web_url = _setting_str(
        "WORKERPALS_OPENHANDS_WEB_MCP_URL",
        "workerpals.openhands.web_mcp_url",
        "",
    )
    if not web_url:
        notes.append(
            "[OpenHandsExecutor] WORKERPALS_OPENHANDS_ENABLE_WEB_MCP=1 but "
            "WORKERPALS_OPENHANDS_WEB_MCP_URL is empty; skipping web MCP connector."
        )
        return config, notes

    server_name = _setting_str(
        "WORKERPALS_OPENHANDS_WEB_MCP_NAME",
        "workerpals.openhands.web_mcp_name",
        "web-search",
    )
    transport = _setting_str(
        "WORKERPALS_OPENHANDS_WEB_MCP_TRANSPORT",
        "workerpals.openhands.web_mcp_transport",
        "streamable-http",
    ).lower()
    if transport == "streamable_http":
        transport = "streamable-http"
    if transport not in {"http", "streamable-http", "sse"}:
        notes.append(
            "[OpenHandsExecutor] Unsupported WORKERPALS_OPENHANDS_WEB_MCP_TRANSPORT="
            f"{transport}; defaulting to streamable-http."
        )
        transport = "streamable-http"

    headers, headers_error = _json_object_from_env("WORKERPALS_OPENHANDS_WEB_MCP_HEADERS_JSON")
    if headers_error:
        notes.append(
            "[OpenHandsExecutor] Ignoring WORKERPALS_OPENHANDS_WEB_MCP_HEADERS_JSON "
            f"because it is invalid: {headers_error}"
        )
        headers = None

    auth_token = (os.environ.get("WORKERPALS_OPENHANDS_WEB_MCP_AUTH_TOKEN") or "").strip()
    timeout_sec = _setting_int(
        "WORKERPALS_OPENHANDS_WEB_MCP_TIMEOUT_SEC",
        "workerpals.openhands.web_mcp_timeout_sec",
        0,
    )

    server_config: Dict[str, Any] = {"url": web_url, "transport": transport}
    if headers:
        server_config["headers"] = {
            str(k): str(v) for k, v in headers.items() if isinstance(k, str) and isinstance(v, (str, int, float, bool))
        }
    if auth_token:
        server_config["auth"] = auth_token
    if timeout_sec > 0:
        server_config["timeout"] = timeout_sec

    if config is None:
        config = {"mcpServers": {}}
    servers_raw = config.get("mcpServers")
    if not isinstance(servers_raw, dict):
        notes.append(
            "[OpenHandsExecutor] mcp_config did not contain object mcpServers; replacing it."
        )
        servers_raw = {}
        config["mcpServers"] = servers_raw
    servers_raw[server_name] = server_config
    notes.append(
        f"[OpenHandsExecutor] Web MCP connector enabled: {server_name} -> {web_url} ({transport})."
    )
    return config, notes


def _browser_tool_enabled() -> bool:
    return _is_truthy_env(
        "WORKERPALS_OPENHANDS_ENABLE_BROWSER_TOOL",
        False,
        "workerpals.openhands.enable_browser_tool",
    )


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
    raw = _setting_str(
        "WORKERPALS_OPENHANDS_LARGE_INSTRUCTION_CHARS",
        "workerpals.openhands.large_instruction_chars",
        "",
    )
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
    raw = _setting_str(
        "WORKERPALS_OPENHANDS_TIMEOUT_MS",
        "workerpals.openhands_timeout_ms",
        "",
    )
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

    mode = _setting_str(
        "WORKERPALS_OPENHANDS_TASK_PROMPT_MODE",
        "workerpals.openhands.task_prompt_mode",
        "none",
    ).lower()
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


def _auto_steer_enabled() -> bool:
    return _setting_bool(
        "WORKERPALS_OPENHANDS_AUTO_STEER_ENABLED",
        "workerpals.openhands.auto_steer_enabled",
        True,
    )


def _auto_steer_initial_delay_sec() -> int:
    return max(
        15,
        _setting_int(
            "WORKERPALS_OPENHANDS_AUTO_STEER_INITIAL_DELAY_SEC",
            "workerpals.openhands.auto_steer_initial_delay_sec",
            90,
        ),
    )


def _auto_steer_interval_sec() -> int:
    return max(
        20,
        _setting_int(
            "WORKERPALS_OPENHANDS_AUTO_STEER_INTERVAL_SEC",
            "workerpals.openhands.auto_steer_interval_sec",
            60,
        ),
    )


def _auto_steer_max_nudges() -> int:
    return max(
        0,
        min(
            120,
            _setting_int(
                "WORKERPALS_OPENHANDS_AUTO_STEER_MAX_NUDGES",
                "workerpals.openhands.auto_steer_max_nudges",
                30,
            ),
        ),
    )


def _llm_max_message_chars() -> int:
    return max(
        2000,
        min(
            120000,
            _setting_int(
                "WORKERPALS_OPENHANDS_LLM_MAX_MESSAGE_CHARS",
                "workerpals.openhands.llm_max_message_chars",
                DEFAULT_LLM_MAX_MESSAGE_CHARS,
            ),
        ),
    )


def _llm_timeout_recovery_attempts() -> int:
    return max(
        0,
        min(
            5,
            _setting_int(
                "WORKERPALS_OPENHANDS_LLM_TIMEOUT_RECOVERY_ATTEMPTS",
                "workerpals.openhands.llm_timeout_recovery_attempts",
                DEFAULT_LLM_TIMEOUT_RECOVERY_ATTEMPTS,
            ),
        ),
    )


def _llm_timeout_recovery_backoff_sec() -> float:
    return max(
        0.0,
        min(
            30.0,
            _setting_float(
                "WORKERPALS_OPENHANDS_LLM_TIMEOUT_RECOVERY_BACKOFF_SEC",
                "workerpals.openhands.llm_timeout_recovery_backoff_sec",
                DEFAULT_LLM_TIMEOUT_RECOVERY_BACKOFF_SEC,
            ),
        ),
    )


def _is_llm_timeout_error(exc: Exception) -> bool:
    lowered = str(exc).lower()
    signals = (
        "litellm.timeout",
        "apitimeouterror",
        "request timed out",
        "timeout error",
        "deadline exceeded",
        "context deadline exceeded",
    )
    return any(signal in lowered for signal in signals)


def _build_auto_steer_message(nudge_index: int, max_nudges: int) -> str:
    if nudge_index <= 1:
        return (
            f"Steering reminder {nudge_index}/{max_nudges}: "
            "Stop broad repository exploration and lock onto one concrete target file now. "
            "Make the smallest correct edit and run one focused validation command for it."
        )
    if nudge_index == 2:
        return (
            f"Steering reminder {nudge_index}/{max_nudges}: "
            "No more discovery loops. Choose the best candidate file, apply a minimal patch, "
            "then validate with a narrow test/lint command. Avoid repo-wide scans."
        )
    return (
        f"Steering reminder {nudge_index}/{max_nudges}: "
        "If still blocked, stop scanning and return concise blocker status with the exact next "
        "command you would run."
    )


def _run_agentic_task_execute(
    repo: str, instruction: str, payload: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
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
    stable_session_user = _stable_llm_session_user(payload)
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

    llm_kwargs_base: Dict[str, Any] = {"api_key": api_key}
    if base_url:
        llm_kwargs_base["base_url"] = base_url
    if stable_session_user:
        llm_kwargs_base["litellm_extra_body"] = {
            "user": stable_session_user,
            "session_id": stable_session_user,
            "conversation_id": stable_session_user,
        }
        llm_kwargs_base["extra_headers"] = _session_hint_headers(stable_session_user)
    if _looks_local_base_url(base_url):
        # Local model servers should fail fast on connectivity issues instead
        # of spending long retry windows that hit outer Docker timeouts.
        llm_kwargs_base["num_retries"] = max(
            0,
            _setting_int(
                "WORKERPALS_OPENHANDS_LLM_NUM_RETRIES",
                "workerpals.openhands.llm_num_retries",
                2,
            ),
        )
        llm_kwargs_base["retry_multiplier"] = max(
            1.0,
            _setting_float(
                "WORKERPALS_OPENHANDS_LLM_RETRY_MULTIPLIER",
                "workerpals.openhands.llm_retry_multiplier",
                1.5,
            ),
        )
        llm_kwargs_base["retry_min_wait"] = max(
            1,
            _setting_int(
                "WORKERPALS_OPENHANDS_LLM_RETRY_MIN_WAIT",
                "workerpals.openhands.llm_retry_min_wait",
                1,
            ),
        )
        llm_kwargs_base["retry_max_wait"] = max(
            llm_kwargs_base["retry_min_wait"],
            _setting_int(
                "WORKERPALS_OPENHANDS_LLM_RETRY_MAX_WAIT",
                "workerpals.openhands.llm_retry_max_wait",
                4,
            ),
        )
        llm_kwargs_base["timeout"] = max(
            5,
            _setting_int(
                "WORKERPALS_OPENHANDS_LLM_TIMEOUT_SEC",
                "workerpals.openhands.llm_timeout_sec",
                90,
            ),
        )
        # LM Studio/llama.cpp can fail with n_keep >= n_ctx when large prompts
        # are cache-pinned. Disable prompt caching for local endpoints.
        llm_kwargs_base["caching_prompt"] = False
    llm_kwargs_base["max_message_chars"] = _llm_max_message_chars()

    tools = [Tool(name=TerminalTool.name), Tool(name=FileEditorTool.name)]
    if _browser_tool_enabled():
        try:
            from openhands.tools.browser_use import BrowserToolSet

            tools.append(Tool(name=BrowserToolSet.name))
            _executor_log(
                "[OpenHandsExecutor] BrowserToolSet enabled (browser-use/playwright lane).\n"
            )
        except Exception as exc:
            _executor_log(
                "[OpenHandsExecutor] Browser tooling requested but unavailable; "
                f"continuing without browser tools ({exc}).\n"
            )

    agent_overrides = _resolve_agent_prompt_overrides(base_url)
    if agent_overrides:
        _executor_log(
            "[OpenHandsExecutor] Using minimal OpenHands prompt profile for local context constraints.\n"
        )
    mcp_config, mcp_notes = _resolve_mcp_config()
    for note in mcp_notes:
        _executor_log(note)

    prepared_instruction, handoff_path = _prepare_instruction_for_agent(repo, instruction)
    if handoff_path:
        _executor_log(
            f"[OpenHandsExecutor] Large instruction handoff enabled ({len(instruction)} chars): {handoff_path}\n"
        )
    user_message = _build_agent_user_message(prepared_instruction)
    max_steps = max(
        1,
        _setting_int(
            "WORKERPALS_OPENHANDS_AGENT_MAX_STEPS",
            "workerpals.openhands.agent_max_steps",
            30,
        ),
    )
    llm_kwargs = dict(llm_kwargs_base)
    llm_kwargs["model"] = model

    try:
        with redirect_stderr(sys.stdout):
            llm = LLM(**llm_kwargs)
        try:
            primary_agent_kwargs: Dict[str, Any] = {"llm": llm, "tools": tools}
            if mcp_config:
                primary_agent_kwargs["mcp_config"] = mcp_config
            if agent_overrides:
                primary_agent_kwargs.update(agent_overrides)
            with redirect_stderr(sys.stdout):
                agent = Agent(**primary_agent_kwargs)
        except TypeError:
            # Older SDK versions may not support explicit prompt override kwargs/mcp_config.
            fallback_agent_kwargs: Dict[str, Any] = {"llm": llm, "tools": tools}
            if mcp_config:
                fallback_agent_kwargs["mcp_config"] = mcp_config
            if agent_overrides:
                _executor_log(
                    "[OpenHandsExecutor] Prompt profile overrides unsupported by installed OpenHands SDK; using defaults.\n"
                )
            try:
                with redirect_stderr(sys.stdout):
                    agent = Agent(**fallback_agent_kwargs)
            except TypeError:
                if mcp_config:
                    _executor_log(
                        "[OpenHandsExecutor] mcp_config unsupported by installed OpenHands SDK; using tools without MCP.\n"
                    )
                with redirect_stderr(sys.stdout):
                    agent = Agent(llm=llm, tools=tools)
        except Exception as agent_exc:
            lowered_agent_exc = str(agent_exc).lower()
            if mcp_config and "mcp" in lowered_agent_exc:
                _executor_log(
                    "[OpenHandsExecutor] Invalid mcp_config for current runtime; continuing without MCP.\n"
                )
                fallback_kwargs: Dict[str, Any] = {"llm": llm, "tools": tools}
                if agent_overrides:
                    fallback_kwargs.update(agent_overrides)
                try:
                    with redirect_stderr(sys.stdout):
                        agent = Agent(**fallback_kwargs)
                except TypeError:
                    with redirect_stderr(sys.stdout):
                        agent = Agent(llm=llm, tools=tools)
            else:
                raise

        with redirect_stderr(sys.stdout):
            conversation = Conversation(agent=agent, workspace=repo)
            conversation.send_message(user_message)
        auto_steer_enabled = _auto_steer_enabled()
        auto_steer_initial_delay_sec = _auto_steer_initial_delay_sec()
        auto_steer_interval_sec = _auto_steer_interval_sec()
        auto_steer_max_nudges = _auto_steer_max_nudges()
        llm_timeout_recovery_attempts = _llm_timeout_recovery_attempts()
        llm_timeout_recovery_backoff_sec = _llm_timeout_recovery_backoff_sec()
        auto_steer_stop = threading.Event()
        auto_steer_thread: Optional[threading.Thread] = None

        def _auto_steer_worker() -> None:
            if not auto_steer_enabled or auto_steer_max_nudges <= 0:
                return
            if auto_steer_stop.wait(auto_steer_initial_delay_sec):
                return
            for nudge_index in range(1, auto_steer_max_nudges + 1):
                if auto_steer_stop.is_set():
                    return
                message = _build_auto_steer_message(nudge_index, auto_steer_max_nudges)
                try:
                    with redirect_stderr(sys.stdout):
                        conversation.send_message(message)
                    _executor_log(
                        "[OpenHandsExecutor] Auto-steering nudge sent "
                        f"({nudge_index}/{auto_steer_max_nudges}).\n"
                    )
                except Exception as steer_exc:
                    _executor_log(
                        "[OpenHandsExecutor] Auto-steering nudge failed "
                        f"({nudge_index}/{auto_steer_max_nudges}): {steer_exc}\n"
                    )
                    return
                if nudge_index < auto_steer_max_nudges and auto_steer_stop.wait(
                    auto_steer_interval_sec
                ):
                    return

        if auto_steer_enabled and auto_steer_max_nudges > 0:
            _executor_log(
                "[OpenHandsExecutor] Auto-steering enabled: "
                f"initial_delay={auto_steer_initial_delay_sec}s "
                f"interval={auto_steer_interval_sec}s max_nudges={auto_steer_max_nudges}\n"
            )
            auto_steer_thread = threading.Thread(
                target=_auto_steer_worker,
                name="openhands-auto-steer",
                daemon=True,
            )
            auto_steer_thread.start()
        try:
            run_attempt = 0
            while True:
                try:
                    with redirect_stderr(sys.stdout):
                        try:
                            conversation.run(max_steps=max_steps)
                        except TypeError:
                            # SDK versions differ; fall back to default run() signature.
                            conversation.run()
                    break
                except Exception as run_exc:
                    if (
                        run_attempt >= llm_timeout_recovery_attempts
                        or not _is_llm_timeout_error(run_exc)
                    ):
                        raise
                    run_attempt += 1
                    _executor_log(
                        "[OpenHandsExecutor] LLM endpoint timeout during run; "
                        f"retrying attempt {run_attempt}/{llm_timeout_recovery_attempts} with compact recovery hint.\n"
                    )
                    try:
                        with redirect_stderr(sys.stdout):
                            conversation.send_message(
                                "Recovery hint: last LLM request timed out. Continue from current state with minimal context. "
                                "Stop broad scans, choose one target file, make the smallest valid edit, run one focused validation command, then finish."
                            )
                    except Exception as steer_exc:
                        _executor_log(
                            "[OpenHandsExecutor] Timeout recovery hint failed before retry: "
                            f"{steer_exc}\n"
                        )
                    if llm_timeout_recovery_backoff_sec > 0:
                        time.sleep(llm_timeout_recovery_backoff_sec)
        finally:
            auto_steer_stop.set()
            if auto_steer_thread is not None:
                auto_steer_thread.join(timeout=1.0)

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
        return {
            "ok": False,
            "summary": "OpenHands agent task execution failed",
            "stderr": str(exc),
            "exitCode": 1,
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
        cmd = _python_script_cmd(
            repo,
            "apps/workerpals/scripts/deterministic_ops.py",
            {
                "op": "project.summary",
                "repoRoot": repo,
                "instruction": instruction,
                "recentJobs": params.get("recentJobs", []),
            },
        )
        return cmd, "Generated repository architecture summary"

    if kind == "shell.exec":
        return str(req("command")), None

    if kind == "task.execute":
        instruction = str(req("instruction"))
        lane = str(params.get("lane") or "openhands").strip().lower()
        target_path = str(params.get("targetPath") or params.get("path") or "").strip()
        if not target_path:
            target_path = _extract_target_path_from_instruction(instruction)
        cmd = _python_script_cmd(
            repo,
            "apps/workerpals/scripts/deterministic_ops.py",
            {
                "op": "task.summary",
                "repoRoot": repo,
                "instruction": instruction,
                "lane": lane,
                "targetPath": target_path,
                "recentJobs": params.get("recentJobs", []),
            },
        )
        if not target_path:
            return cmd, "Executed deterministic task summary (no targetPath provided)"
        return cmd, f"Executed task and wrote {target_path}"

    if kind == "file.write":
        path = str(req("path"))
        content = str(req("content"))
        cmd = _python_script_cmd(
            repo,
            "apps/workerpals/scripts/deterministic_ops.py",
            {"op": "file.write", "repoRoot": repo, "path": path, "content": content},
        )
        return cmd, f"Wrote {len(content)} bytes to {path}"

    if kind == "file.patch":
        path = str(req("path"))
        old_text = str(req("oldText"))
        new_text = str(req("newText"))
        cmd = _python_script_cmd(
            repo,
            "apps/workerpals/scripts/deterministic_ops.py",
            {
                "op": "file.patch",
                "repoRoot": repo,
                "path": path,
                "oldText": old_text,
                "newText": new_text,
            },
        )
        return cmd, f"Patched {path}"

    if kind == "file.rename":
        src = str(req("from"))
        dst = str(req("to"))
        cmd = _python_script_cmd(
            repo,
            "apps/workerpals/scripts/deterministic_ops.py",
            {"op": "file.rename", "repoRoot": repo, "from": src, "to": dst},
        )
        return cmd, f"Renamed {src} -> {dst}"

    if kind == "file.delete":
        path = str(req("path"))
        cmd = _python_script_cmd(
            repo,
            "apps/workerpals/scripts/deterministic_ops.py",
            {"op": "file.delete", "repoRoot": repo, "path": path},
        )
        return cmd, f"Deleted {path}"

    if kind == "file.copy":
        src = str(req("from"))
        dst = str(req("to"))
        cmd = _python_script_cmd(
            repo,
            "apps/workerpals/scripts/deterministic_ops.py",
            {"op": "file.copy", "repoRoot": repo, "from": src, "to": dst},
        )
        return cmd, f"Copied {src} -> {dst}"

    if kind == "file.append":
        path = str(req("path"))
        content = str(req("content"))
        cmd = _python_script_cmd(
            repo,
            "apps/workerpals/scripts/deterministic_ops.py",
            {"op": "file.append", "repoRoot": repo, "path": path, "content": content},
        )
        return cmd, f"Appended {len(content)} bytes to {path}"

    if kind == "file.mkdir":
        path = str(req("path"))
        cmd = _python_script_cmd(
            repo,
            "apps/workerpals/scripts/deterministic_ops.py",
            {"op": "file.mkdir", "repoRoot": repo, "path": path},
        )
        return cmd, f"Created directory {path}"

    if kind == "web.fetch":
        url = str(req("url"))
        cmd = _python_script_cmd(
            repo,
            "apps/workerpals/scripts/deterministic_ops.py",
            {"op": "web.fetch", "repoRoot": repo, "url": url},
        )
        return cmd, f"Fetched {url}"

    if kind == "web.search":
        query = str(req("query"))
        cmd = _python_script_cmd(
            repo,
            "apps/workerpals/scripts/deterministic_ops.py",
            {"op": "web.search", "repoRoot": repo, "query": query},
        )
        return cmd, f"Search results for {query}"

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
    planner_instruction = str(params.get("plannerWorkerInstruction") or "").strip()
    if planner_instruction and planner_instruction != instruction:
        _executor_log(
            "[OpenHandsExecutor] Planner guidance was provided, but preserving original user instruction as canonical task input.\n"
        )
    lane = str(params.get("lane") or "openhands").strip().lower()
    if lane not in {"openhands", "deterministic"}:
        return _fail(
            "task.execute requires lane='openhands' or lane='deterministic'",
            exit_code=2,
        )
    if lane == "openhands":
        result = _run_agentic_task_execute(repo, instruction, payload)
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
        _executor_log(
            "[OpenHandsExecutor] Shared agent server is unreachable; falling back to per-job server.\n"
        )

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
                _executor_log(
                    "[OpenHandsExecutor] Shared agent server refused connection; retrying with per-job server.\n"
                )
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
