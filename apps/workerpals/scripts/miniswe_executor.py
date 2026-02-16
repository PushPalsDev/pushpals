#!/usr/bin/env python3
"""
PushPals -> mini-swe-agent worker wrapper.

This script receives a base64-encoded JSON payload from the TS worker,
executes the requested task through the mini-swe-agent Python SDK, and prints
one structured result line:

  __PUSHPALS_OH_RESULT__ {"ok":true,...}

The sentinel prefix is intentionally the same as the OpenHands wrapper so that
the TypeScript host can parse results with a single code path.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

try:
    import tomllib
except Exception:  # pragma: no cover - python <3.11 fallback
    tomllib = None  # type: ignore[assignment]


# ─── Constants ───────────────────────────────────────────────────────────────

RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ "
DEFAULT_MINISWE_MODEL = "local-model"
KNOWN_LITELLM_PROVIDER_PREFIXES: Set[str] = {
    "openai", "azure", "ollama", "openrouter", "anthropic", "google",
    "gemini", "vertex_ai", "bedrock", "cohere", "groq", "mistral",
    "huggingface", "replicate", "deepseek", "xai", "together_ai",
    "fireworks_ai",
}

_CONFIG_CACHE: Optional[Dict[str, Any]] = None


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _emit(result: Dict[str, Any]) -> None:
    sys.stdout.write(f"{RESULT_PREFIX}{json.dumps(result, ensure_ascii=True)}\n")
    sys.stdout.flush()


def _executor_log(message: str) -> None:
    line = message if message.endswith("\n") else f"{message}\n"
    sys.stdout.write(line)


def _fail(summary: str, stderr: Optional[str] = None, exit_code: int = 1) -> int:
    _emit({"ok": False, "summary": summary, "stderr": stderr or "", "exitCode": exit_code})
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


# ─── Config loading (mirrors openhands_executor.py) ─────────────────────────

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


def _looks_local_base_url(base_url: str) -> bool:
    if not base_url:
        return False
    lowered = base_url.lower()
    return "localhost" in lowered or "127.0.0.1" in lowered or "host.docker.internal" in lowered


def _resolve_llm_config() -> Tuple[str, str, str]:
    """Returns (model, api_key, base_url) resolved from config + env."""
    raw_model = _setting_str("WORKERPALS_LLM_MODEL", "workerpals.llm.model", "")
    api_key = _setting_str("WORKERPALS_LLM_API_KEY", "workerpals.llm.api_key", "")
    raw_base_url = _setting_str("WORKERPALS_LLM_ENDPOINT", "workerpals.llm.endpoint", "")
    provider = _infer_litellm_provider(raw_base_url)
    configured_model = _normalize_litellm_model(raw_model or DEFAULT_MINISWE_MODEL, provider)
    base_url = _normalize_base_url_for_provider(raw_base_url, provider)
    if _running_in_container():
        rewritten = _rewrite_localhost_for_container(base_url)
        if rewritten != base_url:
            _executor_log(
                f"[MiniSweExecutor] Rewriting local LLM base URL for container networking: {base_url} -> {rewritten}"
            )
            base_url = rewritten
    if not raw_model.strip():
        _executor_log(
            f"[MiniSweExecutor] No explicit model configured; using default model {DEFAULT_MINISWE_MODEL}."
        )
    return configured_model, api_key, base_url


def _execution_timeout_ms() -> int:
    raw = _setting_str("WORKERPALS_MINISWE_TIMEOUT_MS", "workerpals.miniswe_timeout_ms", "")
    default_ms = 1800000
    if not raw:
        return default_ms
    try:
        parsed = int(raw)
    except Exception:
        return default_ms
    return max(10000, parsed)


def _summarize_git_changes(repo: str) -> List[str]:
    try:
        proc = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=repo, capture_output=True, text=True, timeout=20, check=False,
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

    model_name, api_key, base_url = _resolve_llm_config()
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

    # Build the full task prompt, incorporating supplemental guidance
    full_instruction = instruction
    if supplemental_guidance:
        guidance_parts = [g.strip() for g in supplemental_guidance if g and g.strip()]
        if guidance_parts:
            full_instruction += "\n\n--- Supplemental execution guidance ---\n" + "\n\n".join(guidance_parts)

    timeout_ms = _execution_timeout_ms()
    timeout_minutes = max(1, round(timeout_ms / 60000))
    full_instruction += (
        f"\n\nTime limit: about {timeout_minutes} minute(s) for this task. "
        "If you cannot finish in time, stop and provide a concise status of what you checked, "
        "what remains, and the blocker."
    )

    _executor_log(f"[MiniSweExecutor] Starting mini-swe-agent execution in {repo}")
    _executor_log(f"[MiniSweExecutor] Model: {model_name}, base_url: {base_url or '(default)'}")
    _executor_log(f"[MiniSweExecutor] Timeout: {timeout_ms}ms ({timeout_minutes}min)")

    try:
        import yaml
        from minisweagent import package_dir

        # Configure the LiteLLM model.
        # LitellmModel accepts model_name directly and passes extra kwargs
        # to litellm via model_kwargs dict.
        litellm_kwargs: Dict[str, Any] = {}
        if api_key:
            litellm_kwargs["api_key"] = api_key
        if base_url:
            litellm_kwargs["api_base"] = base_url

        model = LitellmModel(model_name=model_name, model_kwargs=litellm_kwargs)

        # Create local environment rooted in the repo working directory
        env = LocalEnvironment(cwd=repo)

        # Load the built-in default agent config which provides the required
        # system_template and instance_template fields for AgentConfig.
        config_path = package_dir / "config" / "default.yaml"
        with open(config_path, "r", encoding="utf-8") as f:
            builtin_config = yaml.safe_load(f)
        agent_kwargs = builtin_config.get("agent", {})

        # Override cost/step limits from our config
        agent_kwargs["cost_limit"] = 0.0  # we manage budget externally
        agent_kwargs["step_limit"] = _setting_int(
            "WORKERPALS_OPENHANDS_AGENT_MAX_STEPS",
            "workerpals.openhands.agent_max_steps",
            30,
        )

        # Create and run the agent (positional: model, env; config via kwargs)
        agent = DefaultAgent(model, env, **agent_kwargs)

        _executor_log("[MiniSweExecutor] Agent initialized, running task...")
        agent.run(full_instruction)
        _executor_log("[MiniSweExecutor] Agent execution completed.")

    except Exception as exc:
        return {
            "ok": False,
            "summary": "mini-swe-agent task execution failed",
            "stderr": str(exc),
            "exitCode": 1,
        }

    # Check what files were changed
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
        "summary": "Executed task via mini-swe-agent (no file changes detected)",
        "stdout": "No modified files were detected after execution.",
        "stderr": "",
        "exitCode": 0,
    }


# ─── Main entry point ───────────────────────────────────────────────────────

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
            f"Unsupported job kind '{kind}'. mini-swe-agent executor accepts only task.execute.",
            exit_code=2,
        )

    instruction = str(params.get("instruction") or "").strip()
    if not instruction:
        return _fail("task.execute requires 'instruction'", exit_code=2)

    planner_instruction = str(params.get("plannerWorkerInstruction") or "").strip()
    quality_revision_hint = str(params.get("qualityRevisionHint") or "").strip()

    supplemental_guidance: List[str] = []
    if planner_instruction and planner_instruction != instruction:
        _executor_log(
            "[MiniSweExecutor] Planner guidance was provided, but preserving original user instruction as canonical task input."
        )
        supplemental_guidance.append(planner_instruction)
    if quality_revision_hint:
        _executor_log(
            "[MiniSweExecutor] Quality revision guidance provided for this attempt; preserving canonical user instruction and applying additive guidance."
        )
        supplemental_guidance.append(quality_revision_hint)

    lane = str(params.get("lane") or "openhands").strip().lower()
    if lane not in {"openhands", "deterministic"}:
        return _fail(
            "task.execute requires lane='openhands' or lane='deterministic'",
            exit_code=2,
        )

    if lane == "deterministic":
        # For deterministic lane, mini-swe-agent still uses agentic execution
        # but with a more constrained instruction. The deterministic lane concept
        # is handled at the TS layer; if we get here, just run agentic.
        _executor_log(
            "[MiniSweExecutor] Deterministic lane received; running with agentic execution "
            "(mini-swe-agent does not have a separate deterministic mode)."
        )

    result = _run_miniswe_task(repo, instruction, payload, supplemental_guidance)
    _emit(result)
    return 0 if bool(result.get("ok")) else _to_int(result.get("exitCode"), 1)


if __name__ == "__main__":
    raise SystemExit(main())
