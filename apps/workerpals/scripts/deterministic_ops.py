#!/usr/bin/env python3
"""
Deterministic helper operations invoked by openhands_executor.py.

Usage:
  python deterministic_ops.py <base64-json-payload>
"""

from __future__ import annotations

import base64
import json
import re
import shutil
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List


IGNORE_DIRS = {
    ".git",
    "node_modules",
    "outputs",
    ".worktrees",
    "workspace",
    ".venv",
    "dist",
    "build",
}

DEFAULT_TASK_SUMMARY_FILENAME = "task_summary.md"


def _decode_payload(raw: str) -> Dict[str, Any]:
    decoded = base64.b64decode(raw).decode("utf-8")
    payload = json.loads(decoded)
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    return payload


def _extract_target_path_from_instruction(instruction: str) -> str:
    m = re.search(
        r"(?:file\s+(?:called|named)|create\s+(?:a\s+)?file|write\s+(?:to|into))\s+[\"'`]?(?P<path>[^\"'`\s]+)",
        instruction,
        flags=re.I,
    )
    if not m:
        return ""
    return str(m.group("path") or "").strip().rstrip(".,!?;:")


def _repo_root(payload: Dict[str, Any]) -> Path:
    raw = str(payload.get("repoRoot") or ".").strip()
    return Path(raw).resolve()


def _resolve_in_repo(repo_root: Path, raw_path: str) -> Path:
    path_in = Path(raw_path)
    path = (path_in if path_in.is_absolute() else (repo_root / path_in)).resolve()
    if repo_root not in path.parents and path != repo_root:
        raise SystemExit(f"Refusing to access outside repo: {path}")
    return path


def _resolve_task_summary_target(repo_root: Path, raw_target_path: str) -> Path:
    target = _resolve_in_repo(repo_root, raw_target_path)
    raw_trimmed = str(raw_target_path or "").strip()
    # If the provided path is (or looks like) a directory, write into a stable default file.
    looks_like_dir = raw_trimmed.endswith("/") or raw_trimmed.endswith("\\")
    if target.exists() and target.is_dir():
        return target / DEFAULT_TASK_SUMMARY_FILENAME
    if looks_like_dir:
        return target / DEFAULT_TASK_SUMMARY_FILENAME
    if target.suffix == "":
        return target / DEFAULT_TASK_SUMMARY_FILENAME
    return target


def _tree(base: Path, depth: int, prefix: str = "") -> List[str]:
    if depth < 0:
        return []
    lines: List[str] = []
    try:
        entries = sorted(base.iterdir(), key=lambda p: p.name.lower())
    except Exception:
        return lines
    for entry in entries:
        name = entry.name
        if name.startswith(".") and name != ".env.example":
            continue
        if name in IGNORE_DIRS:
            continue
        suffix = "/" if entry.is_dir() else ""
        lines.append(f"{prefix}- {name}{suffix}")
        if entry.is_dir() and depth > 0 and len(lines) < 120:
            lines.extend(_tree(entry, depth - 1, prefix + "  "))
        if len(lines) >= 120:
            break
    return lines


def _summarize_recent_jobs(value: Any, limit: int = 6) -> List[str]:
    if not isinstance(value, list):
        return []
    out: List[str] = []
    for row in value[:limit]:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("kind", "")).strip()
        status = str(row.get("status", "")).strip()
        summary = str(row.get("summary", "")).replace("\n", " ").strip()
        error = str(row.get("error", "")).replace("\n", " ").strip()
        tail = summary or error
        if tail:
            out.append(f"- {kind} [{status}]: {tail}"[:220])
        elif kind or status:
            out.append(f"- {kind} [{status}]")
    return out


def _build_repo_summary(
    repo_root: Path,
    instruction: str,
    recent_jobs: Any,
    footer: str,
) -> str:
    readme_excerpt = ""
    readme = repo_root / "README.md"
    if readme.exists():
        try:
            readme_excerpt = readme.read_text(encoding="utf-8")[:2400].strip()
        except Exception:
            readme_excerpt = ""

    lines: List[str] = []
    lines.append("# Repository Architecture")
    lines.append("")
    lines.append(f"Requested task: {instruction}")
    lines.append("")
    lines.append("## Top-level Structure")
    lines.extend(_tree(repo_root, 1))
    if readme_excerpt:
        lines.append("")
        lines.append("## README Excerpt")
        lines.append(readme_excerpt)

    job_lines = _summarize_recent_jobs(recent_jobs)
    if job_lines:
        lines.append("")
        lines.append("## Recent Worker Job Context")
        lines.extend(job_lines)

    lines.append("")
    lines.append(footer)
    return "\n".join(lines).strip() + "\n"


def _op_project_summary(payload: Dict[str, Any]) -> None:
    repo_root = _repo_root(payload)
    instruction = str(
        payload.get("instruction")
        or "Summarize repository architecture and key components."
    )
    content = _build_repo_summary(
        repo_root,
        instruction,
        payload.get("recentJobs", []),
        "Generated by worker project.summary from repository state. Review and refine as needed.",
    )
    print(content)


def _op_task_summary(payload: Dict[str, Any]) -> None:
    repo_root = _repo_root(payload)
    instruction = str(payload.get("instruction") or "")
    lane = str(payload.get("lane") or "openhands").strip().lower()
    target_path = str(payload.get("targetPath") or "").strip()
    if not target_path:
        target_path = _extract_target_path_from_instruction(instruction)
    content = _build_repo_summary(
        repo_root,
        instruction,
        payload.get("recentJobs", []),
        f"Generated by worker task.execute (lane={lane}) from repository state.",
    )

    if target_path:
        target = _resolve_task_summary_target(repo_root, target_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        display = target.relative_to(repo_root) if target != repo_root else Path(".")
        print(f"Wrote {len(content)} bytes to {display}")
        return

    print(content)


def _op_file_write(payload: Dict[str, Any]) -> None:
    repo_root = _repo_root(payload)
    path = _resolve_in_repo(repo_root, str(payload.get("path") or ""))
    content = str(payload.get("content") or "")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    display = path.relative_to(repo_root) if path != repo_root else Path(".")
    print(f"Wrote {len(content)} bytes to {display}")


def _op_file_patch(payload: Dict[str, Any]) -> None:
    repo_root = _repo_root(payload)
    path = _resolve_in_repo(repo_root, str(payload.get("path") or ""))
    old_text = str(payload.get("oldText") or "")
    new_text = str(payload.get("newText") or "")
    current = path.read_text(encoding="utf-8")
    if old_text not in current:
        raise SystemExit("oldText not found in file")
    updated = current.replace(old_text, new_text, 1)
    path.write_text(updated, encoding="utf-8")
    print(f"Patched {path}")


def _op_file_rename(payload: Dict[str, Any]) -> None:
    repo_root = _repo_root(payload)
    src = _resolve_in_repo(repo_root, str(payload.get("from") or ""))
    dst = _resolve_in_repo(repo_root, str(payload.get("to") or ""))
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    print(f"Renamed {src} -> {dst}")


def _op_file_delete(payload: Dict[str, Any]) -> None:
    repo_root = _repo_root(payload)
    path = _resolve_in_repo(repo_root, str(payload.get("path") or ""))
    if path.is_dir():
        shutil.rmtree(path)
        print(f"Deleted directory {path}")
    else:
        path.unlink()
        print(f"Deleted {path}")


def _op_file_copy(payload: Dict[str, Any]) -> None:
    repo_root = _repo_root(payload)
    src = _resolve_in_repo(repo_root, str(payload.get("from") or ""))
    dst = _resolve_in_repo(repo_root, str(payload.get("to") or ""))
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    print(f"Copied {src} -> {dst}")


def _op_file_append(payload: Dict[str, Any]) -> None:
    repo_root = _repo_root(payload)
    path = _resolve_in_repo(repo_root, str(payload.get("path") or ""))
    content = str(payload.get("content") or "")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(content)
    print(f"Appended {len(content)} bytes to {path}")


def _op_file_mkdir(payload: Dict[str, Any]) -> None:
    repo_root = _repo_root(payload)
    path = _resolve_in_repo(repo_root, str(payload.get("path") or ""))
    path.mkdir(parents=True, exist_ok=True)
    print(f"Created directory {path}")


def _op_web_fetch(payload: Dict[str, Any]) -> None:
    url = str(payload.get("url") or "")
    req = urllib.request.Request(url, headers={"User-Agent": "PushPals/1.0"})
    with urllib.request.urlopen(req, timeout=25) as res:
        body = res.read().decode("utf-8", errors="replace")
        content_type = (res.headers.get("content-type") or "").lower()

    if "html" in content_type:
        body = re.sub(r"<script[^>]*>[\s\S]*?</script>", "", body, flags=re.I)
        body = re.sub(r"<style[^>]*>[\s\S]*?</style>", "", body, flags=re.I)
        body = re.sub(r"<[^>]+>", " ", body)
        body = re.sub(r"\s+", " ", body).strip()

    print(body)


def _op_web_search(payload: Dict[str, Any]) -> None:
    query = str(payload.get("query") or "")
    url = "https://lite.duckduckgo.com/lite/?q=" + urllib.parse.quote(query)
    req = urllib.request.Request(url, headers={"User-Agent": "PushPals/1.0"})
    with urllib.request.urlopen(req, timeout=20) as res:
        html = res.read().decode("utf-8", errors="replace")

    links = re.findall(r'<a[^>]+href="(https?://[^"]+)"[^>]*>([^<]+)</a>', html, re.I)
    rows: List[str] = []
    for href, title in links:
        if "duckduckgo.com" in href:
            continue
        rows.append(f"{len(rows)+1}. {title.strip()}\n  {href}")
        if len(rows) >= 10:
            break
    print("\n\n".join(rows) if rows else "No results found.")


OPS = {
    "project.summary": _op_project_summary,
    "task.summary": _op_task_summary,
    "file.write": _op_file_write,
    "file.patch": _op_file_patch,
    "file.rename": _op_file_rename,
    "file.delete": _op_file_delete,
    "file.copy": _op_file_copy,
    "file.append": _op_file_append,
    "file.mkdir": _op_file_mkdir,
    "web.fetch": _op_web_fetch,
    "web.search": _op_web_search,
}


def main() -> int:
    if len(sys.argv) < 2:
        print("Missing base64 payload", file=sys.stderr)
        return 2
    payload = _decode_payload(sys.argv[1])
    op = str(payload.get("op") or "").strip()
    fn = OPS.get(op)
    if fn is None:
        print(f"Unknown op: {op}", file=sys.stderr)
        return 2
    fn(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
