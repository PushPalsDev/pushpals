import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SHARED = _HERE.parent / "shared"
for path in (_HERE, _SHARED):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from executor_base import SettingsResolver
from openai_codex_executor import OpenAICodexRuntimeConfig


class OpenAICodexRuntimeConfigTests(unittest.TestCase):
    def test_env_overrides_config_for_selected_fields(self) -> None:
        resolver = SettingsResolver(
            env={
                "PUSHPALS_OPENAI_CODEX_BIN": "bunx --yes @openai/codex",
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "chatgpt",
                "WORKERPALS_OPENAI_CODEX_JSON": "false",
            },
            config_loader=lambda: {
                "workerpals": {
                    "openai_codex": {
                        "bin": "codex",
                        "auth_mode": "api_key",
                        "json": True,
                        "sandbox": "workspace-write",
                    },
                    "llm": {
                        "reasoning_effort": "medium",
                    },
                }
            },
        )
        cfg = OpenAICodexRuntimeConfig.from_sources(resolver)
        self.assertEqual(cfg.codex_bin, "bunx --yes @openai/codex")
        self.assertEqual(cfg.auth_mode, "chatgpt")
        self.assertFalse(cfg.json_output)
        self.assertEqual(cfg.reasoning_effort, "medium")
        self.assertEqual(cfg.sandbox, "workspace-write")

    def test_defaults_apply_when_missing(self) -> None:
        cfg = OpenAICodexRuntimeConfig.from_sources(
            SettingsResolver(env={}, config_loader=lambda: {}),
        )
        self.assertEqual(cfg.auth_mode, "auto")
        self.assertEqual(cfg.approval_policy, "never")
        self.assertEqual(cfg.sandbox, "workspace-write")
        self.assertEqual(cfg.color, "never")
        self.assertFalse(cfg.json_output)


if __name__ == "__main__":
    unittest.main()
