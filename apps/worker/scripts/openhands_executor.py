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
import re
import shlex
import sys
from typing import Any, Dict, Optional, Tuple


RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ "


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
        str(
            (
                __import__("os").environ.get("WORKER_OPENHANDS_WORKSPACE_PYTHON")
                or "python3"
            )
        )
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


def _job_to_command(kind: str, params: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
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
        return (
            "printf 'Branch: '; git rev-parse --abbrev-ref HEAD; "
            "printf '\\nRecent commits:\\n'; git log --oneline -n 5; "
            "printf '\\nWorking tree:\\n'; git status --porcelain"
        ), None

    if kind == "shell.exec":
        return str(req("command")), None

    if kind == "file.write":
        path = str(req("path"))
        content = str(req("content"))
        payload = base64.b64encode(content.encode("utf-8")).decode("ascii")
        script = f"""
import base64
from pathlib import Path

path = Path({json.dumps(path)})
path.parent.mkdir(parents=True, exist_ok=True)
content = base64.b64decode({json.dumps(payload)}).decode("utf-8")
path.write_text(content, encoding="utf-8")
print(f"Wrote {{len(content)}} bytes to {path}")
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

    try:
        from openhands.sdk import LocalAgentServer, Workspace
    except Exception as exc:
        return _fail(
            "OpenHands SDK is not available in worker runtime. "
            "Install openhands-sdk/openhands-agent-server/openhands-workspace.",
            stderr=str(exc),
            exit_code=3,
        )

    try:
        cmd, preferred_summary = _job_to_command(kind, params)
    except Exception as exc:
        return _fail(str(exc), exit_code=2)

    if not cmd:
        return _fail(f"Unknown job kind: {kind}", exit_code=2)

    try:
        with LocalAgentServer() as server:
            with Workspace(host=server.base_url, working_dir=repo) as workspace:
                raw_result = workspace.execute_command(cmd)
                exit_code, stdout, stderr = _parse_workspace_result(raw_result)
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
