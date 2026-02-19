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

Tool-broker shim:
- If mini-swe-agent fails because the model doesn't tool-call, fall back to a
  "tool broker" loop that does NOT require native tool/function calling.
- The broker asks the model to emit a strict JSON "plan of actions" (file ops + safe shell),
  executes them locally, and feeds observations back to the model for a few steps.
- Broker can be forced on/off with WORKERPALS_MINISWE_TOOL_BROKER=1/0.
  If unset, local endpoints (LM Studio/Ollama-style) default to ON.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
import time
import traceback
import fnmatch
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# Shared executor infrastructure lives in src/backends/shared.
_SHARED_DIR = Path(__file__).resolve().parents[1] / "shared"
if str(_SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(_SHARED_DIR))

from executor_base import (
    Logger,
    config_get,
    emit,
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
log = Logger(LOG_PREFIX)

# Tool broker defaults (conservative)
# Keep explicit default off, but auto-enable when using a local endpoint.
_BROKER_ENABLED_DEFAULT = "0"
_BROKER_MAX_STEPS_DEFAULT = 8
_BROKER_MAX_ACTIONS_PER_STEP_DEFAULT = 10
_BROKER_HTTP_TIMEOUT_SEC_DEFAULT = 60
_BROKER_HTTP_RETRY_MAX_DEFAULT = 1
_BROKER_TEMPERATURE = 0.0
_BROKER_SHELL_TIMEOUT_SEC_DEFAULT = 120
_BROKER_OBSERVATION_MAX_CHARS = 8_000

# Safety: very simple denylist for shell commands (can be adjusted)
_DENY_PATTERNS = [
    r"\bsudo\b",
    r"\brm\b\s+-rf\b",
    r"\bmkfs\b",
    r"\bdd\b",
    r"\bshutdown\b",
    r"\breboot\b",
    r"\bpoweroff\b",
    r"\bcurl\b",
    r"\bwget\b",
    r"\bnc\b",
    r"\bnetcat\b",
    r"\bssh\b",
    r"\bscp\b",
    r"\brsync\b",
    r"\bpython\b\s+-m\s+http\.server\b",
]
_ALLOWED_BINARIES = {
    "git",
    "cat",
    "tail",
    "head",
    "ls",
    "find",
    "rg",
    "grep",
    "sed",
    "awk",
    "wc",
    "stat",
    "printf",
    "echo",
    "test",
}
_ALLOWED_GIT_SUBCOMMANDS = {
    "status",
    "diff",
    "show",
    "log",
    "grep",
    "rev-parse",
    "ls-files",
}
_SHELL_META_CHARS = set(";|&$`()<>")
_BROKER_MAX_WRITE_CHARS = 200_000


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


def _parse_boolish(raw: Any) -> Optional[bool]:
    if raw is None:
        return None
    text = str(raw).strip().lower()
    if not text:
        return None
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return None


def _tool_broker_enabled(base_url: str = "") -> bool:
    env_setting = _parse_boolish(os.environ.get("WORKERPALS_MINISWE_TOOL_BROKER"))
    if env_setting is not None:
        return env_setting
    cfg_setting = _parse_boolish(config_get("workerpals.miniswe_tool_broker", None))
    if cfg_setting is not None:
        return cfg_setting
    if looks_local_base_url(base_url):
        return True
    return _parse_boolish(_BROKER_ENABLED_DEFAULT) is True


def _tool_broker_max_steps() -> int:
    raw = (os.environ.get("WORKERPALS_MINISWE_TOOL_BROKER_MAX_STEPS") or "").strip()
    if raw:
        return max(1, min(30, to_int(raw, _BROKER_MAX_STEPS_DEFAULT)))
    return _BROKER_MAX_STEPS_DEFAULT


def _tool_broker_max_actions_per_step() -> int:
    raw = (os.environ.get("WORKERPALS_MINISWE_TOOL_BROKER_MAX_ACTIONS_PER_STEP") or "").strip()
    if raw:
        return max(1, min(50, to_int(raw, _BROKER_MAX_ACTIONS_PER_STEP_DEFAULT)))
    return _BROKER_MAX_ACTIONS_PER_STEP_DEFAULT


def _tool_broker_shell_timeout_sec() -> int:
    raw = (os.environ.get("WORKERPALS_MINISWE_TOOL_BROKER_SHELL_TIMEOUT_SEC") or "").strip()
    if raw:
        return max(5, min(600, to_int(raw, _BROKER_SHELL_TIMEOUT_SEC_DEFAULT)))
    return _BROKER_SHELL_TIMEOUT_SEC_DEFAULT


def _tool_broker_http_timeout_sec() -> int:
    raw = (os.environ.get("WORKERPALS_MINISWE_TOOL_BROKER_HTTP_TIMEOUT_SEC") or "").strip()
    if raw:
        return max(10, min(600, to_int(raw, _BROKER_HTTP_TIMEOUT_SEC_DEFAULT)))
    cfg = config_get("workerpals.miniswe_tool_broker_http_timeout_sec", None)
    if cfg is None:
        return _BROKER_HTTP_TIMEOUT_SEC_DEFAULT
    return max(10, min(600, to_int(cfg, _BROKER_HTTP_TIMEOUT_SEC_DEFAULT)))


def _tool_broker_http_retry_max() -> int:
    raw = (os.environ.get("WORKERPALS_MINISWE_TOOL_BROKER_HTTP_RETRY_MAX") or "").strip()
    if raw:
        return max(0, min(3, to_int(raw, _BROKER_HTTP_RETRY_MAX_DEFAULT)))
    cfg = config_get("workerpals.miniswe_tool_broker_http_retry_max", None)
    if cfg is None:
        return _BROKER_HTTP_RETRY_MAX_DEFAULT
    return max(0, min(3, to_int(cfg, _BROKER_HTTP_RETRY_MAX_DEFAULT)))


def _build_strict_tool_use_guidance(repo: str) -> str:
    return (
        "CRITICAL: You must use tools to make progress.\n"
        "- Use the environment's tools (file read/list/search, and file edit/write/patch) to inspect and modify the repo.\n"
        "- Do NOT only describe what you would do; actually do it.\n"
        "- Avoid broad scans; choose one target file quickly.\n"
        "- After making edits, run a narrow validation command if available (tests/lint) and then finish.\n"
        f"- Repo root: {repo}\n"
    )


# ─── Tool Broker Shim ────────────────────────────────────────────────────────

def _messages_indicate_missing_tool_calls(messages: Any) -> bool:
    if not isinstance(messages, list) or not messages:
        return False
    saw_tool_call = False
    no_tool_call_prompts = 0
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        tool_calls = msg.get("tool_calls")
        if isinstance(tool_calls, list) and tool_calls:
            saw_tool_call = True
        role = str(msg.get("role") or "").strip().lower()
        content = str(msg.get("content") or "").strip().lower()
        if role == "user" and "no tool calls found" in content:
            no_tool_call_prompts += 1
    return (not saw_tool_call) and no_tool_call_prompts > 0


@dataclass
class _LLMConfig:
    model: str
    api_key: str
    base_url: str


def _normalize_openai_base_url(base_url: str) -> str:
    """
    Accept:
      - http://host:1234
      - http://host:1234/
      - http://host:1234/v1
      - http://host:1234/v1/
    Return a base that ends with /v1
    """
    b = (base_url or "").strip()
    if not b:
        return ""
    b = b.rstrip("/")
    if b.endswith("/v1"):
        return b
    if b.endswith("v1"):
        # e.g. ".../v1" already covered, but keep safe
        return b
    return b + "/v1"


def _http_post_json(url: str, payload: Dict[str, Any], api_key: str, timeout_sec: float) -> Dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = Request(url, data=data, headers=headers, method="POST")
    try:
        with urlopen(req, timeout=timeout_sec) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw)
    except HTTPError as e:
        try:
            details = e.read().decode("utf-8", errors="replace")
        except Exception:
            details = ""
        raise RuntimeError(f"HTTP {e.code} {e.reason} for POST {url}\n{details}") from e
    except URLError as e:
        raise RuntimeError(f"URLError for POST {url}: {e}") from e
    except TimeoutError as e:
        raise RuntimeError(f"TimeoutError for POST {url}: timed out after {timeout_sec}s") from e


def _chat_completion(cfg: _LLMConfig, messages: List[Dict[str, str]], timeout_sec: int) -> str:
    base = _normalize_openai_base_url(cfg.base_url)
    if not base:
        raise RuntimeError("No base_url configured for broker shim (WORKERPALS_LLM_ENDPOINT/BASE_URL).")
    url = base + "/chat/completions"
    payload: Dict[str, Any] = {
        "model": cfg.model,
        "messages": messages,
        "temperature": _BROKER_TEMPERATURE,
        "stream": False,
    }
    obj = _http_post_json(url, payload, cfg.api_key, timeout_sec=float(timeout_sec))
    choices = obj.get("choices") or []
    if not choices:
        raise RuntimeError(f"LLM returned no choices: {to_single_line(obj, 400)}")
    msg = choices[0].get("message") or {}
    content = msg.get("content")
    if not isinstance(content, str):
        raise RuntimeError(f"LLM returned non-text content: {to_single_line(obj, 400)}")
    return content.strip()


def _repo_safe_path(repo: str, rel_path: str) -> Path:
    rel = str(rel_path or "")
    if not rel.strip():
        raise RuntimeError("Path is required")
    if "\x00" in rel:
        raise RuntimeError("Path contains NUL byte")
    if Path(rel).is_absolute():
        raise RuntimeError(f"Absolute paths are not allowed: {rel}")
    if re.match(r"^[A-Za-z]:[\\/]", rel):
        raise RuntimeError(f"Drive-letter paths are not allowed: {rel}")
    root = Path(repo).resolve()
    p = (root / rel).resolve()
    # Ensure p is within root
    if root == p or root in p.parents:
        return p
    raise RuntimeError(f"Refusing to access path outside repo: {rel}")


def _normalize_scope_rel_path(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    raw = value.strip().replace("\\", "/")
    if not raw:
        return None
    while raw.startswith("./"):
        raw = raw[2:]
    raw = raw.rstrip("/")
    if not raw or raw.startswith("/"):
        return None
    if re.match(r"^[A-Za-z]:[\\/]", raw):
        return None
    segments = []
    for segment in raw.split("/"):
        seg = segment.strip()
        if not seg or seg == ".":
            continue
        if seg == "..":
            return None
        segments.append(seg)
    if not segments:
        return None
    return "/".join(segments)


def _extract_write_globs_from_payload(payload: Optional[Dict[str, Any]]) -> List[str]:
    if not isinstance(payload, dict):
        return []
    params = payload.get("params")
    if not isinstance(params, dict):
        return []
    planning = params.get("planning")
    if not isinstance(planning, dict):
        return []
    scope = planning.get("scope")
    if not isinstance(scope, dict):
        return []
    write_globs_raw = scope.get("writeGlobs")
    if not isinstance(write_globs_raw, list):
        return []
    out: List[str] = []
    seen = set()
    for item in write_globs_raw:
        normalized = _normalize_scope_rel_path(item)
        if not normalized:
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        out.append(normalized)
    return out


def _assert_write_allowed(repo: str, path: str, write_globs: Optional[List[str]]) -> None:
    if not write_globs:
        return
    normalized = _normalize_scope_rel_path(path)
    if not normalized:
        raise RuntimeError(f"Invalid write path for scope enforcement: {path!r}")
    for glob in write_globs:
        pattern = str(glob or "").strip()
        if not pattern:
            continue
        if any(ch in pattern for ch in "*?[]"):
            if fnmatch.fnmatchcase(normalized, pattern):
                return
            continue
        if normalized == pattern or normalized.startswith(pattern + "/"):
            return
    raise RuntimeError(
        "Scope violation: attempted write outside writeGlobs. "
        f"path={normalized!r} write_globs={write_globs!r}"
    )


def _read_text_file(repo: str, path: str, max_chars: int = 60000) -> str:
    p = _repo_safe_path(repo, path)
    if not p.exists():
        raise RuntimeError(f"File not found: {path}")
    data = p.read_text(encoding="utf-8", errors="replace")
    if len(data) > max_chars:
        return data[:max_chars] + "\n... (truncated)"
    return data


def _write_text_file(repo: str, path: str, content: str, write_globs: Optional[List[str]] = None) -> None:
    _assert_write_allowed(repo, path, write_globs)
    p = _repo_safe_path(repo, path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def _append_line(repo: str, path: str, line: str, write_globs: Optional[List[str]] = None) -> None:
    """
    Append a single line to end of file using append mode (no full-file rewrite).
    If the file exists and does not end with newline, add one first.
    """
    _assert_write_allowed(repo, path, write_globs)
    p = _repo_safe_path(repo, path)
    p.parent.mkdir(parents=True, exist_ok=True)
    needs_prefix_newline = False
    if p.exists() and p.stat().st_size > 0:
        try:
            with open(p, "rb") as rf:
                rf.seek(-1, os.SEEK_END)
                needs_prefix_newline = rf.read(1) != b"\n"
        except Exception:
            needs_prefix_newline = False
    with open(p, "a", encoding="utf-8") as wf:
        if needs_prefix_newline:
            wf.write("\n")
        wf.write(f"{line}\n")


def _replace_text_once(
    repo: str,
    path: str,
    old: str,
    new: str,
    write_globs: Optional[List[str]] = None,
) -> int:
    _assert_write_allowed(repo, path, write_globs)
    p = _repo_safe_path(repo, path)
    data = p.read_text(encoding="utf-8", errors="replace")
    idx = data.find(old)
    if idx < 0:
        return 0
    updated = data[:idx] + new + data[idx + len(old):]
    p.write_text(updated, encoding="utf-8")
    return 1


def _parse_and_validate_shell_command(cmd: str) -> Tuple[Optional[List[str]], str]:
    c = (cmd or "").strip()
    if not c:
        return None, "empty command"
    if any(ord(ch) < 32 for ch in c):
        return None, "control characters are not allowed"
    if any(ch in c for ch in _SHELL_META_CHARS):
        return None, "shell metacharacters are not allowed"
    try:
        args = shlex.split(c, posix=True)
    except Exception as exc:
        return None, f"failed to parse command: {exc}"
    if not args:
        return None, "empty parsed command"
    binary = args[0].strip().lower()
    if binary not in _ALLOWED_BINARIES:
        return None, f"binary not allowed: {binary}"
    lowered = c.lower()
    for pat in _DENY_PATTERNS:
        if re.search(pat, lowered):
            return None, f"blocked by denylist: {pat}"
    # Additional guardrails for risky allowlisted binaries.
    if binary == "find":
        joined = " ".join(args[1:]).lower()
        if "-exec" in joined or "-delete" in joined:
            return None, "find with -exec/-delete is not allowed"
    if binary == "git" and len(args) >= 2:
        sub = args[1].strip().lower()
        if sub not in _ALLOWED_GIT_SUBCOMMANDS:
            return None, f"git subcommand not allowed: {sub}"
        for raw_arg in args[2:]:
            arg = str(raw_arg or "").strip()
            if not arg:
                continue
            lower_arg = arg.lower()
            if lower_arg in {"-c", "-C"}:
                return None, f"git option is not allowed: {arg}"
            if lower_arg.startswith("-c"):
                return None, f"git option prefix is not allowed: {arg}"
            if lower_arg.startswith("--git-dir") or lower_arg.startswith("--work-tree"):
                return None, f"git path/work-tree override is not allowed: {arg}"
            if lower_arg == "--no-index":
                return None, "git diff --no-index is not allowed"
            if arg.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", arg):
                return None, f"absolute path-like git arg is not allowed: {arg}"
            normalized = arg.replace("\\", "/")
            while normalized.startswith("./"):
                normalized = normalized[2:]
            if (
                normalized == ".."
                or normalized.startswith("../")
                or "/../" in normalized
            ):
                return None, f"path escape git arg is not allowed: {arg}"
    if binary == "git" and len(args) < 2:
        return None, "git command requires an explicit allowed subcommand"
    if binary == "sed":
        for raw_arg in args[1:]:
            arg = str(raw_arg or "").strip().lower()
            if not arg:
                continue
            if arg == "-i" or arg.startswith("-i") or arg.startswith("--in-place"):
                return None, "sed in-place edits are not allowed"
    if binary == "awk":
        joined = " ".join(args[1:]).lower()
        if "system(" in joined:
            return None, "awk system() is not allowed"
    return args, ""


def _run_shell(repo: str, cmd: str, max_output: int = 60000, timeout_sec: Optional[int] = None) -> str:
    """
    Run a tokenized command in repo without shell expansion/chaining.
    Blocks unsafe commands with binary allowlist + additional guardrails.
    """
    args, reason = _parse_and_validate_shell_command(cmd)
    if args is None:
        raise RuntimeError(f"Shell command rejected: {reason}. cmd={cmd!r}")

    import subprocess

    proc = subprocess.run(
        args,
        cwd=str(Path(repo).resolve()),
        capture_output=True,
        text=True,
        check=False,
        timeout=(timeout_sec if timeout_sec is not None else _tool_broker_shell_timeout_sec()),
    )
    out = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
    out = out.strip()
    if len(out) > max_output:
        out = out[:max_output] + "\n... (truncated)"
    return f"(exit={proc.returncode})\n{out}" if out else f"(exit={proc.returncode})"


def _shell_exit_code(output: str) -> Optional[int]:
    m = re.match(r"^\(exit=(\d+)\)", str(output or "").strip())
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None


def _extract_first_json_object(text: str) -> Optional[Dict[str, Any]]:
    """
    Tries to find and parse a single JSON object from the model response.
    Accepts plain JSON, or JSON inside Markdown fences.
    """
    if not text:
        return None
    # Strip ```json fences
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, flags=re.IGNORECASE)
    candidate = fenced.group(1).strip() if fenced else text.strip()

    # Fast path: whole string is JSON
    try:
        obj = json.loads(candidate)
        return obj if isinstance(obj, dict) else None
    except Exception:
        pass

    # Heuristic: find first {...} block
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start >= 0 and end > start:
        snippet = candidate[start : end + 1]
        try:
            obj = json.loads(snippet)
            return obj if isinstance(obj, dict) else None
        except Exception:
            return None
    return None


def _truncate_observation(text: str, max_chars: int = _BROKER_OBSERVATION_MAX_CHARS) -> str:
    t = str(text or "").strip()
    if len(t) <= max_chars:
        return t
    head = max_chars // 2
    tail = max_chars - head
    return f"{t[:head]}\n...[observation truncated]...\n{t[-tail:]}"


def _validate_broker_actions(actions: Any, max_actions: int) -> Tuple[bool, str, List[Dict[str, Any]]]:
    if actions is None:
        return True, "", []
    if not isinstance(actions, list):
        return False, f"Expected actions to be a list, got: {type(actions).__name__}", []
    valid: List[Dict[str, Any]] = []
    for i, act in enumerate(actions[:max_actions], start=1):
        if not isinstance(act, dict):
            return False, f"Action {i}: must be an object", []
        typ = str(act.get("type") or "").strip()
        if not typ:
            return False, f"Action {i}: missing type", []
        if typ == "read_file":
            if not isinstance(act.get("path"), str) or not str(act.get("path")).strip():
                return False, f"Action {i} read_file: path is required", []
            valid.append({"type": typ, "path": str(act.get("path")).strip()})
            continue
        if typ in {"append_line", "append_comment"}:
            if not isinstance(act.get("path"), str) or not str(act.get("path")).strip():
                return False, f"Action {i} {typ}: path is required", []
            line_value = act.get("line")
            if typ == "append_comment" and not isinstance(line_value, str):
                line_value = act.get("comment")
            if not isinstance(line_value, str):
                return False, f"Action {i} {typ}: line/comment must be a string", []
            valid.append(
                {
                    "type": "append_line",
                    "path": str(act.get("path")).strip(),
                    "line": str(line_value),
                }
            )
            continue
        if typ == "replace_text_once":
            if not isinstance(act.get("path"), str) or not str(act.get("path")).strip():
                return False, f"Action {i} replace_text_once: path is required", []
            old = act.get("old")
            new = act.get("new")
            if not isinstance(old, str) or not isinstance(new, str):
                return False, f"Action {i} replace_text_once: old/new must be strings", []
            if not old:
                return False, f"Action {i} replace_text_once: old must be non-empty", []
            valid.append(
                {"type": typ, "path": str(act.get("path")).strip(), "old": old, "new": new}
            )
            continue
        if typ == "write_file":
            if not isinstance(act.get("path"), str) or not str(act.get("path")).strip():
                return False, f"Action {i} write_file: path is required", []
            content = act.get("content")
            if not isinstance(content, str):
                return False, f"Action {i} write_file: content must be a string", []
            if len(content) > _BROKER_MAX_WRITE_CHARS:
                return False, f"Action {i} write_file: content too large ({len(content)} chars)", []
            valid.append({"type": typ, "path": str(act.get("path")).strip(), "content": content})
            continue
        if typ == "run_shell":
            cmd = act.get("command")
            if not isinstance(cmd, str) or not cmd.strip():
                return False, f"Action {i} run_shell: command is required", []
            valid.append({"type": typ, "command": cmd.strip()})
            continue
        return False, f"Action {i}: unknown type {typ!r}", []
    return True, "", valid


def _extract_expected_target_paths(instruction: str) -> List[str]:
    targets: List[str] = []
    # lightweight heuristic for common file-target asks
    for m in re.finditer(r"\b([A-Za-z0-9._/\-]+(?:\.[A-Za-z0-9._-]+))\b", instruction or ""):
        token = m.group(1).strip()
        if "/" in token or "." in token:
            lower = token.lower()
            if lower in {"true", "false", "none"}:
                continue
            if token not in targets:
                targets.append(token)
        if len(targets) >= 8:
            break
    return targets


def _extract_explicit_target_paths_from_payload(payload: Optional[Dict[str, Any]]) -> List[str]:
    if not isinstance(payload, dict):
        return []
    out: List[str] = []
    seen = set()
    params = payload.get("params")
    if not isinstance(params, dict):
        return []

    def add(val: Any) -> None:
        if not isinstance(val, str):
            return
        token = val.strip().replace("\\", "/")
        while token.startswith("./"):
            token = token[2:]
        token = token.rstrip("/")
        if not token or token in seen:
            return
        if token in {".", "/"}:
            return
        seen.add(token)
        out.append(token)

    add(params.get("targetPath"))
    planning = params.get("planning")
    if isinstance(planning, dict):
        target_paths = planning.get("targetPaths")
        if isinstance(target_paths, list):
            for item in target_paths:
                add(item)
        scope = planning.get("scope")
        if isinstance(scope, dict):
            write_globs = scope.get("writeGlobs")
            if isinstance(write_globs, list):
                for item in write_globs:
                    add(item)
    return out


def _target_hint_matches_changed_path(target_hint: str, changed_path: str) -> bool:
    target = str(target_hint or "").strip().replace("\\", "/").rstrip("/")
    changed = str(changed_path or "").strip().replace("\\", "/").rstrip("/")
    if not target or not changed:
        return False
    if target in {".", "/"}:
        return True
    if changed == target:
        return True
    if changed.startswith(target + "/"):
        return True
    if any(ch in target for ch in "*?[]"):
        return fnmatch.fnmatchcase(changed, target)
    return False


def _is_git_porcelain_status_command(cmd: str) -> bool:
    args, reason = _parse_and_validate_shell_command(cmd)
    if args is None:
        return False
    if len(args) < 2 or args[0].lower() != "git" or args[1].lower() != "status":
        return False
    return any(a.lower().startswith("--porcelain") for a in args[2:])


def _broker_system_prompt(repo: str) -> str:
    return (
        "You are a code-changing assistant operating on a local git repository.\n"
        "You DO NOT have native tool/function calling. Instead, you must output a STRICT JSON object describing actions.\n"
        "\n"
        "Repository root: " + repo + "\n"
        "\n"
        "Output format (STRICT JSON, no markdown, no extra keys unless specified):\n"
        "{\n"
        '  "actions": [\n'
        "    {\"type\":\"read_file\",\"path\":\"README.md\"},\n"
        "    {\"type\":\"append_line\",\"path\":\"README.md\",\"line\":\"...\"},\n"
        "    {\"type\":\"replace_text_once\",\"path\":\"x\",\"old\":\"a\",\"new\":\"b\"},\n"
        "    {\"type\":\"write_file\",\"path\":\"x\",\"content\":\"...\"},\n"
        "    {\"type\":\"run_shell\",\"command\":\"git status --porcelain\"}\n"
        "  ],\n"
        '  "done": false,\n'
        '  "note": "short explanation"\n'
        "}\n"
        "\n"
        "Rules:\n"
        "- Keep actions minimal and directly relevant.\n"
        "- Paths must be repo-relative.\n"
        "- Use read_file before edit when unsure.\n"
        "- After edits, run_shell: \"git status --porcelain\".\n"
        "- When task is complete, set done=true and keep actions empty or only verification commands.\n"
    )


def _broker_run(
    repo: str,
    instruction: str,
    llm: _LLMConfig,
    timeout_ms: int,
    explicit_targets: Optional[List[str]] = None,
    write_globs: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Executes a simple plan/act loop where the model emits JSON actions.
    """
    started = time.time()
    deadline = started + max(5, int(timeout_ms / 1000))

    max_steps = _tool_broker_max_steps()
    max_actions = _tool_broker_max_actions_per_step()
    shell_timeout_sec = _tool_broker_shell_timeout_sec()
    http_timeout_sec = _tool_broker_http_timeout_sec()
    http_retry_max = _tool_broker_http_retry_max()

    transcript: List[str] = []
    obs: str = ""
    edits_made = False
    shell_validation_ran = False
    explicit_target_set = {str(t).strip() for t in (explicit_targets or []) if str(t).strip()}
    allowed_write_globs = [g for g in (write_globs or []) if str(g).strip()]
    expected_targets = sorted(explicit_target_set) if explicit_target_set else _extract_expected_target_paths(instruction)

    messages: List[Dict[str, str]] = [
        {"role": "system", "content": _broker_system_prompt(repo)},
        {"role": "user", "content": f"Task:\n{instruction}\n\nStart now. Output STRICT JSON only."},
    ]

    def _record(line: str) -> None:
        transcript.append(line)
        log.debug(line)

    def _remaining_http_timeout_sec() -> int:
        remaining = int(deadline - time.time())
        if remaining <= 0:
            return 10
        return max(10, min(http_timeout_sec, remaining))

    def _broker_llm_call(step_label: str) -> str:
        attempt = 0
        while True:
            attempt += 1
            timeout_for_call = _remaining_http_timeout_sec()
            try:
                return _chat_completion(llm, messages, timeout_sec=timeout_for_call)
            except Exception as exc:
                msg = to_single_line(exc, 400)
                is_timeout = "timeout" in msg.lower() or "timed out" in msg.lower()
                if (not is_timeout) or attempt > (http_retry_max + 1) or time.time() >= deadline:
                    raise RuntimeError(
                        f"{step_label} failed after {attempt} attempt(s): {msg}"
                    ) from exc
                _record(
                    f"[Broker] {step_label} timeout; retry {attempt}/{http_retry_max + 1} "
                    f"(timeout={timeout_for_call}s): {msg}"
                )
                time.sleep(min(2.0, 0.25 * attempt))

    def _broker_fail(summary: str, stderr: str, exit_code: int = 3) -> Dict[str, Any]:
        transcript_text = "\n".join(transcript).strip()
        stdout = f"Tool broker transcript:\n{transcript_text}" if transcript_text else ""
        return {
            "ok": False,
            "summary": summary,
            "stdout": stdout,
            "stderr": stderr,
            "exitCode": exit_code,
        }

    step = 0
    model_done = False
    while step < max_steps and time.time() < deadline:
        step += 1

        if obs:
            messages.append({"role": "user", "content": f"Observation (from executed actions):\n{obs}\n\nNext JSON only."})

        try:
            raw = _broker_llm_call(f"step {step} initial call")
        except Exception as exc:
            return _broker_fail(
                "tool broker failed: llm request error",
                f"Broker LLM request failed at step {step}: {to_single_line(exc, 500)}",
            )
        raw_used = raw
        _record(f"[Broker] Step {step} model output: {to_single_line(raw, 500)}")

        obj = _extract_first_json_object(raw)
        if not obj:
            # one reprompt to force JSON
            messages.append({"role": "user", "content": "Your last response was not valid JSON. Return ONLY the JSON object."})
            try:
                raw2 = _broker_llm_call(f"step {step} json-repair call")
            except Exception as exc:
                return _broker_fail(
                    "tool broker failed: llm request error",
                    f"Broker JSON-repair request failed at step {step}: {to_single_line(exc, 500)}",
                )
            _record(f"[Broker] Step {step} JSON repair output: {to_single_line(raw2, 500)}")
            obj = _extract_first_json_object(raw2)
            if not obj:
                return {
                    "ok": False,
                    "summary": "tool broker failed: model did not produce parsable JSON actions",
                    "stderr": "Model output could not be parsed as the required JSON action format.",
                    "exitCode": 3,
                }
            raw = raw2
        allowed_top_keys = {"actions", "done", "note"}
        extras = [k for k in obj.keys() if str(k) not in allowed_top_keys]
        if extras:
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Your JSON had unsupported top-level keys. "
                        "Return ONLY one JSON object with keys: actions, done, note."
                    ),
                }
            )
            try:
                raw3 = _broker_llm_call(f"step {step} shape-repair call")
            except Exception as exc:
                return _broker_fail(
                    "tool broker failed: llm request error",
                    f"Broker shape-repair request failed at step {step}: {to_single_line(exc, 500)}",
                )
            _record(f"[Broker] Step {step} shape repair output: {to_single_line(raw3, 500)}")
            obj2 = _extract_first_json_object(raw3)
            if not isinstance(obj2, dict):
                return {
                    "ok": False,
                    "summary": "tool broker failed: invalid response shape",
                    "stderr": f"Unexpected top-level keys in broker JSON: {extras}",
                    "exitCode": 3,
                }
            obj = obj2
            raw_used = raw3
            extras = [k for k in obj.keys() if str(k) not in allowed_top_keys]
            if extras:
                # Recoverable formatting issue: ignore extras rather than hard-fail.
                obj = {k: obj.get(k) for k in allowed_top_keys}
                raw_used = json.dumps(obj, ensure_ascii=False)

        actions = obj.get("actions")
        done = bool(obj.get("done"))

        ok_actions, reason_actions, planned_actions = _validate_broker_actions(actions, max_actions)
        if not ok_actions:
            return {
                "ok": False,
                "summary": "tool broker failed: invalid actions schema",
                "stderr": reason_actions,
                "exitCode": 3,
            }

        # Execute actions
        action_logs: List[str] = []
        for i, act in enumerate(planned_actions, start=1):
            typ = str(act.get("type") or "").strip()
            try:
                if typ == "read_file":
                    path = str(act.get("path") or "")
                    content = _read_text_file(repo, path)
                    preview = _truncate_observation(content, max_chars=2000)
                    action_logs.append(
                        f"- read_file {path}: ok ({len(content)} chars total)\n{preview}"
                    )
                elif typ == "append_line":
                    path = str(act.get("path") or "")
                    line = str(act.get("line") or "")
                    _append_line(repo, path, line, allowed_write_globs)
                    edits_made = True
                    action_logs.append(f"- append_line {path}: ok (appended {line!r})")
                elif typ == "replace_text_once":
                    path = str(act.get("path") or "")
                    old = str(act.get("old") or "")
                    new = str(act.get("new") or "")
                    n = _replace_text_once(repo, path, old, new, allowed_write_globs)
                    edits_made = edits_made or (n > 0)
                    action_logs.append(f"- replace_text_once {path}: {n} replacement(s)")
                elif typ == "write_file":
                    path = str(act.get("path") or "")
                    content = str(act.get("content") or "")
                    _write_text_file(repo, path, content, allowed_write_globs)
                    edits_made = True
                    action_logs.append(f"- write_file {path}: ok ({len(content)} chars)")
                elif typ == "run_shell":
                    cmd = str(act.get("command") or "")
                    out = _run_shell(repo, cmd, timeout_sec=shell_timeout_sec)
                    shell_validation_ran = shell_validation_ran or _is_git_porcelain_status_command(cmd)
                    action_logs.append(f"- run_shell {cmd!r}:\n{out}")
                else:
                    action_logs.append(f"- action {i}: unknown type {typ!r} (rejected by schema)")
            except Exception as exc:
                action_logs.append(f"- {typ or 'action'} failed: {to_single_line(exc, 400)}")

        obs = _truncate_observation("\n".join(action_logs).strip())

        # Feed the raw JSON back as assistant message (helps the model stay consistent)
        messages.append({"role": "assistant", "content": raw_used})

        if done:
            _record("[Broker] Model signaled done=true.")
            model_done = True
            break

    # Always include a final git status if possible (and safe)
    try:
        final_status = _run_shell(repo, "git status --porcelain", timeout_sec=shell_timeout_sec)
    except Exception as exc:
        final_status = f"(git status failed) {to_single_line(exc, 300)}"
    final_status_exit = _shell_exit_code(final_status)

    transcript_text = "\n".join(transcript).strip()
    stdout = ""
    if transcript_text:
        stdout += "Tool broker transcript:\n" + transcript_text + "\n\n"
    stdout += "Final verification:\n" + final_status

    if not model_done:
        return {
            "ok": False,
            "summary": "tool broker failed: did not reach done=true before limits",
            "stdout": stdout,
            "stderr": (
                "Model did not return done=true before max steps/timeout. "
                "Treating broker run as incomplete."
            ),
            "exitCode": 3,
        }
    if final_status_exit is not None and final_status_exit != 0:
        return {
            "ok": False,
            "summary": "tool broker failed: verification command failed",
            "stdout": stdout,
            "stderr": "Final verification command `git status --porcelain` failed.",
            "exitCode": 3,
        }
    changed_paths = summarize_git_changes(repo)
    if edits_made and not changed_paths:
        return {
            "ok": False,
            "summary": "tool broker failed: model claimed edits but repo has no changes",
            "stdout": stdout,
            "stderr": "Broker executed edit actions but git reports no changed files.",
            "exitCode": 3,
        }
    if expected_targets and changed_paths:
        changed_set = {str(p).strip().replace("\\", "/") for p in changed_paths}
        expected_set = {str(p).strip().replace("\\", "/") for p in expected_targets}
        strict_target_match = bool(
            explicit_target_set
            and not any(t in {".", "/"} for t in explicit_target_set)
            and not any(any(ch in t for ch in "*?[]") for t in explicit_target_set)
        )
        matched = any(
            _target_hint_matches_changed_path(expected, changed)
            for expected in expected_set
            for changed in changed_set
        )
        if expected_set and not matched:
            msg = (
                "Expected one of target paths to change, but observed different files. "
                f"expected={sorted(expected_set)} observed={sorted(changed_set)}"
            )
            if strict_target_match:
                return {
                    "ok": False,
                    "summary": "tool broker failed: changed files do not match explicit target paths",
                    "stdout": stdout + "\n\nChanged files:\n" + "\n".join(f"- {p}" for p in changed_paths),
                    "stderr": msg,
                    "exitCode": 3,
                }
            stdout += "\n\nTarget-path mismatch (heuristic, non-fatal):\n" + msg
    if edits_made and not shell_validation_ran:
        return {
            "ok": False,
            "summary": "tool broker failed: no explicit validation command was executed",
            "stdout": stdout,
            "stderr": "Model performed edits but did not run `git status --porcelain` during broker steps.",
            "exitCode": 3,
        }

    return {
        "ok": True,
        "summary": "Executed task via tool broker shim",
        "stdout": stdout,
        "stderr": "",
        "exitCode": 0,
    }


# ─── mini-swe-agent execution ───────────────────────────────────────────────

def _run_miniswe_task(
    repo: str,
    instruction: str,
    payload: Optional[Dict[str, Any]] = None,
    supplemental_guidance: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Execute a task using mini-swe-agent's Python SDK (and optional broker fallback)."""

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
        default_model=DEFAULT_MINISWE_MODEL, logger=log,
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

    log.info(f"Starting mini-swe-agent execution in {repo}")
    log.info(f"Model: {model_name}, base_url: {base_url or '(default)'}")
    log.info(f"Timeout: {timeout_ms}ms ({timeout_minutes}min)")
    log.debug(f"Instruction: {to_single_line(instruction, 300)}")

    # Pre-run baseline so we can tell whether *anything* changed even if the model/tooling is flaky.
    baseline_changes = set(summarize_git_changes(repo))
    explicit_targets = _extract_explicit_target_paths_from_payload(payload)
    explicit_write_globs = _extract_write_globs_from_payload(payload)

    # Prepare broker config upfront (so we can fall back cleanly)
    llm_cfg = _LLMConfig(model=model_name, api_key=api_key or "", base_url=base_url or "")

    exit_info: Dict[str, Any] = {}
    agent = None
    agent_messages: List[Dict[str, Any]] = []
    broker_enabled = _tool_broker_enabled(base_url)
    prefer_broker_for_scoped_writes = bool(explicit_write_globs)
    ran_primary_broker = False
    if prefer_broker_for_scoped_writes and broker_enabled:
        log.info("Using tool broker shim for strict per-write scope enforcement.")
        broker_result = _broker_run(
            repo,
            instruction=_compose_instruction(),
            llm=llm_cfg,
            timeout_ms=timeout_ms,
            explicit_targets=explicit_targets,
            write_globs=explicit_write_globs,
        )
        if not bool(broker_result.get("ok")):
            return {
                "ok": False,
                "summary": str(broker_result.get("summary") or "tool broker execution failed"),
                "stdout": str(broker_result.get("stdout") or ""),
                "stderr": str(broker_result.get("stderr") or ""),
                "exitCode": to_int(broker_result.get("exitCode"), 3),
            }
        exit_info = {"submission": broker_result.get("stdout") or ""}
        ran_primary_broker = True
    elif prefer_broker_for_scoped_writes and not broker_enabled:
        log.info(
            "Strict write scope requested but tool broker is disabled; "
            "using native mini-swe path with post-run scope verification."
        )

    if not ran_primary_broker:
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
            agent_kwargs = builtin_config.get("agent", {}) or {}

            agent_kwargs["cost_limit"] = 0.0  # we manage budget externally
            agent_kwargs["step_limit"] = setting_int(
                "WORKERPALS_MINISWE_AGENT_MAX_STEPS",
                "workerpals.miniswe.agent_max_steps",
                30,
            )

            agent = DefaultAgent(model, env, **agent_kwargs)
            log.info("Agent initialized, running task...")

            toolcall_retry_max = _toolcall_retry_max()
            attempt = 0
            while True:
                try:
                    attempt += 1
                    if attempt > 1:
                        log.info(
                            f"Retrying agent run after tool-call failure (attempt {attempt}/{toolcall_retry_max + 1})."
                        )

                    extra_guidance: List[str] = []
                    if attempt > 1:
                        extra_guidance.append(_build_strict_tool_use_guidance(repo))
                        extra_guidance.append(
                            "If you previously failed because you did not emit tool calls: "
                            "you must now call tools immediately (read target files, then edit)."
                        )

                    exit_info = agent.run(_compose_instruction(extra_guidance=extra_guidance)) or {}
                    log.info("Agent execution completed.")

                    # Log what the agent did
                    if hasattr(agent, "messages") and agent.messages:
                        agent_messages = [msg for msg in agent.messages if isinstance(msg, dict)]
                        log.debug(f"Agent message history ({len(agent.messages)} messages):")
                        log_agent_messages(agent.messages, log)
                    log_git_status(repo, log)
                    break

                except Exception as exc:
                    if is_no_tool_calls_error(exc) and (attempt - 1) < toolcall_retry_max:
                        log.info(
                            "Detected tool-call failure from model/runtime: "
                            f"{to_single_line(exc, 220)}"
                        )
                        continue
                    raise

        except Exception as exc:
            # If it's a tool-call failure, optionally fall back to broker shim.
            if is_no_tool_calls_error(exc):
                if broker_enabled:
                    log.info("mini-swe-agent failed due to missing tool calls; falling back to tool broker shim.")
                    broker_result = _broker_run(
                        repo,
                        instruction=_compose_instruction(),
                        llm=llm_cfg,
                        timeout_ms=timeout_ms,
                        explicit_targets=explicit_targets,
                        write_globs=explicit_write_globs,
                    )
                    if not bool(broker_result.get("ok")):
                        return {
                            "ok": False,
                            "summary": str(broker_result.get("summary") or "tool broker fallback failed"),
                            "stdout": str(broker_result.get("stdout") or ""),
                            "stderr": str(broker_result.get("stderr") or ""),
                            "exitCode": to_int(broker_result.get("exitCode"), 3),
                        }

                    # The broker_result itself doesn't include changed-files list; we add it below in the shared post-run path.
                    # We return broker_result as "exit_info-like" output by mapping it into exit_info and continuing.
                    exit_info = {"submission": broker_result.get("stdout") or ""}
                    # Continue into post-run summary construction (changed files etc.) by not returning early.
                else:
                    return {
                        "ok": False,
                        "summary": "mini-swe-agent could not execute: model did not emit tool calls",
                        "stderr": (
                            "Agentic execution requires a tool-calling-capable model/runtime. "
                            "The model output did not include any tool calls.\n"
                            f"Error: {to_single_line(exc, 600)}\n"
                            "Fix options:\n"
                            "- Use a model/runtime that supports tool calls (function calling), or\n"
                            "- Enable the tool broker shim: WORKERPALS_MINISWE_TOOL_BROKER=1, or\n"
                            "- Switch executor backend."
                        ),
                        "exitCode": 3,
                    }
            else:
                return {
                    "ok": False,
                    "summary": "mini-swe-agent task execution failed",
                    "stderr": str(exc),
                    "exitCode": 1,
                }

        if _messages_indicate_missing_tool_calls(agent_messages):
            if broker_enabled:
                log.info("mini-swe-agent exited without tool calls; falling back to tool broker shim.")
                broker_result = _broker_run(
                    repo,
                    instruction=_compose_instruction(),
                    llm=llm_cfg,
                    timeout_ms=timeout_ms,
                    explicit_targets=explicit_targets,
                    write_globs=explicit_write_globs,
                )
                if not bool(broker_result.get("ok")):
                    return {
                        "ok": False,
                        "summary": str(broker_result.get("summary") or "tool broker fallback failed"),
                        "stdout": str(broker_result.get("stdout") or ""),
                        "stderr": str(broker_result.get("stderr") or ""),
                        "exitCode": to_int(broker_result.get("exitCode"), 3),
                    }
                exit_info = {"submission": broker_result.get("stdout") or ""}
            else:
                return {
                    "ok": False,
                    "summary": "mini-swe-agent could not execute: model did not emit tool calls",
                    "stderr": (
                        "Agentic execution requires a tool-calling-capable model/runtime. "
                        "The model output did not include any tool calls.\n"
                        "Fix options:\n"
                        "- Enable the tool broker shim: WORKERPALS_MINISWE_TOOL_BROKER=1, or\n"
                        "- Use a model/runtime with function-calling support."
                    ),
                    "exitCode": 3,
                }

    # Extract the agent's conversational output from its message history (or broker transcript).
    agent_text = ""
    try:
        agent_text = str(exit_info.get("submission") or "").strip()
        if not agent_text and agent is not None and hasattr(agent, "messages"):
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

    # Build stdout: include agent/broker text output followed by file change info.
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
        "summary": "Executed task (no file changes detected)",
        "stdout": "\n\n".join(stdout_parts),
        "stderr": "",
        "exitCode": 0,
    }


# ─── Main entry point ───────────────────────────────────────────────────────

def main() -> int:
    try:
        task = parse_task_execute_payload(sys.argv, logger=log)
        result = _run_miniswe_task(
            task.repo, task.instruction, task.payload, task.supplemental_guidance,
        )
    except Exception as exc:
        result = {
            "ok": False,
            "summary": "miniswe wrapper crashed while executing task.execute",
            "stdout": "",
            "stderr": traceback.format_exc(),
            "exitCode": 1,
            "error": to_single_line(exc, 300),
        }
    emit(result)
    return 0 if bool(result.get("ok")) else to_int(result.get("exitCode"), 1)


if __name__ == "__main__":
    raise SystemExit(main())
