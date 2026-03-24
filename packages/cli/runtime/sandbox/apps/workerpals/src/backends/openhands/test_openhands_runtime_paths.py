import os
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SHARED = _HERE.parent / "shared"
for path in (_HERE, _SHARED):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from openhands_executor import _PROMPT_TEMPLATE_CACHE, _load_prompt_template, _resolve_prompt_file


class OpenHandsRuntimePathTests(unittest.TestCase):
    def test_prompt_resolution_prefers_explicit_prompt_root_override(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-openhands-prompts-") as root:
            repo_root = Path(root) / "repo"
            runtime_root = Path(root) / "runtime"
            repo_prompt = repo_root / "prompts" / "workerpals" / "openhands_strict_tool_use_message.md"
            runtime_prompt = (
                runtime_root / "prompts" / "workerpals" / "openhands_strict_tool_use_message.md"
            )
            repo_prompt.parent.mkdir(parents=True, exist_ok=True)
            runtime_prompt.parent.mkdir(parents=True, exist_ok=True)
            repo_prompt.write_text("repo prompt", encoding="utf-8")
            runtime_prompt.write_text("runtime prompt", encoding="utf-8")

            previous_env = {
                "PUSHPALS_REPO_PATH": os.environ.get("PUSHPALS_REPO_PATH"),
                "PUSHPALS_PROMPTS_ROOT_OVERRIDE": os.environ.get("PUSHPALS_PROMPTS_ROOT_OVERRIDE"),
            }
            previous_cache = dict(_PROMPT_TEMPLATE_CACHE)
            try:
                os.environ["PUSHPALS_REPO_PATH"] = str(repo_root)
                os.environ["PUSHPALS_PROMPTS_ROOT_OVERRIDE"] = str(runtime_root)
                _PROMPT_TEMPLATE_CACHE.clear()

                resolved = _resolve_prompt_file("workerpals/openhands_strict_tool_use_message.md")
                self.assertEqual(resolved, runtime_prompt)
                self.assertEqual(
                    _load_prompt_template("workerpals/openhands_strict_tool_use_message.md"),
                    "runtime prompt",
                )
            finally:
                _PROMPT_TEMPLATE_CACHE.clear()
                _PROMPT_TEMPLATE_CACHE.update(previous_cache)
                for key, value in previous_env.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value


if __name__ == "__main__":
    unittest.main()
