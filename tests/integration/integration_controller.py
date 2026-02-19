#!/usr/bin/env python3
"""Single entrypoint for PushPals integration test modes.

Routes to the shared integration harness with mode-specific env defaults.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
HARNESS = REPO_ROOT / "tests" / "integration" / "test_workerpals_e2e.py"


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
    args = parser.parse_args()

    env = os.environ.copy()
    _configure_mode_env(args.mode, env)

    print(
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
        return 0

    cmd = [sys.executable, "-u", str(HARNESS)]
    proc = subprocess.run(cmd, cwd=str(REPO_ROOT), env=env, check=False)
    return int(proc.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
