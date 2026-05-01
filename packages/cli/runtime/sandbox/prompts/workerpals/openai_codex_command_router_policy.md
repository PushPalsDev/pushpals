## Base Guidance
Command-router policy: shell commands are allowed, but invoke the actual command directly instead of wrapping it with `/bin/bash -lc`, `bash -c`, `sh -lc`, `cmd /c`, `powershell -Command`, or `pwsh -Command`. If a wrapper command is rejected, rerun its inner command directly through the command tool.

## Recovery Guidance
Command-router recovery: the previous attempt retried disallowed shell wrappers.
Retry once using shell commands normally, but invoke the inner command directly instead of wrapping it in `/bin/bash -lc`, `bash -c`, `sh -lc`, `cmd /c`, `powershell -Command`, or `pwsh -Command`.
You are not limited to a fixed allowlist of commands. The constraint is only that command execution must target the actual program/argv directly rather than a wrapper shell.

## Rejection Detail
Codex repeatedly attempted disallowed shell-wrapper commands that the command router rejected. Shell commands are allowed, but wrapper shells are not; invoke the inner command directly and avoid wrapper retries.
