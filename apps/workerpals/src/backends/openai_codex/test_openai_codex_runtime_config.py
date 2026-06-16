import base64
import os
import re
import json
import subprocess
import sys
import time
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
    parse_task_execute_payload,
    runtime_config,
)
from openai_codex_executor import (
    OpenAICodexRuntimeConfig,
    _augment_supplemental_guidance,
    _build_wrapper_bootstrap_context,
    _build_wrapper_recovery_guidance,
    _run_codex_task,
    _resolve_reasoning_effort,
    _resolve_task_reasoning_effort,
    _build_instruction,
    _build_no_edit_recovery_guidance,
    _build_rollout_recovery_guidance,
    _collect_disallowed_shell_wrapper_rejections,
    _codex_sandbox_additional_dirs,
    _codex_changed_paths,
    _capture_git_change_snapshot,
    _describe_non_publishable_paths,
    _detect_offtrack_rollout,
    _detect_codex_workaround_signal,
    _extract_usage_counts,
    _has_credible_shell_wrapper_progress,
    _load_prompt_template,
    _looks_like_validation_repair_prompt,
    _mask_repo_local_codex_files,
    _minimum_recovery_attempt_seconds,
    _repo_root_for_prompt_loading,
    _restore_repo_local_codex_files,
    _resolve_codex_command_prefix,
    _resolve_no_edit_command_grace_seconds,
    _resolve_no_edit_command_progress_cap_seconds,
    _resolve_no_edit_recheck_seconds,
    _resolve_no_edit_watchdog_seconds,
    _resolve_rollout_watchdog_seconds,
    _resolve_startup_stall_watchdog_seconds,
    _unwrap_shell_wrapper_command,
    _usage_from_trace_or_estimate,
)


def _link_test_directory(source: Path, destination: Path) -> None:
    try:
        os.symlink(source, destination, target_is_directory=True)
        return
    except OSError as exc:
        if os.name != "nt":
            raise
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(destination), str(source)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise unittest.SkipTest(
                f"could not create Windows directory link for test: {result.stderr or result.stdout or exc}"
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
        self.assertEqual(cfg.reasoning_effort, "xhigh")
        self.assertFalse(cfg.json_output)

    def test_masks_and_restores_repo_local_codex_file(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-mask-") as root:
            repo = Path(root) / "repo"
            repo.mkdir()
            codex_file = repo / ".codex"
            codex_file.write_text("tracked repo sentinel\n", encoding="utf-8")

            masked = _mask_repo_local_codex_files(str(repo), {})
            try:
                self.assertFalse(codex_file.exists())
                self.assertEqual(len(masked), 1)
                self.assertTrue(masked[0][1].exists())
            finally:
                _restore_repo_local_codex_files(masked)

            self.assertEqual(codex_file.read_text(encoding="utf-8"), "tracked repo sentinel\n")

    def test_masks_project_root_override_codex_file_for_worktree_runs(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-mask-root-") as root:
            project_root = Path(root) / "project"
            worktree = project_root / ".worktrees" / "job-123"
            worktree.mkdir(parents=True)
            root_codex_file = project_root / ".codex"
            worktree_codex_file = worktree / ".codex"
            root_codex_file.write_text("root sentinel\n", encoding="utf-8")
            worktree_codex_file.write_text("worktree sentinel\n", encoding="utf-8")

            masked = _mask_repo_local_codex_files(
                str(worktree),
                {"PUSHPALS_REPO_ROOT_OVERRIDE": str(project_root)},
            )
            try:
                self.assertFalse(root_codex_file.exists())
                self.assertFalse(worktree_codex_file.exists())
                self.assertEqual(len(masked), 2)
            finally:
                _restore_repo_local_codex_files(masked)

            self.assertEqual(root_codex_file.read_text(encoding="utf-8"), "root sentinel\n")
            self.assertEqual(worktree_codex_file.read_text(encoding="utf-8"), "worktree sentinel\n")

    def test_does_not_mask_repo_local_codex_directory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-mask-dir-") as root:
            repo = Path(root) / "repo"
            codex_dir = repo / ".codex"
            codex_dir.mkdir(parents=True)
            (codex_dir / "config.toml").write_text("[hooks]\n", encoding="utf-8")

            masked = _mask_repo_local_codex_files(str(repo), {})
            try:
                self.assertEqual(masked, [])
                self.assertTrue((codex_dir / "config.toml").exists())
            finally:
                _restore_repo_local_codex_files(masked)

    def test_reasoning_effort_defaults_to_extra_high_for_default_gpt_5_5(self) -> None:
        cfg = OpenAICodexRuntimeConfig.from_sources(
            SettingsResolver(env={}, config_loader=lambda: {}),
        )
        self.assertEqual(_resolve_reasoning_effort(cfg), "xhigh")

    def test_resolve_codex_command_prefix_resolves_configured_executable(self) -> None:
        cfg = OpenAICodexRuntimeConfig.from_sources(
            SettingsResolver(
                env={"PUSHPALS_OPENAI_CODEX_BIN": "bun x --yes @openai/codex"},
                config_loader=lambda: {},
            ),
        )
        with mock.patch(
            "openai_codex_executor.shutil_which",
            side_effect=lambda binary: {"bun": r"C:\Tools\bun.CMD"}.get(binary, ""),
        ):
            self.assertEqual(
                _resolve_codex_command_prefix(cfg),
                [r"C:\Tools\bun.CMD", "x", "--yes", "@openai/codex"],
            )

    def test_resolve_codex_command_prefix_resolves_fallback_executable(self) -> None:
        cfg = OpenAICodexRuntimeConfig.from_sources(
            SettingsResolver(env={}, config_loader=lambda: {}),
        )
        with mock.patch(
            "openai_codex_executor.shutil_which",
            side_effect=lambda binary: {"bunx": "/usr/local/bin/bunx" }.get(binary, ""),
        ):
            self.assertEqual(
                _resolve_codex_command_prefix(cfg),
                ["/usr/local/bin/bunx", "--yes", "@openai/codex"],
            )

    def test_codex_sandbox_additional_dirs_includes_linked_dependency_artifact(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-add-dir-") as root:
            project = Path(root) / "project"
            dependency_root = project / "node_modules"
            worktree = project / ".worktrees" / "job-123"
            dependency_root.mkdir(parents=True)
            worktree.mkdir(parents=True)
            _link_test_directory(dependency_root, worktree / "node_modules")

            self.assertEqual(
                _codex_sandbox_additional_dirs(str(worktree)),
                [str(dependency_root.resolve())],
            )

    def test_codex_sandbox_additional_dirs_skips_local_dependency_artifact(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-local-deps-") as root:
            repo = Path(root) / "repo"
            (repo / "node_modules").mkdir(parents=True)

            self.assertEqual(_codex_sandbox_additional_dirs(str(repo)), [])

    def test_run_codex_task_adds_linked_dependency_artifact_to_workspace_sandbox(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-add-dir-cmd-") as root:
            project = Path(root) / "project"
            dependency_root = project / "node_modules"
            worktree = project / ".worktrees" / "job-123"
            dependency_root.mkdir(parents=True)
            worktree.mkdir(parents=True)
            _link_test_directory(dependency_root, worktree / "node_modules")
            (worktree / "README.md").write_text("# add-dir command test\n", encoding="utf-8")
            subprocess.run(["git", "init"], cwd=worktree, check=True, capture_output=True, text=True)
            subprocess.run(
                ["git", "config", "user.name", "PushPals Test"],
                cwd=worktree,
                check=True,
                capture_output=True,
                text=True,
            )
            subprocess.run(
                ["git", "config", "user.email", "pushpals-tests@example.com"],
                cwd=worktree,
                check=True,
                capture_output=True,
                text=True,
            )
            subprocess.run(
                ["git", "add", "README.md"],
                cwd=worktree,
                check=True,
                capture_output=True,
                text=True,
            )
            subprocess.run(
                ["git", "commit", "-m", "chore: seed add-dir command repo"],
                cwd=worktree,
                check=True,
                capture_output=True,
                text=True,
            )

            argv_path = Path(root) / "codex-argv.json"
            stub_path = Path(root) / "fake_codex_add_dir.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "import json",
                        "import sys",
                        "from pathlib import Path",
                        "",
                        "argv = sys.argv[1:]",
                        f"Path({str(argv_path)!r}).write_text(json.dumps(argv), encoding='utf-8')",
                        "last_message_path = None",
                        "for index, arg in enumerate(argv):",
                        "    if arg == '--output-last-message' and index + 1 < len(argv):",
                        "        last_message_path = argv[index + 1]",
                        "        break",
                        "sys.stdin.read()",
                        "if last_message_path:",
                        "    Path(last_message_path).write_text('No changes needed.', encoding='utf-8')",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-add-dir-command-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "5",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                _run_codex_task(str(worktree), "Inspect dependency sandbox wiring.", [])

            argv = json.loads(argv_path.read_text(encoding="utf-8"))
            self.assertIn("exec", argv)
            self.assertIn("--add-dir", argv)
            add_dir_index = argv.index("--add-dir")
            self.assertEqual(argv[add_dir_index + 1], str(dependency_root.resolve()))

    def test_reasoning_effort_caps_extra_high_for_legacy_gpt_5_4(self) -> None:
        cfg = OpenAICodexRuntimeConfig.from_sources(
            SettingsResolver(
                env={"WORKERPALS_OPENAI_CODEX_REASONING_EFFORT": "extra high"},
                config_loader=lambda: {},
            ),
        )
        self.assertEqual(_resolve_reasoning_effort(cfg, model="gpt-5.4"), "high")

    def test_reasoning_effort_preserves_extra_high_for_default_gpt_5_5(self) -> None:
        cfg = OpenAICodexRuntimeConfig.from_sources(
            SettingsResolver(
                env={"WORKERPALS_OPENAI_CODEX_REASONING_EFFORT": "extra high"},
                config_loader=lambda: {},
            ),
        )
        self.assertEqual(_resolve_reasoning_effort(cfg), "xhigh")

    def test_reasoning_effort_preserves_extra_high_for_future_models(self) -> None:
        cfg = OpenAICodexRuntimeConfig.from_sources(
            SettingsResolver(
                env={"WORKERPALS_OPENAI_CODEX_REASONING_EFFORT": "extra high"},
                config_loader=lambda: {},
            ),
        )
        self.assertEqual(_resolve_reasoning_effort(cfg, model="gpt-6-preview"), "xhigh")

    def test_task_reasoning_effort_routes_compact_shell_tasks_to_high(self) -> None:
        prompt = (
            "Task planning contract from PushPals:\n"
            "- Planning summary: intent=code_change, risk=low, priority=normal\n"
            "- Route-entry/shell task rule: inspect the hinted route wrapper, then patch the owner.\n"
        )

        self.assertEqual(_resolve_task_reasoning_effort("xhigh", prompt, "gpt-5.5"), "high")
        self.assertEqual(_resolve_task_reasoning_effort("high", prompt, "gpt-5.5"), "high")
        self.assertEqual(
            _resolve_task_reasoning_effort(
                "xhigh",
                "Merge-conflict rebase task with risk=low wording in reviewer text.",
                "gpt-5.5",
            ),
            "xhigh",
        )

    def test_background_autonomy_uses_short_no_edit_and_rollout_watchdogs(self) -> None:
        prompt = (
            "Task planning contract from PushPals:\n"
            "- Planning summary: intent=code_change, risk=low, priority=background\n"
            "Make one narrow repo-native patch and avoid broad discovery.\n"
        )

        no_edit = _resolve_no_edit_watchdog_seconds(prompt, 1200)
        self.assertEqual(no_edit, 120)
        self.assertEqual(
            _resolve_no_edit_watchdog_seconds(prompt, 1200, recovery_attempt=1),
            90,
        )
        self.assertEqual(_resolve_rollout_watchdog_seconds(prompt, 1200, no_edit), 90)

    def test_background_autonomy_caps_patchless_command_progress_before_recovery_reserve(self) -> None:
        prompt = (
            "Task planning contract from PushPals:\n"
            "- Planning summary: intent=code_change, risk=low, priority=background\n"
            "- Origin=autonomy targetPaths=[app/__tests__/opportunity-graph.contract.test.ts]\n"
            "Add focused contract coverage without broad discovery.\n"
        )
        child_budget_s = 570

        with mock.patch.dict(
            os.environ,
            {
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_GRACE_S": "",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_PROGRESS_CAP_S": "",
                "WORKERPALS_OPENAI_CODEX_STARTUP_STALL_WATCHDOG_S": "",
            },
            clear=False,
        ):
            command_grace_s = _resolve_no_edit_command_grace_seconds(child_budget_s)
            command_cap_s = _resolve_no_edit_command_progress_cap_seconds(
                child_budget_s,
                command_grace_s,
                prompt=prompt,
            )
            startup_stall_s = _resolve_startup_stall_watchdog_seconds(child_budget_s)

        self.assertEqual(command_grace_s, 240)
        self.assertEqual(command_cap_s, 120)
        self.assertEqual(startup_stall_s, 210)
        first_attempt_patchless_ceiling_s = startup_stall_s + command_cap_s
        self.assertGreaterEqual(
            child_budget_s - first_attempt_patchless_ceiling_s,
            2 * _minimum_recovery_attempt_seconds(child_budget_s),
        )

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

    def test_parse_payload_adds_structured_planning_guidance(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-planning-guidance-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            payload = {
                "kind": "task.execute",
                "repo": str(repo),
                "params": {
                    "instruction": "Improve the game startup smoke path",
                    "schemaVersion": 2,
                    "planning": {
                        "intent": "code_change",
                        "riskLevel": "medium",
                        "queuePriority": "normal",
                        "queueWaitBudgetMs": 90_000,
                        "executionBudgetMs": 1_800_000,
                        "finalizationBudgetMs": 120_000,
                        "scope": {
                            "readAnywhere": True,
                            "writeAllowed": True,
                            "writeGlobs": ["app/**", "scripts/**"],
                        },
                        "targetPaths": ["app/__tests__/_layout.autonomy.test.ts"],
                        "discovery": {
                            "ripgrepQueries": ['rg "home-screen|web:e2e" app scripts'],
                            "likelyDirs": ["app", "scripts"],
                            "keywords": ["home-screen", "web:e2e"],
                        },
                        "acceptanceCriteria": ["Home shell startup is assertable"],
                        "validationSteps": ["bun test", "bun run web:e2e"],
                        "requiredValidationSteps": ["bun run web:e2e"],
                    },
                },
            }
            encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")

            task = parse_task_execute_payload(["executor", encoded], logger=Logger("[test]"))
            guidance = "\n".join(task.supplemental_guidance)

            self.assertIn("Worker speed/convergence contract", guidance)
            self.assertIn("roughly 20 minutes", guidance)
            self.assertIn("Task planning contract from PushPals", guidance)
            self.assertIn("Worker phase contract", guidance)
            self.assertIn("Write globs are relevance hints, not hard limits", guidance)
            self.assertIn("app/__tests__/_layout.autonomy.test.ts", guidance)
            self.assertIn("Home shell startup is assertable", guidance)
            self.assertIn("bun run web:e2e", guidance)

    def test_parse_payload_accepts_file_backed_payload_transport(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-payload-file-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            payload = {
                "kind": "task.execute",
                "repo": str(repo),
                "params": {"instruction": "Make one small publishable change"},
            }
            encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
            payload_file = Path(temp_dir) / "payload.b64"
            payload_file.write_text(encoded, encoding="utf-8")

            task = parse_task_execute_payload(
                ["executor", "--payload-file", str(payload_file)],
                logger=Logger("[test]"),
            )

            self.assertEqual(task.kind, "task.execute")
            self.assertEqual(task.repo, str(repo.resolve()))
            self.assertEqual(task.instruction, "Make one small publishable change")

    def test_parse_payload_accepts_positional_payload_file_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-payload-file-positional-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            payload = {
                "kind": "task.execute",
                "repo": str(repo),
                "params": {"instruction": "Recover from a direct-worker payload handoff"},
            }
            encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
            payload_file = Path(temp_dir) / "payload.b64"
            payload_file.write_text(encoded, encoding="utf-8")

            task = parse_task_execute_payload(
                ["executor", str(payload_file)],
                logger=Logger("[test]"),
            )

            self.assertEqual(task.kind, "task.execute")
            self.assertEqual(task.repo, str(repo.resolve()))
            self.assertEqual(task.instruction, "Recover from a direct-worker payload handoff")

    def test_parse_payload_accepts_unpadded_base64_payload(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-payload-unpadded-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            payload = {
                "kind": "task.execute",
                "repo": str(repo),
                "params": {"instruction": "Accept wrapper-normalized payload padding"},
            }
            encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
            unpadded = encoded.rstrip("=")

            task = parse_task_execute_payload(["executor", unpadded], logger=Logger("[test]"))

            self.assertEqual(task.kind, "task.execute")
            self.assertEqual(task.repo, str(repo.resolve()))
            self.assertEqual(task.instruction, "Accept wrapper-normalized payload padding")

    def test_parse_payload_accepts_raw_json_payload(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-payload-raw-json-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            payload = {
                "kind": "task.execute",
                "repo": str(repo),
                "params": {"instruction": "Accept raw JSON from a recovery wrapper"},
            }
            raw_json = json.dumps(payload)

            task = parse_task_execute_payload(["executor", raw_json], logger=Logger("[test]"))

            self.assertEqual(task.kind, "task.execute")
            self.assertEqual(task.repo, str(repo.resolve()))
            self.assertEqual(task.instruction, "Accept raw JSON from a recovery wrapper")

    def test_parse_payload_prefers_helper_tests_for_visual_derivation_tasks(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-visual-guidance-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            payload = {
                "kind": "task.execute",
                "repo": str(repo),
                "params": {
                    "instruction": (
                        "Improve battlefield readability by making planet ownership rings, "
                        "projectile trails, and danger cues clearer."
                    ),
                    "schemaVersion": 2,
                    "planning": {
                        "intent": "code_change",
                        "riskLevel": "medium",
                        "queuePriority": "normal",
                        "queueWaitBudgetMs": 90_000,
                        "executionBudgetMs": 1_800_000,
                        "finalizationBudgetMs": 120_000,
                        "scope": {"readAnywhere": True, "writeAllowed": True},
                        "targetPaths": ["app/game.tsx"],
                        "acceptanceCriteria": ["Projectile and ownership readability improve"],
                        "validationSteps": ["bun test app/__tests__/battlefieldReadability.test.ts"],
                    },
                },
            }
            encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")

            task = parse_task_execute_payload(["executor", encoded], logger=Logger("[test]"))
            guidance = "\n".join(task.supplemental_guidance)

            self.assertIn("Visual/rendering task rule", guidance)
            self.assertIn("prefer pure helper/state/style-prop tests", guidance)
            self.assertIn("full React Native/component render regression", guidance)

    def test_parse_payload_adds_route_shell_convergence_guidance(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-shell-guidance-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            payload = {
                "kind": "task.execute",
                "repo": str(repo),
                "params": {
                    "instruction": (
                        "Polish the first-entry shell. Start with app/_layout.tsx and "
                        "app/index.tsx, then tighten the home/settings route-entry affordance."
                    ),
                    "schemaVersion": 2,
                    "planning": {
                        "intent": "code_change",
                        "riskLevel": "low",
                        "queuePriority": "normal",
                        "queueWaitBudgetMs": 90_000,
                        "executionBudgetMs": 1_200_000,
                        "finalizationBudgetMs": 120_000,
                        "scope": {"readAnywhere": True, "writeAllowed": True},
                        "targetPaths": ["app/_layout.tsx", "app/index.tsx"],
                        "acceptanceCriteria": ["Home shell feels coherent with the match UI"],
                    },
                },
            }
            encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")

            task = parse_task_execute_payload(["executor", encoded], logger=Logger("[test]"))
            guidance = "\n".join(task.supplemental_guidance)

            self.assertIn("Route-entry/shell task rule", guidance)
            self.assertIn("route is thin", guidance)
            self.assertIn("Do not keep re-reading navigation topology", guidance)
            self.assertIn("missing test infrastructure", guidance)
            self.assertIn("make one small visual/affordance patch", guidance)

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
        self.assertIn("ValidationGate is the authoritative browser runner", template)
        self.assertIn("Do not run long browser/e2e smoke commands", template)

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

    def test_build_wrapper_bootstrap_context_runs_safe_direct_replacements(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-wrapper-bootstrap-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# wrapper bootstrap test\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed wrapper bootstrap repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            guidance = _build_wrapper_bootstrap_context(
                str(repo),
                [
                    "/bin/bash -lc pwd",
                    "/bin/bash -c pwd",
                    "/bin/bash -lc ls",
                    "/bin/bash -lc 'git branch --show-current'",
                    "/bin/bash -lc 'cat README.md'",
                    "/bin/bash -lc 'git diff --output=leak.txt'",
                ],
            )

        self.assertIn("Direct command context bootstrap:", guidance)
        self.assertIn("Direct command: `pwd`", guidance)
        self.assertIn("Direct command: `ls`", guidance)
        self.assertIn("Direct command: `git branch --show-current`", guidance)
        self.assertIn("Direct command: `cat README.md`", guidance)
        self.assertIn("README.md", guidance)
        self.assertIn("# wrapper bootstrap test", guidance)
        self.assertNotIn("git diff --output=leak.txt", guidance)

    def test_run_codex_task_hands_changed_worktree_to_gates_after_wrapper_loop(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-wrapper-changed-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# wrapper changed test\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed wrapper changed repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_wrapper_changed.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "from pathlib import Path",
                        "import sys",
                        "import time",
                        "",
                        "sys.stdin.read()",
                        "Path('src').mkdir(exist_ok=True)",
                        "Path('src/change.txt').write_text('changed before wrapper loop\\n', encoding='utf-8')",
                        "for line in (",
                        "    'error=exec_command failed for `/bin/bash -lc pwd`: CreateProcess { message: \"Rejected\" }',",
                        "    'error=exec_command failed for `/bin/bash -lc \\'git status --porcelain\\'`: CreateProcess { message: \"Rejected\" }',",
                        "    'error=exec_command failed for `/bin/bash -lc \\'sed -n 1,40p README.md\\'`: CreateProcess { message: \"Rejected\" }',",
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
                "OPENAI_API_KEY": "pushpals-wrapper-changed-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "10",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Create a small file and inspect the repo.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        self.assertIn("before shell-wrapper command rejections", str(result.get("summary") or ""))
        self.assertIn("ValidationGate/CriticGate", str(result.get("stdout") or ""))
        self.assertIn("src/", str(result.get("stdout") or ""))
        self.assertNotIn("Recovered after Codex attempts", str(result.get("stdout") or ""))

    def test_shell_wrapper_progress_guard_rejects_broad_noisy_path_sets(self) -> None:
        self.assertTrue(
            _has_credible_shell_wrapper_progress(
                [
                    "src/change.ts",
                    "src/change.test.ts",
                    "docs/change.md",
                ]
            )
        )
        self.assertFalse(
            _has_credible_shell_wrapper_progress(
                [f"src/generated-{index}.ts" for index in range(9)]
            )
        )
        self.assertFalse(
            _has_credible_shell_wrapper_progress(
                [
                    "app/main.ts",
                    "components/card.tsx",
                    "docs/readme.md",
                    "scripts/check.ts",
                    "tests/card.test.ts",
                ]
            )
        )
        self.assertFalse(
            _has_credible_shell_wrapper_progress(
                [f"area{index}/" for index in range(5)]
            )
        )

    def test_run_codex_task_recovers_instead_of_handing_noisy_wrapper_diff_to_gates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-wrapper-noisy-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# wrapper noisy test\n", encoding="utf-8")
            for index in range(9):
                (repo / f"noisy-{index}.txt").write_text("baseline\n", encoding="utf-8")
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
            subprocess.run(["git", "add", "."], cwd=repo, check=True, capture_output=True, text=True)
            subprocess.run(
                ["git", "commit", "-m", "chore: seed wrapper noisy repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_wrapper_noisy.py"
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
                        "if 'Command-router recovery:' in prompt:",
                        "    Path('src').mkdir(exist_ok=True)",
                        "    Path('src/recovered.txt').write_text('direct recovery\\n', encoding='utf-8')",
                        "    if last_message_path:",
                        "        Path(last_message_path).write_text(",
                        "            'Recovered after noisy shell-wrapper path detection using direct commands.',",
                        "            encoding='utf-8',",
                        "        )",
                        "    print('item.completed | Recovered with direct-command guidance.', flush=True)",
                        "    sys.exit(0)",
                        "",
                        "for index in range(9):",
                        "    Path(f'noisy-{index}.txt').write_text('noisy path\\n', encoding='utf-8')",
                        "for line in (",
                        "    'error=exec_command failed for `/bin/bash -lc pwd`: CreateProcess { message: \"Rejected\" }',",
                        "    'error=exec_command failed for `/bin/bash -lc \\'git status --porcelain\\'`: CreateProcess { message: \"Rejected\" }',",
                        "    'error=exec_command failed for `/bin/bash -lc \\'sed -n 1,40p README.md\\'`: CreateProcess { message: \"Rejected\" }',",
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
                "OPENAI_API_KEY": "pushpals-wrapper-noisy-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "10",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Recover from a shell-wrapper loop after noisy repo changes.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        stdout = str(result.get("stdout") or "")
        self.assertIn("Recovered after Codex attempts hit command-router shell-wrapper rejections.", stdout)
        self.assertIn("Recovered after noisy shell-wrapper path detection", stdout)
        self.assertNotIn("ValidationGate/CriticGate", stdout)

    def test_run_codex_task_hands_changed_worktree_to_gates_after_timeout(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-timeout-changed-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# timeout changed repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed timeout changed repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_timeout_changed.py"
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
                        "sys.stdin.read()",
                        "Path('src').mkdir(exist_ok=True)",
                        "Path('src/timeout-patch.txt').write_text('changed before timeout\\n', encoding='utf-8')",
                        "if last_message_path:",
                        "    Path(last_message_path).write_text('Made a small patch before timeout.', encoding='utf-8')",
                        "print('item.completed | Made a small patch before timeout.', flush=True)",
                        "time.sleep(5)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-timeout-changed-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "1",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Create a small file, then continue thinking too long.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        self.assertIn("timed out after modifying", str(result.get("summary") or ""))
        self.assertIn("partial patch", str(result.get("stdout") or "").lower())
        self.assertIn("src/", str(result.get("stdout") or ""))
        self.assertIn("Made a small patch before timeout", str(result.get("stdout") or ""))

    def test_run_codex_task_rejects_broad_timeout_partial_patch(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-timeout-noisy-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# timeout noisy repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed timeout noisy repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_timeout_noisy.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "from pathlib import Path",
                        "import sys",
                        "import time",
                        "",
                        "sys.stdin.read()",
                        "for index in range(5):",
                        "    root = Path(f'area{index}')",
                        "    root.mkdir(exist_ok=True)",
                        "    (root / 'changed.txt').write_text('broad change before timeout\\n', encoding='utf-8')",
                        "print('item.completed | Touched a broad set of files before timeout.', flush=True)",
                        "time.sleep(5)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-timeout-noisy-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "1",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "0",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Create a broad unfocused patch, then continue thinking too long.",
                    [],
                )

        self.assertFalse(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 124)
        self.assertIn("broad/noisy publishable-looking changes", str(result.get("summary") or ""))
        self.assertIn("too broad/noisy", str(result.get("stderr") or ""))
        self.assertIn("area0", str(result.get("stderr") or ""))

    def test_run_codex_task_timeout_ignores_broad_dirty_baseline(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-timeout-dirty-baseline-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# timeout dirty baseline repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed timeout dirty baseline repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )
            for index in range(5):
                root = repo / f"area{index}"
                root.mkdir(exist_ok=True)
                (root / "changed.txt").write_text("pre-existing dirty change\n", encoding="utf-8")

            stub_path = Path(temp_dir) / "fake_codex_timeout_dirty_baseline.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "import sys",
                        "import time",
                        "",
                        "sys.stdin.read()",
                        "print('item.completed | Still thinking without changing baseline files.', flush=True)",
                        "time.sleep(5)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-timeout-dirty-baseline-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "1",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "0",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Make a compact scoped patch, then continue thinking too long.",
                    [],
                )

        self.assertFalse(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 124)
        self.assertIn("execution timed out", str(result.get("summary") or ""))
        self.assertNotIn("broad/noisy", str(result.get("summary") or ""))
        self.assertNotIn("too broad/noisy", str(result.get("stderr") or ""))

    def test_run_codex_task_retries_once_when_codex_stalls_before_first_response(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-startup-stall-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# startup stall repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed startup stall repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_startup_stall.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "from pathlib import Path",
                        "import json",
                        "import sys",
                        "import time",
                        "",
                        "argv = sys.argv[1:]",
                        "last_message_path = None",
                        "model = ''",
                        "for index, arg in enumerate(argv):",
                        "    if arg == '--output-last-message' and index + 1 < len(argv):",
                        "        last_message_path = argv[index + 1]",
                        "    if arg == '-m' and index + 1 < len(argv):",
                        "        model = argv[index + 1]",
                        "        break",
                        "",
                        "prompt = sys.stdin.read()",
                        "if 'Codex startup-stall recovery' in prompt and model == 'gpt-5.4':",
                        "    Path('src').mkdir(exist_ok=True)",
                        "    Path('src/startup-stall-recovered.txt').write_text('patched after restart\\n', encoding='utf-8')",
                        "    if last_message_path:",
                        "        Path(last_message_path).write_text('Patched after Codex startup-stall recovery.', encoding='utf-8')",
                        "    print(json.dumps({'type': 'item.completed', 'message': 'Patched after Codex startup-stall recovery.'}), flush=True)",
                        "    sys.exit(0)",
                        "",
                        "print(json.dumps({'type': 'thread.started'}), flush=True)",
                        "print(json.dumps({'type': 'turn.started'}), flush=True)",
                        "time.sleep(10)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-startup-stall-test-key",
                "WORKERPALS_OPENAI_CODEX_JSON": "true",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "20",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "0",
                "WORKERPALS_OPENAI_CODEX_STARTUP_STALL_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Rename one misleading test fixture constant and update the related assertions.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        stdout = str(result.get("stdout") or "")
        self.assertIn("Recovered after the first Codex subprocess stalled", stdout)
        self.assertIn("Patched after Codex startup-stall recovery", stdout)
        self.assertIn("src/", stdout)

    def test_run_codex_task_reports_startup_stall_when_restart_also_never_responds(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-startup-stall-fail-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# startup stall failure repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed startup stall failure repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_startup_stall_fail.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "import json",
                        "import sys",
                        "import time",
                        "",
                        "sys.stdin.read()",
                        "print(json.dumps({'type': 'thread.started'}), flush=True)",
                        "print(json.dumps({'type': 'turn.started'}), flush=True)",
                        "time.sleep(10)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-startup-stall-fail-test-key",
                "WORKERPALS_OPENAI_CODEX_JSON": "true",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "20",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_STARTUP_STALL_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Rename one misleading test fixture constant and update the related assertions.",
                    [],
                )

        self.assertFalse(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 124)
        self.assertEqual(result.get("summary"), "openai_codex stalled before first response")
        self.assertNotIn("no publishable", str(result.get("summary") or "").lower())
        self.assertEqual(result.get("cooldownMs"), 600000)

    def test_run_codex_task_no_edit_recovery_retries_same_model_after_startup_stall(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-no-edit-startup-stall-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# no edit startup stall repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed no-edit startup stall repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_no_edit_startup_stall.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "from pathlib import Path",
                        "import json",
                        "import sys",
                        "import time",
                        "",
                        "argv = sys.argv[1:]",
                        "last_message_path = None",
                        "model = ''",
                        "for index, arg in enumerate(argv):",
                        "    if arg == '--output-last-message' and index + 1 < len(argv):",
                        "        last_message_path = argv[index + 1]",
                        "    if arg == '-m' and index + 1 < len(argv):",
                        "        model = argv[index + 1]",
                        "",
                        "prompt = sys.stdin.read()",
                        "has_no_edit_recovery = 'No-edit watchdog recovery' in prompt",
                        "has_startup_recovery = 'Codex startup-stall recovery' in prompt",
                        "if has_no_edit_recovery and has_startup_recovery and model != 'gpt-5.4':",
                        "    Path('src').mkdir(exist_ok=True)",
                        "    Path('src/no-edit-startup-stall-recovered.txt').write_text('patched after same-model restart\\n', encoding='utf-8')",
                        "    if last_message_path:",
                        "        Path(last_message_path).write_text('Patched after same-model startup-stall recovery.', encoding='utf-8')",
                        "    print(json.dumps({'type': 'item.completed', 'item': {'type': 'message', 'text': 'Patched after same-model startup-stall recovery.'}}), flush=True)",
                        "    raise SystemExit(0)",
                        "",
                        "print(json.dumps({'type': 'thread.started'}), flush=True)",
                        "print(json.dumps({'type': 'turn.started'}), flush=True)",
                        "if not has_no_edit_recovery:",
                        "    print(json.dumps({'type': 'item.started', 'item': {'id': 'cmd-read', 'type': 'command_execution', 'command': 'cat README.md', 'status': 'in_progress'}}), flush=True)",
                        "    time.sleep(0.2)",
                        "    print(json.dumps({'type': 'item.completed', 'item': {'id': 'cmd-read', 'type': 'command_execution', 'command': 'cat README.md', 'status': 'completed', 'exit_code': 0}}), flush=True)",
                        "time.sleep(10)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-no-edit-startup-stall-test-key",
                "WORKERPALS_OPENAI_CODEX_JSON": "true",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "30",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_GRACE_S": "1",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_PROGRESS_CAP_S": "1",
                "WORKERPALS_OPENAI_CODEX_STARTUP_STALL_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Add one focused regression assertion after reading the hinted test.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        stdout = str(result.get("stdout") or "")
        self.assertIn("same-model startup-stall recovery", stdout)
        self.assertIn("src/", stdout)

    def test_run_codex_task_retries_once_when_no_edit_watchdog_fires(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-no-edit-watchdog-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# no edit watchdog repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed no-edit watchdog repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_no_edit_watchdog.py"
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
                        "if 'No-edit watchdog recovery' in prompt:",
                        "    Path('src').mkdir(exist_ok=True)",
                        "    Path('src/no-edit-retry.txt').write_text('patched on retry\\n', encoding='utf-8')",
                        "    if last_message_path:",
                        "        Path(last_message_path).write_text('Patched immediately after no-edit recovery.', encoding='utf-8')",
                        "    print('item.completed | Patched immediately after no-edit recovery.', flush=True)",
                        "    sys.exit(0)",
                        "",
                        "print('item.completed | Still inspecting route wrappers.', flush=True)",
                        "time.sleep(10)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-no-edit-watchdog-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "20",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Polish the first-entry home shell with a compact visual patch.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        self.assertIn("Patched immediately after no-edit recovery", str(result.get("stdout") or ""))
        self.assertIn("src/", str(result.get("stdout") or ""))

    def test_run_codex_task_final_no_edit_recovery_can_patch(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-final-no-edit-recovery-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# final no edit recovery repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed final no-edit recovery repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_final_no_edit_recovery.py"
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
                        "if 'Final no-edit recovery' in prompt:",
                        "    Path('src').mkdir(exist_ok=True)",
                        "    Path('src/final-no-edit-recovery.txt').write_text('patched on final recovery\\n', encoding='utf-8')",
                        "    if last_message_path:",
                        "        Path(last_message_path).write_text('Patched immediately during final no-edit recovery.', encoding='utf-8')",
                        "    print('item.completed | Patched immediately during final no-edit recovery.', flush=True)",
                        "    sys.exit(0)",
                        "",
                        "print('item.completed | Still reading without a publishable edit.', flush=True)",
                        "time.sleep(10)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-final-no-edit-recovery-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "30",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Add one focused contract assertion after inspecting the hinted test.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        self.assertIn("Patched immediately during final no-edit recovery", str(result.get("stdout") or ""))
        self.assertIn("src/", str(result.get("stdout") or ""))

    def test_run_codex_task_no_edit_watchdog_allows_command_backed_discovery(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-no-edit-command-grace-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# command grace repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed command grace repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_no_edit_command_grace.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "from pathlib import Path",
                        "import json",
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
                        "sys.stdin.read()",
                        "print(json.dumps({'type': 'thread.started'}), flush=True)",
                        "print(json.dumps({'type': 'turn.started'}), flush=True)",
                        "print(json.dumps({'type': 'item.started', 'item': {'id': 'cmd-read-target', 'type': 'command_execution', 'command': 'sed -n 1,120p README.md', 'status': 'in_progress'}}), flush=True)",
                        "time.sleep(1.4)",
                        "print(json.dumps({'type': 'item.completed', 'item': {'id': 'cmd-read-target', 'type': 'command_execution', 'command': 'sed -n 1,120p README.md', 'status': 'completed', 'exit_code': 0, 'aggregated_output': '# command grace repo'}}), flush=True)",
                        "time.sleep(1.6)",
                        "Path('src').mkdir(exist_ok=True)",
                        "Path('src/command-grace.txt').write_text('patched after command-backed discovery\\n', encoding='utf-8')",
                        "if last_message_path:",
                        "    Path(last_message_path).write_text('Patched after command-backed discovery.', encoding='utf-8')",
                        "print(json.dumps({'type': 'item.completed', 'item': {'type': 'message', 'text': 'Patched after command-backed discovery.'}}), flush=True)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-no-edit-command-grace-test-key",
                "WORKERPALS_OPENAI_CODEX_JSON": "true",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "20",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_GRACE_S": "5",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Add one focused contract assertion after inspecting the hinted test.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        self.assertIn("Patched after command-backed discovery", str(result.get("stdout") or ""))
        self.assertIn("src/", str(result.get("stdout") or ""))

    def test_run_codex_task_no_edit_watchdog_extends_after_later_command_progress(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-no-edit-late-command-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# late command grace repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed late command repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_late_command_grace.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "from pathlib import Path",
                        "import json",
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
                        "sys.stdin.read()",
                        "print(json.dumps({'type': 'thread.started'}), flush=True)",
                        "print(json.dumps({'type': 'turn.started'}), flush=True)",
                        "print(json.dumps({'type': 'item.started', 'item': {'id': 'cmd-one', 'type': 'command_execution', 'command': 'cat README.md', 'status': 'in_progress'}}), flush=True)",
                        "time.sleep(0.2)",
                        "print(json.dumps({'type': 'item.completed', 'item': {'id': 'cmd-one', 'type': 'command_execution', 'command': 'cat README.md', 'status': 'completed', 'exit_code': 0}}), flush=True)",
                        "time.sleep(2.2)",
                        "print(json.dumps({'type': 'item.started', 'item': {'id': 'cmd-two', 'type': 'command_execution', 'command': 'ls', 'status': 'in_progress'}}), flush=True)",
                        "time.sleep(0.2)",
                        "print(json.dumps({'type': 'item.completed', 'item': {'id': 'cmd-two', 'type': 'command_execution', 'command': 'ls', 'status': 'completed', 'exit_code': 0}}), flush=True)",
                        "time.sleep(2.0)",
                        "Path('src').mkdir(exist_ok=True)",
                        "Path('src/late-command-grace.txt').write_text('patched after later command progress\\n', encoding='utf-8')",
                        "if last_message_path:",
                        "    Path(last_message_path).write_text('Patched after later command progress.', encoding='utf-8')",
                        "print(json.dumps({'type': 'item.completed', 'item': {'type': 'message', 'text': 'Patched after later command progress.'}}), flush=True)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-no-edit-late-command-test-key",
                "WORKERPALS_OPENAI_CODEX_JSON": "true",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "20",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_GRACE_S": "3",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Add one focused contract assertion after a later targeted read.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        self.assertIn("Patched after later command progress", str(result.get("stdout") or ""))
        self.assertIn("src/", str(result.get("stdout") or ""))

    def test_run_codex_task_command_progress_cap_forces_patch_first_recovery(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-command-progress-cap-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# command progress cap repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed command progress cap repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_command_progress_cap.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "from pathlib import Path",
                        "import json",
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
                        "if 'No-edit watchdog recovery' in prompt:",
                        "    Path('src').mkdir(exist_ok=True)",
                        "    Path('src/capped-command-recovery.txt').write_text('patched after capped command progress\\n', encoding='utf-8')",
                        "    if last_message_path:",
                        "        Path(last_message_path).write_text('Patched after capped command progress.', encoding='utf-8')",
                        "    print(json.dumps({'type': 'item.completed', 'item': {'type': 'message', 'text': 'Patched after capped command progress.'}}), flush=True)",
                        "    raise SystemExit(0)",
                        "",
                        "print(json.dumps({'type': 'thread.started'}), flush=True)",
                        "print(json.dumps({'type': 'turn.started'}), flush=True)",
                        "for index in range(8):",
                        "    command_id = f'cmd-{index}'",
                        "    print(json.dumps({'type': 'item.started', 'item': {'id': command_id, 'type': 'command_execution', 'command': 'cat README.md', 'status': 'in_progress'}}), flush=True)",
                        "    time.sleep(0.2)",
                        "    print(json.dumps({'type': 'item.completed', 'item': {'id': command_id, 'type': 'command_execution', 'command': 'cat README.md', 'status': 'completed', 'exit_code': 0}}), flush=True)",
                        "    time.sleep(0.8)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-command-progress-cap-test-key",
                "WORKERPALS_OPENAI_CODEX_JSON": "true",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "12",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_GRACE_S": "3",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_PROGRESS_CAP_S": "3",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Add one focused patch after bounded command-backed discovery.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        self.assertIn("Patched after capped command progress", str(result.get("stdout") or ""))
        self.assertIn("src/", str(result.get("stdout") or ""))

    def test_run_codex_task_finalizes_after_durable_publishable_progress(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-durable-progress-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# durable progress repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed durable progress repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_durable_progress.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "from pathlib import Path",
                        "import json",
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
                        "sys.stdin.read()",
                        "print(json.dumps({'type': 'thread.started'}), flush=True)",
                        "print(json.dumps({'type': 'turn.started'}), flush=True)",
                        "Path('src').mkdir(exist_ok=True)",
                        "Path('src/durable-progress.txt').write_text('durable patch\\n', encoding='utf-8')",
                        "if last_message_path:",
                        "    Path(last_message_path).write_text('Created durable patch and kept thinking.', encoding='utf-8')",
                        "print(json.dumps({'type': 'item.completed', 'item': {'type': 'message', 'text': 'Created durable patch and kept thinking.'}}), flush=True)",
                        "time.sleep(10)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-durable-progress-test-key",
                "WORKERPALS_OPENAI_CODEX_JSON": "true",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "20",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_RECHECK_S": "1",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Make a focused patch and stop once it is durable.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        self.assertIn("stopped after durable publishable progress", str(result.get("summary") or ""))
        self.assertIn("src/", str(result.get("stdout") or ""))

    def test_run_codex_task_recovery_attempt_is_still_guarded_by_no_edit_watchdog(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-no-edit-watchdog-fail-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# no edit watchdog failure repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed no-edit watchdog failure repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_no_edit_watchdog_fail.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "import sys",
                        "import time",
                        "",
                        "sys.stdin.read()",
                        "print('item.completed | Still inspecting, no patch yet.', flush=True)",
                        "time.sleep(10)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-no-edit-watchdog-fail-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "20",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Polish the first-entry home shell with a compact visual patch.",
                    [],
                )

        self.assertFalse(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 124)
        self.assertIn("no publishable changes", str(result.get("summary") or ""))
        self.assertEqual(result.get("cooldownMs"), 600000)

    def test_run_codex_task_recovery_command_grace_stops_before_child_timeout(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-no-edit-before-timeout-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# no edit before timeout repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed no-edit before timeout repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_no_edit_before_timeout.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "import json",
                        "import sys",
                        "import time",
                        "",
                        "prompt = sys.stdin.read()",
                        "print(json.dumps({'type': 'thread.started'}), flush=True)",
                        "print(json.dumps({'type': 'turn.started'}), flush=True)",
                        "if 'No-edit watchdog recovery' in prompt:",
                        "    print(json.dumps({'type': 'item.started', 'item': {'id': 'cmd-read', 'type': 'command_execution', 'command': 'cat README.md', 'status': 'in_progress'}}), flush=True)",
                        "    time.sleep(0.1)",
                        "    print(json.dumps({'type': 'item.completed', 'item': {'id': 'cmd-read', 'type': 'command_execution', 'command': 'cat README.md', 'status': 'completed', 'exit_code': 0, 'aggregated_output': '# no edit before timeout repo'}}), flush=True)",
                        "    time.sleep(6)",
                        "    raise SystemExit(0)",
                        "",
                        "print(json.dumps({'type': 'item.completed', 'item': {'type': 'message', 'text': 'Still inspecting without a patch.'}}), flush=True)",
                        "time.sleep(6)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-no-edit-before-timeout-test-key",
                "WORKERPALS_OPENAI_CODEX_JSON": "true",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "6",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_GRACE_S": "5",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Make one focused test edit after the hinted file read.",
                    [],
                )

        self.assertFalse(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 124)
        self.assertEqual(
            result.get("summary"),
            "openai_codex recovery budget exhausted before retry",
        )
        self.assertNotIn("execution timed out", str(result.get("summary") or ""))
        self.assertEqual(result.get("cooldownMs"), 600000)

    def test_run_codex_task_no_edit_watchdog_rechecks_transient_publishable_progress(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-no-edit-recheck-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# no edit recheck repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed no-edit recheck repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_no_edit_recheck.py"
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
                        "if 'No-edit watchdog recovery' in prompt:",
                        "    Path('src').mkdir(exist_ok=True)",
                        "    Path('src/no-edit-recheck-retry.txt').write_text('patched after recheck\\n', encoding='utf-8')",
                        "    if last_message_path:",
                        "        Path(last_message_path).write_text('Patched after transient no-edit recheck.', encoding='utf-8')",
                        "    print('item.completed | Patched after transient no-edit recheck.', flush=True)",
                        "    sys.exit(0)",
                        "",
                        "Path('src').mkdir(exist_ok=True)",
                        "transient = Path('src/transient-progress.txt')",
                        "transient.write_text('temporary progress\\n', encoding='utf-8')",
                        "print('item.completed | Created transient publishable progress.', flush=True)",
                        "time.sleep(1.4)",
                        "transient.unlink()",
                        "Path('node_modules').mkdir(exist_ok=True)",
                        "Path('node_modules/linked.txt').write_text('artifact only\\n', encoding='utf-8')",
                        "print('item.completed | Lost patch while still thinking.', flush=True)",
                        "time.sleep(10)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-no-edit-recheck-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "20",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_RECHECK_S": "1",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Polish the first-entry home shell with a compact visual patch.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        self.assertIn("Patched after transient no-edit recheck", str(result.get("stdout") or ""))
        self.assertIn("src/", str(result.get("stdout") or ""))

    def test_codex_changed_paths_filters_dependency_artifacts_from_publishable_delta(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-artifact-delta-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# artifact delta test\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed artifact test"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            (repo / "node_modules").mkdir()
            (repo / "node_modules" / "linked.txt").write_text("artifact\n", encoding="utf-8")
            (repo / "outputs").mkdir()
            (repo / "outputs" / "runtime.log").write_text("artifact\n", encoding="utf-8")
            changed_paths, delta, effective = _codex_changed_paths(str(repo), [])

        self.assertGreaterEqual(len(changed_paths), 2)
        self.assertGreaterEqual(len(delta), 2)
        self.assertEqual(effective, [])

    def test_codex_changed_paths_filters_windows_powershell_cache_directory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-powershell-cache-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# powershell cache artifact test\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed powershell cache artifact test"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            cache_dir = repo / "Microsoft" / "Windows" / "PowerShell"
            cache_dir.mkdir(parents=True, exist_ok=True)
            (cache_dir / "ModuleAnalysisCache").write_text("cache artifact\n", encoding="utf-8")

            changed_paths, delta, effective = _codex_changed_paths(str(repo), [])

        self.assertIn("Microsoft/Windows/PowerShell/ModuleAnalysisCache", changed_paths)
        self.assertIn("Microsoft/Windows/PowerShell/ModuleAnalysisCache", delta)
        self.assertNotIn("Microsoft/", changed_paths)
        self.assertEqual(effective, [])

    def test_codex_changed_paths_can_clean_generated_powershell_cache_artifact(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-clean-powershell-cache-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# clean powershell cache artifact test\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed powershell cache cleanup test"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            cache_file = repo / "Microsoft" / "Windows" / "PowerShell" / "ModuleAnalysisCache"
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text("cache artifact\n", encoding="utf-8")

            changed_paths, delta, effective = _codex_changed_paths(
                str(repo),
                [],
                clean_known_runtime_artifacts=True,
            )

            self.assertFalse(cache_file.exists())
            self.assertNotIn("Microsoft/Windows/PowerShell/ModuleAnalysisCache", changed_paths)
            self.assertEqual(delta, [])
            self.assertEqual(effective, [])

    def test_codex_changed_paths_ignores_publishable_paths_dirty_at_baseline(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-dirty-baseline-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# dirty baseline repo\n", encoding="utf-8")
            (repo / "src").mkdir()
            (repo / "src" / "existing.ts").write_text("export const value = 1;\n", encoding="utf-8")
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
            subprocess.run(["git", "add", "."], cwd=repo, check=True, capture_output=True, text=True)
            subprocess.run(
                ["git", "commit", "-m", "chore: seed dirty baseline repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )
            (repo / "README.md").write_text("# dirty baseline repo\n\npre-existing edit\n", encoding="utf-8")
            (repo / "src" / "existing.ts").write_text("export const value = 2;\n", encoding="utf-8")
            baseline = _capture_git_change_snapshot(str(repo))

            changed_paths, delta, effective = _codex_changed_paths(str(repo), baseline)

        self.assertIn("README.md", changed_paths)
        self.assertEqual(delta, [])
        self.assertEqual(effective, [])

    def test_codex_changed_paths_counts_worker_edits_to_dirty_baseline_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-dirty-baseline-mutated-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# dirty baseline mutation repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed dirty baseline mutation repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )
            (repo / "README.md").write_text("# dirty baseline mutation repo\n\npre-existing edit\n", encoding="utf-8")
            baseline = _capture_git_change_snapshot(str(repo))
            (repo / "README.md").write_text(
                "# dirty baseline mutation repo\n\npre-existing edit\nworker edit\n",
                encoding="utf-8",
            )

            _, delta, effective = _codex_changed_paths(str(repo), baseline)

        self.assertEqual(delta, ["README.md"])
        self.assertEqual(effective, ["README.md"])

    def test_non_publishable_path_summary_names_artifact_only_dirty_paths(self) -> None:
        changed_paths = [
            "node_modules/react/index.js",
            "outputs/data/runtime.log",
            "src/real-change.ts",
        ]
        summary = _describe_non_publishable_paths(changed_paths, ["src/real-change.ts"])

        self.assertIn("node_modules/react/index.js", summary)
        self.assertIn("outputs/data/runtime.log", summary)
        self.assertNotIn("src/real-change.ts", summary)

    def test_web_review_tasks_use_faster_no_edit_watchdog(self) -> None:
        with mock.patch.dict(os.environ, {"WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": ""}, clear=False):
            watchdog_s = _resolve_no_edit_watchdog_seconds(
                "Strengthen the repo-native web review path with a compact repo-native patch.",
                1200,
            )

        self.assertEqual(watchdog_s, 240)

    def test_narrow_contract_tests_use_fast_no_edit_watchdog(self) -> None:
        prompt = (
            "Update app/__tests__/opportunity-graph.contract.test.ts to tighten the "
            "ranking contract test. Keep this test-only and preserve existing behavior."
        )
        with mock.patch.dict(os.environ, {"WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": ""}, clear=False):
            watchdog_s = _resolve_no_edit_watchdog_seconds(prompt, 1200)

        self.assertEqual(watchdog_s, 180)

    def test_startup_stall_watchdog_allows_slower_first_response_than_no_edit_watchdog(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"WORKERPALS_OPENAI_CODEX_STARTUP_STALL_WATCHDOG_S": ""},
            clear=False,
        ):
            watchdog_s = _resolve_startup_stall_watchdog_seconds(1200)
            recovery_watchdog_s = _resolve_startup_stall_watchdog_seconds(
                1200,
                recovery_attempt=1,
            )

        self.assertEqual(watchdog_s, 210)
        self.assertEqual(recovery_watchdog_s, 150)

    def test_explicit_startup_stall_watchdog_override_is_bounded(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"WORKERPALS_OPENAI_CODEX_STARTUP_STALL_WATCHDOG_S": "500"},
            clear=False,
        ):
            watchdog_s = _resolve_startup_stall_watchdog_seconds(120)

        self.assertEqual(watchdog_s, 119)

    def test_narrow_contract_regression_with_required_e2e_uses_fast_no_edit_watchdog(self) -> None:
        prompt = (
            "Harden the opportunity graph contract around autonomous delivery-loop failure signals. "
            "Add focused regression coverage in app/__tests__/opportunity-graph.contract.test.ts. "
            "Required vision.md testing criteria: bun test | bun x tsc --noEmit | bun run lint | bun run web:e2e."
        )
        with mock.patch.dict(os.environ, {"WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": ""}, clear=False):
            watchdog_s = _resolve_no_edit_watchdog_seconds(prompt, 1200)

        self.assertEqual(watchdog_s, 180)

    def test_validation_repair_prompt_gets_diagnostic_watchdogs(self) -> None:
        prompt = (
            "Restore required validation: bun run web:e2e\n\n"
            "Required validation is repeatedly failing before publication.\n"
            "Primary failing command: bun run web:e2e.\n"
            "Fix the repo baseline issue that makes this command fail, then rerun the failing command.\n\n"
            "Course of action:\n"
            "- Reproduce the failing command first: bun run web:e2e\n\n"
            "Expected validation:\n"
            "- bun run web:e2e\n\n"
            "priority=background origin=autonomy"
        )
        env = {
            "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "",
            "WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_PROGRESS_CAP_S": "",
            "WORKERPALS_OPENAI_CODEX_ROLLOUT_WATCHDOG_S": "",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            no_edit_s = _resolve_no_edit_watchdog_seconds(prompt, 1200)
            command_cap_s = _resolve_no_edit_command_progress_cap_seconds(
                1200,
                _resolve_no_edit_command_grace_seconds(1200),
                prompt=prompt,
            )
            rollout_s = _resolve_rollout_watchdog_seconds(prompt, 1200, no_edit_s)

        self.assertTrue(_looks_like_validation_repair_prompt(prompt))
        self.assertEqual(no_edit_s, 300)
        self.assertEqual(command_cap_s, 360)
        self.assertEqual(rollout_s, 240)

    def test_no_edit_recovery_attempt_uses_short_patch_first_watchdog(self) -> None:
        prompt = "Investigate a broad reliability issue and make the smallest safe fix."
        with mock.patch.dict(os.environ, {"WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": ""}, clear=False):
            first_attempt_s = _resolve_no_edit_watchdog_seconds(prompt, 1200)
            recovery_attempt_s = _resolve_no_edit_watchdog_seconds(
                prompt,
                1200,
                recovery_attempt=1,
            )
            final_recovery_attempt_s = _resolve_no_edit_watchdog_seconds(
                prompt,
                1200,
                recovery_attempt=2,
            )

        self.assertEqual(first_attempt_s, 480)
        self.assertEqual(recovery_attempt_s, 90)
        self.assertEqual(final_recovery_attempt_s, 60)

    def test_explicit_no_edit_watchdog_override_still_controls_recovery_attempts(self) -> None:
        with mock.patch.dict(os.environ, {"WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "300"}, clear=False):
            watchdog_s = _resolve_no_edit_watchdog_seconds(
                "Investigate a broad reliability issue.",
                1200,
                recovery_attempt=1,
            )

        self.assertEqual(watchdog_s, 300)

    def test_no_edit_recovery_attempt_uses_short_durable_recheck_and_command_cap(self) -> None:
        env = {
            "WORKERPALS_OPENAI_CODEX_NO_EDIT_RECHECK_S": "",
            "WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_GRACE_S": "",
            "WORKERPALS_OPENAI_CODEX_NO_EDIT_COMMAND_PROGRESS_CAP_S": "",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            first_recheck_s = _resolve_no_edit_recheck_seconds(750)
            recovery_recheck_s = _resolve_no_edit_recheck_seconds(750, recovery_attempt=1)
            final_recovery_recheck_s = _resolve_no_edit_recheck_seconds(750, recovery_attempt=2)
            command_grace_s = _resolve_no_edit_command_grace_seconds(750)
            first_command_cap_s = _resolve_no_edit_command_progress_cap_seconds(
                750,
                command_grace_s,
            )
            recovery_command_cap_s = _resolve_no_edit_command_progress_cap_seconds(
                750,
                command_grace_s,
                recovery_attempt=1,
            )
            final_recovery_command_cap_s = _resolve_no_edit_command_progress_cap_seconds(
                750,
                command_grace_s,
                recovery_attempt=2,
            )

        self.assertEqual(first_recheck_s, 120)
        self.assertEqual(recovery_recheck_s, 30)
        self.assertEqual(final_recovery_recheck_s, 15)
        self.assertEqual(first_command_cap_s, 360)
        self.assertEqual(recovery_command_cap_s, 120)
        self.assertEqual(final_recovery_command_cap_s, 60)

    def test_codex_recovery_attempt_refuses_exhausted_shared_deadline(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-exhausted-recovery-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# exhausted recovery repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed exhausted recovery repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_should_not_run.py"
            stub_path.write_text(
                "raise SystemExit('fake codex should not run when recovery budget is exhausted')\n",
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-exhausted-recovery-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "750",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Apply patch-first recovery.",
                    [],
                    no_edit_recovery_attempt=1,
                    execution_deadline_monotonic=time.monotonic() - 1.0,
                )

        self.assertFalse(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 124)
        self.assertIn("recovery budget exhausted", str(result.get("summary") or ""))
        self.assertIn("Stopping before a low-odds retry", str(result.get("stderr") or ""))

    def test_review_fix_contract_level_tests_use_fast_no_edit_watchdog(self) -> None:
        prompt = (
            "Restore exact score assertions for contract-level tests where score is part "
            "of the public output. Keep this as a test-only patch in app/__tests__."
        )
        with mock.patch.dict(os.environ, {"WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": ""}, clear=False):
            watchdog_s = _resolve_no_edit_watchdog_seconds(prompt, 1200)

        self.assertEqual(watchdog_s, 180)

    def test_rejected_pr_review_fix_prompt_uses_compact_no_edit_watchdog(self) -> None:
        prompt = (
            "Rejected PR revision brief: Previous ReviewAgent score: 7.6 / 10. "
            "Address reviewer must-fix items in the cleanup harness with focused coverage."
        )
        with mock.patch.dict(os.environ, {"WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": ""}, clear=False):
            watchdog_s = _resolve_no_edit_watchdog_seconds(prompt, 1200)

        self.assertEqual(watchdog_s, 180)

    def test_review_fix_child_budget_below_ten_minutes_still_uses_watchdogs(self) -> None:
        prompt = (
            "Rejected PR revision brief: Previous ReviewAgent score: 8.0 / 10. "
            "Add focused tests for createCleanupHarness.runTask covering successful execution, "
            "execute failure, cleanup failure, invalid task input, and cleanup execution after "
            "successful task completion."
        )
        env = {
            "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "",
            "WORKERPALS_OPENAI_CODEX_ROLLOUT_WATCHDOG_S": "",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            no_edit_s = _resolve_no_edit_watchdog_seconds(prompt, 570)
            rollout_s = _resolve_rollout_watchdog_seconds(prompt, 570, no_edit_s)

        self.assertEqual(no_edit_s, 180)
        self.assertEqual(rollout_s, 120)

    def test_no_edit_recovery_guidance_warns_against_artifact_only_progress(self) -> None:
        guidance = _build_no_edit_recovery_guidance(
            "item.completed | still inspecting",
            "node_modules, outputs/data/runtime.log",
        )

        self.assertIn("node_modules", guidance)
        self.assertIn("patch-first contract", guidance)
        self.assertIn("Re-reading the target without editing is a failed recovery", guidance)
        self.assertIn("do not invent PushPals/autonomy-specific files", guidance)
        self.assertIn("Previous Codex event trace excerpt", guidance)

    def test_final_no_edit_recovery_guidance_forbids_more_discovery(self) -> None:
        guidance = _build_no_edit_recovery_guidance(
            "item.completed | I found the target block and will open it",
            recovery_attempt=2,
        )

        self.assertIn("Final no-edit recovery", guidance)
        self.assertIn("Do not run more exploratory reads", guidance)
        self.assertIn("first tool action", guidance)
        self.assertIn("publishable file edit", guidance)

    def test_rollout_watchdog_is_earlier_than_web_review_no_edit_watchdog(self) -> None:
        with mock.patch.dict(os.environ, {"WORKERPALS_OPENAI_CODEX_ROLLOUT_WATCHDOG_S": ""}, clear=False):
            no_edit_s = _resolve_no_edit_watchdog_seconds(
                "Strengthen the repo-native web review path.",
                1200,
            )
            rollout_s = _resolve_rollout_watchdog_seconds(
                "Strengthen the repo-native web review path.",
                1200,
                no_edit_s,
            )

        self.assertEqual(no_edit_s, 240)
        self.assertEqual(rollout_s, 180)

    def test_narrow_contract_rollout_watchdog_is_earlier_than_no_edit_watchdog(self) -> None:
        prompt = "Tighten the focused contract test for one ranking behavior."
        with mock.patch.dict(os.environ, {"WORKERPALS_OPENAI_CODEX_ROLLOUT_WATCHDOG_S": ""}, clear=False):
            no_edit_s = _resolve_no_edit_watchdog_seconds(prompt, 1200)
            rollout_s = _resolve_rollout_watchdog_seconds(prompt, 1200, no_edit_s)

        self.assertEqual(no_edit_s, 180)
        self.assertEqual(rollout_s, 120)

    def test_offtrack_rollout_detects_missing_path_and_harness_drift(self) -> None:
        trace = {
            "summaries": [
                "item.completed | The requested test path is not present in this checkout.",
                "item.completed | I am checking the React Native test surface before choosing assertion style.",
            ],
        }

        self.assertIn("missing hinted files", _detect_offtrack_rollout(trace))

    def test_rollout_recovery_guidance_points_to_repo_native_patch(self) -> None:
        guidance = _build_rollout_recovery_guidance(
            "the worker is spending time on missing hinted files",
            "Codex event trace:\n- missing test path",
            "node_modules",
        )

        self.assertIn("Rollout coach recovery", guidance)
        self.assertIn("stale hint", guidance)
        self.assertIn("repo-native", guidance)
        self.assertIn("node_modules", guidance)

    def test_run_codex_task_retries_once_when_rollout_coach_fires(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-rollout-coach-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# rollout coach repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed rollout coach repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_rollout_coach.py"
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
                        "if 'Rollout coach recovery' in prompt:",
                        "    Path('scripts').mkdir(exist_ok=True)",
                        "    Path('scripts/web-review-path.txt').write_text('repo-native patch\\n', encoding='utf-8')",
                        "    if last_message_path:",
                        "        Path(last_message_path).write_text('Patched after rollout coach guidance.', encoding='utf-8')",
                        "    print('item.completed | Patched after rollout coach guidance.', flush=True)",
                        "    sys.exit(0)",
                        "",
                        "print('item.completed | The requested test path is not present in this checkout.', flush=True)",
                        "print('item.completed | I am checking the React Native test surface before choosing assertion style.', flush=True)",
                        "time.sleep(10)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-rollout-coach-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "700",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "10",
                "WORKERPALS_OPENAI_CODEX_ROLLOUT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Strengthen the repo-native web review path.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        self.assertIn("Patched after rollout coach guidance", str(result.get("stdout") or ""))
        self.assertIn("scripts/", str(result.get("stdout") or ""))

    def test_run_codex_task_rollout_coach_resets_broad_small_task_changes_before_retry(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-rollout-noisy-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# rollout noisy repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed rollout noisy repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_rollout_noisy.py"
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
                        "if 'Rollout coach recovery' in prompt:",
                        "    Path('src').mkdir(exist_ok=True)",
                        "    Path('src/narrow-rollout-recovery.txt').write_text('narrow recovery patch\\n', encoding='utf-8')",
                        "    if last_message_path:",
                        "        Path(last_message_path).write_text('Patched narrowly after broad rollout reset.', encoding='utf-8')",
                        "    print('item.completed | Patched narrowly after broad rollout reset.', flush=True)",
                        "    sys.exit(0)",
                        "",
                        "for index in range(5):",
                        "    root = Path(f'area{index}')",
                        "    root.mkdir(exist_ok=True)",
                        "    (root / 'changed.txt').write_text('broad rollout change\\n', encoding='utf-8')",
                        "print('item.completed | Made broad edits for a supposedly small task.', flush=True)",
                        "time.sleep(10)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-rollout-noisy-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "700",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "10",
                "WORKERPALS_OPENAI_CODEX_ROLLOUT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Make a small low-risk repo-native patch.",
                    [],
                )
            area0_exists_after_retry = (repo / "area0").exists()

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        self.assertIn("Patched narrowly after broad rollout reset", str(result.get("stdout") or ""))
        self.assertIn("src/", str(result.get("stdout") or ""))
        self.assertFalse(area0_exists_after_retry)

    def test_run_codex_task_rollout_coach_hands_publishable_progress_to_quality_gate(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-rollout-repeat-noisy-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# repeated rollout noisy repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed repeated rollout noisy repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_rollout_repeat_noisy.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "from pathlib import Path",
                        "import sys",
                        "import time",
                        "",
                        "sys.stdin.read()",
                        "for index in range(5):",
                        "    root = Path(f'area{index}')",
                        "    root.mkdir(exist_ok=True)",
                        "    (root / 'changed.txt').write_text('broad rollout change\\n', encoding='utf-8')",
                        "print('item.completed | Repeated broad edits for a small task.', flush=True)",
                        "time.sleep(10)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-rollout-repeat-noisy-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "700",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "10",
                "WORKERPALS_OPENAI_CODEX_ROLLOUT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Make a small low-risk repo-native patch.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        self.assertIn("rollout coach", str(result.get("summary") or ""))
        self.assertIn("QualityGate/ValidationGate", str(result.get("stdout") or ""))
        self.assertIn("area0", str(result.get("stdout") or ""))
        self.assertNotIn("cooldownMs", result)

    def test_run_codex_task_validation_repair_ignores_artifact_only_rollout_progress(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-validation-repair-artifact-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# validation repair artifact repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed validation repair repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_validation_repair_artifact.py"
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
                        "sys.stdin.read()",
                        "cache = Path('Microsoft/Windows/PowerShell/ModuleAnalysisCache')",
                        "cache.parent.mkdir(parents=True, exist_ok=True)",
                        "cache.write_text('runtime artifact only\\n', encoding='utf-8')",
                        "print('item.completed | The failure reproduces as a route/startup timeout.', flush=True)",
                        "time.sleep(2)",
                        "if last_message_path:",
                        "    Path(last_message_path).write_text(",
                        "        'Validation repair diagnosis continued past artifact-only rollout noise.',",
                        "        encoding='utf-8',",
                        "    )",
                        "sys.exit(0)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-validation-repair-artifact-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "20",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "10",
                "WORKERPALS_OPENAI_CODEX_ROLLOUT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    (
                        "Restore required validation: bun run web:e2e\n\n"
                        "Required validation is repeatedly failing before publication.\n"
                        "Primary failing command: bun run web:e2e.\n"
                        "Fix the repo baseline issue that makes this command fail.\n\n"
                        "Course of action:\n"
                        "- Reproduce the failing command first: bun run web:e2e\n\n"
                        "Expected validation:\n"
                        "- bun run web:e2e"
                    ),
                    ["priority=background origin=autonomy"],
                )

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        self.assertIn("no file changes", str(result.get("summary") or ""))
        self.assertIn("continued past artifact-only", str(result.get("stdout") or ""))
        self.assertNotIn("rollout coach", str(result.get("summary") or "").lower())
        self.assertNotIn("rollout coach", str(result.get("stderr") or "").lower())

    def test_run_codex_task_cleans_powershell_artifact_before_rollout_failure(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-rollout-artifact-cleanup-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# rollout artifact cleanup repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed rollout artifact cleanup repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_rollout_artifact_cleanup.py"
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
                        "sys.stdin.read()",
                        "cache = Path('Microsoft/Windows/PowerShell/ModuleAnalysisCache')",
                        "cache.parent.mkdir(parents=True, exist_ok=True)",
                        "cache.write_text('runtime artifact before patch\\n', encoding='utf-8')",
                        "print('item.completed | I found the route shell owner and will patch it next.', flush=True)",
                        "time.sleep(2)",
                        "Path('app').mkdir(exist_ok=True)",
                        "Path('app/_layout.tsx').write_text('export const shell = true;\\n', encoding='utf-8')",
                        "if last_message_path:",
                        "    Path(last_message_path).write_text('Patched route shell after artifact cleanup.', encoding='utf-8')",
                        "print('item.completed | Patched route shell after artifact cleanup.', flush=True)",
                        "sys.exit(0)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-rollout-artifact-cleanup-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "20",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "10",
                "WORKERPALS_OPENAI_CODEX_ROLLOUT_WATCHDOG_S": "1",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Implement a small, low-risk polish pass for the client app shell around match entry.",
                    [],
                )
            cache_file = repo / "Microsoft" / "Windows" / "PowerShell" / "ModuleAnalysisCache"

            self.assertFalse(cache_file.exists())

        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 0)
        self.assertIn("Patched route shell after artifact cleanup", str(result.get("stdout") or ""))
        self.assertIn("app/", str(result.get("stdout") or ""))
        self.assertNotIn("rollout coach", str(result.get("summary") or "").lower())
        self.assertNotIn("artifact-only", str(result.get("stderr") or "").lower())

    def test_run_codex_task_timeout_reports_artifact_only_changes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-artifact-timeout-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# artifact timeout repo\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed artifact timeout repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_artifact_timeout.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "from pathlib import Path",
                        "import sys",
                        "import time",
                        "",
                        "sys.stdin.read()",
                        "Path('node_modules').mkdir(exist_ok=True)",
                        "Path('node_modules/linked.txt').write_text('artifact only\\n', encoding='utf-8')",
                        "print('item.completed | Touched dependency artifact only.', flush=True)",
                        "time.sleep(10)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-artifact-timeout-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "1",
                "WORKERPALS_OPENAI_CODEX_NO_EDIT_WATCHDOG_S": "0",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Strengthen the repo-native web review path.",
                    [],
                )

        self.assertFalse(result.get("ok"), result)
        self.assertEqual(result.get("exitCode"), 124)
        self.assertIn("without publishable changes", str(result.get("summary") or ""))
        self.assertIn("node_modules", str(result.get("stderr") or ""))

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
                        "bootstrap_marker = 'Direct command context bootstrap:'",
                        "pwd_marker = 'Direct command: `pwd`'",
                        "branch_marker = 'Direct command: `git branch --show-current`'",
                        "if hard_marker in prompt and bootstrap_marker in prompt and pwd_marker in prompt and branch_marker in prompt:",
                        "    if last_message_path:",
                        "        Path(last_message_path).write_text(",
                        "            'Recovered by using backend-supplied direct command bootstrap after strict wrapper recovery.',",
                        "            encoding='utf-8',",
                        "        )",
                        "    print('item.completed | Used backend bootstrap context after strict recovery guidance.', flush=True)",
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
        self.assertIn("backend-supplied direct command bootstrap", str(result.get("stdout") or ""))

    def test_run_codex_task_recovers_when_default_model_requires_newer_codex(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pushpals-codex-model-compat-") as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True, exist_ok=True)
            (repo / "README.md").write_text("# model compatibility test\n", encoding="utf-8")
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
                ["git", "commit", "-m", "chore: seed model compatibility repo"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )

            stub_path = Path(temp_dir) / "fake_codex_model_compat.py"
            stub_path.write_text(
                "\n".join(
                    [
                        "from pathlib import Path",
                        "import sys",
                        "",
                        "argv = sys.argv[1:]",
                        "model = ''",
                        "last_message_path = None",
                        "for index, arg in enumerate(argv):",
                        "    if arg == '-m' and index + 1 < len(argv):",
                        "        model = argv[index + 1]",
                        "    if arg == '--output-last-message' and index + 1 < len(argv):",
                        "        last_message_path = argv[index + 1]",
                        "",
                        "if model == 'gpt-5.5':",
                        "    print(\"ERROR: {'detail': \\\"The 'gpt-5.5' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.\\\"}\", file=sys.stderr)",
                        "    sys.exit(1)",
                        "",
                        "if model == 'gpt-5.4':",
                        "    if last_message_path:",
                        "        Path(last_message_path).write_text('Recovered on legacy model fallback.', encoding='utf-8')",
                        "    print('item.completed | Used legacy model fallback.', flush=True)",
                        "    sys.exit(0)",
                        "",
                        "print(f'unexpected model {model}', file=sys.stderr)",
                        "sys.exit(2)",
                    ]
                ),
                encoding="utf-8",
            )

            env_overrides = {
                "PUSHPALS_OPENAI_CODEX_BIN_JSON": json.dumps([sys.executable, str(stub_path)]),
                "PUSHPALS_OPENAI_CODEX_AUTH_MODE": "api_key",
                "OPENAI_API_KEY": "pushpals-model-compat-test-key",
                "WORKERPALS_OPENAI_CODEX_TIMEOUT_S": "10",
                "WORKERPALS_OPENAI_CODEX_PROGRESS_LOG_INTERVAL_S": "1",
            }
            with mock.patch.dict(os.environ, env_overrides, clear=False):
                result = _run_codex_task(
                    str(repo),
                    "Use the configured Codex model.",
                    [],
                )

        self.assertTrue(result.get("ok"), result)
        stdout = str(result.get("stdout") or "")
        self.assertIn("rejected default model gpt-5.5", stdout.lower())
        self.assertIn("gpt-5.4", stdout)
        self.assertIn("Recovered on legacy model fallback.", stdout)

    def test_usage_falls_back_to_estimate_when_trace_has_no_usage(self) -> None:
        usage = _usage_from_trace_or_estimate({}, "abc" * 30, "done", model="gpt-5.4")
        self.assertTrue(usage["estimated"])
        self.assertEqual(usage["backend"], "openai_codex")
        self.assertEqual(usage["modelId"], "gpt-5.4")
        self.assertGreater(usage["promptTokens"], 0)
        self.assertGreater(usage["totalTokens"], usage["completionTokens"])


if __name__ == "__main__":
    unittest.main()
