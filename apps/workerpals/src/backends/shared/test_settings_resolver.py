import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from executor_base import (
    SettingsResolver,
    build_settings_resolver,
    parse_task_execute_payload,
    _build_executor_validation_guidance,
    _build_planning_guidance,
)


class ValidationOwnershipTests(unittest.TestCase):
    def params(self):
        return {
            "instruction": "Correct the catalog label",
            "plannerWorkerInstruction": "Fix the label, then run the full test suite and bun run validate.",
            "qualityRevisionHint": "Keep the existing regression assertion.",
            "planning": {
                "acceptanceCriteria": ["The corrected label is visible"],
                "validationSteps": ["bun run test"],
                "requiredValidationSteps": ["bun run validate"],
            },
            "executorValidationOwnership": {
                "schemaVersion": 1,
                "owner": "pushpals_after_edit",
                "focusedCommands": ["bun test ./tests/catalog.test.ts"],
                "postEditCommands": [
                    {"command": "bun run test", "capability": "worker"},
                    {"command": "bun run validate", "capability": "trusted_host"},
                ],
                "requiredSteps": ["bun run validate"],
            },
        }

    def test_ownership_follows_conflicting_planner_and_revision_context(self):
        with tempfile.TemporaryDirectory(prefix="pushpals-ownership-") as root:
            params = self.params()
            payload = {"kind": "task.execute", "repo": root, "params": params}
            encoded = base64.b64encode(json.dumps(payload).encode()).decode()
            task = parse_task_execute_payload(["executor", encoded])
            last = task.supplemental_guidance[-1]
            self.assertIn("Host-derived validation ownership", last)
            self.assertIn("not a request to execute them during coding", last)
            self.assertIn("supplemental planner prose", last)
            self.assertIn("[worker]: bun run test", last)
            self.assertIn("[trusted_host]: bun run validate", last)
            self.assertIn("bun test ./tests/catalog.test.ts", last)
            self.assertIn("not reusable final-gate evidence", last)
            self.assertIn("A small full suite can be the smallest useful check", last)
            self.assertIn("one necessary reproduction", last)
            self.assertEqual(task.params["planning"], params["planning"])
            self.assertNotIn("Planned validation steps", _build_planning_guidance(params))

    def test_contract_is_not_lost_to_planning_prompt_truncation(self):
        params = self.params()
        params["planning"]["discovery"] = {"ripgrepQueries": ["x" * 1000] * 8}
        params["planning"]["acceptanceCriteria"] = ["y" * 1000] * 10
        params["planning"]["targetPaths"] = ["z" * 1000] * 12
        self.assertIn("truncated", _build_planning_guidance(params))
        self.assertIn("[trusted_host]: bun run validate", _build_executor_validation_guidance(params))

    def test_disabled_gate_does_not_promise_automatic_validation(self):
        params = self.params()
        params["executorValidationOwnership"]["owner"] = "executor"
        guidance = _build_executor_validation_guidance(params)
        self.assertIn("ValidationGate is disabled", guidance)
        self.assertIn("perform appropriate validation yourself", guidance)
        self.assertNotIn("Post-edit owner: PushPals", guidance)

    def test_malformed_contract_keeps_legacy_requirements_visible(self):
        for contract in (None, {"schemaVersion": 99}, {"schemaVersion": 1, "owner": "executor"}):
            with self.subTest(contract=contract):
                params = self.params()
                params["executorValidationOwnership"] = contract
                guidance = _build_executor_validation_guidance(params)
                self.assertIn("Planned validation steps", guidance)
                self.assertIn("Required vision.md validation steps", guidance)
                self.assertIn("bun run test", guidance)
                self.assertIn("bun run validate", guidance)
                self.assertNotIn("Scheduled after editing", guidance)
                self.assertNotIn("hand off the whole suite", guidance)
                self.assertIn("no automatic post-edit or trusted-host handoff is established", guidance)
                self.assertNotIn("Planned validation steps", _build_planning_guidance(params))

    def test_missing_or_malformed_ownership_keeps_whole_commands_in_composed_prompt(self):
        codex_path = str(_HERE.parent / "openai_codex")
        if codex_path not in sys.path:
            sys.path.insert(0, codex_path)
        from openai_codex_executor import _build_instruction

        command = 'bun test "./tests/catalog  spaced.test.ts" --test-name-pattern "' + "x" * 650 + '"'
        required = 'bun test "./tests/required  spaced.test.ts" --test-name-pattern "' + "r" * 800 + '"'
        for contract in (None, {"schemaVersion": 99}, {"schemaVersion": 1, "owner": "executor"}):
            with self.subTest(contract=contract), tempfile.TemporaryDirectory(prefix="pushpals-fallback-validation-") as root:
                params = self.params()
                params["executorValidationOwnership"] = contract
                params["planning"].update(
                    validationSteps=[command, "oversized-" + "z" * 1000],
                    requiredValidationSteps=[required],
                    discovery={"ripgrepQueries": ["d" * 1000] * 8},
                    acceptanceCriteria=["a" * 1000] * 10,
                    targetPaths=["p" * 1000] * 12,
                )
                payload = {"kind": "task.execute", "repo": root, "params": params}
                encoded = base64.b64encode(json.dumps(payload).encode()).decode()
                task = parse_task_execute_payload(["executor", encoded])
                prompt = _build_instruction(task.instruction, task.supplemental_guidance)
                self.assertIn("Planning guidance truncated", prompt)
                self.assertIn("Planned validation steps (executor-owned): " + command, prompt)
                self.assertIn("Required vision.md validation steps (executor-owned): " + required, prompt)
                self.assertNotIn(command[:257] + "...", prompt)
                self.assertNotIn(required[:257] + "...", prompt)
                self.assertNotIn("oversized-", prompt)
                self.assertIn("manifest is incomplete, not a waiver or a pass", prompt)
                self.assertIn("no automatic post-edit or trusted-host handoff is established", prompt)
                self.assertNotIn("PushPals ValidationGate runs those required gates", prompt)
                self.assertLessEqual(len(task.supplemental_guidance[-1]), 32_000)

    def test_guidance_does_not_promise_an_unconfigured_critic(self):
        params = self.params()
        # Ownership does not carry critic configuration, so it must not promise
        # that the critic runs. This applies to both enabled and disabled setups.
        guidance = _build_executor_validation_guidance(params)
        self.assertIn("Only configured, enabled final gates run", guidance)
        self.assertIn("any enabled critic review", guidance)
        self.assertNotIn("critic review still run", guidance)

    def test_focused_commands_are_complete_or_omitted_never_clipped(self):
        params = self.params()
        prefix = 'bun test ./catalog.test.ts --test-name-pattern "'
        boundary = prefix + "x" * (500 - len(prefix) - 1) + '"'
        oversized = prefix + "y" * 500 + '"'
        quoted_spaces = 'bun test "./tests/catalog  spaced.test.ts"'
        params["executorValidationOwnership"]["focusedCommands"] = [
            oversized, boundary, quoted_spaces,
        ]
        guidance = _build_executor_validation_guidance(params)
        self.assertEqual(len(boundary), 500)
        self.assertIn(boundary, guidance)
        self.assertIn(quoted_spaces, guidance)
        self.assertNotIn("y" * 20, guidance)
        params["executorValidationOwnership"]["focusedCommands"] = [oversized]
        self.assertIn("No focused command was established", _build_executor_validation_guidance(params))

    def test_manifest_and_required_commands_preserve_full_valid_argv_or_explicitly_report_omission(self):
        prefix = 'bun test "./tests/catalog  spaced.test.ts" --test-name-pattern "'
        boundary = prefix + "x" * (1000 - len(prefix) - 1) + '"'
        required_only = 'bun test ./other.test.ts --test-name-pattern "' + "y" * 600 + '"'
        oversized = prefix + "z" * 1000 + '"'
        for owner in ("executor", "pushpals_after_edit"):
            with self.subTest(owner=owner):
                params = self.params()
                contract = params["executorValidationOwnership"]
                contract.update(owner=owner, focusedCommands=[], postEditCommands=[{"command": boundary, "capability": "worker"}, {"command": oversized, "capability": "worker"}], requiredSteps=[boundary, required_only, "bun run test\nextra"])
                guidance = _build_executor_validation_guidance(params)
                self.assertEqual(len(boundary), 1000)
                self.assertIn(boundary, guidance)
                self.assertEqual(guidance.count(boundary), 1)
                self.assertIn(required_only, guidance)
                self.assertNotIn("z" * 20, guidance)
                self.assertNotIn(boundary[:497] + "...", guidance)
                self.assertIn("manifest is incomplete, not a waiver or a pass", guidance)

    def test_requirement_manifest_has_a_total_prompt_budget(self):
        params = self.params()
        def command(index):
            prefix = f'bun test ./case{index}.test.ts --test-name-pattern "'
            return prefix + "a" * (1000 - len(prefix) - 1) + '"'
        contract = params["executorValidationOwnership"]
        contract.update(postEditCommands=[{"command": command(index), "capability": "worker"} for index in range(100)], requiredSteps=[command(index) for index in range(100, 200)])
        guidance = _build_executor_validation_guidance(params)
        self.assertLessEqual(len(guidance), 32_000)
        self.assertIn("manifest is incomplete, not a waiver or a pass", guidance)
        self.assertNotIn(command(16), guidance)


class SettingsResolverTests(unittest.TestCase):
    def test_get_str_prefers_env_then_config(self) -> None:
        resolver = SettingsResolver(
            env={"A": "  env-value  "},
            config_loader=lambda: {"root": {"value": "toml-value"}},
        )
        value = resolver.get_str(
            env_names=("A",),
            config_paths=("root.value",),
            default="fallback",
        )
        self.assertEqual(value, "env-value")

    def test_get_str_uses_first_present_config_path(self) -> None:
        resolver = SettingsResolver(
            env={},
            config_loader=lambda: {"root": {"secondary": "value-2"}},
        )
        value = resolver.get_str(
            config_paths=("root.primary", "root.secondary"),
            default="fallback",
        )
        self.assertEqual(value, "value-2")

    def test_numeric_and_boolean_parsing(self) -> None:
        resolver = SettingsResolver(
            env={"INT_ENV": "42", "BOOL_ENV": "true"},
            config_loader=lambda: {"root": {"int": "9", "enabled": False}},
        )
        self.assertEqual(
            resolver.get_int(env_names=("INT_ENV",), config_paths=("root.int",), default=0),
            42,
        )
        self.assertTrue(
            resolver.get_bool(env_names=("BOOL_ENV",), config_paths=("root.enabled",), default=False),
        )

    def test_build_settings_resolver_static_config(self) -> None:
        resolver = build_settings_resolver(
            env={"X": ""},
            config={"root": {"flag": "on"}},
        )
        self.assertTrue(
            resolver.get_bool(env_names=("X",), config_paths=("root.flag",), default=False),
        )


if __name__ == "__main__":
    unittest.main()
