#!/usr/bin/env python3
import importlib.util
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = (
    ROOT
    / "apps"
    / "workerpals"
    / "src"
    / "backends"
    / "openai_codex"
    / "openai_codex_executor.py"
)

spec = importlib.util.spec_from_file_location("openai_codex_executor", MODULE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class OpenAICodexExecutorStreamingTests(unittest.TestCase):
    def test_command_category_uses_executable_not_search_terms_or_filenames(self):
        self.assertEqual(module._command_timing_category("rg test src"), "discovery")
        self.assertEqual(module._command_timing_category("cat foo.test.ts"), "discovery")
        self.assertEqual(module._command_timing_category("bun run test"), "validation")
        self.assertEqual(module._command_timing_category("bash -lc 'bun test'"), "other")
        self.assertEqual(module._command_timing_category("rg symbol src && bun test"), "other")

    def record_command(self, trace, event, item_id, command, now, **extra):
        module._record_command_timing({"item": {"type": "command_execution", "id": item_id, "command": command, **extra}}, event, trace, now)

    def test_command_timings_pair_parallel_commands_and_ignore_duplicates(self):
        trace = module._empty_codex_trace()
        self.record_command(trace, "item.started", "a", "bun test", 10)
        self.record_command(trace, "item.started", "b", "rg symbol src", 11)
        self.record_command(trace, "item.started", "a", "bun test", 12)
        self.record_command(trace, "item.completed", "b", "rg symbol src", 13, exit_code=0)
        self.record_command(trace, "item.completed", "a", "bun test", 15, exit_code=1)
        self.record_command(trace, "item.completed", "a", "bun test", 30, exit_code=0)
        result = module._finalize_command_timings(trace, 40)
        self.assertEqual([row["durationMs"] for row in result["commands"]], [5000, 2000])
        self.assertEqual([row["exitCode"] for row in result["commands"]], [1, 0])
        self.assertEqual(result["duplicateEvents"], 2)
        self.assertIsNone(trace["last_command_activity_at"])
        self.assertIsNone(trace["last_meaningful_progress_at"])

    def test_command_timings_report_missing_start_and_interrupted_commands(self):
        trace = module._empty_codex_trace()
        self.record_command(trace, "item.completed", "missing", "bun test", 12, exit_code=0)
        self.record_command(trace, "item.started", "interrupted", "npm install", 14)
        records = module._finalize_command_timings(trace, 20)["commands"]
        self.assertTrue(all(row["incomplete"] for row in records))
        self.assertIsNone(records[0]["durationMs"])
        self.assertIsNone(records[1]["durationMs"])
        self.assertEqual(records[1]["observedDurationMs"], 6000)

    def test_command_timings_are_bounded_and_do_not_persist_secrets_or_external_ids(self):
        trace = module._empty_codex_trace()
        secret = "PRIVATE_TOKEN_MUST_NOT_BE_STORED"
        for index in range(1000):
            self.record_command(trace, "item.started", f"{secret}-{index}", f"curl -H 'Authorization: Bearer {secret}'", index)
        result = module._finalize_command_timings(trace, 1001)
        self.assertEqual(len(result["commands"]), 64)
        self.assertEqual(result["omittedEvents"], 936)
        self.assertNotIn(secret, json.dumps(result))
        self.assertNotIn("curl", json.dumps(result))
        self.assertEqual(result["commands"][0]["commandId"], "command-1")

    def test_command_timings_do_not_invent_pairing_for_missing_ids_or_invalid_clocks(self):
        trace = module._empty_codex_trace()
        self.record_command(trace, "item.started", None, "cat README", 1)
        self.record_command(trace, "item.started", "x" * 513, "cat README", 1)
        self.record_command(trace, "item.started", "invalid", "cat README", float("nan"))
        self.record_command(trace, "item.started", "clock", {"not": "a command"}, 10)
        self.record_command(trace, "item.completed", "clock", "cat README", 9, exit_code=True)
        result = module._finalize_command_timings(trace, 20)
        self.assertEqual(result["malformedEvents"], 3)
        self.assertEqual(len(result["commands"]), 1)
        self.assertIsNone(result["commands"][0]["durationMs"])
        self.assertIsNone(result["commands"][0]["exitCode"])
        self.assertTrue(result["commands"][0]["incomplete"])

    def test_git_repo_probe_retries_transient_failure(self) -> None:
        calls = []
        original_run = module.subprocess.run
        original_sleep = module.time.sleep

        def fake_run(*args, **kwargs):
            calls.append((args, kwargs))
            if len(calls) == 1:
                return module.subprocess.CompletedProcess(
                    args=args[0],
                    returncode=128,
                    stdout="",
                    stderr="fatal: not a git repository",
                )
            return module.subprocess.CompletedProcess(
                args=args[0],
                returncode=0,
                stdout="true\n",
                stderr="",
            )

        try:
            module.subprocess.run = fake_run
            module.time.sleep = lambda _seconds: None

            self.assertTrue(
                module._is_git_repo(
                    "/repo/.worktrees/job-123",
                    timeout_seconds=1,
                    poll_seconds=0.01,
                )
            )
            self.assertEqual(len(calls), 2)
        finally:
            module.subprocess.run = original_run
            module.time.sleep = original_sleep

    def test_records_and_finalizes_json_events(self) -> None:
        trace = module._empty_codex_trace()
        module._record_live_codex_stdout_line(
            '{"type":"turn.started","message":"planning started"}',
            True,
            trace,
        )
        self.assertEqual(trace["line_count"], 1)
        self.assertEqual(trace["valid_json"], 1)
        self.assertEqual(trace["invalid_json"], 0)

        finalized = module._finalize_codex_stdout_trace(trace, True)
        self.assertEqual(finalized["line_count"], 1)
        self.assertEqual(finalized["valid_json"], 1)
        self.assertGreaterEqual(finalized["event_type_counts"].get("turn.started", 0), 1)
        self.assertTrue(any("turn.started" in item for item in finalized["summaries"]))

    def test_counts_invalid_json_lines(self) -> None:
        trace = module._empty_codex_trace()
        module._record_live_codex_stdout_line("not-json", True, trace)
        finalized = module._finalize_codex_stdout_trace(trace, True)
        self.assertEqual(finalized["line_count"], 1)
        self.assertEqual(finalized["valid_json"], 0)
        self.assertEqual(finalized["invalid_json"], 1)

    def test_captures_thread_id_for_context_preserving_recovery(self) -> None:
        trace = module._empty_codex_trace()
        module._record_live_codex_stdout_line(
            '{"type":"thread.started","thread_id":"019f-thread-id"}',
            True,
            trace,
        )
        finalized = module._finalize_codex_stdout_trace(trace, True)
        self.assertEqual(finalized["thread_id"], "019f-thread-id")

    def test_plain_text_mode_collects_summaries(self) -> None:
        trace = module._empty_codex_trace()
        module._record_live_codex_stdout_line("hello from codex", False, trace)
        finalized = module._finalize_codex_stdout_trace(trace, False)
        self.assertEqual(finalized["line_count"], 1)
        self.assertIn("hello from codex", "\n".join(finalized["summaries"]))

    def test_surfaces_nested_reasoning_from_item_updated(self) -> None:
        trace = module._empty_codex_trace()
        module._record_live_codex_stdout_line(
            '{"type":"item.updated","item":{"type":"reasoning","summary":[{"text":"drafting plan"}]},"delta":{"type":"response.reasoning_summary_text.delta","text":"next step"}}',
            True,
            trace,
        )
        self.assertGreaterEqual(trace.get("reasoning_events", 0), 1)
        finalized = module._finalize_codex_stdout_trace(trace, True)
        joined = "\n".join(finalized["summaries"])
        self.assertIn("item.updated", joined)
        self.assertIn("drafting plan", joined)
        self.assertGreaterEqual(finalized.get("reasoning_events", 0), 1)

    def test_reasoning_event_without_text_has_fallback_summary(self) -> None:
        trace = module._empty_codex_trace()
        module._record_live_codex_stdout_line(
            '{"type":"item.updated","item":{"type":"reasoning"}}',
            True,
            trace,
        )
        finalized = module._finalize_codex_stdout_trace(trace, True)
        joined = "\n".join(finalized["summaries"])
        self.assertIn("item.updated", joined)
        self.assertIn("reasoning update", joined)


if __name__ == "__main__":
    unittest.main()
