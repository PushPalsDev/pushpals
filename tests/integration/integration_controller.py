#!/usr/bin/env python3
"""Single entrypoint for PushPals integration test modes.

Routes to the shared integration harness with mode-specific env defaults.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
HARNESS = REPO_ROOT / "tests" / "integration" / "test_workerpals_e2e.py"
DEFAULT_LOG_PATH = REPO_ROOT / "workerpals_e2e.log"


def _set_default_env(env: dict[str, str], key: str, value: str) -> None:
    if not str(env.get(key, "")).strip():
        env[key] = value


def _clear_env(env: dict[str, str], keys: list[str]) -> None:
    for key in keys:
        env.pop(key, None)


def _configure_mode_env(mode: str, env: dict[str, str]) -> None:
    if mode == "eval":
        _set_default_env(env, "WORKERPALS_E2E_EVAL", "1")
        _set_default_env(env, "WORKERPALS_E2E_MAX_TOTAL_SEC", "0")
        _set_default_env(env, "WORKERPALS_E2E_MAX_BACKEND_SEC", "1200")
        _set_default_env(env, "WORKERPALS_E2E_REQUEST_TIMEOUT_SEC", "960")
        _set_default_env(env, "WORKERPALS_MINISWE_TOOL_BROKER_HTTP_TIMEOUT_SEC", "120")
        _set_default_env(env, "WORKERPALS_MINISWE_TOOL_BROKER_HTTP_RETRY_MAX", "1")
        _set_default_env(env, "WORKERPALS_E2E_EVAL_OUTPUT", str(REPO_ROOT / "outputs" / "workerpals_backend_eval.json"))
        _set_default_env(env, "WORKERPALS_E2E_EVAL_SCENARIO_SUITE", "real-hard")
        _set_default_env(env, "WORKERPALS_E2E_SCENARIOS_PER_BACKEND", "1")
        _set_default_env(env, "WORKERPALS_E2E_SCENARIO_STRATEGY", "same")
        return

    env["WORKERPALS_E2E_EVAL"] = "0"
    _clear_env(
        env,
        [
            "WORKERPALS_E2E_MAX_TOTAL_SEC",
            "WORKERPALS_E2E_MAX_BACKEND_SEC",
            "WORKERPALS_E2E_EVAL_OUTPUT",
            "WORKERPALS_E2E_EVAL_SCENARIO_SUITE",
            "WORKERPALS_E2E_SCENARIOS_PER_BACKEND",
            "WORKERPALS_E2E_SCENARIO_STRATEGY",
        ],
    )


def _stream_harness_output(
    cmd: list[str],
    cwd: Path,
    env: dict[str, str],
    log_path: Path,
    prelude_lines: list[str] | None = None,
) -> int:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", encoding="utf-8", newline="") as log_file:
        lines = list(prelude_lines or [])
        lines.append(f"[integration-controller] tee log file: {log_path}")
        for line in lines:
            print(line)
            log_file.write(f"{line}\n")
        log_file.flush()

        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        assert proc.stdout is not None
        try:
            for line in proc.stdout:
                try:
                    sys.stdout.write(line)
                    sys.stdout.flush()
                except UnicodeEncodeError:
                    safe_line = line.encode(sys.stdout.encoding or "utf-8", errors="replace").decode(
                        sys.stdout.encoding or "utf-8",
                        errors="replace",
                    )
                    sys.stdout.write(safe_line)
                    sys.stdout.flush()
                log_file.write(line)
                log_file.flush()
            return int(proc.wait())
        except KeyboardInterrupt:
            if proc.poll() is None:
                try:
                    proc.send_signal(signal.SIGINT)
                except Exception:
                    proc.terminate()
            return int(proc.wait())


def main() -> int:
    parser = argparse.ArgumentParser(description="PushPals integration test controller")
    parser.add_argument(
        "--mode",
        choices=["integration", "eval"],
        default="integration",
        help="integration: regular flow test, eval: backend quality benchmark",
    )
    parser.add_argument(
        "--pass-through",
        action="store_true",
        help="Only print mode/env config; do not launch the harness.",
    )
    parser.add_argument(
        "--log-file",
        default=os.environ.get("WORKERPALS_E2E_LOG_FILE", str(DEFAULT_LOG_PATH)),
        help="Path for tee-style integration output log (default: repo/workerpals_e2e.log).",
    )
    args = parser.parse_args()

    env = os.environ.copy()
    _configure_mode_env(args.mode, env)

    controller_line = (
        "[integration-controller] mode={mode} eval={eval_flag} budget={budget} "
        "backend_budget={backend_budget} request_timeout={timeout} scenario_suite={suite} scenarios_per_backend={spb}".format(
            mode=args.mode,
            eval_flag=env.get("WORKERPALS_E2E_EVAL"),
            budget=env.get("WORKERPALS_E2E_MAX_TOTAL_SEC", "<none>"),
            backend_budget=env.get("WORKERPALS_E2E_MAX_BACKEND_SEC", "<none>"),
            timeout=env.get("WORKERPALS_E2E_REQUEST_TIMEOUT_SEC", "<default>"),
            suite=env.get("WORKERPALS_E2E_EVAL_SCENARIO_SUITE", "<none>"),
            spb=env.get("WORKERPALS_E2E_SCENARIOS_PER_BACKEND", "<none>"),
        )
    )

    if args.pass_through:
        print(controller_line)
        return 0

    log_path = Path(args.log_file)
    default_log_resolved = DEFAULT_LOG_PATH.resolve()
    try:
        selected_log_resolved = log_path.resolve()
    except Exception:
        selected_log_resolved = log_path
    if selected_log_resolved == default_log_resolved and log_path.exists():
        log_path.unlink()

    cmd = [sys.executable, "-u", str(HARNESS)]
    return _stream_harness_output(
        cmd=cmd,
        cwd=REPO_ROOT,
        env=env,
        log_path=log_path,
        prelude_lines=[controller_line],
    )


if __name__ == "__main__":
    raise SystemExit(main())
