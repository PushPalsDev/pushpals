#!/usr/bin/env python3
"""PushPals OpenHands executor wrapper.

Minimal wrapper contract:
- decode payload via executor_base
- run OpenHands SDK task.execute flow
- emit one structured result line
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_SHARED_DIR = Path(__file__).resolve().parents[1] / "shared"
if str(_SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(_SHARED_DIR))

from executor_base import (
    Logger,
    emit,
    is_no_tool_calls_error,
    is_truthy_env,
    log_git_status,
    looks_local_base_url,
    parse_task_execute_payload,
    repo_root_for_runtime_config,
    resolve_llm_config,
    setting_int,
    setting_str,
    summarize_git_changes,
    to_int,
    to_single_line,
)

LOG_PREFIX = "[OpenHandsExecutor]"
log = Logger(LOG_PREFIX)
DEFAULT_OPENHANDS_MODEL = "local-model"
PROMPT_TOKEN_REGEX = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")
GLOB_META_REGEX = re.compile(r"[*?\[\]{}()!]")
_PROMPT_TEMPLATE_CACHE: Dict[str, str] = {}


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
    override = setting_str("WORKERPALS_LLM_SESSION_ID", "workerpals.llm.session_id", "")
    if override:
        return _safe_session_component(override, "pushpals-worker")

    session_id = _safe_session_component(setting_str("PUSHPALS_SESSION_ID", "session_id", ""), "session")
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


def _repo_root_for_prompt_loading() -> Path:
    return repo_root_for_runtime_config()


def _resolve_prompt_file(relative_path: str) -> Path:
    return _repo_root_for_prompt_loading() / "prompts" / relative_path


def _load_prompt_template(relative_path: str, replacements: Optional[Dict[str, str]] = None) -> str:
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


def _resolve_agent_prompt_overrides(base_url: str) -> Dict[str, Any]:
    profile = setting_str(
        "WORKERPALS_OPENHANDS_PROMPT_PROFILE",
        "workerpals.openhands.prompt_profile",
        "minimal" if looks_local_base_url(base_url) else "default",
    ).lower()
    if profile not in {"minimal", "compact", "small"}:
        return {}

    overrides: Dict[str, Any] = {}
    system_prompt = _resolve_prompt_file("workerpals/openhands_minimal_system_prompt.j2")
    security_prompt = _resolve_prompt_file("workerpals/openhands_minimal_security_policy.j2")
    if system_prompt.exists():
        overrides["system_prompt_filename"] = str(system_prompt)
    if security_prompt.exists():
        overrides["security_policy_filename"] = str(security_prompt)
    return overrides


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


def _resolve_mcp_config() -> Tuple[Optional[Dict[str, Any]], List[str]]:
    notes: List[str] = []
    config: Optional[Dict[str, Any]] = None

    raw = setting_str("WORKERPALS_OPENHANDS_MCP_CONFIG_JSON", "workerpals.openhands.mcp_config_json", "")
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                config = parsed
            else:
                notes.append(f"{LOG_PREFIX} Ignoring MCP config: expected JSON object.")
        except Exception as exc:
            notes.append(f"{LOG_PREFIX} Ignoring MCP config JSON: {exc}")

    if not is_truthy_env("WORKERPALS_OPENHANDS_ENABLE_WEB_MCP", False, "workerpals.openhands.enable_web_mcp"):
        return config, notes

    web_url = setting_str("WORKERPALS_OPENHANDS_WEB_MCP_URL", "workerpals.openhands.web_mcp_url", "")
    if not web_url:
        notes.append(f"{LOG_PREFIX} Web MCP enabled but URL is empty; skipping.")
        return config, notes

    server_name = setting_str(
        "WORKERPALS_OPENHANDS_WEB_MCP_NAME",
        "workerpals.openhands.web_mcp_name",
        "web-search",
    )
    transport = setting_str(
        "WORKERPALS_OPENHANDS_WEB_MCP_TRANSPORT",
        "workerpals.openhands.web_mcp_transport",
        "streamable-http",
    ).lower().replace("streamable_http", "streamable-http")
    if transport not in {"http", "streamable-http", "sse"}:
        transport = "streamable-http"

    headers, headers_error = _json_object_from_env("WORKERPALS_OPENHANDS_WEB_MCP_HEADERS_JSON")
    if headers_error:
        notes.append(f"{LOG_PREFIX} Ignoring MCP headers JSON: {headers_error}")
        headers = None

    auth_token = (os.environ.get("WORKERPALS_OPENHANDS_WEB_MCP_AUTH_TOKEN") or "").strip()
    timeout_sec = setting_int(
        "WORKERPALS_OPENHANDS_WEB_MCP_TIMEOUT_SEC",
        "workerpals.openhands.web_mcp_timeout_sec",
        0,
    )

    server_config: Dict[str, Any] = {"url": web_url, "transport": transport}
    if headers:
        server_config["headers"] = {
            str(k): str(v)
            for k, v in headers.items()
            if isinstance(k, str) and isinstance(v, (str, int, float, bool))
        }
    if auth_token:
        server_config["auth"] = auth_token
    if timeout_sec > 0:
        server_config["timeout"] = timeout_sec

    if config is None:
        config = {"mcpServers": {}}
    if not isinstance(config.get("mcpServers"), dict):
        config["mcpServers"] = {}
    config["mcpServers"][server_name] = server_config
    notes.append(f"{LOG_PREFIX} Web MCP enabled: {server_name} -> {web_url} ({transport})")
    return config, notes


def _browser_tool_enabled() -> bool:
    return is_truthy_env(
        "WORKERPALS_OPENHANDS_ENABLE_BROWSER_TOOL",
        False,
        "workerpals.openhands.enable_browser_tool",
    )


def _build_user_message(instruction: str, timeout_ms: int) -> str:
    timeout_minutes = max(1, round(timeout_ms / 60000))
    timeout_note = (
        f"Time limit: about {timeout_minutes} minute(s) for this task. "
        "If you cannot finish in time, stop and provide a concise status of what you checked, "
        "what remains, and the blocker."
    )

    mode = setting_str(
        "WORKERPALS_OPENHANDS_TASK_PROMPT_MODE",
        "workerpals.openhands.task_prompt_mode",
        "none",
    ).lower()
    if mode in {"none", "off", "instruction_only", "instruction-only", "minimal"}:
        return f"{instruction}\n\n{timeout_note}"

    try:
        system_prompt = _load_prompt_template("workerpals/openhands_task_execute_system_prompt.md").strip()
    except Exception:
        system_prompt = "You are PushPals WorkerPal. Complete the task with minimal correct changes."
    return f"{system_prompt}\n\nTask:\n{instruction}\n\n{timeout_note}"


def _build_strict_tool_use_message() -> str:
    return (
        "CRITICAL: You must use tools to make progress. "
        "Use TerminalTool and FileEditorTool to inspect and modify files, then run one focused validation command."
    )


def _normalize_repo_relative_path(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    path = value.strip().replace("\\", "/")
    if not path:
        return None
    if path == "/repo" or path == "/workspace":
        return "."
    if path.startswith("/repo/"):
        path = path[len("/repo/") :]
    elif path.startswith("/workspace/"):
        path = path[len("/workspace/") :]
    elif path.startswith("/"):
        return None
    if re.match(r"^[A-Za-z]:[\\/]", path):
        return None
    while path.startswith("./"):
        path = path[2:]
    path = re.sub(r"/+", "/", path).strip("/")
    if not path:
        return None
    segments = path.split("/")
    out: List[str] = []
    for segment in segments:
        segment = segment.strip()
        if not segment or segment == ".":
            continue
        if segment == "..":
            return None
        out.append(segment)
    if not out:
        return None
    return "/".join(out)


def _add_literal_path(values: List[str], seen: set[str], raw: Any) -> None:
    normalized = _normalize_repo_relative_path(raw)
    if not normalized or normalized == ".":
        return
    if GLOB_META_REGEX.search(normalized):
        return
    key = normalized.lower()
    if key in seen:
        return
    seen.add(key)
    values.append(normalized)


def _extract_target_paths(payload: Optional[Dict[str, Any]]) -> List[str]:
    out: List[str] = []
    seen: set[str] = set()
    if not isinstance(payload, dict):
        return out
    params = payload.get("params")
    if not isinstance(params, dict):
        return out

    _add_literal_path(out, seen, params.get("targetPath"))
    _add_literal_path(out, seen, params.get("path"))
    paths = params.get("paths")
    if isinstance(paths, list):
        for entry in paths:
            _add_literal_path(out, seen, entry)
            if len(out) >= 8:
                return out

    planning = params.get("planning")
    if not isinstance(planning, dict):
        return out
    target_paths = planning.get("targetPaths")
    if isinstance(target_paths, list):
        for entry in target_paths:
            _add_literal_path(out, seen, entry)
            if len(out) >= 8:
                return out
    scope = planning.get("scope")
    if isinstance(scope, dict):
        write_globs = scope.get("writeGlobs")
        if isinstance(write_globs, list):
            for entry in write_globs:
                _add_literal_path(out, seen, entry)
                if len(out) >= 8:
                    return out
    return out


def _build_path_handling_message(target_paths: List[str], repo: str) -> str:
    if not target_paths:
        return ""
    rel_paths = target_paths[:8]
    listed_rel = "\n".join(f"- {path}" for path in rel_paths)
    repo_root = str(Path(repo).resolve()).replace("\\", "/").rstrip("/")
    abs_paths = [f"{repo_root}/{path}" for path in rel_paths]
    listed_abs = "\n".join(f"- {path}" for path in abs_paths)
    return (
        "Path handling requirements:\n"
        "- The current working directory is the repository root.\n"
        "- Prefer the repo-relative paths for shell commands.\n"
        "- If FileEditor rejects a repo-relative path, retry with the matching absolute path.\n"
        "- Do not run broad filesystem scans when concrete target paths are listed.\n"
        "Concrete target paths (repo-relative):\n"
        f"{listed_rel}\n"
        "Concrete target paths (absolute):\n"
        f"{listed_abs}"
    )


def _run_openhands_task(
    repo: str,
    instruction: str,
    payload: Optional[Dict[str, Any]] = None,
    supplemental_guidance: Optional[List[str]] = None,
) -> Dict[str, Any]:
    try:
        from openhands.sdk import Agent, Conversation, LLM, Tool
        from openhands.tools.file_editor import FileEditorTool
        from openhands.tools.terminal import TerminalTool
    except Exception as exc:
        return {
            "ok": False,
            "summary": "OpenHands SDK is not installed. Install with: pip install openhands-ai",
            "stderr": str(exc),
            "exitCode": 3,
        }

    model, api_key, base_url = resolve_llm_config(
        default_model=DEFAULT_OPENHANDS_MODEL,
        logger=log,
    )
    if not model:
        return {
            "ok": False,
            "summary": "task.execute requires an LLM model. Set WORKERPALS_LLM_MODEL.",
            "stderr": "",
            "exitCode": 2,
        }

    if not api_key:
        if looks_local_base_url(base_url):
            api_key = "local"
        else:
            return {
                "ok": False,
                "summary": "task.execute requires an API key. Set WORKERPALS_LLM_API_KEY.",
                "stderr": "",
                "exitCode": 2,
            }

    llm_kwargs: Dict[str, Any] = {
        "model": model,
        "api_key": api_key,
    }
    if base_url:
        llm_kwargs["base_url"] = base_url

    session_user = _stable_llm_session_user(payload)
    if session_user:
        llm_kwargs["litellm_extra_body"] = {
            "user": session_user,
            "session_id": session_user,
            "conversation_id": session_user,
        }
        llm_kwargs["extra_headers"] = _session_hint_headers(session_user)

    max_steps = max(
        1,
        setting_int(
            "WORKERPALS_OPENHANDS_AGENT_MAX_STEPS",
            "workerpals.openhands.agent_max_steps",
            30,
        ),
    )
    timeout_ms = to_int((payload or {}).get("timeoutMs"), 0)
    if timeout_ms <= 0:
        timeout_ms = max(
            10_000,
            setting_int("WORKERPALS_OPENHANDS_TIMEOUT_MS", "workerpals.openhands_timeout_ms", 300_000),
        )

    mcp_config, mcp_notes = _resolve_mcp_config()
    for note in mcp_notes:
        log.info(note.removeprefix(f"{LOG_PREFIX} ").strip())

    tools = [Tool(name=TerminalTool.name), Tool(name=FileEditorTool.name)]
    if _browser_tool_enabled():
        try:
            from openhands.tools.browser_use import BrowserToolSet

            tools.append(Tool(name=BrowserToolSet.name))
            log.info("BrowserToolSet enabled.")
        except Exception as exc:
            log.info(f"Browser tooling unavailable: {to_single_line(exc, 300)}")

    try:
        llm = LLM(**llm_kwargs)

        agent_kwargs: Dict[str, Any] = {"llm": llm, "tools": tools}
        agent_kwargs.update(_resolve_agent_prompt_overrides(base_url))
        if mcp_config:
            agent_kwargs["mcp_config"] = mcp_config

        try:
            agent = Agent(**agent_kwargs)
        except TypeError:
            # Older SDKs may not support prompt overrides/mcp_config.
            agent = Agent(llm=llm, tools=tools)

        conversation = Conversation(agent=agent, workspace=repo)
        log.debug(f"Instruction: {to_single_line(instruction, 300)}")
        conversation.send_message(_build_user_message(instruction, timeout_ms))
        path_handling = _build_path_handling_message(_extract_target_paths(payload), repo)
        if path_handling:
            conversation.send_message(path_handling)
        if supplemental_guidance:
            for guidance in supplemental_guidance:
                trimmed = str(guidance or "").strip()
                if trimmed:
                    conversation.send_message(
                        "Supplemental execution guidance (do not change canonical user intent):\n" + trimmed
                    )

        try:
            conversation.run(max_steps=max_steps)
        except TypeError:
            conversation.run()
        except Exception as run_exc:
            if is_no_tool_calls_error(run_exc):
                # One strict nudge before surfacing failure.
                conversation.send_message(_build_strict_tool_use_message())
                try:
                    conversation.run(max_steps=max_steps)
                except TypeError:
                    conversation.run()
                except Exception:
                    raise run_exc
            else:
                raise

        log.debug("Agent execution completed.")
        # Log conversation events if the SDK exposes them
        try:
            events = getattr(conversation, "events", None) or getattr(conversation, "get_events", lambda: None)()
            if events:
                log.debug(f"Conversation events ({len(events)}):")
                for i, event in enumerate(events[:30], 1):
                    if isinstance(event, dict):
                        action = event.get("action") or event.get("type") or "unknown"
                        args = event.get("args") or {}
                        path = args.get("path") or args.get("command") or ""
                        log.debug(f"  Event {i}: {action} {to_single_line(str(path), 120)}")
                    else:
                        log.debug(f"  Event {i}: {to_single_line(str(event), 150)}")
        except Exception:
            pass
        log_git_status(repo, log)

    except Exception as exc:
        if is_no_tool_calls_error(exc):
            return {
                "ok": False,
                "summary": "OpenHands could not execute: model did not emit tool calls/actions",
                "stderr": (
                    "Agentic execution requires a tool-capable model/runtime. "
                    "The agent did not produce tool calls/actions.\n"
                    f"Error: {to_single_line(exc, 700)}"
                ),
                "exitCode": 3,
            }
        return {
            "ok": False,
            "summary": "OpenHands task execution failed",
            "stderr": str(exc),
            "exitCode": 1,
        }

    changed_paths = summarize_git_changes(repo)
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
        "summary": "Executed task via OpenHands (no file changes detected)",
        "stdout": "No modified files were detected after execution.",
        "stderr": "",
        "exitCode": 0,
    }


def main() -> int:
    task = parse_task_execute_payload(sys.argv, logger=log)
    result = _run_openhands_task(task.repo, task.instruction, task.payload, task.supplemental_guidance)
    emit(result)
    return 0 if bool(result.get("ok")) else to_int(result.get("exitCode"), 1)


if __name__ == "__main__":
    raise SystemExit(main())
