"""
Shared infrastructure for PushPals executor scripts.

Both ``miniswe_executor.py`` and ``openhands_executor.py`` (and any future
executors) import from here instead of duplicating config loading, LLM
resolution, result emission, payload decoding, git helpers, etc.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Set, Tuple

try:
    import tomllib
except Exception:  # pragma: no cover - python <3.11 fallback
    tomllib = None  # type: ignore[assignment]


# ─── Constants ───────────────────────────────────────────────────────────────

RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ "

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

DEFAULT_TOOLCALL_RETRY_MAX = 1
LOGGER_STANDARD_METHODS: Tuple[str, ...] = (
    "debug",
    "info",
    "warn",
    "warning",
    "error",
    "exception",
    "critical",
)

# Superset of signals from both executors indicating the model failed to
# emit tool calls / tool actions.
NO_TOOL_CALL_SIGNALS: Tuple[str, ...] = (
    "no tool calls found",
    "no tool call found",
    "no function calls found",
    "no function call found",
    "tool_calls",
    "function_call",
    "did not call any tools",
    "didn't call any tools",
    "tool use required",
    "must use tools",
    "no actions found",
    "no action found",
    "no tool messages",
)

# ─── Core helpers ────────────────────────────────────────────────────────────

def emit(result: Dict[str, Any]) -> None:
    """Write a structured result line that the TS host parses."""
    sys.stdout.write(f"{RESULT_PREFIX}{json.dumps(result, ensure_ascii=True)}\n")
    sys.stdout.flush()


def executor_log(message: str) -> None:
    line = message if message.endswith("\n") else f"{message}\n"
    sys.stdout.write(line)
    sys.stdout.flush()


def _debug_enabled() -> bool:
    return os.environ.get("WORKERPALS_DEBUG", "").strip().lower() in {"1", "true", "yes"}


class Logger:
    """Simple levelled logger for executor scripts.

    Usage::

        log = Logger("[MiniSweExecutor]")
        log.info("Starting execution")
        log.debug("Instruction: ...")   # only when WORKERPALS_DEBUG=1
    """

    def __init__(self, prefix: str) -> None:
        self.prefix = prefix

    def _coerce_message(self, message: Any, args: Tuple[Any, ...]) -> str:
        text = str(message)
        if not args:
            return text
        try:
            return text % args
        except Exception:
            pieces = [text, *(str(arg) for arg in args)]
            return " ".join(piece for piece in pieces if piece)

    def _emit(self, _level: str, message: Any, *args: Any) -> None:
        executor_log(f"{self.prefix} {self._coerce_message(message, args)}")

    def info(self, message: Any, *args: Any) -> None:
        self._emit("info", message, *args)

    def debug(self, message: Any, *args: Any) -> None:
        if _debug_enabled():
            self._emit("debug", message, *args)

    def warn(self, message: Any, *args: Any) -> None:
        self._emit("warn", message, *args)

    def warning(self, message: Any, *args: Any) -> None:
        self.warn(message, *args)

    def error(self, message: Any, *args: Any) -> None:
        self._emit("error", message, *args)

    def critical(self, message: Any, *args: Any) -> None:
        self._emit("critical", message, *args)

    def exception(self, message: Any, *args: Any, exc_info: Any = True) -> None:
        detail = self._coerce_message(message, args)
        if exc_info:
            detail = f"{detail}\n{traceback.format_exc().strip()}"
        self._emit("exception", detail)


def fail(summary: str, stderr: Optional[str] = None, exit_code: int = 1) -> int:
    """Emit a failure result and return the exit code."""
    emit({"ok": False, "summary": summary, "stderr": stderr or "", "exitCode": exit_code})
    return exit_code


def decode_payload(raw: str) -> Dict[str, Any]:
    decoded = base64.b64decode(raw).decode("utf-8")
    payload = json.loads(decoded)
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    return payload


def resolve_repo_within_assigned_root(repo: str) -> Tuple[Optional[str], Optional[str]]:
    raw_repo = str(repo or "").strip()
    if not raw_repo:
        return None, "Invalid payload: missing 'repo'"

    try:
        repo_path = Path(raw_repo).resolve()
    except Exception as exc:
        return None, f"Invalid payload repo path: {exc}"

    if not repo_path.exists() or not repo_path.is_dir():
        return None, f"Invalid payload repo path: not a directory ({repo_path})"

    assigned_raw = (os.environ.get("PUSHPALS_ASSIGNED_REPO_ROOT") or "").strip()
    if assigned_raw:
        try:
            assigned_root = Path(assigned_raw).resolve()
        except Exception as exc:
            return None, f"Invalid assigned repo root: {exc}"
        if repo_path != assigned_root and assigned_root not in repo_path.parents:
            return (
                None,
                "Refusing repo path outside assigned root: "
                f"repo={repo_path} assigned_root={assigned_root}",
            )

    return str(repo_path), None


def to_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return default


def to_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return default


def to_single_line(value: Any, max_chars: int = 240) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    if not text:
        return ""
    if len(text) <= max_chars:
        return text
    return text[: max(1, max_chars - 3)] + "..."


def is_no_tool_calls_error(exc: Exception) -> bool:
    lowered = str(exc).lower()
    return any(sig in lowered for sig in NO_TOOL_CALL_SIGNALS)


# ─── Config loading (TOML + env) ────────────────────────────────────────────

_CONFIG_CACHE: Optional[Dict[str, Any]] = None
_MISSING = object()


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        existing = out.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            out[key] = _deep_merge(existing, value)
        else:
            out[key] = value
    return out


def repo_root_for_runtime_config() -> Path:
    explicit = (os.environ.get("PUSHPALS_REPO_PATH") or "").strip()
    if explicit:
        return Path(explicit)
    return Path(__file__).resolve().parents[3]


def config_dir_for_runtime_config() -> Path:
    explicit = (os.environ.get("PUSHPALS_CONFIG_DIR_OVERRIDE") or "").strip()
    if explicit:
        return Path(explicit)
    return repo_root_for_runtime_config() / "configs"


def prompts_root_for_runtime_assets() -> Path:
    explicit = (os.environ.get("PUSHPALS_PROMPTS_ROOT_OVERRIDE") or "").strip()
    if explicit:
        return Path(explicit)
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "prompts").is_dir():
            return parent
    return repo_root_for_runtime_config()


def _parse_toml_file(path: Path) -> Dict[str, Any]:
    if not path.exists() or not tomllib:
        return {}
    try:
        parsed = tomllib.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def runtime_config() -> Dict[str, Any]:
    global _CONFIG_CACHE
    if _CONFIG_CACHE is not None:
        return _CONFIG_CACHE
    config_dir = config_dir_for_runtime_config()
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


class SettingsResolver:
    """Thin config interface over env + runtime TOML config.

    This isolates source precedence (env vs TOML paths) from backend logic so
    call sites consume stable typed accessors.
    """

    def __init__(
        self,
        *,
        env: Optional[Mapping[str, str]] = None,
        config_loader: Optional[Callable[[], Dict[str, Any]]] = None,
    ) -> None:
        self._env: Mapping[str, str] = env if env is not None else os.environ
        self._config_loader: Callable[[], Dict[str, Any]] = config_loader or runtime_config

    def _config_value(self, path: str, default: Any = _MISSING) -> Any:
        node: Any = self._config_loader()
        for part in path.split("."):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node

    def _first_env(self, names: Sequence[str]) -> Any:
        for name in names:
            raw = self._env.get(name)
            if raw is None:
                continue
            text = str(raw).strip()
            if text:
                return text
        return _MISSING

    def _first_config(self, paths: Sequence[str]) -> Any:
        for path in paths:
            value = self._config_value(path, _MISSING)
            if value is _MISSING:
                continue
            if isinstance(value, str):
                trimmed = value.strip()
                if trimmed:
                    return trimmed
                continue
            return value
        return _MISSING

    def get_str(
        self,
        *,
        env_names: Sequence[str] = (),
        config_paths: Sequence[str] = (),
        default: str = "",
    ) -> str:
        env_value = self._first_env(env_names)
        if env_value is not _MISSING:
            return str(env_value)
        cfg_value = self._first_config(config_paths)
        if cfg_value is _MISSING:
            return default
        return str(cfg_value).strip() or default

    def get_int(
        self,
        *,
        env_names: Sequence[str] = (),
        config_paths: Sequence[str] = (),
        default: int,
    ) -> int:
        env_value = self._first_env(env_names)
        if env_value is not _MISSING:
            return to_int(env_value, default)
        cfg_value = self._first_config(config_paths)
        if cfg_value is _MISSING:
            return default
        return to_int(cfg_value, default)

    def get_float(
        self,
        *,
        env_names: Sequence[str] = (),
        config_paths: Sequence[str] = (),
        default: float,
    ) -> float:
        env_value = self._first_env(env_names)
        if env_value is not _MISSING:
            return to_float(env_value, default)
        cfg_value = self._first_config(config_paths)
        if cfg_value is _MISSING:
            return default
        return to_float(cfg_value, default)

    def get_bool(
        self,
        *,
        env_names: Sequence[str] = (),
        config_paths: Sequence[str] = (),
        default: bool = False,
    ) -> bool:
        env_value = self._first_env(env_names)
        if env_value is not _MISSING:
            lowered = str(env_value).strip().lower()
            if lowered in {"1", "true", "yes", "on"}:
                return True
            if lowered in {"0", "false", "no", "off"}:
                return False
            return default

        cfg_value = self._first_config(config_paths)
        if cfg_value is _MISSING:
            return default
        if isinstance(cfg_value, bool):
            return cfg_value
        if isinstance(cfg_value, (int, float)):
            return bool(cfg_value)
        if isinstance(cfg_value, str):
            lowered = cfg_value.strip().lower()
            if lowered in {"1", "true", "yes", "on"}:
                return True
            if lowered in {"0", "false", "no", "off"}:
                return False
        return default


def build_settings_resolver(
    *,
    env: Optional[Mapping[str, str]] = None,
    config: Optional[Dict[str, Any]] = None,
) -> SettingsResolver:
    if config is None:
        return SettingsResolver(env=env)
    return SettingsResolver(env=env, config_loader=lambda: config)


def config_get(path: str, default: Any = None) -> Any:
    return build_settings_resolver()._config_value(path, default)


def setting_str(name: str, config_path: str, default: str = "") -> str:
    return build_settings_resolver().get_str(
        env_names=(name,),
        config_paths=(config_path,),
        default=default,
    )


def setting_int(name: str, config_path: str, default: int) -> int:
    return build_settings_resolver().get_int(
        env_names=(name,),
        config_paths=(config_path,),
        default=default,
    )


def setting_float(name: str, config_path: str, default: float) -> float:
    return build_settings_resolver().get_float(
        env_names=(name,),
        config_paths=(config_path,),
        default=default,
    )


def setting_bool(name: str, config_path: str, default: bool = False) -> bool:
    return build_settings_resolver().get_bool(
        env_names=(name,),
        config_paths=(config_path,),
        default=default,
    )


def is_truthy_env(name: str, default: bool = False, config_path: str = "") -> bool:
    if config_path:
        return setting_bool(name, config_path, default)
    return build_settings_resolver().get_bool(env_names=(name,), default=default)


# ─── LLM config resolution ──────────────────────────────────────────────────

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


def infer_litellm_provider(base_url: str) -> str:
    backend = setting_str("WORKERPALS_LLM_BACKEND", "workerpals.llm.backend", "").lower()
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


def running_in_container() -> bool:
    return os.path.exists("/.dockerenv") or os.path.exists("/run/.containerenv")


def rewrite_localhost_for_container(base_url: str) -> str:
    import urllib.parse

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
        (parsed.scheme, netloc, parsed.path, parsed.params, parsed.query, parsed.fragment)
    )
    return rewritten or normalized


def looks_local_base_url(base_url: str) -> bool:
    if not base_url:
        return False
    lowered = base_url.lower()
    return "localhost" in lowered or "127.0.0.1" in lowered or "host.docker.internal" in lowered


def resolve_llm_config(
    default_model: str = "local-model",
    logger: Optional[Logger] = None,
) -> Tuple[str, str, str]:
    """Returns (model, api_key, base_url) resolved from config + env."""
    log = logger or Logger("[Executor]")
    raw_model = setting_str("WORKERPALS_LLM_MODEL", "workerpals.llm.model", "")
    api_key = setting_str("WORKERPALS_LLM_API_KEY", "workerpals.llm.api_key", "")
    raw_base_url = setting_str("WORKERPALS_LLM_ENDPOINT", "workerpals.llm.endpoint", "")
    provider = infer_litellm_provider(raw_base_url)
    configured_model = _normalize_litellm_model(raw_model or default_model, provider)
    base_url = _normalize_base_url_for_provider(raw_base_url, provider)
    if running_in_container():
        rewritten = rewrite_localhost_for_container(base_url)
        if rewritten != base_url:
            log.info(f"Rewriting local LLM base URL for container networking: {base_url} -> {rewritten}")
            base_url = rewritten
    if not raw_model.strip():
        log.info(f"No explicit model configured; using default model {default_model}.")
    return configured_model, api_key, base_url


# ─── Git helpers ─────────────────────────────────────────────────────────────

def summarize_git_changes(repo: str) -> List[str]:
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
        for raw_line in proc.stdout.splitlines():
            line = str(raw_line or "").rstrip("\r\n")
            if not line.strip():
                continue
            # Porcelain format uses two status columns + space prefix.
            # Do not trim leading whitespace before slicing, otherwise
            # paths like "README.md" become "EADME.md".
            if len(line) < 4:
                continue
            path = line[3:].strip()
            if " -> " in path:
                path = path.split(" -> ", 1)[1]
            if path:
                paths.append(path)
        return paths
    except Exception:
        return []


def log_git_status(repo: str, logger: Optional[Logger] = None) -> None:
    """Log ``git status --porcelain`` and ``git diff --stat`` for post-execution visibility."""
    log = logger or Logger("[Executor]")
    try:
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=repo, capture_output=True, text=True, timeout=10, check=False,
        )
        lines = [l for l in (status.stdout or "").splitlines() if l.strip()]
        if lines:
            log.debug("Git status after execution:")
            for line in lines[:30]:
                log.debug(f"  {line}")
        else:
            log.debug("Git status: clean (no changes)")
    except Exception as exc:
        log.debug(f"Git status failed: {exc}")

    try:
        diff = subprocess.run(
            ["git", "diff", "--stat"],
            cwd=repo, capture_output=True, text=True, timeout=10, check=False,
        )
        diff_lines = [l for l in (diff.stdout or "").splitlines() if l.strip()]
        if diff_lines:
            log.debug("Git diff stat:")
            for line in diff_lines[:20]:
                log.debug(f"  {line}")
    except Exception:
        pass


def log_agent_messages(messages: list, logger: Optional[Logger] = None, max_chars: int = 200) -> None:
    """Log a summary of agent message history (works with miniswe's message format).

    Only emits output when WORKERPALS_DEBUG=1.
    """
    if not _debug_enabled():
        return
    log = logger or Logger("[Executor]")
    step = 0
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "").strip()
        if not role:
            continue

        step += 1
        content = str(msg.get("content") or "").strip()

        # Tool calls (assistant requesting a tool)
        tool_calls = msg.get("tool_calls") or []
        if tool_calls and isinstance(tool_calls, list):
            for tc in tool_calls:
                if isinstance(tc, dict):
                    fn = tc.get("function") or {}
                    name = fn.get("name") or "unknown"
                    args_raw = str(fn.get("arguments") or "")[:80]
                    log.debug(f"Step {step} (tool_call): {name}({args_raw})")
            continue

        # Tool response
        if role == "tool":
            name = str(msg.get("name") or msg.get("tool_call_id") or "tool")
            excerpt = to_single_line(content, max_chars)
            log.debug(f"Step {step} (tool_result/{name}): {excerpt}")
            continue

        # Assistant or user text
        excerpt = to_single_line(content, max_chars)
        if excerpt:
            log.debug(f"Step {step} ({role}): {excerpt}")


# ─── Payload parsing ────────────────────────────────────────────────────────

@dataclass
class TaskExecutePayload:
    """Validated fields extracted from the base64 job payload."""
    kind: str
    params: Dict[str, Any]
    repo: str
    instruction: str
    supplemental_guidance: List[str] = field(default_factory=list)
    payload: Dict[str, Any] = field(default_factory=dict)


def _is_non_actionable_planner_guidance(text: str) -> bool:
    lower = str(text or "").strip().lower()
    if not lower:
        return True
    blocked_markers = (
        "no worker instruction needed",
        "no additional instruction needed",
        "purely documentation update",
        "already updated",
        "nothing to do",
    )
    return any(marker in lower for marker in blocked_markers)


def parse_task_execute_payload(
    argv: List[str],
    *,
    accepted_kinds: Tuple[str, ...] = ("task.execute",),
    logger: Optional[Logger] = None,
) -> TaskExecutePayload:
    """Decode argv[1], validate required fields, return structured payload.

    Raises ``SystemExit`` via ``fail()`` on validation errors so callers
    don't need to handle them.
    """
    log = logger or Logger("[Executor]")
    if len(argv) < 2:
        raise SystemExit(fail("Missing base64 job payload", exit_code=2))

    try:
        payload = decode_payload(argv[1])
    except Exception as exc:
        raise SystemExit(fail(f"Failed to decode job payload: {exc}", exit_code=2))

    kind = payload.get("kind")
    params = payload.get("params", {})
    repo_raw = payload.get("repo")

    if not isinstance(kind, str) or not kind:
        raise SystemExit(fail("Invalid payload: missing 'kind'", exit_code=2))
    if not isinstance(params, dict):
        raise SystemExit(fail("Invalid payload: 'params' must be an object", exit_code=2))
    if not isinstance(repo_raw, str) or not repo_raw:
        raise SystemExit(fail("Invalid payload: missing 'repo'", exit_code=2))
    repo, repo_error = resolve_repo_within_assigned_root(repo_raw)
    if repo_error or not repo:
        raise SystemExit(fail(repo_error or "Invalid payload repo path", exit_code=2))

    if kind not in accepted_kinds:
        kinds_str = ", ".join(accepted_kinds)
        raise SystemExit(
            fail(f"Unsupported job kind '{kind}'. Accepted: {kinds_str}.", exit_code=2)
        )

    instruction = str(params.get("instruction") or "").strip()
    if not instruction:
        raise SystemExit(fail("task.execute requires 'instruction'", exit_code=2))

    planner_instruction = str(params.get("plannerWorkerInstruction") or "").strip()
    quality_revision_hint = str(params.get("qualityRevisionHint") or "").strip()

    supplemental_guidance: List[str] = []
    if planner_instruction and planner_instruction != instruction:
        if _is_non_actionable_planner_guidance(planner_instruction):
            log.info(
                "Planner guidance was provided but ignored due to "
                "non-actionable placeholder content."
            )
        else:
            log.info(
                "Planner guidance was provided, but preserving original "
                "user instruction as canonical task input."
            )
            supplemental_guidance.append(planner_instruction)
    if quality_revision_hint:
        log.info(
            "Quality revision guidance provided for this attempt; "
            "preserving canonical user instruction and applying additive guidance."
        )
        supplemental_guidance.append(quality_revision_hint)

    return TaskExecutePayload(
        kind=kind,
        params=params,
        repo=repo,
        instruction=instruction,
        supplemental_guidance=supplemental_guidance,
        payload=payload,
    )
