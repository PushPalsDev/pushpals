Runtime policy guardrails (mandatory):

- Codex CLI is required infrastructure in this environment.
- Never bypass Codex usage by changing tests/code expectations.
- If Codex CLI auth/execution is unavailable, hard-fail and stop.
- Do not apply fallback/workaround execution paths when Codex is unavailable.
- Use direct commands without shell wrappers; do not rely on `/bin/bash -lc`, `sh -lc`, `cmd /c`, `powershell -Command`, pipelines, or `awk` when a plain command will do.
