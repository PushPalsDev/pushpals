import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SHARED = _HERE.parent / "shared"
for path in (_HERE, _SHARED):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from executor_base import SettingsResolver
from openai_codex_executor import (
    OpenAICodexRuntimeConfig,
    _build_instruction,
    _detect_codex_workaround_signal,
    _load_prompt_template,
    _repo_root_for_prompt_loading,
)


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

    def test_build_instruction_includes_codex_runtime_invariants(self) -> None:
        prompt = _build_instruction("Add two tests for localbuddy", [])
        self.assertIn("Codex CLI is required infrastructure", prompt)
        self.assertIn("Runtime policy guardrails (mandatory):", prompt)
        self.assertIn("Canonical task instruction", prompt)
        self.assertIn("Add two tests for localbuddy", prompt)

    def test_build_instruction_appends_supplemental_guidance(self) -> None:
        prompt = _build_instruction(
            "Fix flaky request-status tests",
            ["Keep assertions strict", "Run bun test tests/localbuddy.request-status.test.ts"],
        )
        self.assertIn("Supplemental execution guidance", prompt)
        self.assertIn("Keep assertions strict", prompt)
        self.assertIn("bun test tests/localbuddy.request-status.test.ts", prompt)

    def test_detects_codex_workaround_signals(self) -> None:
        signal = _detect_codex_workaround_signal(
            "Adapting test to avoid external Codex calls because Codex CLI isn't available in this environment.",
        )
        self.assertIsNotNone(signal)

    def test_detects_explicit_fallback_language(self) -> None:
        signal = _detect_codex_workaround_signal(
            "Codex CLI isn't available, so I switched to a fallback and continued with edits.",
        )
        self.assertIsNotNone(signal)

    def test_ignores_normal_codex_status_messages(self) -> None:
        signal = _detect_codex_workaround_signal(
            "Codex CLI login status is ready and task execution can proceed.",
        )
        self.assertIsNone(signal)

    def test_ignores_policy_instruction_text(self) -> None:
        signal = _detect_codex_workaround_signal(
            "If Codex CLI auth/execution is unavailable, fail loudly with a clear error and stop; do not apply non-Codex workarounds.",
        )
        self.assertIsNone(signal)

    def test_discovers_repo_root_for_prompt_loading(self) -> None:
        repo_root = _repo_root_for_prompt_loading()
        self.assertTrue((repo_root / "prompts").is_dir())

    def test_loads_openai_codex_task_prompt_template(self) -> None:
        template = _load_prompt_template("workerpals/openai_codex_task_execute_system_prompt.md")
        self.assertIn("Codex CLI is required infrastructure", template)


if __name__ == "__main__":
    unittest.main()
