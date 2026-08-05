#!/usr/bin/env python3
"""PushPals OpenAI Codex backend wrapper.

Runs `codex exec` in non-interactive mode and emits one structured result line
that the TypeScript host parses.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
from shutil import rmtree, which
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_SHARED_DIR = Path(__file__).resolve().parents[1] / "shared"
if str(_SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(_SHARED_DIR))

from executor_base import (
    Logger,
    SettingsResolver,
    build_settings_resolver,
    emit,
    log_git_status,
    looks_local_base_url,
    parse_task_execute_payload,
    prompts_root_for_runtime_assets,
    resolve_llm_config,
    summarize_git_changes,
    to_int,
    to_single_line,
)

LOG_PREFIX = "[OpenAICodexExecutor]"
DEFAULT_CODEX_MODEL = "gpt-5.6-sol"
LEGACY_CODEX_MODEL_FALLBACK = "gpt-5.5"
_ACTIVE_CHILD: Optional[subprocess.Popen[str]] = None
_INTERRUPTED_SIGNAL: Optional[int] = None
log = Logger(LOG_PREFIX)

_PROMPT_TEMPLATE_CACHE: Dict[str, str] = {}
_PROMPT_TOKEN_REGEX = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")
_TASK_SYSTEM_PROMPT_PATH = "workerpals/openai_codex_task_execute_system_prompt.md"
_DEFAULT_TASK_SYSTEM_PROMPT_PATH = "workerpals/openai_codex_default_system_prompt.md"
_MANDATORY_RUNTIME_POLICY_APPENDIX_PATH = "workerpals/openai_codex_runtime_policy_appendix.md"
_INSTRUCTION_WRAPPER_PROMPT_PATH = "workerpals/openai_codex_instruction_wrapper.md"
_SUPPLEMENTAL_GUIDANCE_SECTION_PATH = "workerpals/openai_codex_supplemental_guidance_section.md"
_COMMAND_ROUTER_POLICY_PATH = "workerpals/openai_codex_command_router_policy.md"
_CODEX_WORKAROUND_PATTERNS = (
    re.compile(
        r"\bcodex cli\b.{0,120}\b(isn't|is not|not)\b.{0,120}\bavailable\b.{0,120}\b(so|therefore|instead|fallback|workaround|without|using)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bwithout requiring\b.{0,120}\bcodex\b", re.IGNORECASE),
    re.compile(r"\bavoid(?:ing)?\b.{0,120}\bcodex\b.{0,120}\bcall", re.IGNORECASE),
)
_CODEX_WORKAROUND_NEGATION_HINTS = (
    "do not",
    "don't",
    "never",
    "must not",
    "fail loudly",
    "hard-fail",
    "hard fail",
    "explicit failure",
    "codex cli is required infrastructure",
)
_REJECTED_EXEC_COMMAND_PATTERN = re.compile(r"exec_command failed for `([^`]+)`", re.IGNORECASE)
_MODEL_REQUIRES_NEWER_CODEX_PATTERN = re.compile(
    r"model requires a newer version of codex|requires a newer version of codex|upgrade to the latest app or cli",
    re.IGNORECASE,
)
_DISALLOWED_SHELL_WRAPPER_PREFIXES = (
    "/bin/bash -lc ",
    "/bin/bash -c ",
    "bash -lc ",
    "bash -c ",
    "sh -lc ",
    "sh -c ",
    "cmd /c ",
    "powershell -command ",
    "powershell.exe -command ",
    "pwsh -command ",
    "pwsh.exe -command ",
)

_VALID_APPROVAL_POLICIES = {"untrusted", "on-failure", "on-request", "never"}
_VALID_SANDBOX_POLICIES = {"read-only", "workspace-write", "danger-full-access"}
_VALID_COLORS = {"always", "never", "auto"}
_VALID_AUTH_MODES = {"auto", "api_key", "chatgpt"}
_VALID_REASONING_EFFORTS = {"low", "medium", "high", "xhigh"}
_CODEX_SANDBOX_DEPENDENCY_ARTIFACTS = ("node_modules",)
_MAX_WRAPPER_RECOVERY_ATTEMPTS = 2
_MAX_WRAPPER_BOOTSTRAP_OUTPUT_CHARS = 1_200
_MAX_WRAPPER_BOOTSTRAP_TOTAL_CHARS = 5_000
_MAX_CREDIBLE_WRAPPER_LOOP_CHANGED_PATHS = 8
_MAX_CREDIBLE_WRAPPER_LOOP_TOP_LEVELS = 4
_BATCH_GIT_CONTENT_DELTA_MIN_PATHS = 8
_MAX_STARTUP_STALL_RECOVERY_ATTEMPTS = 1
_MAX_STARTUP_STALL_DURING_NO_EDIT_RECOVERY_ATTEMPTS = 2
_MAX_NO_EDIT_RECOVERY_ATTEMPTS = 2
_MAX_ROLLOUT_RECOVERY_ATTEMPTS = 1
_DEFAULT_NO_EDIT_WATCHDOG_S = 480
_SMALL_TASK_NO_EDIT_WATCHDOG_S = 240
_NARROW_TEST_TASK_NO_EDIT_WATCHDOG_S = 180
_WEB_REVIEW_NO_EDIT_WATCHDOG_S = 240
_BACKGROUND_NO_EDIT_WATCHDOG_S = 120
_NO_EDIT_RECOVERY_WATCHDOG_S = 90
_FINAL_NO_EDIT_RECOVERY_WATCHDOG_S = 60
_DEFAULT_NO_EDIT_RECHECK_S = 120
_REVIEW_FIX_NO_EDIT_RECHECK_S = 30
_NO_EDIT_RECOVERY_RECHECK_S = 30
_FINAL_NO_EDIT_RECOVERY_RECHECK_S = 15
_DEFAULT_NO_EDIT_COMMAND_GRACE_S = 240
_DEFAULT_NO_EDIT_COMMAND_PROGRESS_CAP_S = 360
_BACKGROUND_NO_EDIT_COMMAND_PROGRESS_CAP_S = 120
_VALIDATION_REPAIR_NO_EDIT_WATCHDOG_S = 300
_VALIDATION_REPAIR_COMMAND_PROGRESS_CAP_S = 360
_NO_EDIT_RECOVERY_COMMAND_PROGRESS_CAP_S = 120
_FINAL_NO_EDIT_RECOVERY_COMMAND_PROGRESS_CAP_S = 60
_DEFAULT_STARTUP_STALL_WATCHDOG_S = 210
_RECOVERY_STARTUP_STALL_WATCHDOG_S = 150
_DEFAULT_ROLLOUT_WATCHDOG_S = 300
_SMALL_TASK_ROLLOUT_WATCHDOG_S = 240
_NARROW_TEST_TASK_ROLLOUT_WATCHDOG_S = 150
_WEB_REVIEW_ROLLOUT_WATCHDOG_S = 180
_VALIDATION_REPAIR_ROLLOUT_WATCHDOG_S = 240
_BACKGROUND_ROLLOUT_WATCHDOG_S = 90
_MIN_AUTO_WATCHDOG_TIMEOUT_S = 180
_MIN_CODEX_RECOVERY_ATTEMPT_S = 120
_NO_PUBLISHABLE_FAILURE_COOLDOWN_MS = 10 * 60 * 1000
_CODEX_STARTUP_ONLY_EVENT_TYPES = {"thread.started", "turn.started"}


def _model_supports_xhigh_reasoning(model: str) -> bool:
    normalized = str(model or "").strip().lower()
    if not normalized:
        return False
    return not (
        normalized == "gpt-5.4"
        or normalized.startswith("gpt-5.4-")
        or normalized == "codex-1p"
        or normalized.startswith("codex-1p-")
    )


@dataclass(frozen=True)
class OpenAICodexRuntimeConfig:
    codex_bin_json: str
    codex_bin: str
    auth_mode: str
    base_url_override: str
    timeout_seconds_override: int
    timeout_ms_top_level: int
    timeout_ms_llm_codex: int
    timeout_ms_backend: int
    progress_log_interval_s: int
    reasoning_effort: str
    approval_policy: str
    sandbox: str
    color: str
    json_output: bool

    @classmethod
    def from_sources(cls, settings: Optional[SettingsResolver] = None) -> "OpenAICodexRuntimeConfig":
        cfg = settings or build_settings_resolver()
        return cls(
            codex_bin_json=cfg.get_str(
                env_names=("PUSHPALS_OPENAI_CODEX_BIN_JSON",),
                config_paths=("workerpals.llm.codex_bin_json", "workerpals.openai_codex.bin_json"),
                default="",
            ),
            codex_bin=cfg.get_str(
                env_names=("PUSHPALS_OPENAI_CODEX_BIN",),
                config_paths=("workerpals.llm.codex_bin", "workerpals.openai_codex.bin"),
                default="",
            ),
            auth_mode=cfg.get_str(
                env_names=("PUSHPALS_OPENAI_CODEX_AUTH_MODE",),
                config_paths=("workerpals.llm.codex_auth_mode", "workerpals.openai_codex.auth_mode"),
                default="auto",
            ),
            base_url_override=cfg.get_str(
                env_names=("PUSHPALS_OPENAI_CODEX_BASE_URL",),
                config_paths=("workerpals.llm.codex_base_url", "workerpals.openai_codex.base_url"),
                default="",
            ),
            timeout_seconds_override=cfg.get_int(
                env_names=("WORKERPALS_OPENAI_CODEX_TIMEOUT_S",),
                config_paths=("workerpals.openai_codex.timeout_s",),
                default=0,
            ),
            timeout_ms_top_level=cfg.get_int(
                env_names=("WORKERPALS_OPENAI_CODEX_TIMEOUT_MS",),
                config_paths=("workerpals.openai_codex_timeout_ms",),
                default=0,
            ),
            timeout_ms_llm_codex=cfg.get_int(
                env_names=("WORKERPALS_LLM_CODEX_TIMEOUT_MS",),
                config_paths=("workerpals.llm.codex_timeout_ms",),
                default=0,
            ),
            timeout_ms_backend=cfg.get_int(
                env_names=("WORKERPALS_OPENAI_CODEX_BACKEND_TIMEOUT_MS",),
                config_paths=("workerpals.openai_codex.timeout_ms",),
                default=0,
            ),
            progress_log_interval_s=cfg.get_int(
                env_names=("WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S",),
                config_paths=("workerpals.openai_codex.progress_log_interval_s",),
                default=30,
            ),
            reasoning_effort=cfg.get_str(
                env_names=("WORKERPALS_LLM_REASONING_EFFORT", "WORKERPALS_OPENAI_CODEX_REASONING_EFFORT"),
                config_paths=("workerpals.llm.reasoning_effort", "workerpals.openai_codex.reasoning_effort"),
                default="xhigh",
            ),
            approval_policy=cfg.get_str(
                env_names=("WORKERPALS_OPENAI_CODEX_APPROVAL_POLICY",),
                config_paths=("workerpals.openai_codex.approval_policy",),
                default="never",
            ),
            sandbox=cfg.get_str(
                env_names=("WORKERPALS_OPENAI_CODEX_SANDBOX",),
                config_paths=("workerpals.openai_codex.sandbox",),
                default="workspace-write",
            ),
            color=cfg.get_str(
                env_names=("WORKERPALS_OPENAI_CODEX_COLOR",),
                config_paths=("workerpals.openai_codex.color",),
                default="never",
            ),
            json_output=cfg.get_bool(
                env_names=("WORKERPALS_OPENAI_CODEX_JSON",),
                config_paths=("workerpals.openai_codex.json",),
                default=False,
            ),
        )


def shutil_which(binary: str) -> str:
    return which(binary) or ""


def _resolve_command_executable(binary: str) -> str:
    value = str(binary or "").strip()
    if not value or os.path.dirname(value) or os.path.isabs(value):
        return value
    return shutil_which(value) or value


def _normalize_command_prefix(parts: List[str]) -> List[str]:
    if not parts:
        return []
    return [_resolve_command_executable(parts[0]), *parts[1:]]


def _truncate(text: str, max_chars: int = 4000) -> str:
    value = str(text or "")
    if len(value) <= max_chars:
        return value
    return value[: max(1, max_chars - 15)] + "\n...[truncated]"


def _repo_root_for_prompt_loading() -> Path:
    return prompts_root_for_runtime_assets()


def _resolve_prompt_file(relative_path: str) -> Path:
    return _repo_root_for_prompt_loading() / "prompts" / relative_path


def _load_prompt_template(
    relative_path: str, replacements: Optional[Dict[str, str]] = None
) -> str:
    prompt_path = _resolve_prompt_file(relative_path)
    cache_key = str(prompt_path)
    cached = _PROMPT_TEMPLATE_CACHE.get(cache_key)
    if cached is not None:
        template = cached
    else:
        try:
            template = prompt_path.read_text(encoding="utf-8").strip()
        except Exception:
            template = ""
        _PROMPT_TEMPLATE_CACHE[cache_key] = template
    if not replacements:
        return template

    def _replace(match: re.Match[str]) -> str:
        key = match.group(1)
        value = replacements.get(key)
        if value is None:
            raise KeyError(f"Missing prompt replacement '{{{{{key}}}}}' for {prompt_path}")
        return value

    return _PROMPT_TOKEN_REGEX.sub(_replace, template)


def _load_markdown_h2_section(relative_path: str, heading: str) -> str:
    document = _load_prompt_template(relative_path)
    if not document:
        return ""
    lines = document.splitlines()
    needle = f"## {heading}".strip().lower()
    start: Optional[int] = None
    for idx, line in enumerate(lines):
        if line.strip().lower() == needle:
            start = idx + 1
            break
    if start is None:
        return ""
    collected: List[str] = []
    for line in lines[start:]:
        if line.startswith("## "):
            break
        collected.append(line)
    return "\n".join(collected).strip()


def _command_router_policy_guidance() -> str:
    guidance = _load_markdown_h2_section(_COMMAND_ROUTER_POLICY_PATH, "Base Guidance")
    if guidance:
        return guidance
    return (
        "Command-router policy: shell commands are allowed, but invoke the actual command directly "
        "instead of wrapping it with `/bin/bash -lc`, `bash -c`, `sh -lc`, `cmd /c`, "
        "`powershell -Command`, or `pwsh -Command`. If a wrapper command is rejected, rerun its "
        "inner command directly through the command tool."
    )


def _command_router_recovery_guidance() -> str:
    guidance = _load_markdown_h2_section(_COMMAND_ROUTER_POLICY_PATH, "Recovery Guidance")
    if guidance:
        return guidance
    return (
        "Command-router recovery: the previous attempt retried disallowed shell wrappers.\n"
        "Retry once using shell commands normally, but invoke the inner command directly instead of "
        "wrapping it in `/bin/bash -lc`, `bash -c`, `sh -lc`, `cmd /c`, `powershell -Command`, or "
        "`pwsh -Command`.\n"
        "You are not limited to a fixed allowlist of commands. The constraint is only that command "
        "execution must target the actual program/argv directly rather than a wrapper shell."
    )


def _command_router_hard_recovery_guidance() -> str:
    guidance = _load_markdown_h2_section(_COMMAND_ROUTER_POLICY_PATH, "Hard Recovery Guidance")
    if guidance:
        return guidance
    return (
        "Command-router escalation: the previous retry still attempted disallowed shell wrappers.\n"
        "Do not invoke `bash`, `/bin/bash`, `sh`, `cmd`, `powershell`, `powershell.exe`, `pwsh`, "
        "or `pwsh.exe` as the command itself on this attempt.\n"
        "Your first command invocation on this retry must be one of the direct replacements listed "
        "below, with no wrapper shell around it.\n"
        "After you re-establish repo context, continue using ordinary shell commands directly "
        "without wrapper shells."
    )


def _command_router_rejection_detail_intro() -> str:
    guidance = _load_markdown_h2_section(_COMMAND_ROUTER_POLICY_PATH, "Rejection Detail")
    if guidance:
        return guidance
    return (
        "Codex repeatedly attempted disallowed shell-wrapper commands that the command router "
        "rejected. Shell commands are allowed, but wrapper shells are not; invoke the inner "
        "command directly and avoid wrapper retries."
    )


def _to_positive_int(raw: str) -> Optional[int]:
    try:
        parsed = int(raw)
    except Exception:
        return None
    return parsed if parsed > 0 else None


def _normalize_choice(
    value: str,
    valid: set[str],
    default: str,
    *,
    env_name: str,
) -> str:
    normalized = value.strip().lower()
    if normalized in valid:
        return normalized
    if normalized:
        log.info(
            f"Invalid {env_name}={value!r}; using default {default!r}. "
            f"Allowed: {', '.join(sorted(valid))}."
        )
    return default


def _is_git_repo(repo: str, timeout_seconds: float = 5.0, poll_seconds: float = 0.1) -> bool:
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    last_detail = ""
    attempts = 0

    while True:
        attempts += 1
        try:
            proc = subprocess.run(
                ["git", "rev-parse", "--is-inside-work-tree"],
                cwd=repo,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            if proc.returncode == 0 and (proc.stdout or "").strip().lower() == "true":
                return True
            last_detail = "\n".join(
                part.strip()
                for part in [proc.stderr or "", proc.stdout or ""]
                if part and part.strip()
            )
        except Exception as exc:
            last_detail = str(exc)

        if time.monotonic() >= deadline:
            if last_detail:
                log.warning(
                    "Git repository preflight failed "
                    f"after {attempts} attempt(s) for {repo}: {to_single_line(last_detail, 240)}"
                )
            return False

        time.sleep(max(0.01, poll_seconds))


def _codex_project_config_roots(repo: str, env: Dict[str, str]) -> List[Path]:
    roots: List[Path] = []
    seen: set[str] = set()

    def add(raw: object) -> None:
        text = str(raw or "").strip()
        if not text:
            return
        try:
            path = Path(text).resolve()
        except Exception:
            return
        key = str(path)
        if key in seen:
            return
        seen.add(key)
        roots.append(path)

    add(repo)
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if proc.returncode == 0:
            add((proc.stdout or "").strip())
    except Exception:
        pass

    for key in (
        "PUSHPALS_REPO_ROOT_OVERRIDE",
        "PUSHPALS_PROJECT_ROOT_OVERRIDE",
        "PUSHPALS_ASSIGNED_REPO_ROOT",
        "PUSHPALS_REPO_PATH",
    ):
        add(env.get(key))
    return roots


def _mask_repo_local_codex_files(repo: str, env: Dict[str, str]) -> List[Tuple[Path, Path]]:
    masked: List[Tuple[Path, Path]] = []
    for root in _codex_project_config_roots(repo, env):
        codex_path = root / ".codex"
        if not os.path.lexists(codex_path):
            continue
        if codex_path.is_dir():
            continue
        backup = root / f".codex.pushpals-masked-{os.getpid()}-{len(masked)}"
        suffix = 0
        while os.path.lexists(backup):
            suffix += 1
            backup = root / f".codex.pushpals-masked-{os.getpid()}-{len(masked)}-{suffix}"
        try:
            os.replace(codex_path, backup)
            masked.append((codex_path, backup))
            log.info(
                f"Temporarily masked repo-local .codex file so Codex CLI can use CODEX_HOME: {codex_path}"
            )
        except Exception as exc:
            log.warning(f"Failed to mask repo-local .codex file {codex_path}: {exc}")
    return masked


def _restore_repo_local_codex_files(masked: List[Tuple[Path, Path]]) -> None:
    for codex_path, backup in reversed(masked):
        try:
            if os.path.lexists(codex_path):
                if codex_path.is_dir() and not codex_path.is_symlink():
                    rmtree(codex_path)
                else:
                    codex_path.unlink()
            if os.path.lexists(backup):
                os.replace(backup, codex_path)
        except Exception as exc:
            log.warning(f"Failed to restore repo-local .codex file {codex_path}: {exc}")


def _resolve_codex_command_prefix(config: OpenAICodexRuntimeConfig) -> List[str]:
    override_json = config.codex_bin_json
    if override_json:
        try:
            parsed = json.loads(override_json)
            if isinstance(parsed, list):
                parts = [str(p).strip() for p in parsed if str(p).strip()]
                if parts:
                    return _normalize_command_prefix(parts)
        except Exception:
            log.info(
                "Invalid PUSHPALS_OPENAI_CODEX_BIN_JSON; expected JSON array of command segments."
            )

    override = config.codex_bin
    if override:
        try:
            parts = [p for p in shlex.split(override) if p.strip()]
        except Exception:
            log.info(
                "Invalid PUSHPALS_OPENAI_CODEX_BIN value; expected a command string parseable by shlex."
            )
            return []
        return _normalize_command_prefix(parts)

    # The worker image installs Codex during image construction. Prefer that
    # deterministic binary so job startup never needs registry access.
    codex = shutil_which("codex")
    if codex:
        return [codex]
    bunx = shutil_which("bunx")
    if bunx:
        return [bunx, "--yes", "@openai/codex"]
    return []


def _path_is_inside(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _codex_sandbox_additional_dirs(repo: str) -> List[str]:
    try:
        repo_path = Path(repo).resolve()
    except Exception:
        return []

    out: List[str] = []
    seen: set[str] = set()
    for name in _CODEX_SANDBOX_DEPENDENCY_ARTIFACTS:
        artifact = Path(repo) / name
        try:
            if not artifact.exists():
                continue
            resolved = artifact.resolve()
        except Exception:
            continue
        try:
            if not resolved.is_dir():
                continue
        except Exception:
            continue
        if _path_is_inside(resolved, repo_path):
            continue
        key = os.path.normcase(str(resolved))
        if key in seen:
            continue
        seen.add(key)
        out.append(str(resolved))
    return out


def _resolve_communicate_timeout_seconds(config: OpenAICodexRuntimeConfig) -> Optional[int]:
    explicit_s = _to_positive_int(str(config.timeout_seconds_override))
    if explicit_s is not None:
        return explicit_s
    # Top-level execution budget (e.g. openai_codex_timeout_ms = 7200000 in [workerpals])
    # takes precedence over the more granular LLM/CLI-level timeout settings.
    top_level_ms = config.timeout_ms_top_level
    if top_level_ms > 0:
        return max(1, top_level_ms // 1000)
    timeout_ms = config.timeout_ms_llm_codex
    if timeout_ms <= 0:
        timeout_ms = config.timeout_ms_backend
    if timeout_ms <= 0:
        return None
    return max(1, timeout_ms // 1000)


def _resolve_reasoning_effort(config: OpenAICodexRuntimeConfig, model: str = DEFAULT_CODEX_MODEL) -> str:
    raw = config.reasoning_effort
    normalized = str(raw).strip().lower()
    default_effort = "xhigh" if _model_supports_xhigh_reasoning(model) else "high"
    if normalized in {"extra high", "extra-high", "extrahigh", "x-high"}:
        normalized = "xhigh"
    if normalized == "xhigh" and not _model_supports_xhigh_reasoning(model):
        log.info(
            f"Downgrading workerpals.openai_codex.reasoning_effort='xhigh' to 'high' for model {model!r}."
        )
        return "high"
    if normalized in _VALID_REASONING_EFFORTS:
        return normalized
    log.info(
        "Invalid workerpals.openai_codex.reasoning_effort="
        f"{raw!r}; using default {default_effort!r}. Allowed: low, medium, high, xhigh."
    )
    return default_effort


def _looks_like_small_task_prompt(prompt: str) -> bool:
    text = str(prompt or "").lower()
    small_markers = (
        "risk=low",
        "small scoped",
        "small or medium repo tasks",
        "compact",
        "low-risk",
        "low risk",
        "route-entry",
        "first-entry",
        "home shell",
        "startup shell",
        "shell polish",
        "visual/affordance",
        "repo-native web review",
        "web review path",
        "browser smoke",
        "web delivery",
        "navigation trustworthy",
        "test-only",
        "test only",
        "contract test",
        "contract-level test",
        "contract-level tests",
        "contract around",
        "contract coverage",
        "focused contract coverage",
        "ranking contract",
        "regression coverage",
        "focused coverage",
        "focused regression",
        "focused scenario",
        "targeted test",
        "small deterministic",
        "review-fix",
        "review fix",
        "rejected pr",
        "must-fix",
        "cleanup harness",
        "one-file",
        "one file",
        "single-file",
        "single file",
        "max_files_to_edit: 1",
        "max_files_to_edit=1",
        "maxfilestoedit: 1",
        "maxfilestoedit=1",
    )
    heavy_markers = (
        "merge-conflict",
        "merge conflict",
        "rebase",
        "broad refactor",
        "migration",
        "security",
        "architecture",
        "deep debug",
    )
    return any(marker in text for marker in small_markers) and not any(
        marker in text for marker in heavy_markers
    )


def _looks_like_review_fix_prompt(prompt: str) -> bool:
    text = str(prompt or "").lower()
    return any(
        marker in text
        for marker in (
            "review-fix",
            "review fix",
            "rejected pr",
            "existing pr branch",
            "previous reviewagent score",
        )
    )


def _looks_like_narrow_test_task_prompt(prompt: str) -> bool:
    text = str(prompt or "").lower()
    if not text:
        return False
    narrow_markers = (
        "contract test",
        "contract-level test",
        "contract-level tests",
        "contract around",
        "contract coverage",
        "focused contract coverage",
        "ranking contract",
        "regression coverage",
        "focused coverage",
        "focused test",
        "focused tests",
        "focused testing",
        "focused regression",
        "test-only",
        "test only",
        "targeted test",
        "focused scenario",
        "cleanup harness",
    )
    if not any(marker in text for marker in narrow_markers):
        return False
    broad_markers = (
        "full render harness",
        "full-surface",
        "full surface",
        "migration",
        "broad refactor",
    )
    return not any(marker in text for marker in broad_markers)


def _minimum_recovery_attempt_seconds(requested_timeout_s: Optional[int]) -> int:
    if not requested_timeout_s or requested_timeout_s <= 0:
        return _MIN_CODEX_RECOVERY_ATTEMPT_S
    scaled_s = max(1, int(requested_timeout_s * 0.25))
    return max(2, min(_MIN_CODEX_RECOVERY_ATTEMPT_S, scaled_s))


def _resolve_task_reasoning_effort(
    configured_effort: str,
    prompt: str,
    model: str = DEFAULT_CODEX_MODEL,
) -> str:
    effort = configured_effort if configured_effort in _VALID_REASONING_EFFORTS else "high"
    if not _looks_like_small_task_prompt(prompt):
        return effort
    if effort == "xhigh":
        log.info(
            f"Routing compact task on model {model!r} from reasoning_effort='xhigh' to 'high' for faster convergence."
        )
        return "high"
    return effort


def _resolve_progress_log_interval_seconds(config: OpenAICodexRuntimeConfig) -> int:
    interval = to_int(config.progress_log_interval_s, 30)
    # Avoid noisy logs (<30s) and stale logs (>120s).
    return max(30, min(120, interval))


def _looks_like_background_autonomy_prompt(prompt: str) -> bool:
    text = str(prompt or "").lower()
    return (
        "priority=background" in text
        or "queuepriority=background" in text
        or "origin=autonomy" in text
        or "autonomy background" in text
    )


def _looks_like_validation_repair_prompt(prompt: str) -> bool:
    text = str(prompt or "").lower()
    if not text:
        return False
    return (
        "restore required validation:" in text
        or "required validation is repeatedly failing before publication" in text
        or "fix the repo baseline issue that makes this command fail" in text
        or (
            "primary failing command:" in text
            and "expected validation:" in text
            and "course of action:" in text
        )
    )


def _resolve_no_edit_watchdog_seconds(
    prompt: str,
    communicate_timeout_s: Optional[int],
    recovery_attempt: int = 0,
) -> Optional[int]:
    if not communicate_timeout_s:
        return None

    raw = os.environ.get("WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S", "").strip()
    if raw:
        if raw == "0":
            return None
        parsed = _to_positive_int(raw)
        if parsed is None:
            log.info(
                f"Invalid WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S={raw!r}; using default no-edit watchdog."
            )
        else:
            return max(1, min(parsed, max(1, communicate_timeout_s - 1)))

    if communicate_timeout_s < _MIN_AUTO_WATCHDOG_TIMEOUT_S:
        return None

    prompt_text = str(prompt or "").lower()
    is_background = _looks_like_background_autonomy_prompt(prompt)
    is_validation_repair = _looks_like_validation_repair_prompt(prompt)
    if is_validation_repair:
        default_s = _VALIDATION_REPAIR_NO_EDIT_WATCHDOG_S
    elif is_background:
        default_s = _BACKGROUND_NO_EDIT_WATCHDOG_S
    elif _looks_like_narrow_test_task_prompt(prompt):
        default_s = _NARROW_TEST_TASK_NO_EDIT_WATCHDOG_S
    elif "repo-native web review" in prompt_text or "web review path" in prompt_text:
        default_s = _WEB_REVIEW_NO_EDIT_WATCHDOG_S
    else:
        default_s = (
            _SMALL_TASK_NO_EDIT_WATCHDOG_S
            if _looks_like_small_task_prompt(prompt)
            else _DEFAULT_NO_EDIT_WATCHDOG_S
        )
    if recovery_attempt >= _MAX_NO_EDIT_RECOVERY_ATTEMPTS:
        default_s = min(default_s, _FINAL_NO_EDIT_RECOVERY_WATCHDOG_S)
    elif recovery_attempt > 0:
        default_s = min(default_s, _NO_EDIT_RECOVERY_WATCHDOG_S)
    floor_s = (
        60
        if recovery_attempt >= _MAX_NO_EDIT_RECOVERY_ATTEMPTS
        else 90
        if (is_background and not is_validation_repair) or recovery_attempt > 0
        else 120
    )
    return max(floor_s, min(default_s, max(floor_s, communicate_timeout_s - 60)))


def _resolve_no_edit_recheck_seconds(
    communicate_timeout_s: Optional[int],
    recovery_attempt: int = 0,
    prompt: str = "",
) -> int:
    raw = os.environ.get("WORKERPALS_OPENAI_CODEX_NO_EDIT_RECHECK_S", "").strip()
    if raw:
        parsed = _to_positive_int(raw)
        if parsed is None:
            log.info(
                f"Invalid WORKERPALS_OPENAI_CODEX_NO_EDIT_RECHECK_S={raw!r}; using default no-edit recheck interval."
            )
        else:
            upper = max(1, (communicate_timeout_s or parsed + 1) - 1)
            return max(1, min(parsed, upper))
    if recovery_attempt >= _MAX_NO_EDIT_RECOVERY_ATTEMPTS:
        default_s = _FINAL_NO_EDIT_RECOVERY_RECHECK_S
    elif recovery_attempt > 0:
        default_s = _NO_EDIT_RECOVERY_RECHECK_S
    elif _looks_like_review_fix_prompt(prompt):
        default_s = _REVIEW_FIX_NO_EDIT_RECHECK_S
    else:
        default_s = _DEFAULT_NO_EDIT_RECHECK_S
    upper = max(1, (communicate_timeout_s or default_s + 1) - 1)
    return max(1, min(default_s, upper))


def _resolve_no_edit_command_grace_seconds(communicate_timeout_s: Optional[int]) -> Optional[int]:
    if not communicate_timeout_s:
        return None

    raw = os.environ.get("WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_GRACE_S", "").strip()
    if raw:
        if raw == "0":
            return None
        parsed = _to_positive_int(raw)
        if parsed is None:
            log.info(
                "Invalid WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_GRACE_S="
                f"{raw!r}; using default command-progress grace."
            )
        else:
            return max(1, min(parsed, max(1, communicate_timeout_s - 1)))

    upper = max(1, communicate_timeout_s - 1)
    return max(1, min(_DEFAULT_NO_EDIT_COMMAND_GRACE_S, upper))


def _resolve_no_edit_command_progress_cap_seconds(
    communicate_timeout_s: Optional[int],
    no_edit_command_grace_s: Optional[int],
    recovery_attempt: int = 0,
    prompt: str = "",
) -> Optional[int]:
    if not communicate_timeout_s or no_edit_command_grace_s is None:
        return None

    raw = os.environ.get("WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_PROGRESS_CAP_S", "").strip()
    if raw:
        if raw == "0":
            return None
        parsed = _to_positive_int(raw)
        if parsed is None:
            log.info(
                "Invalid WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_PROGRESS_CAP_S="
                f"{raw!r}; using default command-progress cap."
            )
        else:
            return max(1, min(parsed, max(1, communicate_timeout_s - 1)))

    if recovery_attempt >= _MAX_NO_EDIT_RECOVERY_ATTEMPTS:
        default_s = _FINAL_NO_EDIT_RECOVERY_COMMAND_PROGRESS_CAP_S
    elif recovery_attempt > 0:
        default_s = _NO_EDIT_RECOVERY_COMMAND_PROGRESS_CAP_S
    elif _looks_like_validation_repair_prompt(prompt):
        default_s = _VALIDATION_REPAIR_COMMAND_PROGRESS_CAP_S
    elif _looks_like_background_autonomy_prompt(prompt):
        default_s = _BACKGROUND_NO_EDIT_COMMAND_PROGRESS_CAP_S
    else:
        default_s = _DEFAULT_NO_EDIT_COMMAND_PROGRESS_CAP_S
    upper = max(1, communicate_timeout_s - 1)
    return max(1, min(default_s, upper))


def _resolve_startup_stall_watchdog_seconds(
    communicate_timeout_s: Optional[int],
    recovery_attempt: int = 0,
) -> Optional[int]:
    if not communicate_timeout_s:
        return None

    raw = os.environ.get("WORKERPALS_OPENAI_CODEX_STARTUP_STALL_WATCHDOG_S", "").strip()
    if raw:
        if raw == "0":
            return None
        parsed = _to_positive_int(raw)
        if parsed is None:
            log.info(
                "Invalid WORKERPALS_OPENAI_CODEX_STARTUP_STALL_WATCHDOG_S="
                f"{raw!r}; using default startup-stall watchdog."
            )
        else:
            return max(1, min(parsed, max(1, communicate_timeout_s - 1)))

    default_s = (
        _RECOVERY_STARTUP_STALL_WATCHDOG_S
        if recovery_attempt > 0
        else _DEFAULT_STARTUP_STALL_WATCHDOG_S
    )
    floor_s = 60
    return max(floor_s, min(default_s, max(floor_s, communicate_timeout_s - 1)))


def _startup_stall_recovery_model(current_model: str) -> str:
    normalized = str(current_model or "").strip()
    if not normalized:
        return LEGACY_CODEX_MODEL_FALLBACK
    if normalized.lower() == LEGACY_CODEX_MODEL_FALLBACK.lower():
        return normalized
    return LEGACY_CODEX_MODEL_FALLBACK


def _looks_like_web_review_prompt(prompt: str) -> bool:
    text = str(prompt or "").lower()
    return "repo-native web review" in text or "web review path" in text


def _resolve_rollout_watchdog_seconds(
    prompt: str,
    communicate_timeout_s: Optional[int],
    no_edit_watchdog_s: Optional[int],
) -> Optional[int]:
    if not communicate_timeout_s or communicate_timeout_s < _MIN_AUTO_WATCHDOG_TIMEOUT_S:
        return None

    raw = os.environ.get("WORKERPALS_OPENAI_CODEX_ROLLOUT_WATCHDOG_S", "").strip()
    if raw:
        if raw == "0":
            return None
        parsed = _to_positive_int(raw)
        if parsed is None:
            log.info(
                f"Invalid WORKERPALS_OPENAI_CODEX_ROLLOUT_WATCHDOG_S={raw!r}; using default rollout watchdog."
            )
        else:
            return max(1, min(parsed, max(1, communicate_timeout_s - 1)))

    if _looks_like_validation_repair_prompt(prompt):
        default_s = _VALIDATION_REPAIR_ROLLOUT_WATCHDOG_S
    elif _looks_like_background_autonomy_prompt(prompt):
        default_s = _BACKGROUND_ROLLOUT_WATCHDOG_S
    elif _looks_like_narrow_test_task_prompt(prompt):
        default_s = _NARROW_TEST_TASK_ROLLOUT_WATCHDOG_S
    elif _looks_like_web_review_prompt(prompt):
        default_s = _WEB_REVIEW_ROLLOUT_WATCHDOG_S
    elif _looks_like_small_task_prompt(prompt):
        default_s = _SMALL_TASK_ROLLOUT_WATCHDOG_S
    else:
        default_s = _DEFAULT_ROLLOUT_WATCHDOG_S
    if no_edit_watchdog_s is not None:
        default_s = min(default_s, max(90, no_edit_watchdog_s - 60))
    return max(90, min(default_s, max(90, communicate_timeout_s - 60)))


def _baseline_snapshot_paths(baseline_snapshot: Any) -> List[str]:
    if isinstance(baseline_snapshot, dict):
        return [str(path) for path in baseline_snapshot.keys()]
    if isinstance(baseline_snapshot, list):
        return [str(path) for path in baseline_snapshot]
    return []


def _paths_changed_after_baseline(
    repo: str,
    changed_paths: List[str],
    baseline_snapshot: Any,
) -> List[str]:
    baseline_paths = set(_baseline_snapshot_paths(baseline_snapshot))
    delta: List[str] = []
    baseline_fingerprints = baseline_snapshot if isinstance(baseline_snapshot, dict) else {}
    tracked_content_deltas = _tracked_paths_git_content_deltas(repo, changed_paths)
    for path in changed_paths:
        tracked_content_delta = tracked_content_deltas.get(path)
        if tracked_content_delta is False:
            continue
        if not baseline_paths:
            delta.append(path)
            continue
        if path not in baseline_paths:
            delta.append(path)
            continue
        if baseline_fingerprints:
            current_fingerprint = _changed_path_fingerprint(repo, path)
            if current_fingerprint != str(baseline_fingerprints.get(path) or ""):
                delta.append(path)
    return delta


def _describe_non_publishable_paths(changed_paths: List[str], baseline_snapshot: Any) -> str:
    baseline_paths = set(_baseline_snapshot_paths(baseline_snapshot))
    inspected = [p for p in changed_paths if p not in baseline_paths] if baseline_paths else changed_paths
    non_publishable = [p for p in inspected if not _is_publishable_changed_path(p)]
    if not non_publishable:
        return ""
    listed = ", ".join(non_publishable[:8])
    if len(non_publishable) > 8:
        listed += ", ..."
    return listed


def _describe_publishable_paths(paths: List[str]) -> str:
    listed = ", ".join(paths[:8])
    if len(paths) > 8:
        listed = f"{listed}, ..."
    return listed


def _build_no_edit_recovery_guidance(
    trace_excerpt: str,
    artifact_only_paths: str = "",
    *,
    recovery_attempt: int = 1,
) -> str:
    final_attempt = recovery_attempt >= _MAX_NO_EDIT_RECOVERY_ATTEMPTS
    lines = [
        "No-edit watchdog recovery: the previous Codex attempt spent too much of the execution budget without producing publishable file changes.",
        "Do not repeat the same read/search sequence from the previous attempt. Re-reading the target without editing is a failed recovery.",
        "Runtime/dependency artifacts such as node_modules, outputs, .worktrees, .codex, dist, build, and coverage do not count as progress.",
        "Run at most one focused fast validation check before final diff review; let PushPals ValidationGate own long required/browser validation.",
    ]
    if final_attempt:
        lines[0] = (
            "Final no-edit recovery: two Codex attempts have spent too much execution budget "
            "without producing publishable file changes."
        )
        lines.insert(
            1,
            "Do not run more exploratory reads, symbol searches, repo topology scans, or validation before editing.",
        )
        lines.insert(
            2,
            "Use the already inspected context and immediately edit the smallest hinted or behavior-owning file. If uncertain, add the narrowest repo-native assertion or doc/test guard directly beside the existing pattern.",
        )
        lines.insert(
            3,
            "The first tool action in this final recovery must be a publishable file edit, not another read-only command.",
        )
    else:
        lines.insert(
            1,
            "This recovery attempt has a patch-first contract: make one publishable edit before any further broad discovery. If you need one narrow read of the hinted file to place the edit, do that once, then patch immediately.",
        )
        lines.insert(
            3,
            "Start from the already inspected context. Do not re-read broad repo topology, route wrappers, or missing test infrastructure unless that is the blocker.",
        )
        lines.insert(
            5,
            "Within the first response/action, edit the smallest behavior-owning file that satisfies the task. If the hinted file is a thin wrapper, patch the owner you already identified.",
        )
        lines.insert(
            6,
            "If a hinted test path is absent, do not invent PushPals/autonomy-specific files in the user repo. Add repo-native coverage beside existing tests, or make a tiny behavior/script patch with no new broad harness.",
        )
        lines.insert(
            7,
            "Use existing tests or a narrow helper/style assertion; do not create broad React Native mocks or a new full render harness for a compact shell/visual polish task.",
        )
    if artifact_only_paths:
        lines.append(f"Only non-publishable artifact paths changed so far: {artifact_only_paths}.")
    if trace_excerpt:
        lines.append("Previous Codex event trace excerpt:")
        lines.append(trace_excerpt)
    return "\n".join(lines)


def _build_startup_stall_recovery_guidance(trace_excerpt: str) -> str:
    lines = [
        "Codex startup-stall recovery: the previous Codex subprocess started but emitted no assistant, tool, or reasoning progress before the watchdog.",
        "Treat this as a fresh execution with a patch-first contract. After at most one narrow read of the hinted owner, make the smallest publishable edit.",
        "Do not spend this recovery attempt re-reading broad repository topology or validating before an edit exists.",
        "If the hinted path is absent, choose the nearest existing repo-native owner or test rather than creating unrelated scaffolding.",
    ]
    if trace_excerpt:
        lines.append("Previous Codex event trace excerpt:")
        lines.append(trace_excerpt)
    return "\n".join(lines)


def _trace_summaries_text(trace: Dict[str, Any]) -> str:
    summaries = trace.get("summaries")
    if not isinstance(summaries, list):
        return ""
    return "\n".join(str(item or "") for item in summaries[-80:]).lower()


def _codex_trace_has_work_progress(trace: Dict[str, Any]) -> bool:
    if to_int(trace.get("reasoning_events"), 0) > 0:
        return True

    event_counts = trace.get("event_type_counts")
    if isinstance(event_counts, dict):
        for key, value in event_counts.items():
            event_type = str(key or "").strip()
            if to_int(value, 0) > 0 and event_type not in _CODEX_STARTUP_ONLY_EVENT_TYPES:
                return True

    summaries = trace.get("summaries")
    if isinstance(summaries, list):
        for item in summaries:
            summary = str(item or "").strip()
            if not summary:
                continue
            event_type = summary.split("|", 1)[0].strip()
            if event_type not in _CODEX_STARTUP_ONLY_EVENT_TYPES:
                return True

    return False


def _codex_trace_is_startup_stall(trace: Dict[str, Any]) -> bool:
    if to_int(trace.get("total_tokens"), 0) > 0:
        return False
    return not _codex_trace_has_work_progress(trace)


def _task_explicitly_requests_mock_harness_repair(task_text: str) -> bool:
    text = str(task_text or "").lower()
    if not text:
        return False
    if "reactnativemock" in text or "tests/reactnativemock" in text:
        return True
    repair_markers = (
        "stabilize",
        "harden",
        "repair",
        "fix",
        "sync",
        "synchronize",
        "align",
        "resettable",
        "deterministic",
        "typings",
        "declarations",
    )
    mock_harness_markers = (
        "react native mock",
        "rn mock",
        "mock harness",
        "test harness",
        "shared mock",
        "__mocks__",
    )
    return any(marker in text for marker in mock_harness_markers) and any(
        marker in text for marker in repair_markers
    )


def _task_allows_repo_native_test_harness_reference(task_text: str) -> bool:
    text = str(task_text or "").lower()
    if not text:
        return False
    test_markers = (
        "test",
        "tests",
        "contract",
        "regression",
        "coverage",
        "assert",
        "guard",
    )
    owner_markers = (
        "app/_layout",
        "_layout.autonomy",
        "opportunity-graph.contract",
        "web shell",
        "shell review",
        "route-stack",
        "route stack",
        "route shell",
    )
    return any(marker in text for marker in test_markers) and any(
        marker in text for marker in owner_markers
    )


def _trace_mentions_existing_or_focused_harness_reference(text: str) -> bool:
    if not text:
        return False
    markers = (
        "existing react native mock",
        "existing nearby",
        "nearby layout test harness",
        "stable _layout test harness",
        "minimal module mock",
        "already gives us host elements",
        "already gets a react native mock",
        "getanimatedmock",
        "app/__tests__/_layout.autonomy.test",
        "opportunity-graph.contract",
        "narrow contract",
        "focused contract",
    )
    return any(marker in text for marker in markers)


def _detect_offtrack_rollout(
    trace: Dict[str, Any],
    artifact_only_paths: str = "",
    task_text: str = "",
) -> str:
    text = _trace_summaries_text(trace)
    if artifact_only_paths:
        return f"only non-publishable artifact paths changed: {artifact_only_paths}"
    if not text:
        return ""
    missing_or_absent_pattern = re.compile(
        r"(not present|not found|no existing|no .* directory|missing .* checkout|not listed in the checkout|checkout is much smaller|hinted .* absent)",
        re.I,
    )
    if missing_or_absent_pattern.search(text):
        return "the worker is spending time on missing hinted files or absent repo scaffolding"

    if re.search(r"(full[- ]?(surface|render)|full component render)", text, re.I):
        return "the worker is drifting into full render or full-surface harness work"

    task_allows_mock_harness = _task_explicitly_requests_mock_harness_repair(task_text)
    broad_mock_pattern = re.compile(r"(broad .*mock|shared mock|adding .*mock helper)", re.I)
    if not task_allows_mock_harness and broad_mock_pattern.search(text):
        return "the worker is drifting into broad test-harness or React Native mock repair"

    soft_harness_pattern = re.compile(r"(test harness repair|react native mock)", re.I)
    allows_existing_harness_reference = (
        _task_allows_repo_native_test_harness_reference(task_text)
        and _trace_mentions_existing_or_focused_harness_reference(text)
    )
    if (
        not task_allows_mock_harness
        and not allows_existing_harness_reference
        and soft_harness_pattern.search(text)
    ):
        return "the worker is drifting into broad test-harness or React Native mock repair"

    internal_leak_pattern = re.compile(
        r"(queue_health|workerpal|remotebuddy|reviewagent|pushpals-internal|no autonomy module)",
        re.I,
    )
    if internal_leak_pattern.search(text):
        return "the worker is about to add PushPals/autonomy internals to a user repo"
    return ""


def _build_rollout_recovery_guidance(
    reason: str,
    trace_excerpt: str,
    artifact_only_paths: str = "",
) -> str:
    lines = [
        "Rollout coach recovery: the previous Codex trajectory looked unlikely to produce a publishable, repo-native patch inside the budget.",
        f"Detected off-track signal: {reason or 'no publishable progress despite concerning trace signals'}.",
        "Do not continue the same exploration path. Start from the prior findings and make the smallest publishable edit first.",
        "If the requested or hinted file/path is absent, treat it as a stale hint: choose an existing repo-native owner or existing test nearby instead of creating PushPals/autonomy-specific scaffolding.",
        "For web review or shell-validation work, prefer an existing browser/e2e script, route shell, or navigation surface over generic autonomy infrastructure.",
        "Avoid broad React Native render harnesses and shared mock expansion unless the repo already has that stable infrastructure and the task explicitly asks for it.",
        "After the first patch, run one focused fast check or stop with a concise final update so ValidationGate can run the expensive suite.",
    ]
    if artifact_only_paths:
        lines.append(f"Only non-publishable artifact paths changed so far: {artifact_only_paths}.")
    if trace_excerpt:
        lines.append("Previous Codex event trace excerpt:")
        lines.append(trace_excerpt)
    return "\n".join(lines)


def _normalize_auth_mode(raw: str) -> str:
    lowered = (raw or "").strip().lower()
    aliases = {
        "apikey": "api_key",
        "api": "api_key",
        "api-key": "api_key",
        "chatgpt_login": "chatgpt",
        "chatgpt-pro": "chatgpt",
        "subscription": "chatgpt",
    }
    normalized = aliases.get(lowered, lowered)
    if normalized in _VALID_AUTH_MODES:
        return normalized
    if lowered:
        log.info(
            f"Invalid PUSHPALS_OPENAI_CODEX_AUTH_MODE={raw!r}; using default 'auto'. "
            f"Allowed: {', '.join(sorted(_VALID_AUTH_MODES))}."
        )
    return "auto"


def _run_codex_login_status(codex_cmd_prefix: List[str], repo: str, env: Dict[str, str]) -> Dict[str, Any]:
    try:
        proc = subprocess.run(
            [*codex_cmd_prefix, "login", "status"],
            cwd=repo,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=25,
            check=False,
        )
        return {
            "ok": proc.returncode == 0,
            "exitCode": int(proc.returncode),
            "stdout": proc.stdout or "",
            "stderr": proc.stderr or "",
        }
    except Exception as exc:
        return {
            "ok": False,
            "exitCode": 1,
            "stdout": "",
            "stderr": f"Failed to run `codex login status`: {exc}",
        }


def _terminate_active_child() -> None:
    global _ACTIVE_CHILD
    proc = _ACTIVE_CHILD
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
    except Exception:
        pass
    try:
        proc.wait(timeout=3)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _truncate_inline(text: str, max_chars: int = 180) -> str:
    value = " ".join(str(text or "").split())
    if len(value) <= max_chars:
        return value
    return value[: max(1, max_chars - 3)] + "..."


def _contains_reasoning_marker(value: str) -> bool:
    lowered = str(value or "").strip().lower()
    if not lowered:
        return False
    return "reasoning" in lowered or "thinking" in lowered


def _coerce_non_negative_int(value: Any) -> Optional[int]:
    try:
        parsed = int(value)
    except Exception:
        return None
    if parsed < 0:
        return None
    return parsed


def _normalize_usage_counts(
    prompt_tokens: Optional[int],
    completion_tokens: Optional[int],
    total_tokens: Optional[int],
) -> Optional[Dict[str, int]]:
    if prompt_tokens is None and completion_tokens is None and total_tokens is None:
        return None
    prompt = prompt_tokens if prompt_tokens is not None else 0
    completion = completion_tokens if completion_tokens is not None else 0
    total = total_tokens if total_tokens is not None else prompt + completion
    if prompt_tokens is None and total_tokens is not None and completion_tokens is not None:
        prompt = max(0, total - completion)
    if completion_tokens is None and total_tokens is not None and prompt_tokens is not None:
        completion = max(0, total - prompt)
    total = max(total, prompt + completion)
    if total <= 0:
        return None
    return {
        "prompt_tokens": int(prompt),
        "completion_tokens": int(completion),
        "total_tokens": int(total),
    }


def _extract_usage_counts(value: Any) -> Optional[Dict[str, int]]:
    best: Optional[Dict[str, int]] = None
    stack: List[Any] = [value]
    visited = 0
    max_nodes = 256

    while stack and visited < max_nodes:
        current = stack.pop()
        visited += 1
        if isinstance(current, list):
            for item in reversed(current[:80]):
                if isinstance(item, (dict, list)):
                    stack.append(item)
            continue
        if not isinstance(current, dict):
            continue

        prompt_tokens = _coerce_non_negative_int(
            current.get("prompt_tokens")
            or current.get("promptTokens")
            or current.get("input_tokens")
            or current.get("inputTokens")
        )
        completion_tokens = _coerce_non_negative_int(
            current.get("completion_tokens")
            or current.get("completionTokens")
            or current.get("output_tokens")
            or current.get("outputTokens")
        )
        total_tokens = _coerce_non_negative_int(
            current.get("total_tokens") or current.get("totalTokens")
        )
        normalized = _normalize_usage_counts(prompt_tokens, completion_tokens, total_tokens)
        if normalized is not None:
            if best is None or normalized["total_tokens"] > best["total_tokens"]:
                best = normalized

        usage_node = current.get("usage")
        if isinstance(usage_node, (dict, list)):
            stack.append(usage_node)

        for nested in current.values():
            if isinstance(nested, (dict, list)):
                stack.append(nested)

    return best


def _event_contains_reasoning(value: Any) -> bool:
    max_nodes = 256
    visited = 0
    stack: List[Any] = [value]
    while stack and visited < max_nodes:
        current = stack.pop()
        visited += 1
        if isinstance(current, str):
            if _contains_reasoning_marker(current):
                return True
            continue
        if isinstance(current, list):
            for item in reversed(current[:80]):
                if isinstance(item, (dict, list, str)):
                    stack.append(item)
            continue
        if not isinstance(current, dict):
            continue

        for raw_key, nested in current.items():
            key = str(raw_key or "")
            key_lower = key.lower()
            if _contains_reasoning_marker(key_lower):
                return True
            if key_lower in ("type", "kind", "event", "item_type", "role", "channel"):
                if isinstance(nested, str) and _contains_reasoning_marker(nested):
                    return True
            if isinstance(nested, (dict, list, str)):
                stack.append(nested)

    return False


def _collect_text_fragments(value: Any, out: List[str]) -> None:
    if isinstance(value, str):
        text = _truncate_inline(value, 220)
        if text:
            out.append(text)
        return
    if isinstance(value, list):
        for item in value:
            _collect_text_fragments(item, out)
        return
    if isinstance(value, dict):
        matched_key = False
        for raw_key, nested in value.items():
            key = str(raw_key or "").lower()
            if key.endswith("_text") or key.endswith("_message"):
                matched_key = True
                _collect_text_fragments(nested, out)
                continue
            if (
                key in ("text", "content", "summary", "message", "error", "reason", "delta", "output", "item")
                or _contains_reasoning_marker(key)
            ):
                matched_key = True
                _collect_text_fragments(nested, out)
        if not matched_key:
            # Fallback: recurse into nested containers so unknown payload shapes still surface text.
            for nested in value.values():
                if isinstance(nested, (dict, list)):
                    _collect_text_fragments(nested, out)
        return


def _summarize_json_event(obj: Dict[str, Any]) -> str:
    event_type = str(obj.get("type") or obj.get("event") or obj.get("kind") or "event").strip()
    if not event_type:
        event_type = "event"
    # Skip noisy streaming deltas unless they contain meaningful text fragments.
    delta_like = event_type.endswith(".delta") or event_type.endswith("_delta")
    # Reasoning/thinking events are always surfaced because they show the model's reasoning process.
    reasoning_like = _contains_reasoning_marker(event_type) or _event_contains_reasoning(obj)

    tool_name = ""
    for key in ("tool_name", "tool", "name"):
        raw = obj.get(key)
        if isinstance(raw, str) and raw.strip():
            tool_name = raw.strip()
            break
        if isinstance(raw, dict):
            nested = raw.get("name")
            if isinstance(nested, str) and nested.strip():
                tool_name = nested.strip()
                break
    # For Codex CLI item.* events, the tool/function name is nested under obj["item"]["name"].
    if not tool_name and isinstance(obj.get("item"), dict):
        nested = obj["item"].get("name")
        if isinstance(nested, str) and nested.strip():
            tool_name = nested.strip()

    fragments: List[str] = []
    # "item" covers Codex CLI's item.started/updated/completed events where reasoning and
    # tool call content is nested under the item object.
    # "output" covers turn.completed and similar events that carry output arrays.
    # "delta" covers reasoning delta events (response.reasoning_summary_text.delta).
    extract_keys = ["message", "text", "summary", "content", "output_text", "error", "item", "output", "delta"]
    for key in extract_keys:
        if key in obj:
            _collect_text_fragments(obj.get(key), fragments)
    deduped: List[str] = []
    seen: set[str] = set()
    for frag in fragments:
        if frag in seen:
            continue
        seen.add(frag)
        deduped.append(frag)
    text_part = deduped[0] if deduped else ""

    # Suppress noisy deltas, but always surface reasoning events even if text is empty.
    if delta_like and not text_part and not reasoning_like:
        return ""

    parts = [event_type]
    if tool_name:
        parts.append(f"tool={tool_name}")
    if text_part:
        parts.append(text_part)
    elif reasoning_like:
        parts.append("reasoning update")
    return " | ".join(parts)


def _format_codex_trace_excerpt(trace: Dict[str, Any], max_items: int = 20) -> str:
    summaries = trace.get("summaries")
    if isinstance(summaries, list):
        items = [str(item).strip() for item in summaries if str(item).strip()]
        if items:
            shown = items[:max_items]
            lines = [f"- {item}" for item in shown]
            omitted = len(items) - len(shown)
            if omitted > 0:
                lines.append(f"- ... ({omitted} more event(s) omitted)")
            return "Codex event trace:\n" + "\n".join(lines)

    event_counts = trace.get("event_type_counts")
    if isinstance(event_counts, dict):
        pairs = [
            (str(key).strip() or "event", to_int(value, 0))
            for key, value in event_counts.items()
            if to_int(value, 0) > 0
        ]
        if pairs:
            pairs.sort(key=lambda item: item[1], reverse=True)
            listed = ", ".join(f"{name}={count}" for name, count in pairs[:8])
            return f"Codex event types: {listed}"

    return ""


def _empty_codex_trace() -> Dict[str, Any]:
    return {
        "line_count": 0,
        "valid_json": 0,
        "invalid_json": 0,
        "summaries": [],
        "event_type_counts": {},
        "live_logged": 0,
        "live_omitted": 0,
        "raw_logged": 0,
        "raw_omitted": 0,
        "reasoning_events": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "active_command_ids": [],
        "command_event_count": 0,
        "last_command_activity_at": None,
        "last_command_summary": "",
        "thread_id": "",
    }


def _looks_like_codex_command_item(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    type_text = " ".join(
        str(value.get(key) or "")
        for key in ("type", "item_type", "kind", "name", "tool_name")
    ).lower()
    if any(marker in type_text for marker in ("command_execution", "exec_command", "shell_command")):
        return True
    return any(key in value for key in ("command", "cmd", "exit_code", "aggregated_output"))


def _record_codex_command_activity(
    parsed: Dict[str, Any],
    event_type: str,
    trace: Dict[str, Any],
    now: float,
) -> None:
    item = parsed.get("item")
    command_source: Any = item if _looks_like_codex_command_item(item) else parsed
    if not _looks_like_codex_command_item(command_source):
        return

    command_text = ""
    if isinstance(command_source, dict):
        for key in ("command", "cmd", "name"):
            raw = command_source.get(key)
            if isinstance(raw, str) and raw.strip():
                command_text = _truncate_inline(raw.strip(), 160)
                break
    command_id = ""
    if isinstance(command_source, dict):
        command_id = str(
            command_source.get("id")
            or command_source.get("call_id")
            or command_source.get("item_id")
            or command_text
            or "command"
        ).strip()
    command_id = command_id or "command"

    active = trace.setdefault("active_command_ids", [])
    if not isinstance(active, list):
        active = []
        trace["active_command_ids"] = active

    status_text = ""
    if isinstance(command_source, dict):
        status_text = " ".join(
            str(command_source.get(key) or "")
            for key in ("status", "state", "outcome")
        ).lower()
    event_lower = event_type.lower()
    completed = (
        "completed" in event_lower
        or "failed" in event_lower
        or "error" in event_lower
        or any(marker in status_text for marker in ("completed", "failed", "cancelled", "canceled", "exited"))
    )
    started = (
        "started" in event_lower
        or "updated" in event_lower
        or any(marker in status_text for marker in ("running", "in_progress", "started"))
    )

    if completed:
        trace["active_command_ids"] = [item for item in active if str(item) != command_id]
    elif started and command_id not in active:
        active.append(command_id)

    trace["command_event_count"] = to_int(trace.get("command_event_count"), 0) + 1
    trace["last_command_activity_at"] = float(now)
    trace["last_command_summary"] = command_text or event_type


def _record_live_codex_stdout_line(
    line: str,
    use_json: bool,
    trace: Dict[str, Any],
    now: Optional[float] = None,
) -> None:
    stripped = line.strip()
    if not stripped:
        return

    trace["line_count"] = to_int(trace.get("line_count"), 0) + 1
    summaries = trace.setdefault("summaries", [])
    event_type_counts = trace.setdefault("event_type_counts", {})
    max_recorded_summaries = 500
    max_live_logged = 300
    max_raw_logged = 5

    if use_json:
        try:
            parsed = json.loads(stripped)
            trace["valid_json"] = to_int(trace.get("valid_json"), 0) + 1
        except Exception:
            trace["invalid_json"] = to_int(trace.get("invalid_json"), 0) + 1
            raw_logged = to_int(trace.get("raw_logged"), 0)
            if raw_logged < max_raw_logged:
                log.info(f"[codex/raw] {_truncate_inline(stripped, 220)}")
                trace["raw_logged"] = raw_logged + 1
            else:
                trace["raw_omitted"] = to_int(trace.get("raw_omitted"), 0) + 1
            return

        if isinstance(parsed, dict):
            observed_at = float(now if now is not None else time.monotonic())
            usage = _extract_usage_counts(parsed)
            if usage is not None:
                trace["prompt_tokens"] = max(
                    to_int(trace.get("prompt_tokens"), 0), usage["prompt_tokens"]
                )
                trace["completion_tokens"] = max(
                    to_int(trace.get("completion_tokens"), 0), usage["completion_tokens"]
                )
                trace["total_tokens"] = max(
                    to_int(trace.get("total_tokens"), 0), usage["total_tokens"]
                )
            event_type = (
                str(parsed.get("type") or parsed.get("event") or parsed.get("kind") or "event")
                .strip()
                or "event"
            )
            if event_type == "thread.started":
                thread_id = str(
                    parsed.get("thread_id")
                    or parsed.get("threadId")
                    or parsed.get("id")
                    or ""
                ).strip()
                if thread_id:
                    trace["thread_id"] = thread_id
            _record_codex_command_activity(parsed, event_type, trace, observed_at)
            event_type_counts[event_type] = to_int(event_type_counts.get(event_type), 0) + 1
            summary = _summarize_json_event(parsed)
            # Reasoning can arrive under generic event types (for example item.updated).
            priority = _event_contains_reasoning(parsed)
            if priority:
                trace["reasoning_events"] = to_int(trace.get("reasoning_events"), 0) + 1
            if summary:
                if len(summaries) < max_recorded_summaries:
                    summaries.append(summary)
                live_logged = to_int(trace.get("live_logged"), 0)
                if live_logged < max_live_logged or priority:
                    log.info(f"[codex] {summary}")
                    trace["live_logged"] = live_logged + 1
                else:
                    trace["live_omitted"] = to_int(trace.get("live_omitted"), 0) + 1
        return

    summary = _truncate_inline(stripped, 220)
    if summary:
        if len(summaries) < max_recorded_summaries:
            summaries.append(summary)
        live_logged = to_int(trace.get("live_logged"), 0)
        if live_logged < max_live_logged:
            log.info(f"[codex] {summary}")
            trace["live_logged"] = live_logged + 1
        else:
            trace["live_omitted"] = to_int(trace.get("live_omitted"), 0) + 1


def _finalize_codex_stdout_trace(trace: Dict[str, Any], use_json: bool) -> Dict[str, Any]:
    line_count = to_int(trace.get("line_count"), 0)
    valid_json = to_int(trace.get("valid_json"), 0)
    invalid_json = to_int(trace.get("invalid_json"), 0)
    summaries = trace.get("summaries")
    if not isinstance(summaries, list):
        summaries = []
    else:
        summaries = [str(item).strip() for item in summaries if str(item).strip()]
    event_type_counts_raw = trace.get("event_type_counts")
    event_type_counts: Dict[str, int] = {}
    if isinstance(event_type_counts_raw, dict):
        for key, value in event_type_counts_raw.items():
            name = str(key).strip() or "event"
            count = to_int(value, 0)
            if count > 0:
                event_type_counts[name] = count

    if use_json:
        log.info(
            f"Codex JSON stream captured ({line_count} line(s), valid_json={valid_json}, invalid={invalid_json})."
        )
    else:
        log.info(f"Codex stdout captured ({line_count} non-empty line(s)).")

    live_omitted = to_int(trace.get("live_omitted"), 0)
    if live_omitted > 0:
        log.info(f"[codex] ... {live_omitted} additional event(s) omitted.")
    raw_omitted = to_int(trace.get("raw_omitted"), 0)
    if raw_omitted > 0:
        log.info(f"[codex/raw] ... {raw_omitted} additional line(s) omitted.")
    reasoning_events = to_int(trace.get("reasoning_events"), 0)
    prompt_tokens = to_int(trace.get("prompt_tokens"), 0)
    completion_tokens = to_int(trace.get("completion_tokens"), 0)
    total_tokens = to_int(trace.get("total_tokens"), 0)
    command_event_count = to_int(trace.get("command_event_count"), 0)
    thread_id = str(trace.get("thread_id") or "").strip()
    if reasoning_events > 0:
        log.info(f"[codex] Reasoning-like event(s): {reasoning_events}")
    elif use_json and valid_json > 0:
        log.info("[codex] No reasoning-like events observed in this run.")
    if command_event_count > 0:
        log.info(f"[codex] Command execution event(s): {command_event_count}")
    if total_tokens > 0:
        log.info(
            f"[codex] Usage observed: prompt={prompt_tokens} completion={completion_tokens} total={total_tokens}"
        )

    if not summaries and event_type_counts:
        ranked = sorted(event_type_counts.items(), key=lambda item: item[1], reverse=True)
        top = ", ".join(f"{name}={count}" for name, count in ranked[:8])
        log.info(f"[codex] Event types: {top}")

    return {
        "line_count": line_count,
        "valid_json": valid_json,
        "invalid_json": invalid_json,
        "summaries": summaries,
        "event_type_counts": event_type_counts,
        "reasoning_events": reasoning_events,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "command_event_count": command_event_count,
        "thread_id": thread_id,
    }


def _estimated_usage(prompt: str, output_text: str, *, model: str) -> Dict[str, Any]:
    prompt_tokens = max(0, int(len(str(prompt or "")) / 3 + 0.999999))
    completion_tokens = max(0, int(len(str(output_text or "")) / 3 + 0.999999))
    return {
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "totalTokens": prompt_tokens + completion_tokens,
        "estimated": True,
        "backend": "openai_codex",
        "modelId": model,
    }


def _usage_from_trace_or_estimate(trace: Dict[str, Any], prompt: str, output_text: str, *, model: str) -> Dict[str, Any]:
    total_tokens = to_int(trace.get("total_tokens"), 0)
    if total_tokens > 0:
        prompt_tokens = to_int(trace.get("prompt_tokens"), 0)
        completion_tokens = to_int(trace.get("completion_tokens"), 0)
        return {
            "promptTokens": prompt_tokens,
            "completionTokens": completion_tokens,
            "totalTokens": max(total_tokens, prompt_tokens + completion_tokens),
            "estimated": False,
            "backend": "openai_codex",
            "modelId": model,
        }
    return _estimated_usage(prompt, output_text, model=model)


def _log_stderr(stderr: str) -> None:
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    if not lines:
        return
    max_lines = 20
    for line in lines[:max_lines]:
        log.info(f"[stderr] {line}")
    if len(lines) > max_lines:
        log.info(f"[stderr] ... {len(lines) - max_lines} additional line(s) omitted.")


def _safe_model_for_codex(raw_model: str, base_url: str) -> str:
    model = str(raw_model or "").strip()
    if not model:
        return DEFAULT_CODEX_MODEL
    if "/" not in model:
        return model
    provider, bare = model.split("/", 1)
    provider = provider.strip().lower()
    bare = bare.strip()
    if provider == "openai" and bare:
        return bare
    if looks_local_base_url(base_url) and bare:
        return bare
    return DEFAULT_CODEX_MODEL


def _requires_newer_codex_for_model(*texts: str) -> bool:
    return any(_MODEL_REQUIRES_NEWER_CODEX_PATTERN.search(str(text or "")) for text in texts)


def _build_instruction(instruction: str, supplemental_guidance: List[str]) -> str:
    system_prompt = (_load_prompt_template(_TASK_SYSTEM_PROMPT_PATH) or "").strip()
    if not system_prompt:
        system_prompt = (_load_prompt_template(_DEFAULT_TASK_SYSTEM_PROMPT_PATH) or "").strip()
    if not system_prompt:
        raise RuntimeError(
            "Missing required OpenAI Codex system prompt template. "
            f"Expected one of: {_TASK_SYSTEM_PROMPT_PATH}, {_DEFAULT_TASK_SYSTEM_PROMPT_PATH}"
        )

    runtime_policy_appendix = (
        _load_prompt_template(_MANDATORY_RUNTIME_POLICY_APPENDIX_PATH) or ""
    ).strip()
    if not runtime_policy_appendix:
        raise RuntimeError(
            "Missing required OpenAI Codex runtime policy appendix template. "
            f"Expected: {_MANDATORY_RUNTIME_POLICY_APPENDIX_PATH}"
        )
    if runtime_policy_appendix.lower() not in system_prompt.lower():
        system_prompt = f"{system_prompt}\n\n{runtime_policy_appendix}".strip()

    supplemental_section = ""
    filtered_guidance = [str(item).strip() for item in supplemental_guidance if str(item).strip()]
    if filtered_guidance:
        supplemental_section_template = _load_prompt_template(_SUPPLEMENTAL_GUIDANCE_SECTION_PATH)
        if not supplemental_section_template.strip():
            raise RuntimeError(
                "Missing required OpenAI Codex supplemental guidance section template. "
                f"Expected: {_SUPPLEMENTAL_GUIDANCE_SECTION_PATH}"
            )
        supplemental_section = "\n\n" + _load_prompt_template(
            _SUPPLEMENTAL_GUIDANCE_SECTION_PATH,
            {"guidance_lines": "\n".join(filtered_guidance)},
        ).strip()

    wrapped = _load_prompt_template(
        _INSTRUCTION_WRAPPER_PROMPT_PATH,
        {
            "system_prompt": system_prompt,
            "instruction": instruction,
            "supplemental_section": supplemental_section,
        },
    )
    if not wrapped.strip():
        raise RuntimeError(
            "Missing required OpenAI Codex instruction wrapper template. "
            f"Expected: {_INSTRUCTION_WRAPPER_PROMPT_PATH}"
        )
    return wrapped.strip()


def _detect_codex_workaround_signal(*texts: str) -> Optional[str]:
    for text in texts:
        source = str(text or "")
        if not source:
            continue
        for pattern in _CODEX_WORKAROUND_PATTERNS:
            for match in pattern.finditer(source):
                snippet = match.group(0).strip()
                if not snippet:
                    continue
                lowered = snippet.lower()
                if any(hint in lowered for hint in _CODEX_WORKAROUND_NEGATION_HINTS):
                    continue
                return snippet
    return None


def _normalize_command_text(command: str) -> str:
    return re.sub(r"\s+", " ", str(command or "")).strip()


def _is_disallowed_shell_wrapper_command(command: str) -> bool:
    normalized = _normalize_command_text(command).lower()
    return any(normalized.startswith(prefix) for prefix in _DISALLOWED_SHELL_WRAPPER_PREFIXES)


def _extract_rejected_exec_command(text: str) -> str:
    match = _REJECTED_EXEC_COMMAND_PATTERN.search(str(text or ""))
    if not match:
        return ""
    return _normalize_command_text(match.group(1))


def _collect_disallowed_shell_wrapper_rejections(*texts: str) -> List[str]:
    rejected: List[str] = []
    seen: set[str] = set()
    for text in texts:
        command = _extract_rejected_exec_command(str(text or ""))
        if not command or not _is_disallowed_shell_wrapper_command(command):
            continue
        lowered = command.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        rejected.append(command)
    return rejected


def _unwrap_shell_wrapper_command(command: str) -> str:
    normalized = _normalize_command_text(command)
    if not normalized:
        return ""
    try:
        parts = shlex.split(normalized, posix=True)
    except ValueError:
        return ""
    if len(parts) < 3:
        return ""
    executable = str(parts[0] or "").strip().lower()
    flag = str(parts[1] or "").strip().lower()
    if executable in {"/bin/bash", "bash", "sh"} and flag in {"-lc", "-c"}:
        return _normalize_command_text(" ".join(parts[2:]))
    if executable == "cmd" and flag == "/c":
        return _normalize_command_text(" ".join(parts[2:]))
    if executable in {"powershell", "powershell.exe", "pwsh", "pwsh.exe"} and flag == "-command":
        return _normalize_command_text(" ".join(parts[2:]))
    return ""


def _build_wrapper_direct_replacements(rejected_commands: List[str]) -> List[str]:
    direct_equivalents: List[str] = []
    seen: set[str] = set()
    for command in rejected_commands:
        direct = _unwrap_shell_wrapper_command(command)
        lowered = direct.lower()
        if not direct or lowered in seen:
            continue
        seen.add(lowered)
        direct_equivalents.append(f"- `{command}` -> `{direct}`")
    return direct_equivalents


def _build_wrapper_recovery_guidance(rejected_commands: List[str], *, hard: bool = False) -> str:
    guidance_lines = [
        _command_router_hard_recovery_guidance()
        if hard
        else _command_router_recovery_guidance()
    ]
    direct_equivalents = _build_wrapper_direct_replacements(rejected_commands)
    if direct_equivalents:
        guidance_lines.append("Use these direct replacements for the rejected commands:")
        guidance_lines.extend(direct_equivalents[:6])
    return "\n".join(guidance_lines)


def _truncate_wrapper_bootstrap_output(text: str) -> str:
    value = str(text or "").replace("\r\n", "\n").strip()
    if len(value) <= _MAX_WRAPPER_BOOTSTRAP_OUTPUT_CHARS:
        return value
    return f"{value[:_MAX_WRAPPER_BOOTSTRAP_OUTPUT_CHARS].rstrip()}\n...(truncated)"


def _resolve_repo_scoped_path(repo: str, raw_path: str) -> Optional[Path]:
    candidate = str(raw_path or "").strip()
    if not candidate:
        return None
    repo_root = Path(repo).resolve()
    resolved = (repo_root / candidate).resolve()
    try:
        common = os.path.commonpath([str(repo_root), str(resolved)])
    except ValueError:
        return None
    if common != str(repo_root):
        return None
    return resolved


def _run_wrapper_bootstrap_command(repo: str, command: str) -> str:
    normalized = _normalize_command_text(command)
    if not normalized:
        return ""
    try:
        args = shlex.split(normalized, posix=True)
    except ValueError:
        return ""
    if not args:
        return ""
    program = str(args[0] or "").strip().lower()
    if program == "pwd" and len(args) == 1:
        return repo
    if program == "ls":
        target = Path(repo).resolve()
        if len(args) == 2 and not str(args[1]).startswith("-"):
            resolved = _resolve_repo_scoped_path(repo, str(args[1]))
            if not resolved:
                return ""
            target = resolved
        elif len(args) > 1:
            return ""
        if not target.exists():
            return f"{target.name or str(target)} (missing)"
        if target.is_file():
            return target.name
        entries = sorted(child.name for child in target.iterdir())
        return "\n".join(entries[:120])
    if program == "git" and len(args) >= 2:
        safe_git_args: Optional[List[str]] = None
        if args[1:] == ["branch", "--show-current"]:
            safe_git_args = ["git", "--no-pager", "branch", "--show-current"]
        elif args[1:] == ["status", "--porcelain"]:
            safe_git_args = ["git", "--no-pager", "status", "--porcelain"]
        elif len(args) >= 3 and args[1] == "diff":
            diff_args = list(args[2:])
            sanitized_paths: List[str] = []
            if diff_args == ["--name-only"]:
                safe_git_args = [
                    "git",
                    "--no-pager",
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--name-only",
                ]
            elif len(diff_args) >= 2 and diff_args[0] == "--name-only" and diff_args[1] == "--":
                for raw_path in diff_args[2:]:
                    resolved = _resolve_repo_scoped_path(repo, str(raw_path))
                    if not resolved:
                        return ""
                    sanitized_paths.append(os.path.relpath(str(resolved), repo))
                safe_git_args = [
                    "git",
                    "--no-pager",
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--name-only",
                    "--",
                    *sanitized_paths,
                ]
            elif diff_args and diff_args[0] == "--":
                for raw_path in diff_args[1:]:
                    resolved = _resolve_repo_scoped_path(repo, str(raw_path))
                    if not resolved:
                        return ""
                    sanitized_paths.append(os.path.relpath(str(resolved), repo))
                safe_git_args = [
                    "git",
                    "--no-pager",
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--",
                    *sanitized_paths,
                ]
        if not safe_git_args:
            return ""
        proc = subprocess.run(
            safe_git_args,
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        output = proc.stdout.strip()
        if proc.returncode != 0:
            detail = proc.stderr.strip() or output
            return f"(command failed: {detail})" if detail else "(command failed)"
        return output
    if program == "cat" and len(args) == 2:
        resolved = _resolve_repo_scoped_path(repo, str(args[1]))
        if not resolved or not resolved.is_file():
            return ""
        return resolved.read_text(encoding="utf-8", errors="replace")
    if program == "sed" and len(args) == 4 and args[1] == "-n":
        match = re.fullmatch(r"(\d+),(\d+)p", str(args[2] or "").strip())
        if not match:
            return ""
        start = max(1, int(match.group(1)))
        end = max(start, int(match.group(2)))
        resolved = _resolve_repo_scoped_path(repo, str(args[3]))
        if not resolved or not resolved.is_file():
            return ""
        lines = resolved.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(lines[start - 1 : end])
    return ""


def _build_wrapper_bootstrap_context(repo: str, rejected_commands: List[str]) -> str:
    blocks: List[str] = []
    total_chars = 0
    seen: set[str] = set()
    for rejected in rejected_commands:
        direct = _unwrap_shell_wrapper_command(rejected)
        key = direct.lower()
        if not direct or key in seen:
            continue
        seen.add(key)
        output = _run_wrapper_bootstrap_command(repo, direct)
        if not output:
            continue
        truncated = _truncate_wrapper_bootstrap_output(output)
        block = (
            f"- Direct command: `{direct}`\n"
            f"  Rejected wrapper: `{rejected}`\n"
            "  Output:\n"
            "  ```text\n"
            f"{truncated}\n"
            "  ```"
        )
        if total_chars + len(block) > _MAX_WRAPPER_BOOTSTRAP_TOTAL_CHARS and blocks:
            break
        blocks.append(block)
        total_chars += len(block)
    if not blocks:
        return ""
    return "\n".join(
        [
            "Direct command context bootstrap:",
            "The backend already ran safe read-only direct replacements for some rejected wrapper commands.",
            "Use these outputs as current repo context and do not rerun the wrapped variants.",
            *blocks[:6],
        ]
    )


def _merge_usage_records(first: Any, second: Any) -> Dict[str, Any]:
    first_record = first if isinstance(first, dict) else {}
    second_record = second if isinstance(second, dict) else {}
    if not first_record:
        return dict(second_record)
    if not second_record:
        return dict(first_record)
    prompt_tokens = to_int(first_record.get("promptTokens"), 0) + to_int(
        second_record.get("promptTokens"), 0
    )
    completion_tokens = to_int(first_record.get("completionTokens"), 0) + to_int(
        second_record.get("completionTokens"), 0
    )
    merged = dict(second_record)
    merged["promptTokens"] = prompt_tokens
    merged["completionTokens"] = completion_tokens
    merged["totalTokens"] = prompt_tokens + completion_tokens
    merged["estimated"] = bool(first_record.get("estimated")) or bool(second_record.get("estimated"))
    if not merged.get("backend"):
        merged["backend"] = first_record.get("backend")
    if not merged.get("modelId"):
        merged["modelId"] = first_record.get("modelId")
    return merged


def _is_known_runtime_artifact_path(path: str) -> bool:
    normalized = str(path or "").replace("\\", "/").strip().strip("/").lower()
    return bool(
        re.search(
            r"^microsoft/windows/powershell/(moduleanalysiscache|psreadline(/|$))",
            normalized,
        )
    )


def _is_publishable_changed_path(path: str) -> bool:
    normalized = str(path or "").replace("\\", "/").strip().strip("/").lower()
    if _is_known_runtime_artifact_path(normalized):
        return False
    return not re.search(r"(^|/)(outputs|node_modules|\.worktrees|\.codex|dist|build|coverage)(/|$)", normalized)


def _expand_known_artifact_directory_paths(repo: str, paths: List[str]) -> List[str]:
    expanded: List[str] = []
    seen: set[str] = set()
    repo_root = Path(repo).resolve()

    def add(path: str) -> None:
        normalized = str(path or "").replace("\\", "/").strip()
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        expanded.append(normalized)

    for raw_path in paths:
        normalized = str(raw_path or "").replace("\\", "/").strip().strip("/")
        if normalized.lower() != "microsoft":
            add(str(raw_path or ""))
            continue

        power_shell_root = repo_root / "Microsoft" / "Windows" / "PowerShell"
        known_artifacts: List[Path] = []
        module_cache = power_shell_root / "ModuleAnalysisCache"
        if module_cache.exists():
            known_artifacts.append(module_cache)
        psreadline_root = power_shell_root / "PSReadLine"
        if psreadline_root.exists():
            try:
                known_artifacts.extend(path for path in psreadline_root.rglob("*") if path.is_file())
            except Exception:
                pass
        if not known_artifacts:
            add(str(raw_path or ""))
            continue
        for artifact in sorted(known_artifacts):
            try:
                add(artifact.relative_to(repo_root).as_posix())
            except Exception:
                add(str(raw_path or ""))

    return expanded


def _filesystem_fingerprint(repo: str, raw_path: str) -> str:
    root = Path(repo)
    target = (root / raw_path).resolve()
    try:
        root_resolved = root.resolve()
        common = os.path.commonpath([str(root_resolved), str(target)])
        if common != str(root_resolved):
            return "outside-repo"
    except Exception:
        return "unresolved"
    digest = hashlib.sha256()
    if not target.exists():
        return "missing"
    if target.is_file():
        digest.update(b"file\0")
        try:
            digest.update(str(target.stat().st_size).encode("utf-8"))
            with target.open("rb") as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
        except Exception as exc:
            digest.update(f"read-error:{type(exc).__name__}:{exc}".encode("utf-8", errors="replace"))
        return digest.hexdigest()
    if target.is_dir():
        digest.update(b"dir\0")
        files_seen = 0
        try:
            for dirpath, dirnames, filenames in os.walk(target):
                dirnames.sort()
                filenames.sort()
                for filename in filenames:
                    if files_seen >= 128:
                        digest.update(b"\0truncated")
                        return digest.hexdigest()
                    child = Path(dirpath) / filename
                    try:
                        rel = child.relative_to(root_resolved).as_posix()
                    except Exception:
                        rel = child.name
                    digest.update(rel.encode("utf-8", errors="replace"))
                    digest.update(b"\0")
                    digest.update(str(child.stat().st_size).encode("utf-8"))
                    digest.update(b"\0")
                    try:
                        with child.open("rb") as handle:
                            digest.update(handle.read(64 * 1024))
                    except Exception as exc:
                        digest.update(f"read-error:{type(exc).__name__}:{exc}".encode("utf-8", errors="replace"))
                    files_seen += 1
        except Exception as exc:
            digest.update(f"walk-error:{type(exc).__name__}:{exc}".encode("utf-8", errors="replace"))
        return digest.hexdigest()
    return "special"


def _changed_path_fingerprint(repo: str, path: str) -> str:
    normalized = str(path or "").strip()
    if not normalized:
        return ""
    digest = hashlib.sha256()
    digest.update(normalized.replace("\\", "/").encode("utf-8", errors="replace"))
    digest.update(b"\0fs\0")
    digest.update(_filesystem_fingerprint(repo, normalized).encode("utf-8", errors="replace"))
    return digest.hexdigest()


def _publishable_progress_fingerprint(repo: str, paths: List[str]) -> str:
    digest = hashlib.sha256()
    for path in sorted({str(path or "").replace("\\", "/").strip() for path in paths}):
        if not path:
            continue
        digest.update(path.encode("utf-8", errors="replace"))
        digest.update(b"\0")
        digest.update(_changed_path_fingerprint(repo, path).encode("ascii", errors="replace"))
        digest.update(b"\0")
    return digest.hexdigest()


def _capture_git_change_snapshot(repo: str) -> Dict[str, str]:
    return {
        path: _changed_path_fingerprint(repo, path)
        for path in _expand_known_artifact_directory_paths(repo, summarize_git_changes(repo))
    }


def _normalize_baseline_snapshot(repo: str, baseline_changes: Any) -> Dict[str, str]:
    if isinstance(baseline_changes, dict):
        return {
            str(path): str(fingerprint)
            for path, fingerprint in baseline_changes.items()
            if str(path or "").strip()
        }
    if isinstance(baseline_changes, list):
        return {
            str(path): _changed_path_fingerprint(repo, str(path))
            for path in baseline_changes
            if str(path or "").strip()
        }
    return _capture_git_change_snapshot(repo)


def _codex_changed_paths(
    repo: str,
    baseline_snapshot: Any,
    *,
    clean_known_runtime_artifacts: bool = False,
) -> Tuple[List[str], List[str], List[str]]:
    changed_paths = _expand_known_artifact_directory_paths(repo, summarize_git_changes(repo))
    if clean_known_runtime_artifacts:
        cleaned_paths = _cleanup_known_runtime_artifacts(repo, changed_paths, baseline_snapshot)
        if cleaned_paths:
            changed_paths = _expand_known_artifact_directory_paths(repo, summarize_git_changes(repo))
    delta = _paths_changed_after_baseline(repo, changed_paths, baseline_snapshot)
    effective = [p for p in delta if _is_publishable_changed_path(p)]
    return changed_paths, delta, effective


def _safe_repo_relative_path(repo: str, path: str) -> Optional[Path]:
    raw = str(path or "").replace("\\", "/").strip()
    if not raw or raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        return None
    parts = [part for part in raw.split("/") if part]
    if not parts or any(part in ("..", ".") for part in parts):
        return None
    try:
        repo_path = Path(repo).resolve()
        candidate = (repo_path / Path(*parts)).resolve()
        candidate.relative_to(repo_path)
        return candidate
    except Exception:
        return None


def _git_path_is_tracked(repo: str, path: str) -> bool:
    normalized = str(path or "").replace("\\", "/").strip().strip("/")
    if not normalized:
        return False
    try:
        result = subprocess.run(
            ["git", "ls-files", "--error-unmatch", "--", normalized],
            cwd=repo,
            text=True,
            capture_output=True,
            timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


def _tracked_path_has_git_content_delta(repo: str, path: str) -> Optional[bool]:
    normalized = str(path or "").replace("\\", "/").strip().strip("/")
    if not normalized or not _git_path_is_tracked(repo, normalized):
        return None

    has_delta = False
    for args in (
        ["git", "diff", "--quiet", "--", normalized],
        ["git", "diff", "--cached", "--quiet", "--", normalized],
    ):
        try:
            result = subprocess.run(
                args,
                cwd=repo,
                text=True,
                capture_output=True,
                timeout=10,
            )
        except Exception:
            return None
        if result.returncode == 1:
            has_delta = True
            continue
        if result.returncode != 0:
            return None
    return has_delta


def _git_null_delimited_paths(output: str) -> List[str]:
    return [
        path.replace("\\", "/").strip().strip("/")
        for path in str(output or "").split("\0")
        if path.strip()
    ]


def _tracked_paths_git_content_deltas(
    repo: str,
    paths: List[str],
) -> Dict[str, Optional[bool]]:
    normalized_paths = [
        str(path or "").replace("\\", "/").strip().strip("/")
        for path in paths
        if str(path or "").strip()
    ]
    if not normalized_paths:
        return {}
    if len(normalized_paths) < _BATCH_GIT_CONTENT_DELTA_MIN_PATHS:
        return {
            path: _tracked_path_has_git_content_delta(repo, path)
            for path in normalized_paths
        }

    commands = (
        ["git", "ls-files", "-z"],
        ["git", "diff", "--name-only", "--no-renames", "-z"],
        ["git", "diff", "--cached", "--name-only", "--no-renames", "-z"],
    )
    results: List[subprocess.CompletedProcess[str]] = []
    try:
        for args in commands:
            results.append(
                subprocess.run(
                    args,
                    cwd=repo,
                    text=True,
                    capture_output=True,
                    timeout=20,
                )
            )
    except Exception:
        results = []

    if len(results) == len(commands) and all(result.returncode == 0 for result in results):
        tracked_paths = set(_git_null_delimited_paths(results[0].stdout))
        content_deltas = {
            *_git_null_delimited_paths(results[1].stdout),
            *_git_null_delimited_paths(results[2].stdout),
        }
        return {
            path: (path in content_deltas) if path in tracked_paths else None
            for path in normalized_paths
        }

    return {
        path: _tracked_path_has_git_content_delta(repo, path)
        for path in normalized_paths
    }


def _prune_empty_artifact_parent_dirs(repo: str, path: Path) -> None:
    try:
        repo_root = Path(repo).resolve()
        current = path.parent.resolve()
        while current != repo_root:
            try:
                current.relative_to(repo_root)
            except Exception:
                break
            try:
                current.rmdir()
            except OSError:
                break
            current = current.parent.resolve()
    except Exception:
        return


def _cleanup_known_runtime_artifacts(
    repo: str,
    changed_paths: List[str],
    baseline_snapshot: Any,
) -> List[str]:
    baseline_paths = set(_baseline_snapshot_paths(baseline_snapshot))
    cleaned: List[str] = []
    for path in changed_paths:
        normalized = str(path or "").replace("\\", "/").strip().strip("/")
        if not normalized or normalized in baseline_paths:
            continue
        if not _is_known_runtime_artifact_path(normalized):
            continue
        if _git_path_is_tracked(repo, normalized):
            continue
        target = _safe_repo_relative_path(repo, normalized)
        if target is None or not target.exists():
            continue
        try:
            if target.is_dir():
                rmtree(target)
            else:
                target.unlink()
            cleaned.append(normalized)
            _prune_empty_artifact_parent_dirs(repo, target)
        except Exception as exc:
            log.warning(
                f"Failed to clean non-publishable runtime artifact path {normalized}: {exc}"
            )
    if cleaned:
        listed = ", ".join(cleaned[:8])
        if len(cleaned) > 8:
            listed += ", ..."
        log.info(f"Cleaned non-publishable runtime artifact path(s): {listed}")
    return cleaned


def _git_status_entries(repo: str) -> List[Tuple[str, str]]:
    try:
        proc = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except Exception:
        return []
    if proc.returncode != 0:
        return []
    entries: List[Tuple[str, str]] = []
    for raw_line in proc.stdout.splitlines():
        line = str(raw_line or "").rstrip("\r\n")
        if len(line) < 4:
            continue
        status = line[:2]
        path = line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1].strip()
        if path:
            entries.append((status, path))
    return entries


def _restore_retry_baseline(repo: str, baseline_snapshot: Any, reason: str = "") -> bool:
    _changed_paths, delta_paths, _effective_paths = _codex_changed_paths(repo, baseline_snapshot)
    if not delta_paths:
        return True
    baseline_paths = set(_baseline_snapshot_paths(baseline_snapshot))
    unsafe_delta = [path for path in delta_paths if _safe_repo_relative_path(repo, path) is None]
    if unsafe_delta:
        log.info(
            "Rollout recovery cannot safely restore worker sandbox baseline; unsafe changed paths: "
            f"{_describe_publishable_paths(unsafe_delta)}"
        )
        return False
    mutated_baseline_paths = [path for path in delta_paths if path in baseline_paths]
    if mutated_baseline_paths:
        log.info(
            "Rollout recovery will not reset paths that were already dirty at baseline: "
            f"{_describe_publishable_paths(mutated_baseline_paths)}"
        )
        return False

    log.info(
        "Restoring worker sandbox baseline before rollout recovery retry"
        f"{f' ({reason})' if reason else ''}: {_describe_publishable_paths(delta_paths)}"
    )
    try:
        subprocess.run(
            ["git", "restore", "--staged", "--worktree", "--", *delta_paths],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except Exception as exc:
        log.info(f"Failed to run git restore for rollout recovery baseline: {exc}")
        return False

    delta_set = set(delta_paths)
    for status, path in _git_status_entries(repo):
        if status != "??":
            continue
        if path not in delta_set and not any(path.startswith(f"{delta.rstrip('/')}/") for delta in delta_set):
            continue
        candidate = _safe_repo_relative_path(repo, path)
        if candidate is None:
            return False
        try:
            if candidate.is_dir():
                rmtree(candidate)
            elif candidate.exists():
                candidate.unlink()
        except Exception as exc:
            log.info(f"Failed to remove untracked rollout recovery path {path}: {exc}")
            return False

    _remaining_changed, remaining_delta, remaining_effective = _codex_changed_paths(
        repo,
        baseline_snapshot,
    )
    if remaining_delta:
        log.info(
            "Rollout recovery baseline restore left changed paths after cleanup: "
            f"{_describe_publishable_paths(remaining_effective or remaining_delta)}"
        )
        return False
    return True


def _changed_path_top_level(path: str) -> str:
    raw = str(path or "").replace("\\", "/").strip()
    is_top_level_directory = raw.endswith("/")
    normalized = raw.strip("/")
    if not normalized:
        return ""
    parts = [part for part in normalized.split("/") if part]
    if len(parts) > 1 or is_top_level_directory:
        return parts[0]
    return "<repo-root>"


def _has_credible_shell_wrapper_progress(effective_paths: List[str]) -> bool:
    if not effective_paths:
        return False
    if len(effective_paths) > _MAX_CREDIBLE_WRAPPER_LOOP_CHANGED_PATHS:
        return False
    top_levels = {
        top_level
        for top_level in (_changed_path_top_level(path) for path in effective_paths)
        if top_level
    }
    return len(top_levels) <= _MAX_CREDIBLE_WRAPPER_LOOP_TOP_LEVELS


def _build_success_stdout(
    *,
    effective_paths: List[str],
    last_message: str,
    trace_excerpt: str,
    prefix: str = "",
) -> str:
    stdout_parts: List[str] = []
    if prefix.strip():
        stdout_parts.append(prefix.strip())
    if last_message:
        stdout_parts.append(last_message)
    elif trace_excerpt:
        stdout_parts.append(trace_excerpt)
    if effective_paths:
        listed = "\n".join(f"- {path}" for path in effective_paths[:40])
        if len(effective_paths) > 40:
            listed += "\n- ..."
        stdout_parts.append(f"Changed files:\n{listed}")
    if not stdout_parts:
        stdout_parts.append("No modified files were detected after execution.")
    return "\n\n".join(stdout_parts)


def _augment_supplemental_guidance(supplemental_guidance: List[str]) -> List[str]:
    normalized = [str(item or "").strip() for item in supplemental_guidance if str(item or "").strip()]
    joined = "\n".join(normalized).lower()
    if "direct commands only" in joined or "shell-wrapper" in joined or "/bin/bash -lc" in joined:
        return normalized
    return [_command_router_policy_guidance(), *normalized]


def _read_text_if_exists(path: Path) -> str:
    try:
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except Exception:
        return ""


def _terminate_child(signum: int, _frame: Any) -> None:
    global _INTERRUPTED_SIGNAL
    _INTERRUPTED_SIGNAL = signum
    _terminate_active_child()


def _install_signal_handlers() -> None:
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _terminate_child)
        except Exception:
            pass


def _run_codex_task(
    repo: str,
    instruction: str,
    supplemental_guidance: List[str],
    *,
    wrapper_recovery_attempt: int = 0,
    model_compatibility_recovery_attempt: int = 0,
    startup_stall_recovery_attempt: int = 0,
    no_edit_recovery_attempt: int = 0,
    rollout_recovery_attempt: int = 0,
    model_override: Optional[str] = None,
    baseline_changes: Optional[List[str]] = None,
    execution_deadline_monotonic: Optional[float] = None,
    resume_thread_id: Optional[str] = None,
) -> Dict[str, Any]:
    global _ACTIVE_CHILD, _INTERRUPTED_SIGNAL
    _INTERRUPTED_SIGNAL = None
    _install_signal_handlers()

    if not _is_git_repo(repo):
        return {
            "ok": False,
            "summary": "openai_codex requires a git repository",
            "stderr": (
                f"Refusing to run codex in a non-git directory: {repo}. "
                "Validate repo/worktree setup before dispatching this backend."
            ),
            "exitCode": 2,
        }

    runtime_config = OpenAICodexRuntimeConfig.from_sources()
    codex_cmd_prefix = _resolve_codex_command_prefix(runtime_config)
    if not codex_cmd_prefix:
        return {
            "ok": False,
            "summary": "openai_codex CLI is not installed",
            "stderr": (
                "Could not find a runnable Codex command. "
                "Expected one of: `codex` or `bunx --yes @openai/codex` in PATH. "
                "You can also set PUSHPALS_OPENAI_CODEX_BIN explicitly."
            ),
            "exitCode": 3,
        }

    configured_model, api_key, base_url = resolve_llm_config(DEFAULT_CODEX_MODEL, logger=log)
    auth_mode_raw = runtime_config.auth_mode
    auth_mode_configured = _normalize_auth_mode(auth_mode_raw)
    model = str(model_override or "").strip() or _safe_model_for_codex(configured_model, base_url)
    if model_override:
        log.info(
            f"Using Codex model compatibility override {model!r} instead of configured/default "
            f"model {configured_model!r}."
        )
    approval = _normalize_choice(
        runtime_config.approval_policy,
        _VALID_APPROVAL_POLICIES,
        "never",
        env_name="workerpals.openai_codex.approval_policy",
    )
    sandbox = _normalize_choice(
        runtime_config.sandbox,
        _VALID_SANDBOX_POLICIES,
        "workspace-write",
        env_name="workerpals.openai_codex.sandbox",
    )
    color = _normalize_choice(
        runtime_config.color,
        _VALID_COLORS,
        "never",
        env_name="workerpals.openai_codex.color",
    )
    # JSON events provide exact token usage and the thread id required for context-preserving
    # recovery. They are compacted before being returned, so keep them enabled internally even
    # when verbose JSON logging was not explicitly requested.
    use_json = True
    requested_communicate_timeout_s = _resolve_communicate_timeout_seconds(runtime_config)
    recovery_depth = (
        wrapper_recovery_attempt
        + model_compatibility_recovery_attempt
        + startup_stall_recovery_attempt
        + no_edit_recovery_attempt
        + rollout_recovery_attempt
    )
    communicate_timeout_s = requested_communicate_timeout_s
    overall_deadline = execution_deadline_monotonic
    if requested_communicate_timeout_s and requested_communicate_timeout_s > 0:
        if overall_deadline is None:
            overall_deadline = time.monotonic() + float(requested_communicate_timeout_s)
        else:
            remaining_s = int(max(0.0, overall_deadline - time.monotonic()))
            min_attempt_s = (
                _minimum_recovery_attempt_seconds(requested_communicate_timeout_s)
                if recovery_depth > 0
                else 1
            )
            if remaining_s < min_attempt_s:
                return {
                    "ok": False,
                    "summary": "openai_codex recovery budget exhausted before retry",
                    "stderr": (
                        "Codex recovery was requested, but the shared executor budget had only "
                        f"{remaining_s}s remaining (< {min_attempt_s}s). Stopping before a low-odds "
                        "retry so ValidationGate/QualityGate can return a structured result."
                    ),
                    "exitCode": 124,
                    "cooldownMs": _NO_PUBLISHABLE_FAILURE_COOLDOWN_MS,
                }
            communicate_timeout_s = max(1, min(requested_communicate_timeout_s, remaining_s))
    effective_supplemental_guidance = _augment_supplemental_guidance(supplemental_guidance)
    prompt = (
        "\n\n".join(
            [
                "Continue the same task from the preserved Codex thread.",
                *[entry for entry in effective_supplemental_guidance if entry.strip()],
            ]
        )
        if resume_thread_id
        else _build_instruction(instruction, effective_supplemental_guidance)
    )
    reasoning_effort = _resolve_task_reasoning_effort(
        _resolve_reasoning_effort(runtime_config, model),
        instruction if resume_thread_id else prompt,
        model,
    )
    baseline_snapshot = _normalize_baseline_snapshot(repo, baseline_changes)

    with tempfile.TemporaryDirectory(prefix="pushpals-codex-") as tmp_dir:
        last_message_path = Path(tmp_dir) / "codex-last-message.txt"
        sandbox_additional_dirs = (
            _codex_sandbox_additional_dirs(repo) if sandbox == "workspace-write" else []
        )
        cmd: List[str] = [
            *codex_cmd_prefix,
            "-c",
            f'model_reasoning_effort="{reasoning_effort}"',
            "-a",
            approval,
            "exec",
        ]
        if resume_thread_id:
            cmd.append("resume")
        else:
            cmd.extend(["-s", sandbox, "--color", color])
            for directory in sandbox_additional_dirs:
                cmd.extend(["--add-dir", directory])
        cmd.extend(["--output-last-message", str(last_message_path)])
        if use_json:
            cmd.append("--json")
        if model:
            cmd.extend(["-m", model])
        if resume_thread_id:
            cmd.append(resume_thread_id)
        cmd.append("-")

        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PUSHPALS_REPO_PATH"] = repo
        env["PUSHPALS_ASSIGNED_REPO_ROOT"] = repo
        existing_openai_key = (env.get("OPENAI_API_KEY") or "").strip()
        llm_key = api_key.strip()
        if llm_key.lower() == "lmstudio":
            llm_key = ""
        auth_mode = auth_mode_configured
        if auth_mode == "auto":
            auth_mode = "api_key" if (llm_key or existing_openai_key) else "chatgpt"
        log.info(f"Codex auth mode: {auth_mode} (configured={auth_mode_configured})")

        existing_openai_base = (
            env.get("OPENAI_BASE_URL", "").strip() or env.get("OPENAI_API_BASE", "").strip()
        )
        override_base = runtime_config.base_url_override
        effective_base = ""

        if auth_mode == "chatgpt":
            if llm_key or existing_openai_key:
                log.info(
                    "ChatGPT auth mode selected; ignoring OPENAI_API_KEY to use Codex CLI login credentials."
                )
            if override_base or existing_openai_base or base_url:
                log.info("ChatGPT auth mode selected; ignoring OPENAI_BASE_URL/OPENAI_API_BASE overrides.")
            env.pop("OPENAI_API_KEY", None)
            env.pop("OPENAI_BASE_URL", None)
            env.pop("OPENAI_API_BASE", None)
            codex_project_mask = _mask_repo_local_codex_files(repo, env)
            try:
                login_status = _run_codex_login_status(codex_cmd_prefix, repo, env)
            finally:
                _restore_repo_local_codex_files(codex_project_mask)
            if not login_status.get("ok"):
                detail = (
                    str(login_status.get("stderr") or "").strip()
                    or str(login_status.get("stdout") or "").strip()
                    or "codex login status returned non-zero"
                )
                return {
                    "ok": False,
                    "summary": "openai_codex chatgpt auth is not ready",
                    "stdout": _truncate(str(login_status.get("stdout") or "")),
                    "stderr": _truncate(
                        "Codex CLI is not logged in for ChatGPT subscription mode. "
                        "Run `bunx --yes @openai/codex login` on the host (no global install needed), "
                        "complete browser sign-in, then retry.\n"
                        f"Details: {detail}"
                    ),
                    "exitCode": int(login_status.get("exitCode") or 1),
                }
        else:
            final_key = llm_key or existing_openai_key
            if not final_key:
                return {
                    "ok": False,
                    "summary": "openai_codex api_key auth requires OPENAI_API_KEY",
                    "stderr": (
                        "API-key auth mode selected, but no API key is available. "
                        "Set OPENAI_API_KEY (or WORKERPALS_LLM_API_KEY), "
                        "or set PUSHPALS_OPENAI_CODEX_AUTH_MODE=chatgpt."
                    ),
                    "exitCode": 2,
                }
            env["OPENAI_API_KEY"] = final_key
            effective_base = override_base or base_url
            if (
                not override_base
                and not existing_openai_base
                and looks_local_base_url(base_url)
                and (env.get("OPENAI_API_KEY") or "").strip()
            ):
                # If an OpenAI key exists but base URL came from local worker LLM config,
                # prefer Codex/OpenAI defaults unless explicitly overridden.
                log.info(
                    "Detected local worker LLM endpoint with OPENAI_API_KEY present; "
                    "using Codex default OpenAI endpoint (set PUSHPALS_OPENAI_CODEX_BASE_URL "
                    "to force local)."
                )
                effective_base = ""
            if effective_base:
                env["OPENAI_BASE_URL"] = effective_base
                env["OPENAI_API_BASE"] = effective_base
            else:
                env.pop("OPENAI_BASE_URL", None)
                env.pop("OPENAI_API_BASE", None)

        log.info(f"Starting codex exec in {repo}")
        log.debug(f"Codex command: {' '.join(codex_cmd_prefix)}")
        log.debug(f"Model: {model}")
        base_for_log = (
            env.get("OPENAI_BASE_URL", "").strip()
            or env.get("OPENAI_API_BASE", "").strip()
            or "<default>"
        )
        log.debug(f"Base URL: {base_for_log}")
        if communicate_timeout_s:
            log.debug(f"communicate timeout: {communicate_timeout_s}s")
        if sandbox_additional_dirs:
            log.info(
                "Codex sandbox add-dir includes linked dependency artifact root(s): "
                + ", ".join(sandbox_additional_dirs[:4])
            )

        codex_project_mask = _mask_repo_local_codex_files(repo, env)
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=repo,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            _ACTIVE_CHILD = proc
            started_at = time.monotonic()
            progress_interval_s = _resolve_progress_log_interval_seconds(runtime_config)

            stdout_chunks: List[str] = []
            stderr_chunks: List[str] = []
            stdout_trace_state = _empty_codex_trace()
            trace_lock = threading.Lock()
            last_activity_at = {"ts": started_at}
            wrapper_rejection_state: Dict[str, Any] = {"count": 0, "commands": []}

            def _drain_stdout() -> None:
                stream = proc.stdout
                if stream is None:
                    return
                try:
                    for chunk in iter(stream.readline, ""):
                        if chunk == "":
                            break
                        stdout_chunks.append(chunk)
                        line = chunk.strip()
                        if not line:
                            continue
                        with trace_lock:
                            observed_at = time.monotonic()
                            last_activity_at["ts"] = observed_at
                            _record_live_codex_stdout_line(
                                line,
                                use_json,
                                stdout_trace_state,
                                observed_at,
                            )
                except Exception:
                    pass
                finally:
                    try:
                        stream.close()
                    except Exception:
                        pass

            def _drain_stderr() -> None:
                stream = proc.stderr
                if stream is None:
                    return
                try:
                    for chunk in iter(stream.readline, ""):
                        if chunk == "":
                            break
                        stderr_chunks.append(chunk)
                        rejected_commands = _collect_disallowed_shell_wrapper_rejections(chunk)
                        if rejected_commands:
                            with trace_lock:
                                wrapper_rejection_state["count"] = to_int(
                                    wrapper_rejection_state.get("count"), 0
                                ) + len(rejected_commands)
                                tracked = wrapper_rejection_state.get("commands")
                                if not isinstance(tracked, list):
                                    tracked = []
                                for command in rejected_commands:
                                    lowered = command.lower()
                                    if any(str(item).lower() == lowered for item in tracked):
                                        continue
                                    tracked.append(command)
                                wrapper_rejection_state["commands"] = tracked[:6]
                except Exception:
                    pass
                finally:
                    try:
                        stream.close()
                    except Exception:
                        pass

            stdout_thread = threading.Thread(target=_drain_stdout, daemon=True)
            stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
            stdout_thread.start()
            stderr_thread.start()

            if proc.stdin is not None:
                try:
                    proc.stdin.write(prompt)
                    proc.stdin.close()
                except Exception:
                    pass

            deadline = (
                started_at + float(communicate_timeout_s)
                if communicate_timeout_s and communicate_timeout_s > 0
                else None
            )
            next_progress_at = started_at + float(progress_interval_s)
            timed_out = False
            no_edit_watchdog_fired = False
            no_edit_artifact_only_paths = ""
            rollout_watchdog_fired = False
            rollout_watchdog_reason = ""
            rollout_artifact_only_paths = ""
            rollout_watchdog_retryable = True
            rollout_restore_before_retry = False
            command_policy_rejection_loop = False
            no_edit_watchdog_s = (
                _resolve_no_edit_watchdog_seconds(
                    prompt,
                    communicate_timeout_s,
                    recovery_attempt=no_edit_recovery_attempt,
                )
                if no_edit_recovery_attempt <= _MAX_NO_EDIT_RECOVERY_ATTEMPTS
                else None
            )
            no_edit_recheck_s = _resolve_no_edit_recheck_seconds(
                communicate_timeout_s,
                recovery_attempt=recovery_depth,
                prompt=prompt,
            )
            no_edit_command_grace_s = _resolve_no_edit_command_grace_seconds(communicate_timeout_s)
            no_edit_command_progress_cap_s = _resolve_no_edit_command_progress_cap_seconds(
                communicate_timeout_s,
                no_edit_command_grace_s,
                recovery_attempt=recovery_depth,
                prompt=prompt,
            )
            startup_stall_watchdog_s = _resolve_startup_stall_watchdog_seconds(
                communicate_timeout_s,
                recovery_attempt=recovery_depth,
            )
            startup_stall_deadline = (
                started_at + float(startup_stall_watchdog_s)
                if startup_stall_watchdog_s is not None
                else None
            )
            rollout_watchdog_s = (
                _resolve_rollout_watchdog_seconds(
                    prompt,
                    communicate_timeout_s,
                    no_edit_watchdog_s,
                )
                if rollout_recovery_attempt <= _MAX_ROLLOUT_RECOVERY_ATTEMPTS
                else None
            )
            no_edit_deadline = (
                started_at + float(no_edit_watchdog_s)
                if no_edit_watchdog_s is not None
                else None
            )
            rollout_deadline = (
                started_at + float(rollout_watchdog_s)
                if rollout_watchdog_s is not None
                else None
            )
            publishable_progress_seen_at: Optional[float] = None
            publishable_progress_finalized = False
            publishable_progress_paths: List[str] = []
            publishable_progress_fingerprint = ""
            first_no_edit_command_progress_at: Optional[float] = None
            validation_repair_prompt = _looks_like_validation_repair_prompt(
                f"{instruction}\n\n{prompt}"
            )

            while proc.poll() is None:
                now = time.monotonic()
                if deadline is not None and now >= deadline:
                    timed_out = True
                    _terminate_active_child()
                    break

                if startup_stall_deadline is not None and now >= startup_stall_deadline:
                    with trace_lock:
                        live_trace = dict(stdout_trace_state)
                        summaries = stdout_trace_state.get("summaries")
                        if isinstance(summaries, list):
                            live_trace["summaries"] = list(summaries)
                    if _codex_trace_is_startup_stall(live_trace):
                        changed_paths, _, effective_paths = _codex_changed_paths(
                            repo,
                            baseline_snapshot,
                            clean_known_runtime_artifacts=True,
                        )
                        if not effective_paths:
                            no_edit_artifact_only_paths = _describe_non_publishable_paths(
                                changed_paths,
                                baseline_snapshot,
                            )
                            no_edit_watchdog_fired = True
                            elapsed_s = int(max(0.0, now - started_at))
                            log.info(
                                f"Startup-stall watchdog fired after {elapsed_s}s with no assistant/tool progress."
                            )
                            _terminate_active_child()
                            break
                    startup_stall_deadline = None

                if no_edit_deadline is not None and now >= no_edit_deadline:
                    changed_paths, _, effective_paths = _codex_changed_paths(
                        repo,
                        baseline_snapshot,
                        clean_known_runtime_artifacts=True,
                    )
                    if not effective_paths:
                        with trace_lock:
                            live_trace = dict(stdout_trace_state)
                            summaries = stdout_trace_state.get("summaries")
                            if isinstance(summaries, list):
                                live_trace["summaries"] = list(summaries)
                        startup_only = _codex_trace_is_startup_stall(live_trace)
                        if (
                            startup_only
                            and startup_stall_deadline is not None
                            and now < startup_stall_deadline
                        ):
                            no_edit_deadline = startup_stall_deadline
                            remaining_s = int(max(1.0, startup_stall_deadline - now))
                            log.info(
                                "No-edit watchdog observed only Codex startup events; "
                                f"allowing {remaining_s}s for first assistant/tool progress "
                                "before startup-stall recovery."
                            )
                            continue
                        command_event_count = to_int(live_trace.get("command_event_count"), 0)
                        active_commands_raw = live_trace.get("active_command_ids")
                        active_command_count = (
                            len(active_commands_raw)
                            if isinstance(active_commands_raw, list)
                            else 0
                        )
                        last_command_activity_at = 0.0
                        try:
                            last_command_activity_at = float(
                                live_trace.get("last_command_activity_at") or 0.0
                            )
                        except Exception:
                            last_command_activity_at = 0.0
                        command_progress_cap_reached = False
                        command_progress_elapsed_s = 0
                        if command_event_count > 0 and no_edit_command_grace_s is not None:
                            observed_command_progress_at = (
                                last_command_activity_at if last_command_activity_at > 0 else now
                            )
                            if first_no_edit_command_progress_at is None:
                                first_no_edit_command_progress_at = observed_command_progress_at
                            if no_edit_command_progress_cap_s is not None:
                                command_progress_cap_deadline = (
                                    first_no_edit_command_progress_at
                                    + float(no_edit_command_progress_cap_s)
                                )
                                command_progress_elapsed_s = int(
                                    max(0.0, now - first_no_edit_command_progress_at)
                                )
                                if now >= command_progress_cap_deadline:
                                    command_progress_cap_reached = True
                            command_grace_deadline = 0.0
                            if active_command_count > 0:
                                # Do not kill while Codex is actively running a tool command; poll
                                # again soon, but keep endless read-only discovery bounded by the
                                # command-progress cap above.
                                command_grace_deadline = now + min(60.0, float(no_edit_command_grace_s))
                            elif last_command_activity_at > 0:
                                command_grace_deadline = last_command_activity_at + float(
                                    no_edit_command_grace_s
                                )
                            if (
                                no_edit_command_progress_cap_s is not None
                                and first_no_edit_command_progress_at is not None
                            ):
                                command_grace_deadline = min(
                                    command_grace_deadline,
                                    first_no_edit_command_progress_at
                                    + float(no_edit_command_progress_cap_s),
                                )
                            if deadline is not None and command_grace_deadline > 0:
                                command_grace_deadline = min(
                                    command_grace_deadline,
                                    max(now, deadline - 1.0),
                                )
                            if command_progress_cap_reached:
                                log.info(
                                    "No-edit watchdog observed Codex tool progress for "
                                    f"{command_progress_elapsed_s}s without a publishable patch; "
                                    "forcing patch-first recovery instead of waiting for the child timeout."
                                )
                            elif command_grace_deadline > now:
                                no_edit_deadline = command_grace_deadline
                                remaining_s = int(max(1.0, command_grace_deadline - now))
                                command_detail = (
                                    f"{active_command_count} active command(s)"
                                    if active_command_count > 0
                                    else "recent command completion"
                                )
                                log.info(
                                    "No-edit watchdog observed Codex tool progress "
                                    f"({command_detail}); allowing {remaining_s}s for a "
                                    "publishable patch before recovery."
                                )
                                continue
                        no_edit_artifact_only_paths = _describe_non_publishable_paths(
                            changed_paths,
                            baseline_snapshot,
                        )
                        no_edit_watchdog_fired = True
                        artifact_detail = (
                            f" Artifact-only dirty paths: {no_edit_artifact_only_paths}."
                            if no_edit_artifact_only_paths
                            else ""
                        )
                        if startup_only:
                            elapsed_s = int(max(0.0, now - started_at))
                            log.info(
                                f"Startup-stall watchdog fired after {elapsed_s}s with no assistant/tool progress."
                            )
                        else:
                            can_retry_no_edit = (
                                no_edit_recovery_attempt < _MAX_NO_EDIT_RECOVERY_ATTEMPTS
                            )
                            no_edit_action = (
                                "Retrying with patch-first guidance."
                                if can_retry_no_edit
                                else "No no-edit recovery attempts remain; failing this execution."
                            )
                            log.info(
                                f"No-edit watchdog fired after {int(no_edit_watchdog_s or 0)}s with no publishable file changes.{artifact_detail} {no_edit_action}"
                            )
                        _terminate_active_child()
                        break
                    current_progress_fingerprint = _publishable_progress_fingerprint(
                        repo, effective_paths
                    )
                    with trace_lock:
                        active_commands_raw = stdout_trace_state.get("active_command_ids")
                        active_command_count = (
                            len(active_commands_raw)
                            if isinstance(active_commands_raw, list)
                            else 0
                        )
                    if active_command_count > 0:
                        publishable_progress_seen_at = now
                        publishable_progress_paths = list(effective_paths)
                        publishable_progress_fingerprint = current_progress_fingerprint
                        no_edit_deadline = now + float(no_edit_recheck_s)
                        log.info(
                            "No-edit watchdog observed publishable changes while "
                            f"{active_command_count} tool command(s) remain active; waiting for a stable diff."
                        )
                        continue
                    if (
                        publishable_progress_seen_at is None
                        or current_progress_fingerprint != publishable_progress_fingerprint
                    ):
                        publishable_progress_seen_at = now
                        publishable_progress_paths = list(effective_paths)
                        publishable_progress_fingerprint = current_progress_fingerprint
                    elif _has_credible_shell_wrapper_progress(effective_paths):
                        publishable_progress_paths = list(effective_paths)
                        publishable_age_s = now - publishable_progress_seen_at
                        if publishable_age_s >= float(no_edit_recheck_s):
                            publishable_progress_finalized = True
                            log.info(
                                "No-edit watchdog observed durable publishable file changes "
                                f"({_describe_publishable_paths(effective_paths)}) for "
                                f"{int(publishable_age_s)}s; stopping Codex early so "
                                "QualityGate/ValidationGate can use the remaining budget."
                            )
                            _terminate_active_child()
                            break
                    no_edit_deadline = now + float(no_edit_recheck_s)
                    log.info(
                        "No-edit watchdog observed publishable-looking file changes "
                        f"({_describe_publishable_paths(effective_paths)}); rechecking in "
                        f"{int(no_edit_recheck_s)}s to ensure the worker keeps durable PR content."
                    )

                if rollout_deadline is not None and now >= rollout_deadline:
                    changed_paths, _, effective_paths = _codex_changed_paths(
                        repo,
                        baseline_snapshot,
                        clean_known_runtime_artifacts=True,
                    )
                    with trace_lock:
                        live_trace = dict(stdout_trace_state)
                        summaries = stdout_trace_state.get("summaries")
                        if isinstance(summaries, list):
                            live_trace["summaries"] = list(summaries)
                    if effective_paths:
                        small_or_web_task = (
                            _looks_like_small_task_prompt(instruction)
                            or _looks_like_web_review_prompt(instruction)
                            or _looks_like_small_task_prompt(prompt)
                            or _looks_like_web_review_prompt(prompt)
                        )
                        if small_or_web_task and not _has_credible_shell_wrapper_progress(effective_paths):
                            rollout_watchdog_reason = (
                                "publishable-looking changed paths are broad/noisy for a small task: "
                                f"{_describe_publishable_paths(effective_paths)}"
                            )
                            rollout_watchdog_retryable = True
                            rollout_restore_before_retry = True
                        else:
                            rollout_deadline = None
                    else:
                        rollout_artifact_only_paths = _describe_non_publishable_paths(
                            changed_paths,
                            baseline_snapshot,
                        )
                        detection_artifact_only_paths = (
                            "" if validation_repair_prompt else rollout_artifact_only_paths
                        )
                        rollout_watchdog_reason = _detect_offtrack_rollout(
                            live_trace,
                            detection_artifact_only_paths,
                            instruction,
                        )
                        if (
                            validation_repair_prompt
                            and rollout_artifact_only_paths
                            and not rollout_watchdog_reason
                        ):
                            reschedule_s = min(60.0, float(rollout_watchdog_s or 60))
                            rollout_deadline = now + reschedule_s
                            log.info(
                                "Rollout coach observed only non-publishable artifact paths "
                                "during validation repair; allowing command reproduction and "
                                f"diagnosis to continue for another {int(reschedule_s)}s."
                            )
                    if rollout_watchdog_reason:
                        rollout_watchdog_fired = True
                        artifact_detail = (
                            f" Artifact-only dirty paths: {rollout_artifact_only_paths}."
                            if rollout_artifact_only_paths
                            else ""
                        )
                        can_retry_rollout = (
                            rollout_watchdog_retryable
                            and rollout_recovery_attempt < _MAX_ROLLOUT_RECOVERY_ATTEMPTS
                        )
                        action = (
                            "Restoring worker sandbox baseline and retrying with stricter guidance."
                            if rollout_restore_before_retry and can_retry_rollout
                            else
                            "Retrying with course-correction guidance."
                            if can_retry_rollout
                            else "Failing fast instead of retrying on top of a broad/noisy diff."
                        )
                        log.info(
                            f"Rollout coach fired after {int(rollout_watchdog_s or 0)}s: {rollout_watchdog_reason}.{artifact_detail} {action}"
                        )
                        _terminate_active_child()
                        break

                with trace_lock:
                    wrapper_rejections = to_int(wrapper_rejection_state.get("count"), 0)
                if wrapper_rejections >= 1:
                    command_policy_rejection_loop = True
                    _terminate_active_child()
                    break

                if now >= next_progress_at:
                    elapsed = int(max(0.0, now - started_at))
                    with trace_lock:
                        last_event = float(last_activity_at.get("ts", started_at))
                        valid_json = to_int(stdout_trace_state.get("valid_json"), 0)
                        total_lines = to_int(stdout_trace_state.get("line_count"), 0)
                    idle_for = int(max(0.0, now - last_event))
                    if use_json:
                        log.info(
                            f"codex exec still running ({elapsed}s elapsed, json_events={valid_json}, idle={idle_for}s)"
                        )
                    else:
                        log.info(
                            f"codex exec still running ({elapsed}s elapsed, stdout_lines={total_lines}, idle={idle_for}s)"
                        )
                    next_progress_at = now + float(progress_interval_s)

                time.sleep(1.0)

            try:
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                    proc.wait(timeout=5)
                except Exception:
                    pass

            stdout_thread.join(timeout=2)
            stderr_thread.join(timeout=2)
        finally:
            _restore_repo_local_codex_files(codex_project_mask)

        return_code = proc.returncode
        _ACTIVE_CHILD = None
        elapsed_total = int(max(0.0, time.monotonic() - started_at))
        log.info(f"codex exec finished in {elapsed_total}s")

        stdout = "".join(stdout_chunks)
        stderr = "".join(stderr_chunks)
        stdout_trace = _finalize_codex_stdout_trace(stdout_trace_state, use_json)
        trace_excerpt = _format_codex_trace_excerpt(stdout_trace)
        _log_stderr(stderr)
        usage_output_text = "\n\n".join(
            part for part in (stdout, stderr, trace_excerpt) if str(part or "").strip()
        )
        usage = _usage_from_trace_or_estimate(stdout_trace, prompt, usage_output_text, model=model)
        rejected_shell_wrappers = _collect_disallowed_shell_wrapper_rejections(stdout, stderr)
        with trace_lock:
            tracked = wrapper_rejection_state.get("commands")
            if isinstance(tracked, list):
                for command in tracked:
                    text = _normalize_command_text(str(command))
                    if not text:
                        continue
                    lowered = text.lower()
                    if any(entry.lower() == lowered for entry in rejected_shell_wrappers):
                        continue
                    rejected_shell_wrappers.append(text)

        def _return_publishable_progress_for_quality_gate(
            *,
            summary: str,
            prefix: str,
            paths_hint: Optional[List[str]] = None,
        ) -> Dict[str, Any]:
            changed_paths, _, effective_paths = _codex_changed_paths(
                repo,
                baseline_snapshot,
                clean_known_runtime_artifacts=True,
            )
            del changed_paths
            if not effective_paths and paths_hint:
                effective_paths = list(paths_hint)
            last_message = _read_text_if_exists(last_message_path)
            log_git_status(repo, log)
            return {
                "ok": True,
                "summary": summary,
                "stdout": _truncate(
                    _build_success_stdout(
                        effective_paths=effective_paths,
                        last_message=last_message,
                        trace_excerpt=trace_excerpt,
                        prefix=prefix,
                    )
                ),
                "stderr": _truncate(stderr),
                "exitCode": 0,
                "usage": usage,
            }

        if rollout_watchdog_fired:
            if rollout_watchdog_retryable and rollout_recovery_attempt < _MAX_ROLLOUT_RECOVERY_ATTEMPTS:
                if rollout_restore_before_retry and not _restore_retry_baseline(
                    repo,
                    baseline_snapshot,
                    rollout_watchdog_reason,
                ):
                    detail = (
                        "Codex trajectory drifted into broad/noisy changes and the worker sandbox "
                        "could not be restored safely for a clean recovery retry: "
                        f"{rollout_watchdog_reason or 'broad/noisy changes'}."
                    )
                    if trace_excerpt:
                        detail = f"{detail}\n{trace_excerpt}"
                    return {
                        "ok": False,
                        "summary": "openai_codex rollout coach could not safely reset broad changes",
                        "stdout": _truncate(stdout),
                        "stderr": _truncate(f"{detail}\n{stderr}".strip()),
                        "exitCode": 124,
                        "usage": usage,
                        "cooldownMs": _NO_PUBLISHABLE_FAILURE_COOLDOWN_MS,
                    }
                retry_guidance = [
                    *supplemental_guidance,
                    _build_rollout_recovery_guidance(
                        rollout_watchdog_reason,
                        trace_excerpt,
                        rollout_artifact_only_paths,
                    ),
                ]
                return _run_codex_task(
                    repo,
                    instruction,
                    retry_guidance,
                    wrapper_recovery_attempt=wrapper_recovery_attempt,
                    model_compatibility_recovery_attempt=model_compatibility_recovery_attempt,
                    startup_stall_recovery_attempt=startup_stall_recovery_attempt,
                    no_edit_recovery_attempt=no_edit_recovery_attempt,
                    rollout_recovery_attempt=rollout_recovery_attempt + 1,
                    model_override=model_override,
                    baseline_changes=baseline_snapshot,
                    execution_deadline_monotonic=overall_deadline,
                )
            _, _, rollout_effective_paths = _codex_changed_paths(
                repo,
                baseline_snapshot,
                clean_known_runtime_artifacts=True,
            )
            if rollout_effective_paths:
                log.info(
                    "Rollout coach exhausted its recovery attempts, but publishable file "
                    "changes remain "
                    f"({_describe_publishable_paths(rollout_effective_paths)}); stopping "
                    "Codex so QualityGate/ValidationGate can evaluate the patch instead "
                    "of failing the executor before validation."
                )
                return _return_publishable_progress_for_quality_gate(
                    summary=(
                        "openai_codex stopped after rollout coach publishable progress "
                        f"({len(rollout_effective_paths)} file(s))"
                    ),
                    prefix=(
                        "Codex produced publishable file changes before the rollout coach "
                        "exhausted recovery attempts. PushPals stopped the Codex child so "
                        "the normal QualityGate/ValidationGate can reject, repair, or "
                        "accept the patch with full validation context."
                    ),
                    paths_hint=rollout_effective_paths,
                )
            detail = (
                "Codex trajectory remained off-track or too broad for safe recovery: "
                f"{rollout_watchdog_reason or 'no publishable progress'}."
            )
            if trace_excerpt:
                detail = f"{detail}\n{trace_excerpt}"
            return {
                "ok": False,
                "summary": "openai_codex rollout coach could not recover publishable progress",
                "stdout": _truncate(stdout),
                "stderr": _truncate(f"{detail}\n{stderr}".strip()),
                "exitCode": 124,
                "usage": usage,
                "cooldownMs": _NO_PUBLISHABLE_FAILURE_COOLDOWN_MS,
            }

        if publishable_progress_finalized:
            return _return_publishable_progress_for_quality_gate(
                summary=(
                    "openai_codex stopped after durable publishable progress "
                    f"({len(publishable_progress_paths)} file(s))"
                ),
                prefix=(
                    "Codex produced durable publishable file changes. PushPals stopped the "
                    "Codex child early to preserve validation and revision budget; the normal "
                    "QualityGate/ValidationGate will catch any incomplete edit."
                ),
                paths_hint=publishable_progress_paths,
            )

        if no_edit_watchdog_fired:
            startup_stall = _codex_trace_is_startup_stall(stdout_trace)
            startup_stall_recovery_limit = _MAX_STARTUP_STALL_RECOVERY_ATTEMPTS
            if no_edit_recovery_attempt > 0:
                startup_stall_recovery_limit = max(
                    startup_stall_recovery_limit,
                    _MAX_STARTUP_STALL_DURING_NO_EDIT_RECOVERY_ATTEMPTS,
                )
            if startup_stall and startup_stall_recovery_attempt < startup_stall_recovery_limit:
                retry_guidance = [
                    *supplemental_guidance,
                    _build_startup_stall_recovery_guidance(trace_excerpt),
                ]
                prefer_same_model = (
                    no_edit_recovery_attempt > 0
                    and startup_stall_recovery_attempt < _MAX_STARTUP_STALL_RECOVERY_ATTEMPTS
                )
                recovery_model = model if prefer_same_model else _startup_stall_recovery_model(model)
                recovery_detail = (
                    f" using same model {recovery_model!r} because an earlier attempt made tool progress"
                    if prefer_same_model
                    else (
                        f" using fallback model {recovery_model!r}"
                        if recovery_model and recovery_model != model
                        else ""
                    )
                )
                log.warning(
                    "Codex emitted only startup events before the no-edit watchdog; "
                    f"restarting Codex{recovery_detail} before classifying the job terminally."
                )
                retry_model_override = model_override if prefer_same_model else recovery_model or model_override
                retry_result = _run_codex_task(
                    repo,
                    instruction,
                    retry_guidance,
                    wrapper_recovery_attempt=wrapper_recovery_attempt,
                    model_compatibility_recovery_attempt=model_compatibility_recovery_attempt,
                    startup_stall_recovery_attempt=startup_stall_recovery_attempt + 1,
                    no_edit_recovery_attempt=no_edit_recovery_attempt,
                    rollout_recovery_attempt=rollout_recovery_attempt,
                    model_override=retry_model_override,
                    baseline_changes=baseline_snapshot,
                    execution_deadline_monotonic=overall_deadline,
                )
                retry_result["usage"] = _merge_usage_records(usage, retry_result.get("usage"))
                if retry_result.get("ok"):
                    recovered_stdout = str(retry_result.get("stdout") or "").strip()
                    retry_result["stdout"] = _truncate(
                        (
                            "Recovered after the first Codex subprocess stalled before emitting "
                            f"assistant/tool progress.\n\n{recovered_stdout}"
                        ).strip()
                    )
                return retry_result
            if startup_stall:
                detail = (
                    "Codex subprocess started but did not emit assistant, tool, reasoning, "
                    "or usage progress before the startup watchdog."
                )
                if trace_excerpt:
                    detail = f"{detail}\n{trace_excerpt}"
                return {
                    "ok": False,
                    "summary": "openai_codex stalled before first response",
                    "stdout": _truncate(stdout),
                    "stderr": _truncate(f"{detail}\n{stderr}".strip()),
                    "exitCode": 124,
                    "usage": usage,
                    "cooldownMs": _NO_PUBLISHABLE_FAILURE_COOLDOWN_MS,
                }
            if no_edit_recovery_attempt < _MAX_NO_EDIT_RECOVERY_ATTEMPTS:
                retry_guidance = [
                    *supplemental_guidance,
                    _build_no_edit_recovery_guidance(
                        trace_excerpt,
                        no_edit_artifact_only_paths,
                        recovery_attempt=no_edit_recovery_attempt + 1,
                    ),
                ]
                return _run_codex_task(
                    repo,
                    instruction,
                    retry_guidance,
                    wrapper_recovery_attempt=wrapper_recovery_attempt,
                    model_compatibility_recovery_attempt=model_compatibility_recovery_attempt,
                    startup_stall_recovery_attempt=startup_stall_recovery_attempt,
                    no_edit_recovery_attempt=no_edit_recovery_attempt + 1,
                    rollout_recovery_attempt=rollout_recovery_attempt,
                    model_override=model_override,
                    baseline_changes=baseline_snapshot,
                    execution_deadline_monotonic=overall_deadline,
                )
            detail = "Codex spent too much of the execution budget without producing publishable file changes."
            if trace_excerpt:
                detail = f"{detail}\n{trace_excerpt}"
            return {
                "ok": False,
                "summary": "openai_codex made no publishable changes before the no-edit watchdog",
                "stdout": _truncate(stdout),
                "stderr": _truncate(f"{detail}\n{stderr}".strip()),
                "exitCode": 124,
                "usage": usage,
                "cooldownMs": _NO_PUBLISHABLE_FAILURE_COOLDOWN_MS,
            }

        if timed_out:
            detail = (
                f"codex exec timed out after {communicate_timeout_s}s"
                if communicate_timeout_s
                else "codex exec timed out"
            )
            if trace_excerpt:
                detail = f"{detail}\n{trace_excerpt}"
            changed_paths, _, effective_paths = _codex_changed_paths(
                repo,
                baseline_snapshot,
                clean_known_runtime_artifacts=True,
            )
            credible_partial_patch = _has_credible_shell_wrapper_progress(effective_paths)
            if effective_paths and credible_partial_patch:
                last_message = _read_text_if_exists(last_message_path)
                log_git_status(repo, log)
                prefix = (
                    "Codex reached the execution timeout after producing publishable file "
                    "changes. Returning the partial patch to QualityGate/ValidationGate "
                    "instead of discarding it; any incomplete edit will be caught by the "
                    "normal gates or revision loop."
                )
                return {
                    "ok": True,
                    "summary": (
                        f"openai_codex timed out after modifying {len(effective_paths)} "
                        "publishable file(s)"
                    ),
                    "stdout": _truncate(
                        _build_success_stdout(
                            effective_paths=effective_paths,
                            last_message=last_message,
                            trace_excerpt=trace_excerpt,
                            prefix=prefix,
                        )
                    ),
                    "stderr": _truncate(f"{detail}\n{stderr}".strip()),
                    "exitCode": 0,
                    "usage": usage,
                }
            if effective_paths:
                listed = _describe_publishable_paths(effective_paths)
                log.warning(
                    "Codex reached the execution timeout with a broad/noisy changed-path set "
                    f"({len(effective_paths)} publishable-looking path(s)); refusing to spend "
                    "additional gate budget on a likely incomplete patch."
                )
                detail = (
                    f"{detail}\nPublishable-looking changed paths at timeout were too broad/noisy "
                    f"to preserve as a partial patch ({len(effective_paths)} path(s): {listed}). "
                    "The executor is failing fast so the scheduler can replan instead of running "
                    "expensive validation on a likely incomplete update."
                )
                return {
                    "ok": False,
                    "summary": "openai_codex timed out with broad/noisy publishable-looking changes",
                    "stdout": _truncate(stdout),
                    "stderr": _truncate(f"{detail}\n{stderr}".strip()),
                    "exitCode": 124,
                    "usage": usage,
                    "cooldownMs": _NO_PUBLISHABLE_FAILURE_COOLDOWN_MS,
                }
            artifact_only_paths = _describe_non_publishable_paths(changed_paths, baseline_snapshot)
            if artifact_only_paths:
                detail = (
                    f"{detail}\nOnly non-publishable artifact paths changed before timeout: "
                    f"{artifact_only_paths}."
                )
            return {
                "ok": False,
                "summary": (
                    "openai_codex timed out without publishable changes"
                    if artifact_only_paths
                    else "openai_codex execution timed out"
                ),
                "stdout": _truncate(stdout),
                "stderr": _truncate(f"{detail}\n{stderr}".strip()),
                "exitCode": 124,
                "usage": usage,
                "cooldownMs": _NO_PUBLISHABLE_FAILURE_COOLDOWN_MS,
            }

        last_message = _read_text_if_exists(last_message_path)
        log_git_status(repo, log)

        if command_policy_rejection_loop:
            _, _, effective_paths = _codex_changed_paths(
                repo,
                baseline_snapshot,
                clean_known_runtime_artifacts=True,
            )
            credible_progress = _has_credible_shell_wrapper_progress(effective_paths)
            if effective_paths:
                policy_signal = _detect_codex_workaround_signal(last_message)
                if not policy_signal and not last_message.strip():
                    policy_signal = _detect_codex_workaround_signal(stdout)
                if policy_signal:
                    detail = (
                        "Codex CLI is mandatory in this backend, but worker output suggests a workaround "
                        f"instead of hard-failing: {policy_signal!r}. "
                        "Return an explicit failure if Codex auth/execution is unavailable."
                    )
                    if last_message:
                        detail = f"{detail}\nLast assistant message:\n{last_message}"
                    if trace_excerpt:
                        detail = f"{detail}\n{trace_excerpt}"
                    return {
                        "ok": False,
                        "summary": "openai_codex policy violation: Codex CLI workaround detected",
                        "stdout": _truncate(stdout),
                        "stderr": _truncate(detail),
                        "exitCode": 5,
                        "usage": usage,
                    }

            if effective_paths and credible_progress:
                command_lines = (
                    "\n".join(f"- {command}" for command in rejected_shell_wrappers[:6])
                    if rejected_shell_wrappers
                    else "- (no command details captured)"
                )
                log.warning(
                    "Codex hit a shell-wrapper rejection loop after producing file changes; "
                    "returning the patch to QualityGate instead of spending another Codex retry."
                )
                return {
                    "ok": True,
                    "summary": (
                        "Executed task and modified "
                        f"{len(effective_paths)} file(s) before shell-wrapper command rejections"
                    ),
                    "stdout": _build_success_stdout(
                        effective_paths=effective_paths,
                        last_message=last_message,
                        trace_excerpt=trace_excerpt,
                        prefix=(
                            "Codex produced file changes before hitting command-router shell-wrapper "
                            "rejections. The patch is being handed to ValidationGate/CriticGate for "
                            f"normal repair instead of restarting Codex.\nRejected commands:\n{command_lines}"
                        ),
                    ),
                    "stderr": "",
                    "exitCode": 0,
                    "usage": usage,
                }

            if effective_paths:
                log.warning(
                    "Codex hit a shell-wrapper rejection loop with a broad/noisy changed-path set "
                    f"({len(effective_paths)} publishable-looking path(s)); retrying before handing "
                    "the patch to QualityGate."
                )

            if wrapper_recovery_attempt < _MAX_WRAPPER_RECOVERY_ATTEMPTS:
                hard_recovery = wrapper_recovery_attempt >= 1
                recovery_thread_id = str(stdout_trace.get("thread_id") or "").strip()
                recovery_guidance = _build_wrapper_recovery_guidance(
                    rejected_shell_wrappers,
                    hard=hard_recovery,
                )
                if recovery_guidance:
                    bootstrap_context = (
                        _build_wrapper_bootstrap_context(repo, rejected_shell_wrappers)
                        if hard_recovery
                        else ""
                    )
                    log.warning(
                        "Codex hit a shell-wrapper rejection; recovering immediately with "
                        + (
                            "strict no-wrapper recovery guidance."
                            + (" Added direct-command context bootstrap." if bootstrap_context else "")
                            if hard_recovery
                            else "direct-command recovery guidance."
                        )
                        + (
                            " Resuming the preserved Codex thread."
                            if recovery_thread_id
                            else " Thread id unavailable; starting a compact fresh recovery."
                        )
                    )
                    retry_result = _run_codex_task(
                        repo,
                        instruction,
                        [
                            *effective_supplemental_guidance,
                            *( [bootstrap_context] if bootstrap_context else [] ),
                            recovery_guidance,
                        ],
                        wrapper_recovery_attempt=wrapper_recovery_attempt + 1,
                        model_compatibility_recovery_attempt=model_compatibility_recovery_attempt,
                        startup_stall_recovery_attempt=startup_stall_recovery_attempt,
                        no_edit_recovery_attempt=no_edit_recovery_attempt,
                        rollout_recovery_attempt=rollout_recovery_attempt,
                        model_override=model_override,
                        baseline_changes=baseline_snapshot,
                        execution_deadline_monotonic=overall_deadline,
                        resume_thread_id=recovery_thread_id or None,
                    )
                    retry_result["usage"] = _merge_usage_records(usage, retry_result.get("usage"))
                    if wrapper_recovery_attempt == 0 and retry_result.get("ok"):
                        recovered_stdout = str(retry_result.get("stdout") or "").strip()
                        retry_result["stdout"] = _truncate(
                            (
                                "Recovered after Codex attempts hit command-router shell-wrapper rejections.\n\n"
                                f"{recovered_stdout}"
                            ).strip()
                        )
                    elif wrapper_recovery_attempt == 0:
                        retry_stderr = str(retry_result.get("stderr") or "").strip()
                        retry_result["stderr"] = _truncate(
                            (
                                "Earlier Codex attempts hit command-router shell-wrapper rejections and were retried with stricter recovery guidance.\n\n"
                                f"{retry_stderr}"
                            ).strip()
                        )
                    return retry_result
            if effective_paths:
                command_lines = (
                    "\n".join(f"- {command}" for command in rejected_shell_wrappers[:6])
                    if rejected_shell_wrappers
                    else "- (no command details captured)"
                )
                log.warning(
                    "Codex exhausted shell-wrapper recovery attempts with file changes still present; "
                    "returning the patch to QualityGate for final assessment."
                )
                return {
                    "ok": True,
                    "summary": (
                        "Executed task and modified "
                        f"{len(effective_paths)} file(s) before shell-wrapper command rejections"
                    ),
                    "stdout": _build_success_stdout(
                        effective_paths=effective_paths,
                        last_message=last_message,
                        trace_excerpt=trace_excerpt,
                        prefix=(
                            "Codex produced file changes but exhausted command-router shell-wrapper "
                            "recovery attempts. The patch is being handed to ValidationGate/CriticGate for "
                            f"normal assessment.\nRejected commands:\n{command_lines}"
                        ),
                    ),
                    "stderr": "",
                    "exitCode": 0,
                    "usage": usage,
                }
            command_lines = (
                "\n".join(f"- {command}" for command in rejected_shell_wrappers[:6])
                if rejected_shell_wrappers
                else "- (no command details captured)"
            )
            detail = (
                f"{_command_router_rejection_detail_intro()}\n"
                f"Rejected commands:\n{command_lines}"
            )
            if last_message:
                detail = f"{detail}\nLast assistant message:\n{last_message}"
            if trace_excerpt:
                detail = f"{detail}\n{trace_excerpt}"
            return {
                "ok": False,
                "summary": "openai_codex command policy rejection loop",
                "stdout": _truncate(stdout),
                "stderr": _truncate(detail),
                "exitCode": 6,
                "usage": usage,
            }

        if _INTERRUPTED_SIGNAL is not None:
            return {
                "ok": False,
                "summary": f"openai_codex interrupted by signal {_INTERRUPTED_SIGNAL}",
                "stdout": _truncate(stdout),
                "stderr": _truncate(stderr),
                "exitCode": 128 + int(_INTERRUPTED_SIGNAL),
                "usage": usage,
            }

        if return_code is None:
            return {
                "ok": False,
                "summary": "openai_codex execution ended without a process return code",
                "stdout": _truncate(stdout),
                "stderr": _truncate(stderr),
                "exitCode": 1,
                "usage": usage,
            }

        exit_code = int(return_code)

        if exit_code != 0:
            if (
                model_compatibility_recovery_attempt < 1
                and model.strip().lower() == DEFAULT_CODEX_MODEL.lower()
                and LEGACY_CODEX_MODEL_FALLBACK.strip().lower() != DEFAULT_CODEX_MODEL.lower()
                and _requires_newer_codex_for_model(stdout, stderr)
            ):
                log.warning(
                    f"Codex CLI rejected default model {DEFAULT_CODEX_MODEL}; retrying once with "
                    f"{LEGACY_CODEX_MODEL_FALLBACK}. Upgrade Codex CLI to use {DEFAULT_CODEX_MODEL}."
                )
                retry_result = _run_codex_task(
                    repo,
                    instruction,
                    effective_supplemental_guidance,
                    wrapper_recovery_attempt=wrapper_recovery_attempt,
                    model_compatibility_recovery_attempt=model_compatibility_recovery_attempt + 1,
                    startup_stall_recovery_attempt=startup_stall_recovery_attempt,
                    no_edit_recovery_attempt=no_edit_recovery_attempt,
                    rollout_recovery_attempt=rollout_recovery_attempt,
                    model_override=LEGACY_CODEX_MODEL_FALLBACK,
                    baseline_changes=baseline_snapshot,
                    execution_deadline_monotonic=overall_deadline,
                )
                retry_result["usage"] = _merge_usage_records(usage, retry_result.get("usage"))
                if retry_result.get("ok"):
                    recovered_stdout = str(retry_result.get("stdout") or "").strip()
                    retry_result["stdout"] = _truncate(
                        (
                            f"Codex CLI rejected default model {DEFAULT_CODEX_MODEL} because it "
                            "requires a newer Codex version; recovered by retrying with "
                            f"{LEGACY_CODEX_MODEL_FALLBACK}.\n\n{recovered_stdout}"
                        ).strip()
                    )
                return retry_result
            detail = stderr.strip() or stdout.strip() or "codex exec exited with a non-zero status"
            if last_message:
                detail = f"{detail}\nLast assistant message:\n{last_message}"
            if trace_excerpt:
                detail = f"{detail}\n{trace_excerpt}"
            return {
                "ok": False,
                "summary": f"openai_codex execution failed (exit {exit_code})",
                "stdout": _truncate(stdout),
                "stderr": _truncate(detail),
                "exitCode": exit_code,
                "usage": usage,
            }

        policy_signal = _detect_codex_workaround_signal(last_message)
        if not policy_signal and not last_message.strip():
            # Fallback only when the CLI did not emit a final assistant message.
            policy_signal = _detect_codex_workaround_signal(stdout)
        if policy_signal:
            detail = (
                "Codex CLI is mandatory in this backend, but worker output suggests a workaround "
                f"instead of hard-failing: {policy_signal!r}. "
                "Return an explicit failure if Codex auth/execution is unavailable."
            )
            if last_message:
                detail = f"{detail}\nLast assistant message:\n{last_message}"
            if trace_excerpt:
                detail = f"{detail}\n{trace_excerpt}"
            return {
                "ok": False,
                "summary": "openai_codex policy violation: Codex CLI workaround detected",
                "stdout": _truncate(stdout),
                "stderr": _truncate(detail),
                "exitCode": 5,
                "usage": usage,
            }

        _, _, effective = _codex_changed_paths(
            repo,
            baseline_snapshot,
            clean_known_runtime_artifacts=True,
        )
        if effective:
            return {
                "ok": True,
                "summary": f"Executed task and modified {len(effective)} file(s)",
                "stdout": _build_success_stdout(
                    effective_paths=effective,
                    last_message=last_message,
                    trace_excerpt=trace_excerpt,
                ),
                "stderr": "",
                "exitCode": 0,
                "usage": usage,
            }

        return {
            "ok": True,
            "summary": "Executed task via openai_codex (no file changes detected)",
            "stdout": _build_success_stdout(
                effective_paths=[],
                last_message=last_message,
                trace_excerpt=trace_excerpt,
            ),
            "stderr": "",
            "exitCode": 0,
            "usage": usage,
        }


def main() -> int:
    try:
        task = parse_task_execute_payload(sys.argv, logger=log)
        result = _run_codex_task(
            task.repo,
            task.instruction,
            task.supplemental_guidance,
        )
    except Exception as exc:
        result = {
            "ok": False,
            "summary": "openai_codex wrapper crashed while executing task.execute",
            "stdout": "",
            "stderr": traceback.format_exc(),
            "exitCode": 1,
            "error": to_single_line(exc, 300),
        }

    emit(result)
    return 0 if bool(result.get("ok")) else to_int(result.get("exitCode"), 1)


if __name__ == "__main__":
    raise SystemExit(main())
