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
import urllib.error
import urllib.request
from contextlib import nullcontext
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ "
PROMPT_TOKEN_REGEX = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")
_PROMPT_TEMPLATE_CACHE: Dict[str, str] = {}


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
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    return base


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


def _resolve_llm_config() -> Tuple[str, str, str]:
    model = (
        os.environ.get("WORKERPALS_OPENHANDS_MODEL")
        or os.environ.get("LLM_MODEL")
        or ""
    ).strip()
    api_key = (
        os.environ.get("WORKERPALS_OPENHANDS_API_KEY")
        or os.environ.get("LLM_API_KEY")
        or ""
    ).strip()
    base_url = _normalize_base_url(
        (
            os.environ.get("WORKERPALS_OPENHANDS_BASE_URL")
            or os.environ.get("LLM_BASE_URL")
            or os.environ.get("LLM_ENDPOINT")
            or ""
        )
    )
    return model, api_key, base_url


def _repo_root_for_prompt_loading() -> Path:
    explicit = (os.environ.get("PUSHPALS_REPO_PATH") or "").strip()
    if explicit:
        return Path(explicit)
    return Path(__file__).resolve().parents[3]


def _load_prompt_template(
    relative_path: str, replacements: Optional[Dict[str, str]] = None
) -> str:
    prompt_path = _repo_root_for_prompt_loading() / "prompts" / relative_path
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


def _run_agentic_task_execute(repo: str, instruction: str) -> Dict[str, Any]:
    try:
        from openhands.sdk import Agent, Conversation, LLM, Tool
        from openhands.tools.file_editor import FileEditorTool
        from openhands.tools.task_tracker import TaskTrackerTool
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
                "Set WORKERPALS_OPENHANDS_MODEL or LLM_MODEL."
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
                    "Set WORKERPALS_OPENHANDS_API_KEY or LLM_API_KEY."
                ),
                "stderr": "",
                "exitCode": 2,
            }

    llm_kwargs: Dict[str, Any] = {"model": model, "api_key": api_key}
    if base_url:
        llm_kwargs["base_url"] = base_url

    try:
        llm = LLM(**llm_kwargs)
        tools = [
            Tool(name=TerminalTool.name),
            Tool(name=FileEditorTool.name),
            Tool(name=TaskTrackerTool.name),
        ]
        agent = Agent(llm=llm, tools=tools)
        conversation = Conversation(agent=agent, workspace=repo)

        system_prompt = _load_prompt_template(
            "workerpals/openhands_task_execute_system_prompt.txt"
        )
        conversation.send_message(f"{system_prompt}\n\nTask:\n{instruction}")

        max_steps = max(1, _to_int(os.environ.get("WORKERPALS_OPENHANDS_AGENT_MAX_STEPS"), 30))
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
            or params.get("enhancedPrompt")
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
        target_path = str(params.get("targetPath") or params.get("path") or "").strip()
        if not target_path:
            target_path = _extract_target_path_from_instruction(instruction)
        if not target_path:
            raise ValueError("task.execute requires targetPath (or a file name in instruction)")

        recent_jobs_payload = base64.b64encode(
            json.dumps(params.get("recentJobs", []), ensure_ascii=True).encode("utf-8")
        ).decode("ascii")
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

    if kind == "task.execute":
        instruction = str(
            params.get("instruction") or params.get("enhancedPrompt") or ""
        ).strip()
        if not instruction:
            return _fail("task.execute requires 'instruction'", exit_code=2)
        target_path = str(params.get("targetPath") or params.get("path") or "").strip()
        if not target_path:
            target_path = _extract_target_path_from_instruction(instruction)
        if not target_path:
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
