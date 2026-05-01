import os
import re
import json
import subprocess
import sys
import unittest
import tempfile
from unittest import mock
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SHARED = _HERE.parent / "shared"
for path in (_HERE, _SHARED):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from executor_base import (
    LOGGER_STANDARD_METHODS,
    Logger,
    SettingsResolver,
    config_dir_for_runtime_config,
    runtime_config,
)
from openai_codex_executor import (
    OpenAICodexRuntimeConfig,
    _augment_supplemental_guidance,
    _build_wrapper_recovery_guidance,
    _run_codex_task,
    _resolve_reasoning_effort,
    _build_instruction,
    _collect_disallowed_shell_wrapper_rejections,
    _detect_codex_workaround_signal,
    _extract_usage_counts,
    _load_prompt_template,
    _repo_root_for_prompt_loading,
    _unwrap_shell_wrapper_command,
    _usage_from_trace_or_estimate,
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
        self.assertEqual(cfg.reasoning_effort, "high")
        self.assertFalse(cfg.json_output)

    def test_reasoning_effort_caps_extra_high_for_gpt_5_4(self) -> None:
        cfg = OpenAICodexRuntimeConfig.from_sources(
            SettingsResolver(
                env={"WORKERPALS_OPENAI_CODEX_REASONING_EFFORT": "extra high"},
                config_loader=lambda: {},
            ),
        )
        self.assertEqual(_resolve_reasoning_effort(cfg), "high")

    def test_reasoning_effort_preserves_extra_high_for_future_models(self) -> None:
        cfg = OpenAICodexRuntimeConfig.from_sources(
            SettingsResolver(
                env={"WORKERPALS_OPENAI_CODEX_REASONING_EFFORT": "extra high"},
                config_loader=lambda: {},
            ),
        )
        self.assertEqual(_resolve_reasoning_effort(cfg, model="gpt-6-preview"), "xhigh")

    def test_runtime_config_prefers_explicit_config_dir_override(self) -> None:
        import executor_base

        with tempfile.TemporaryDirectory(prefix="pushpals-openai-codex-config-") as root:
            repo_root = Path(root) / "repo"
            runtime_config_dir = Path(root) / "runtime" / "configs"
            repo_config_dir = repo_root / "configs"
            runtime_config_dir.mkdir(parents=True, exist_ok=True)
            repo_config_dir.mkdir(parents=True, exist_ok=True)

            (runtime_config_dir / "default.toml").write_text(
                'profile = "dev"\n[workerpals.openai_codex]\njson = true\n',
                encoding="utf-8",
            )
            (repo_config_dir / "default.toml").write_text(
                'profile = "dev"\n[workerpals.openai_codex]\njson = false\n',
                encoding="utf-8",
            )

            previous_env = {
                "PUSHPALS_REPO_PATH": os.environ.get("PUSHPALS_REPO_PATH"),
                "PUSHPALS_CONFIG_DIR_OVERRIDE": os.environ.get("PUSHPALS_CONFIG_DIR_OVERRIDE"),
                "PUSHPALS_PROFILE": os.environ.get("PUSHPALS_PROFILE"),
            }
            previous_cache = executor_base._CONFIG_CACHE
            try:
                os.environ["PUSHPALS_REPO_PATH"] = str(repo_root)
                os.environ["PUSHPALS_CONFIG_DIR_OVERRIDE"] = str(runtime_config_dir)
                os.environ["PUSHPALS_PROFILE"] = "dev"
                executor_base._CONFIG_CACHE = None

                self.assertEqual(config_dir_for_runtime_config(), runtime_config_dir)
                cfg = runtime_config()
                self.assertTrue(cfg["workerpals"]["openai_codex"]["json"])
            finally:
                executor_base._CONFIG_CACHE = previous_cache
                for key, value in previous_env.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value

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

    def test_ignores_generic_workaround_language_without_unavailable_codex_context(self) -> None:
        signal = _detect_codex_workaround_signal(
            "This is a workaround case, so I am stopping here until the command router issue is fixed.",
        )
        self.assertIsNone(signal)

    def test_discovers_repo_root_for_prompt_loading(self) -> None:
        repo_root = _repo_root_for_prompt_loading()
        self.assertTrue((repo_root / "prompts").is_dir())

    def test_loads_openai_codex_task_prompt_template(self) -> None:
        template = _load_prompt_template("workerpals/openai_codex_task_execute_system_prompt.md")
        self.assertIn("Codex CLI is required infrastructure", template)
        self.assertIn("Use direct commands without shell wrappers", template)

    def test_extracts_usage_counts_from_nested_json_event(self) -> None:
        usage = _extract_usage_counts(
            {
                "type": "response.completed",
                "response": {
                    "usage": {
                        "input_tokens": 120,
                        "output_tokens": 30,
                        "total_tokens": 150,
                    }
                },
            }
        )
        self.assertEqual(
            usage,
            {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150},
        )

    def test_collects_disallowed_shell_wrapper_rejections(self) -> None:
        commands = _collect_disallowed_shell_wrapper_rejections(
            "error=exec_command failed for `/bin/bash -lc pwd`: CreateProcess { message: \"Rejected\" }",
            "error=exec_command failed for `/bin/bash -c \"git status --porcelain\"`: Rejected",
            "error=exec_command failed for `sh -lc \"git diff\"`: Rejected",
            "error=exec_command failed for `pwd`: Rejected",
        )
        self.assertEqual(
            commands,
            ["/bin/bash -lc pwd", '/bin/bash -c "git status --porcelain"', 'sh -lc "git diff"'],
        )

    def test_unwraps_disallowed_shell_wrapper_commands_to_direct_commands(self) -> None:
        self.assertEqual(
            _unwrap_shell_wrapper_command("/bin/bash -lc 'git diff --name-only'"),
            "git diff --name-only",
        )
        self.assertEqual(
            _unwrap_shell_wrapper_command('cmd /c dir /b'),
            "dir /b",
        )
        self.assertEqual(
            _unwrap_shell_wrapper_command('pwsh -Command "Get-ChildItem src"'),
            "Get-ChildItem src",
        )

    def test_logger_supports_warning_alias_used_by_recovery_paths(self) -> None:
        logger = Logger("[test]")
        self.assertTrue(callable(getattr(logger, "warn", None)))
        self.assertTrue(callable(getattr(logger, "warning", None)))

    def test_logger_supports_standard_backend_method_surface(self) -> None:
        logger = Logger("[test]")
        for method_name in LOGGER_STANDARD_METHODS:
            self.assertTrue(
                callable(getattr(logger, method_name, None)),
                f"Logger is missing required method: {method_name}",
            )

    def test_backend_log_method_usage_matches_shared_logger_contract(self) -> None:
        backend_root = _HERE.parent
        method_pattern = re.compile(r"\blog\.(\w+)\(")
        used_methods = set()
        for path in backend_root.rglob("*.py"):
            if path.name.startswith("test_"):
                continue
            text = path.read_text(encoding="utf-8")
            used_methods.update(method_pattern.findall(text))

        self.assertTrue(used_methods, "Expected to discover backend logger usage")
        unsupported = sorted(method for method in used_methods if method not in LOGGER_STANDARD_METHODS)
        self.assertEqual(
            unsupported,
            [],
            f"Backend code uses logger method(s) not covered by executor_base.Logger: {unsupported}",
        )

    def test_augments_guidance_with_direct_command_policy_once(self) -> None:
        guidance = _augment_supplemental_guidance(["Run bun test tests/example.test.ts"])
        self.assertGreaterEqual(len(guidance), 2)
        self.assertIn("shell commands are allowed", guidance[0].lower())
        guidance_again = _augment_supplemental_guidance(guidance)
        self.assertEqual(guidance_again, guidance)

    def test_wrapper_recovery_guidance_allows_arbitrary_shell_commands_without_wrappers(self) -> None:
        guidance = _build_wrapper_recovery_guidance(
            ["/bin/bash -lc 'git status --porcelain'", "/bin/bash -lc pwd"]
        )
        lowered = guidance.lower()
        self.assertIn("shell commands normally", lowered)
        self.assertIn("not limited to a fixed allowlist", lowered)
        self.assertIn("`/bin/bash -lc 'git status --porcelain'` -> `git status --porcelain`", guidance)

    def test_wrapper_hard_recovery_guidance_requires_direct_replacements_first(self) -> None:
        guidance = _build_wrapper_recovery_guidance(
            ["/bin/bash -lc 'git status --porcelain'", "/bin/bash -lc pwd"],
            hard=True,
        )
        lowered = guidance.lower()
        self.assertIn("previous retry still attempted disallowed shell wrappers", lowered)
        self.assertIn("do not invoke `bash`", lowered)
        self.assertIn("first command invocation on this retry must be one of the direct replacements", lowered)
        self.assertIn("`/bin/bash -lc 'git status --porcelain'` -> `git status --porcelain`", guidance)

    def test_run_codex_task_escalates_wrapper_recovery_and_recovers(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-wrapper-recovery-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# wrapper recovery test\n", encoding="utf-8")
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
            subprocess.run(
                ["git", "config", "user.name", "PushPals Test"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )
            subprocess.run(
                ["git", "config", "user.email", "pushpals-tests@example.com"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )
            subprocess.run(["git", "add", "README.md"], cwd=repo, check=True, capture_output=True, text=True)
            subprocess.run(
                ["git", "commit", "-m", "chore: seed wrapper recovery repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_wrapper_recovery.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "from pathlib import Path",
                        "import sys",
                        "import time",
                        "",
                        "argv = sys.argv[1:]",
                        "last_message_path = None",
                        "for index, arg in enumerate(argv):",
                        "    if arg == '--output-last-message' and index + 1 < len(argv):",
                        "        last_message_path = argv[index + 1]",
                        "        break",
                        "",
                        "prompt = sys.stdin.read()",
                        "hard_marker = 'Your first command invocation on this retry must be one of the direct replacements listed below'",
                        "if hard_marker in prompt:",
                        "    if last_message_path:",
                        "        Path(last_message_path).write_text(",
                        "            'Recovered by switching to direct commands after strict wrapper recovery.',",
                        "            encoding='utf-8',",
                        "        )",
                        "    print('item.completed | Used direct commands after strict recovery guidance.', flush=True)",
                        "    sys.exit(0)",
                        "",
                        "for line in (",
                        "    'error=exec_command failed for `/bin/bash -lc pwd`: CreateProcess { message: \"Rejected\" }',",
                        "    'error=exec_command failed for `/bin/bash -lc \\'git branch --show-current\\'`: CreateProcess { message: \"Rejected\" }',",
                        "    'error=exec_command failed for `/bin/bash -lc ls`: CreateProcess { message: \"Rejected\" }',",
                        "    'error=exec_command failed for `/bin/bash -lc \\'git status --porcelain\\'`: CreateProcess { message: \"Rejected\" }',",
                        "):",
                        "    print(line, file=sys.stderr, flush=True)",
                        "time.sleep(10)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-wrapper-recovery-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "10",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Inspect the repo and report the current branch.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertIn("Recovered after Codex attempts hit command-router shell-wrapper rejections.", str(result.get("stdout") or ""))
        self.assertIn("strict wrapper recovery", str(result.get("stdout") or "").lower())

    def test_usage_falls_back_to_estimate_when_trace_has_no_usage(self) -> None:
        usage = _usage_from_trace_or_estimate({}, "abc" * 30, "done", model="gpt-5.4")
        self.assertTrue(usage["estimated"])
        self.assertEqual(usage["backend"], "openai_codex")
        self.assertEqual(usage["modelId"], "gpt-5.4")
        self.assertGreater(usage["promptTokens"], 0)
        self.assertGreater(usage["totalTokens"], usage["completionTokens"])


if __name__ == "__main__":
    unittest.main()
