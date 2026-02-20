#!/usr/bin/env python3
"""PushPals OpenAI Codex backend wrapper.

Runs `codex exec` in non-interactive mode and emits one structured result line
that the TypeScript host parses.
"""

from __future__ import annotations

import json
import os
from shutil import which
import shlex
import signal
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional

_SHARED_DIR = Path(__file__).resolve().parents[1] / "shared"
if str(_SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(_SHARED_DIR))

from executor_base import (
    Logger,
    config_get,
    emit,
    log_git_status,
    looks_local_base_url,
    parse_task_execute_payload,
    resolve_llm_config,
    setting_str,
    summarize_git_changes,
    to_int,
    to_single_line,
)

LOG_PREFIX = "[OpenAICodexExecutor]"
DEFAULT_CODEX_MODEL = "gpt-5-codex"
_ACTIVE_CHILD: Optional[subprocess.Popen[str]] = None
_INTERRUPTED_SIGNAL: Optional[int] = None
log = Logger(LOG_PREFIX)

_VALID_APPROVAL_POLICIES = {"untrusted", "on-failure", "on-request", "never"}
_VALID_SANDBOX_POLICIES = {"read-only", "workspace-write", "danger-full-access"}
_VALID_COLORS = {"always", "never", "auto"}
_VALID_AUTH_MODES = {"auto", "api_key", "chatgpt"}
_VALID_REASONING_EFFORTS = {"low", "medium", "high"}


def _env_first_non_empty(*names: str) -> str:
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def shutil_which(binary: str) -> str:
    return which(binary) or ""


def _truncate(text: str, max_chars: int = 4000) -> str:
    value = str(text or "")
    if len(value) <= max_chars:
        return value
    return value[: max(1, max_chars - 15)] + "\n...[truncated]"


def _to_positive_int(raw: str) -> Optional[int]:
    try:
        parsed = int(raw)
    except Exception:
        return None
    return parsed if parsed > 0 else None


def _config_str(path: str, default: str = "") -> str:
    cfg = config_get(path, default)
    if cfg is None:
        return default
    if isinstance(cfg, str):
        trimmed = cfg.strip()
        return trimmed if trimmed else default
    return str(cfg).strip() or default


def _config_int(path: str, default: int) -> int:
    return to_int(config_get(path, default), default)


def _config_bool(path: str, default: bool) -> bool:
    cfg = config_get(path, default)
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


def _is_git_repo(repo: str) -> bool:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if proc.returncode != 0:
            return False
        return (proc.stdout or "").strip().lower() == "true"
    except Exception:
        return False


def _resolve_codex_command_prefix() -> List[str]:
    override_json = _env_first_non_empty("PUSHPALS_OPENAI_CODEX_BIN_JSON")
    if override_json:
        try:
            parsed = json.loads(override_json)
            if isinstance(parsed, list):
                parts = [str(p).strip() for p in parsed if str(p).strip()]
                if parts:
                    return parts
        except Exception:
            log.info(
                "Invalid PUSHPALS_OPENAI_CODEX_BIN_JSON; expected JSON array of command segments."
            )

    override = _env_first_non_empty("PUSHPALS_OPENAI_CODEX_BIN")
    if not override:
        override = setting_str("PUSHPALS_OPENAI_CODEX_BIN", "workerpals.llm.codex_bin", "")
    if not override:
        override = setting_str("PUSHPALS_OPENAI_CODEX_BIN", "workerpals.openai_codex.bin", "")
    if override:
        try:
            parts = [p for p in shlex.split(override) if p.strip()]
        except Exception:
            log.info(
                "Invalid PUSHPALS_OPENAI_CODEX_BIN value; expected a command string parseable by shlex."
            )
            return []
        return parts

    # Prefer bunx to avoid requiring a separate node runtime in the container.
    if shutil_which("bunx"):
        return ["bunx", "--yes", "@openai/codex"]
    if shutil_which("codex"):
        return ["codex"]
    return []


def _resolve_communicate_timeout_seconds() -> Optional[int]:
    explicit_s_raw = _config_str("workerpals.openai_codex.timeout_s", "")
    explicit_s = _to_positive_int(explicit_s_raw)
    if explicit_s is not None:
        return explicit_s
    timeout_ms = _config_int("workerpals.llm.codex_timeout_ms", 0)
    if timeout_ms <= 0:
        timeout_ms = _config_int("workerpals.openai_codex.timeout_ms", 0)
    if timeout_ms <= 0:
        return None
    return max(1, timeout_ms // 1000)


def _resolve_reasoning_effort() -> str:
    raw = _config_str("workerpals.llm.reasoning_effort", "")
    if not raw:
        raw = _config_str("workerpals.openai_codex.reasoning_effort", "high")
    normalized = str(raw).strip().lower()
    if normalized in _VALID_REASONING_EFFORTS:
        return normalized
    log.info(
        "Invalid workerpals.openai_codex.reasoning_effort="
        f"{raw!r}; using default 'high'. Allowed: low, medium, high."
    )
    return "high"


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


def _log_stdout(stdout: str, use_json: bool) -> None:
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    if not lines:
        return
    if use_json:
        valid = 0
        invalid = 0
        for line in lines:
            try:
                json.loads(line)
                valid += 1
            except Exception:
                invalid += 1
        log.info(
            f"Codex JSON stream captured ({len(lines)} line(s), valid_json={valid}, invalid={invalid}); "
            "suppressing per-line event logs."
        )
        for line in lines[:8]:
            log.debug(line)
        if len(lines) > 8:
            log.debug(f"... {len(lines) - 8} more JSON line(s) omitted.")
        return

    max_lines = 40
    for line in lines[:max_lines]:
        log.info(line)
    if len(lines) > max_lines:
        log.info(f"... {len(lines) - max_lines} additional stdout line(s) omitted.")


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


def _build_instruction(instruction: str, supplemental_guidance: List[str]) -> str:
    if not supplemental_guidance:
        return instruction
    lines = [instruction, "", "Supplemental execution guidance (do not change canonical user intent):"]
    lines.extend(str(item).strip() for item in supplemental_guidance if str(item).strip())
    return "\n".join(lines).strip()


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

    codex_cmd_prefix = _resolve_codex_command_prefix()
    if not codex_cmd_prefix:
        return {
            "ok": False,
            "summary": "openai_codex CLI is not installed",
            "stderr": (
                "Could not find a runnable Codex command. "
                "Expected one of: `bunx --yes @openai/codex` or `codex` in PATH. "
                "You can also set PUSHPALS_OPENAI_CODEX_BIN explicitly."
            ),
            "exitCode": 3,
        }

    configured_model, api_key, base_url = resolve_llm_config(DEFAULT_CODEX_MODEL, logger=log)
    auth_mode_raw = _env_first_non_empty("PUSHPALS_OPENAI_CODEX_AUTH_MODE")
    if not auth_mode_raw:
        auth_mode_raw = setting_str(
            "PUSHPALS_OPENAI_CODEX_AUTH_MODE",
            "workerpals.llm.codex_auth_mode",
            "",
        )
    if not auth_mode_raw:
        auth_mode_raw = setting_str(
            "PUSHPALS_OPENAI_CODEX_AUTH_MODE",
            "workerpals.openai_codex.auth_mode",
            "auto",
        )
    auth_mode_configured = _normalize_auth_mode(auth_mode_raw)
    model = _safe_model_for_codex(configured_model, base_url)
    approval = _normalize_choice(
        _config_str("workerpals.openai_codex.approval_policy", "never"),
        _VALID_APPROVAL_POLICIES,
        "never",
        env_name="workerpals.openai_codex.approval_policy",
    )
    sandbox = _normalize_choice(
        _config_str("workerpals.openai_codex.sandbox", "workspace-write"),
        _VALID_SANDBOX_POLICIES,
        "workspace-write",
        env_name="workerpals.openai_codex.sandbox",
    )
    color = _normalize_choice(
        _config_str("workerpals.openai_codex.color", "never"),
        _VALID_COLORS,
        "never",
        env_name="workerpals.openai_codex.color",
    )
    # JSON event output is noisy by default; prefer plain text + output-last-message.
    use_json = _config_bool("workerpals.openai_codex.json", False)
    reasoning_effort = _resolve_reasoning_effort()
    communicate_timeout_s = _resolve_communicate_timeout_seconds()
    prompt = _build_instruction(instruction, supplemental_guidance)
    baseline_changes = summarize_git_changes(repo)

    with tempfile.TemporaryDirectory(prefix="pushpals-codex-") as tmp_dir:
        last_message_path = Path(tmp_dir) / "codex-last-message.txt"
        cmd: List[str] = [
            *codex_cmd_prefix,
            "-c",
            f'model_reasoning_effort="{reasoning_effort}"',
            "-a",
            approval,
            "-s",
            sandbox,
            "exec",
            "--color",
            color,
            "--output-last-message",
            str(last_message_path),
        ]
        if use_json:
            cmd.append("--json")
        if model:
            cmd.extend(["-m", model])
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
        override_base = _env_first_non_empty(
            "PUSHPALS_OPENAI_CODEX_BASE_URL"
        )
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
            login_status = _run_codex_login_status(codex_cmd_prefix, repo, env)
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
        try:
            if communicate_timeout_s:
                stdout, stderr = proc.communicate(prompt, timeout=communicate_timeout_s)
            else:
                stdout, stderr = proc.communicate(prompt)
        except subprocess.TimeoutExpired as exc:
            _terminate_active_child()
            _ACTIVE_CHILD = None
            stdout = str(exc.stdout or "")
            stderr = str(exc.stderr or "")
            detail = (
                f"codex exec timed out after {communicate_timeout_s}s"
                if communicate_timeout_s
                else "codex exec timed out"
            )
            return {
                "ok": False,
                "summary": "openai_codex execution timed out",
                "stdout": _truncate(stdout),
                "stderr": _truncate(f"{detail}\n{stderr}".strip()),
                "exitCode": 124,
            }

        return_code = proc.returncode
        _ACTIVE_CHILD = None

        stdout = stdout or ""
        stderr = stderr or ""
        _log_stdout(stdout, use_json)
        _log_stderr(stderr)

        last_message = _read_text_if_exists(last_message_path)
        log_git_status(repo, log)

        if _INTERRUPTED_SIGNAL is not None:
            return {
                "ok": False,
                "summary": f"openai_codex interrupted by signal {_INTERRUPTED_SIGNAL}",
                "stdout": _truncate(stdout),
                "stderr": _truncate(stderr),
                "exitCode": 128 + int(_INTERRUPTED_SIGNAL),
            }

        if return_code is None:
            return {
                "ok": False,
                "summary": "openai_codex execution ended without a process return code",
                "stdout": _truncate(stdout),
                "stderr": _truncate(stderr),
                "exitCode": 1,
            }

        exit_code = int(return_code)

        if exit_code != 0:
            detail = stderr.strip() or stdout.strip() or "codex exec exited with a non-zero status"
            if last_message:
                detail = f"{detail}\nLast assistant message:\n{last_message}"
            return {
                "ok": False,
                "summary": f"openai_codex execution failed (exit {exit_code})",
                "stdout": _truncate(stdout),
                "stderr": _truncate(detail),
                "exitCode": exit_code,
            }

        changed_paths = summarize_git_changes(repo)
        delta = [p for p in changed_paths if p not in baseline_changes]
        effective = delta if delta else changed_paths
        stdout_parts: List[str] = []
        if last_message:
            stdout_parts.append(last_message)
        if effective:
            listed = "\n".join(f"- {path}" for path in effective[:40])
            if len(effective) > 40:
                listed += "\n- ..."
            stdout_parts.append(f"Changed files:\n{listed}")
            return {
                "ok": True,
                "summary": f"Executed task and modified {len(effective)} file(s)",
                "stdout": "\n\n".join(stdout_parts),
                "stderr": "",
                "exitCode": 0,
            }

        if not stdout_parts:
            stdout_parts.append("No modified files were detected after execution.")
        return {
            "ok": True,
            "summary": "Executed task via openai_codex (no file changes detected)",
            "stdout": "\n\n".join(stdout_parts),
            "stderr": "",
            "exitCode": 0,
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
