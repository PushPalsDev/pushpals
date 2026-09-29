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


def _parse_payload_json(raw: str) -> Dict[str, Any]:
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    return payload


def decode_payload(raw: str) -> Dict[str, Any]:
    stripped = str(raw or "").strip()
    if not stripped:
        raise ValueError("empty job payload")

    # Direct workers normally receive a file-backed base64 payload, but this
    # parser intentionally accepts the safe adjacent encodings too. That keeps
    # executor startup resilient if an outer wrapper normalizes padding, uses
    # url-safe base64, or hands through raw JSON during recovery.
    if stripped.startswith("{"):
        return _parse_payload_json(stripped)

    compact = "".join(stripped.split())
    padded = compact + ("=" * ((4 - len(compact) % 4) % 4))
    decode_errors: List[str] = []
    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            decoded = decoder(padded).decode("utf-8")
            return _parse_payload_json(decoded)
        except Exception as exc:
            decode_errors.append(str(exc))

    detail = "; ".join(error for error in decode_errors if error) or "unknown decode error"
    raise ValueError(f"invalid base64/JSON job payload: {detail}")


def read_encoded_payload_arg(argv: List[str]) -> str:
    if len(argv) < 2:
        raise ValueError("missing base64 job payload")
    mode = argv[1]
    if mode == "--payload-file":
        if len(argv) < 3 or not str(argv[2] or "").strip():
            raise ValueError("missing payload file path")
        path = Path(str(argv[2])).expanduser()
        return path.read_text(encoding="utf-8").strip()
    if mode == "--payload-stdin":
        return sys.stdin.read().strip()
    if len(mode) < 4096:
        try:
            path = Path(mode).expanduser()
            if path.is_file():
                return path.read_text(encoding="utf-8").strip()
        except OSError:
            pass
    return mode


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


def _string_list(value: Any, *, limit: int = 12, max_chars: int = 220) -> List[str]:
    if not isinstance(value, list):
        return []
    out: List[str] = []
    for item in value:
        text = to_single_line(item, max_chars)
        if text:
            out.append(text)
        if len(out) >= limit:
            break
    return out


def _append_list_guidance(lines: List[str], label: str, values: List[str]) -> None:
    if not values:
        return
    lines.append(f"- {label}:")
    for value in values:
        lines.append(f"  - {value}")


def _joined_task_text(params: Dict[str, Any]) -> str:
    pieces: List[str] = []

    def collect(value: Any) -> None:
        if isinstance(value, str):
            pieces.append(value)
        elif isinstance(value, list):
            for item in value:
                collect(item)
        elif isinstance(value, dict):
            for item in value.values():
                collect(item)

    collect(params.get("instruction"))
    collect(params.get("plannerWorkerInstruction"))
    collect(params.get("qualityRevisionHint"))
    planning = params.get("planning")
    if isinstance(planning, dict):
        collect(planning.get("targetPaths"))
        collect(planning.get("acceptanceCriteria"))
        collect(planning.get("validationSteps"))
        collect(planning.get("requiredValidationSteps"))
        collect(planning.get("discovery"))
    return "\n".join(pieces).lower()


def _looks_like_visual_derivation_task(params: Dict[str, Any]) -> bool:
    text = _joined_task_text(params)
    visual_markers = (
        "visual",
        "readability",
        "battlefield",
        "render",
        "rendering",
        "projectile",
        "planet",
        "ship",
        "ring",
        "danger",
        "threat",
        "ownership",
        "dense action",
        "ui surface",
        "style",
        "styles",
    )
    return any(marker in text for marker in visual_markers)


def _looks_like_route_shell_task(params: Dict[str, Any]) -> bool:
    text = _joined_task_text(params)
    shell_markers = (
        "route-entry",
        "route entry",
        "first-entry",
        "first entry",
        "startup shell",
        "home shell",
        "entry route",
        "shell/navigation",
        "app/_layout",
        "app/index",
        "homescreen",
        "home screen",
        "settingsscreen",
        "settings screen",
        "shopscreen",
        "shop screen",
        "help",
        "game-over",
        "game over",
        "match-start",
        "match start",
        "return affordance",
    )
    return any(marker in text for marker in shell_markers)


def _build_efficiency_guidance(params: Dict[str, Any]) -> str:
    revision = bool(str(params.get("qualityRevisionHint") or "").strip())
    automatic_validation = (
        _has_executor_validation_ownership(params)
        and params["executorValidationOwnership"]["owner"] == "pushpals_after_edit"
    )
    raw_turn_budget = params.get("executorTurnBudgetMs")
    turn_budget_s = (
        max(1, int(raw_turn_budget // 1000))
        if isinstance(raw_turn_budget, (int, float)) and not isinstance(raw_turn_budget, bool)
        and 0 < raw_turn_budget < float("inf") else None
    )
    lines: List[str] = [
        "Worker speed/convergence contract from PushPals:",
        (
            f"- This executor turn has at most {turn_budget_s}s for reading, edits, focused checks, and its final response; the original job deadline is shared with other turns."
            if turn_budget_s is not None else
            "- Target useful completion in roughly 20 minutes for small or medium repo tasks; optimize for the smallest coherent patch over exhaustive exploration."
        ),
        (
            (
                "- This is a focused revision of an existing patch. Inspect the current diff and the supplied failure/critic evidence, spend at most 30s rediscovering context, make the smallest correction, and return after focused checks. Do not restart full repository discovery or run aggregate validation; PushPals owns the full gates after this turn."
                if automatic_validation else
                "- This is a focused revision of an existing patch. Inspect the diff and supplied failure/critic evidence, spend at most 30s rediscovering context, make the smallest correction, then perform the required validation or report the unmet requirement. Do not assume an automatic validation handoff."
            )
            if revision else
            "- Allocate roughly 15% of this turn to discovery, 60% to editing, 20% to focused validation, and 5% to the final diff review. If a phase runs long, narrow scope rather than expanding the harness."
        ),
        "- No-edit checkpoint: if you have not made a patch after identifying the behavior-owning file, stop discovering and edit that file now. Do not spend the execution budget proving every adjacent assumption first.",
        "- Discovery command budget: for compact tasks, use at most 5-8 targeted read/search commands before editing. If that is not enough, state the blocker and patch the best behavior owner rather than widening discovery.",
        (
            "- Validation ownership: discover and run the focused checks needed for the changed behavior or failing-stage reproduction. Do not run the whole test suite or long aggregate validation merely to satisfy the required-validation list during editing; PushPals ValidationGate runs those required gates after this turn. If the task specifically requires reproducing an aggregate failure, use the smallest necessary reproduction once rather than repeating the whole suite."
            if automatic_validation else
            "- Validation ownership: discover and run the focused checks needed for the changed behavior, then perform required validation yourself where available and report any unmet requirements. No automatic post-edit runner has been established; do not omit required checks by assuming another service will run them."
        ),
    ]
    if str(os.environ.get("PUSHPALS_WORKER_DOCKER_CAPABILITY", "")).strip() == "unavailable":
        lines.append(
            "- Known worker capability: this sandbox intentionally has no Docker daemon/socket. Do not run or retry validation commands known to require it, including aggregate commands containing a Docker-dependent stage. Continue with runnable focused checks. "
            + (
                "Report the pending gate. ValidationGate preserves the required command for trusted-host validation against the exact candidate SHA before publication; deferral is not a pass and must not be reported as successful validation. "
                if automatic_validation else
                "Report the capability-blocked requirement explicitly; no automatic trusted-host handoff is established, and deferral is not a pass. "
            )
            + "Do not alter tests or product code to bypass this requirement."
        )
    route_shell_task = _looks_like_route_shell_task(params)
    visual_task = _looks_like_visual_derivation_task(params)
    if route_shell_task or visual_task:
        lines.append(
            "- Test-harness soft budget: if setting up a focused test requires multiple new shared mocks, broad React Native shims, or repeated import fixes, stop building that harness and switch to smaller pure helper/state/style coverage.",
        )
    if route_shell_task:
        lines.extend(
            [
                "- Route-entry/shell task rule: inspect the hinted route wrapper, then move immediately to the behavior-owning shell component when the route is thin. Do not keep re-reading navigation topology once the owner is found.",
                "- Compact shell polish rule: make one small visual/affordance patch before chasing missing test infrastructure. If a referenced React Native mock or app/__tests__ path is absent, use existing nearby tests or a focused style/helper assertion instead of creating a broad render harness.",
                (
                    "- Shell task deadline: by the first clear owner hypothesis, choose the home/settings/shop/help/game-over surface and patch it; ValidationGate can run long browser checks after your focused validation."
                    if automatic_validation else
                    "- Shell task deadline: by the first clear owner hypothesis, choose the behavior-owning surface and patch it; perform required browser checks where available or report the blocker without assuming a later runner."
                ),
            ]
        )
    if visual_task:
        lines.extend(
            [
                "- Visual/rendering task rule: prefer pure helper/state/style-prop tests for derived visual cues. Use a full React Native/component render regression only if the repo already has a stable harness for that exact surface.",
                "- Full-surface React Native tests are a last resort for visual derivation work; do not spend the job constructing broad mocks just to assert pixels or nested component trees.",
            ]
        )
    return "\n".join(lines)


def _build_planning_guidance(params: Dict[str, Any]) -> str:
    planning = params.get("planning")
    if not isinstance(planning, dict):
        return ""

    compact_task = _looks_like_route_shell_task(params) or _looks_like_visual_derivation_task(params)
    lines: List[str] = ["Task planning contract from PushPals:"]
    intent = to_single_line(planning.get("intent"), 80)
    risk = to_single_line(planning.get("riskLevel"), 80)
    priority = to_single_line(planning.get("queuePriority"), 80)
    summary_parts = []
    if intent:
        summary_parts.append(f"intent={intent}")
    if risk:
        summary_parts.append(f"risk={risk}")
    if priority:
        summary_parts.append(f"priority={priority}")
    if summary_parts:
        lines.append(f"- Planning summary: {', '.join(summary_parts)}")
    automatic_validation = (
        _has_executor_validation_ownership(params)
        and params["executorValidationOwnership"]["owner"] == "pushpals_after_edit"
    )
    lines.append(
        "- Worker phase contract: discovering -> editing -> focused validation -> "
        + ("full validation handoff" if automatic_validation else "required validation or explicit blocker")
        + " -> final diff review."
    )
    lines.append(
        "  - discovering: inspect relevant files/artifacts and state the current hypothesis before editing."
    )
    lines.append("  - editing: make the smallest behavior-owning patch.")
    lines.append("  - focused validation: run targeted fast checks for the changed surface.")
    if automatic_validation:
        lines.append(
            "  - full validation: hand off the whole suite and long required/aggregate/browser checks to PushPals ValidationGate after focused validation; required gates are not waived."
        )
    else:
        lines.append("  - full validation: follow the configured validation ownership, verify required checks, and report any unmet requirements; no automatic handoff is established by this planning section.")
    lines.append("  - final diff review: remove unrelated churn before returning.")
    lines.append(
        "- Phase limits: follow the current executor-turn budget and revision guidance above; do not assume a fresh full-job budget. If test harness setup consumes that budget, reduce to focused coverage using the existing harness."
    )

    scope = planning.get("scope")
    if isinstance(scope, dict):
        write_allowed = scope.get("writeAllowed")
        read_anywhere = scope.get("readAnywhere")
        scope_parts = []
        if isinstance(read_anywhere, bool):
            scope_parts.append(f"read_anywhere={str(read_anywhere).lower()}")
        if isinstance(write_allowed, bool):
            scope_parts.append(f"write_allowed={str(write_allowed).lower()}")
        if scope_parts:
            lines.append(f"- Repo access: {', '.join(scope_parts)}")
        write_globs = _string_list(scope.get("writeGlobs"), limit=10)
        if write_globs:
            lines.append("- Write globs are relevance hints, not hard limits; edit behavior-owning files as needed.")
            _append_list_guidance(lines, "Write-scope hints", write_globs)
        forbidden = _string_list(scope.get("forbiddenGlobs"), limit=8)
        _append_list_guidance(lines, "Forbidden path hints", forbidden)

    _append_list_guidance(
        lines,
        "Target path hints",
        _string_list(planning.get("targetPaths"), limit=6 if compact_task else 12),
    )
    _append_list_guidance(
        lines,
        "Repo hint preflight diagnostics",
        _string_list(planning.get("repoHintDiagnostics"), limit=8),
    )
    if _string_list(planning.get("repoHintDiagnostics"), limit=1):
        lines.append(
            "- If a hinted path is absent, treat it as stale guidance unless the task explicitly asks to create that path; prefer an existing repo-native owner or nearby test."
        )

    discovery = planning.get("discovery")
    if isinstance(discovery, dict):
        _append_list_guidance(
            lines,
            "Suggested discovery commands",
            _string_list(discovery.get("ripgrepQueries"), limit=4 if compact_task else 8),
        )
        _append_list_guidance(
            lines,
            "Likely directories",
            _string_list(discovery.get("likelyDirs"), limit=4 if compact_task else 8),
        )
        _append_list_guidance(
            lines,
            "Search keywords",
            _string_list(discovery.get("keywords"), limit=8 if compact_task else 12),
        )

    _append_list_guidance(
        lines,
        "Acceptance criteria",
        _string_list(planning.get("acceptanceCriteria"), limit=10, max_chars=260),
    )
    guidance = "\n".join(lines).strip()
    if len(guidance) > 4000:
        guidance = guidance[:4000].rstrip() + "\n- Planning guidance truncated to stay within worker prompt budget."
    return guidance


def _has_executor_validation_ownership(params: Dict[str, Any]) -> bool:
    contract = params.get("executorValidationOwnership")
    return (
        isinstance(contract, dict)
        and contract.get("schemaVersion") == 1
        and contract.get("owner") in ("pushpals_after_edit", "executor")
        and isinstance(contract.get("focusedCommands"), list)
        and isinstance(contract.get("postEditCommands"), list)
        and isinstance(contract.get("requiredSteps"), list)
    )


def _render_complete_validation_requirements(
    lines: List[str], entries: List[Tuple[str, Any]], omitted: int = 0,
) -> str:
    """Whole commands only, including fallback requirements without a contract."""
    displayed_commands: Set[str] = set()
    used_chars = sum(len(entry) + 1 for entry in lines)
    for prefix, raw_command in entries:
        if not isinstance(raw_command, str) or any(ord(char) < 32 for char in raw_command):
            omitted += 1
            continue
        command = raw_command.strip()
        if not command or len(command) > 1000:
            omitted += 1
            continue
        if command in displayed_commands:
            continue
        line = prefix + command
        if used_chars + len(line) > 31_500:
            omitted += 1
            continue
        lines.append(line)
        used_chars += len(line) + 1
        displayed_commands.add(command)
    if omitted:
        lines.append(
            f"- {omitted} validation requirement(s) could not be displayed completely within the command/prompt limits. This manifest is incomplete, not a waiver or a pass. Inspect the original planning/vision requirements and report any requirement you cannot recover; do not guess a clipped command."
        )
    return "\n".join(lines)


def _build_executor_validation_guidance(params: Dict[str, Any]) -> str:
    if not _has_executor_validation_ownership(params):
        planning = params.get("planning")
        if not isinstance(planning, dict):
            return ""
        entries: List[Tuple[str, Any]] = []
        omitted = 0
        for field, label, limit in (
            ("validationSteps", "Planned validation steps", 16),
            ("requiredValidationSteps", "Required vision.md validation steps", 12),
        ):
            values = planning.get(field)
            if values is None:
                continue
            if not isinstance(values, list):
                omitted += 1
                continue
            omitted += max(0, len(values) - limit)
            entries.extend((f"- {label} (executor-owned): ", value) for value in values[:limit])
        if not entries and not omitted:
            return ""
        return _render_complete_validation_requirements([
            "Validation requirements without an established automatic runner:",
            "- Host-derived validation ownership is absent or malformed. Perform required checks where possible and report unmet requirements; no automatic post-edit or trusted-host handoff is established.",
        ], entries, omitted)
    contract = params["executorValidationOwnership"]
    lines = ["Host-derived validation ownership for this editing turn:"]
    if contract["owner"] == "executor":
        lines.append(
            "- Automatic post-edit ValidationGate is disabled. Do not assume PushPals will execute the listed commands; perform appropriate validation yourself and report unmet requirements honestly."
        )
    else:
        lines.extend([
            "- Edit-turn owner: you. Use focused checks for the changed behavior, then return the patch and validation observations.",
            "- Post-edit owner: PushPals. The scheduled gate commands below are a handoff manifest, not a request to execute them during coding. This ownership also applies when supplemental planner prose says to run the full suite.",
            "- Required vision.md commands remain required. PushPals recomputes and runs its gates after editing; the trusted host runs any deferred aggregate unchanged against the candidate. Do not split, omit, or claim a pending aggregate passed.",
            "- A small full suite can be the smallest useful check. For an explicit validation-repair/reproduction task, run one necessary reproduction or failing subcommand. These exceptions do not authorize repeated long full-suite runs after focused checks answer the question.",
            "- Executor-reported passes are observations, not reusable final-gate evidence. Only configured, enabled final gates run; validation and any enabled critic review use independent gate evidence.",
        ])
    # Commands are actionable suggestions, unlike prose. Never clip a command
    # or collapse whitespace inside a quoted path/filter while rendering it.
    focused: List[str] = []
    for command in contract["focusedCommands"]:
        if not isinstance(command, str) or any(ord(char) < 32 for char in command):
            continue
        complete_command = command.strip()
        if not complete_command or len(complete_command) > 500:
            continue
        focused.append(complete_command)
        if len(focused) >= 4:
            break
    _append_list_guidance(lines, "Suggested focused checks (verify current checkout relevance)", focused)
    if not focused:
        lines.append("- No focused command was established from current test targets. Inspect the relevant existing test/manifest and choose the smallest valid check; do not invent a test runner or automatically substitute the full suite.")
    # Match the trusted-command length limit and preserve exact quoted argv.
    # Budget the whole section, not a prefix of an executable-looking command.
    omitted = max(0, len(contract["postEditCommands"]) - 16) + max(0, len(contract["requiredSteps"]) - 12)
    entries = []
    for node in contract["postEditCommands"][:16]:
        if not isinstance(node, dict):
            omitted += 1
            continue
        capability = node.get("capability")
        if capability in ("worker", "trusted_host"):
            label = "Scheduled after editing" if contract["owner"] == "pushpals_after_edit" else "Validation requirement (no automatic runner)"
            entries.append((f"- {label} [{capability}]: ", node.get("command")))
        else:
            omitted += 1
    for command in contract["requiredSteps"][:12]:
        label = "Required gate criterion (not an extra edit-turn command)" if contract["owner"] == "pushpals_after_edit" else "Required validation criterion (executor-owned)"
        entries.append((f"- {label}: ", command))
    return _render_complete_validation_requirements(lines, entries, omitted)


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
    try:
        payload = decode_payload(read_encoded_payload_arg(argv))
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
    supplemental_guidance.append(_build_efficiency_guidance(params))
    planning_guidance = _build_planning_guidance(params)
    if planning_guidance:
        supplemental_guidance.append(planning_guidance)
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
    # Keep ownership outside the truncated planning section and after planner
    # prose/revision context, which often repeats a broad validation checklist.
    validation_guidance = _build_executor_validation_guidance(params)
    if validation_guidance:
        supplemental_guidance.append(validation_guidance)

    return TaskExecutePayload(
        kind=kind,
        params=params,
        repo=repo,
        instruction=instruction,
        supplemental_guidance=supplemental_guidance,
        payload=payload,
    )
