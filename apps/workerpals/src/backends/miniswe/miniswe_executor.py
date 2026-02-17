#!/usr/bin/env python3
"""
PushPals -> mini-swe-agent worker wrapper.

This script receives a base64-encoded JSON payload from the TS worker,
executes the requested task through the mini-swe-agent Python SDK, and prints
one structured result line:

  __PUSHPALS_OH_RESULT__ {"ok":true,...}

The sentinel prefix is intentionally the same as the OpenHands wrapper so that
the TypeScript host can parse results with a single code path.

Production hardening:
- Detect the common failure mode where the model never emits tool calls
  ("No tool calls found", etc.) and retry once with a strict tool-usage hint.
- If the model still cannot tool-call, return a structured failure that makes
  the root cause obvious to the TS layer (so you can alert / route / fallback).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# Shared executor infrastructure lives in src/backends/shared.
_SHARED_DIR = Path(__file__).resolve().parents[1] / "shared"
if str(_SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(_SHARED_DIR))

from executor_base import (
    config_get,
    emit,
    executor_log,
    is_no_tool_calls_error,
    log_agent_messages,
    log_git_status,
    looks_local_base_url,
    parse_task_execute_payload,
    resolve_llm_config,
    setting_int,
    setting_str,
    summarize_git_changes,
    to_int,
    to_single_line,
    DEFAULT_TOOLCALL_RETRY_MAX,
)


# ─── Constants ───────────────────────────────────────────────────────────────

DEFAULT_MINISWE_MODEL = "local-model"
LOG_PREFIX = "[MiniSweExecutor]"


# ─── Mini-swe-specific config ───────────────────────────────────────────────

def _execution_timeout_ms() -> int:
    raw = setting_str("WORKERPALS_MINISWE_TIMEOUT_MS", "workerpals.miniswe_timeout_ms", "")
    default_ms = 1800000
    if not raw:
        return default_ms
    try:
        parsed = int(raw)
    except Exception:
        return default_ms
    return max(10000, parsed)


def _toolcall_retry_max() -> int:
    raw = (os.environ.get("WORKERPALS_MINISWE_TOOLCALL_RETRY_MAX") or "").strip()
    if raw:
        return max(0, min(3, to_int(raw, DEFAULT_TOOLCALL_RETRY_MAX)))
    cfg = config_get("workerpals.miniswe_toolcall_retry_max", None)
    if cfg is None:
        return DEFAULT_TOOLCALL_RETRY_MAX
    return max(0, min(3, to_int(cfg, DEFAULT_TOOLCALL_RETRY_MAX)))


def _build_strict_tool_use_guidance(repo: str) -> str:
    return (
        "CRITICAL: You must use tools to make progress.\n"
        "- Use the environment's tools (file read/list/search, and file edit/write/patch) to inspect and modify the repo.\n"
        "- Do NOT only describe what you would do; actually do it.\n"
        "- Avoid broad scans; choose one target file quickly.\n"
        "- After making edits, run a narrow validation command if available (tests/lint) and then finish.\n"
        f"- Repo root: {repo}\n"
    )


# ─── mini-swe-agent execution ───────────────────────────────────────────────

def _run_miniswe_task(
    repo: str,
    instruction: str,
    payload: Optional[Dict[str, Any]] = None,
    supplemental_guidance: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Execute a task using mini-swe-agent's Python SDK."""

    try:
        from minisweagent.agents.default import DefaultAgent
        from minisweagent.models.litellm_model import LitellmModel
        from minisweagent.environments.local import LocalEnvironment
    except ImportError as exc:
        return {
            "ok": False,
            "summary": (
                "mini-swe-agent is not installed. "
                "Install with: pip install mini-swe-agent"
            ),
            "stderr": str(exc),
            "exitCode": 3,
        }

    model_name, api_key, base_url = resolve_llm_config(
        default_model=DEFAULT_MINISWE_MODEL, log_prefix=LOG_PREFIX,
    )
    if not model_name:
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
        if looks_local_base_url(base_url):
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

    timeout_ms = _execution_timeout_ms()
    timeout_minutes = max(1, round(timeout_ms / 60000))

    def _compose_instruction(extra_guidance: Optional[List[str]] = None) -> str:
        full = instruction
        merged_guidance: List[str] = []
        if supplemental_guidance:
            merged_guidance.extend([g for g in supplemental_guidance if g and str(g).strip()])
        if extra_guidance:
            merged_guidance.extend([g for g in extra_guidance if g and str(g).strip()])
        if merged_guidance:
            parts = [str(g).strip() for g in merged_guidance if str(g).strip()]
            if parts:
                full += "\n\n--- Supplemental execution guidance ---\n" + "\n\n".join(parts)

        full += (
            f"\n\nTime limit: about {timeout_minutes} minute(s) for this task. "
            "If you cannot finish in time, stop and provide a concise status of what you checked, "
            "what remains, and the blocker."
        )
        return full

    executor_log(f"{LOG_PREFIX} Starting mini-swe-agent execution in {repo}")
    executor_log(f"{LOG_PREFIX} Model: {model_name}, base_url: {base_url or '(default)'}")
    executor_log(f"{LOG_PREFIX} Timeout: {timeout_ms}ms ({timeout_minutes}min)")
    executor_log(f"{LOG_PREFIX} Instruction: {to_single_line(instruction, 300)}")

    # Pre-run baseline so we can tell whether *anything* changed even if the model/tooling is flaky.
    baseline_changes = set(summarize_git_changes(repo))

    try:
        import yaml
        from minisweagent import package_dir

        litellm_kwargs: Dict[str, Any] = {}
        if api_key:
            litellm_kwargs["api_key"] = api_key
        if base_url:
            litellm_kwargs["base_url"] = base_url

        model = LitellmModel(
            model_name=model_name,
            model_kwargs=litellm_kwargs,
            cost_tracking="ignore_errors",
        )

        env = LocalEnvironment(cwd=repo)

        config_path = package_dir / "config" / "default.yaml"
        with open(config_path, "r", encoding="utf-8") as f:
            builtin_config = yaml.safe_load(f)
        agent_kwargs = builtin_config.get("agent", {})

        agent_kwargs["cost_limit"] = 0.0  # we manage budget externally
        agent_kwargs["step_limit"] = setting_int(
            "WORKERPALS_OPENHANDS_AGENT_MAX_STEPS",
            "workerpals.openhands.agent_max_steps",
            30,
        )

        agent = DefaultAgent(model, env, **agent_kwargs)
        executor_log(f"{LOG_PREFIX} Agent initialized, running task...")

        toolcall_retry_max = _toolcall_retry_max()
        attempt = 0
        last_exc: Optional[Exception] = None

        while True:
            try:
                attempt += 1
                if attempt > 1:
                    executor_log(
                        f"{LOG_PREFIX} Retrying agent run after tool-call failure (attempt {attempt}/{toolcall_retry_max + 1})."
                    )

                extra_guidance: List[str] = []
                if attempt > 1:
                    extra_guidance.append(_build_strict_tool_use_guidance(repo))
                    extra_guidance.append(
                        "If you previously failed because you did not emit tool calls: "
                        "you must now call tools immediately (read target files, then edit)."
                    )

                exit_info = agent.run(_compose_instruction(extra_guidance=extra_guidance))
                executor_log(f"{LOG_PREFIX} Agent execution completed.")

                # Log what the agent did
                if hasattr(agent, "messages") and agent.messages:
                    executor_log(f"{LOG_PREFIX} Agent message history ({len(agent.messages)} messages):")
                    log_agent_messages(agent.messages, LOG_PREFIX)
                log_git_status(repo, LOG_PREFIX)
                last_exc = None
                break

            except Exception as exc:
                last_exc = exc
                if is_no_tool_calls_error(exc) and (attempt - 1) < toolcall_retry_max:
                    executor_log(
                        f"{LOG_PREFIX} Detected tool-call failure from model/runtime: "
                        f"{to_single_line(exc, 220)}"
                    )
                    continue
                raise

    except Exception as exc:
        if is_no_tool_calls_error(exc):
            return {
                "ok": False,
                "summary": "mini-swe-agent could not execute: model did not emit tool calls",
                "stderr": (
                    "Agentic execution requires a tool-calling-capable model/runtime. "
                    "The model output did not include any tool calls.\n"
                    f"Error: {to_single_line(exc, 600)}\n"
                    "Fix: use a model/runtime that supports tool calls (function calling), "
                    "or switch executor backend."
                ),
                "exitCode": 3,
            }

        return {
            "ok": False,
            "summary": "mini-swe-agent task execution failed",
            "stderr": str(exc),
            "exitCode": 1,
        }

    # Extract the agent's conversational output from its message history.
    agent_text = ""
    try:
        agent_text = str(exit_info.get("submission") or "").strip()
        if not agent_text and hasattr(agent, "messages"):
            parts: List[str] = []
            for msg in agent.messages:
                if msg.get("role") == "assistant":
                    content = str(msg.get("content") or "").strip()
                    if content:
                        parts.append(content)
            if parts:
                agent_text = "\n\n".join(parts)
    except Exception:
        pass

    # Post-run: determine what files were changed relative to baseline.
    changed_paths = summarize_git_changes(repo)
    delta = [p for p in changed_paths if p not in baseline_changes]
    effective = delta if delta else changed_paths

    # Build stdout: include agent text output followed by file change info.
    stdout_parts: List[str] = []
    if agent_text:
        stdout_parts.append(agent_text)

    if effective:
        listed = "\n".join(f"- {path}" for path in effective[:40])
        if len(effective) > 40:
            listed += "\n- ..."
        suffix = ""
        if delta and len(delta) != len(changed_paths):
            suffix = f" (delta={len(delta)}, total_status={len(changed_paths)})"
        stdout_parts.append(f"Changed files:\n{listed}")
        return {
            "ok": True,
            "summary": f"Executed task and modified {len(effective)} file(s){suffix}",
            "stdout": "\n\n".join(stdout_parts),
            "stderr": "",
            "exitCode": 0,
        }

    if not stdout_parts:
        stdout_parts.append("No modified files were detected after execution.")

    return {
        "ok": True,
        "summary": "Executed task via mini-swe-agent (no file changes detected)",
        "stdout": "\n\n".join(stdout_parts),
        "stderr": "",
        "exitCode": 0,
    }


# ─── Main entry point ───────────────────────────────────────────────────────

def main() -> int:
    task = parse_task_execute_payload(sys.argv, log_prefix=LOG_PREFIX)
    result = _run_miniswe_task(
        task.repo, task.instruction, task.payload, task.supplemental_guidance,
    )
    emit(result)
    return 0 if bool(result.get("ok")) else to_int(result.get("exitCode"), 1)


if __name__ == "__main__":
    raise SystemExit(main())
