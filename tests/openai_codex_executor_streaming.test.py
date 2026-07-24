#!/usr/bin/env python3
import importlib.util
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
