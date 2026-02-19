#!/usr/bin/env python3
"""Backward-compatible wrapper around integration_controller.py (eval mode).

Defaults now target harder eval runs with per-backend budgets.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    cmd = [
        sys.executable,
        "-u",
        "tests/integration/integration_controller.py",
        "--mode",
        "eval",
    ]
    proc = subprocess.run(cmd, cwd=str(REPO_ROOT), check=False)
    return int(proc.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
