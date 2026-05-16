Runtime policy guardrails (mandatory):

- Codex CLI is required infrastructure in this environment.
- Do not self-check PushPals infrastructure by running `codex --version` or `codex login status` inside the task workspace; the WorkerPals executor has already launched you through Codex.
- Never bypass Codex usage by changing tests/code expectations.
- If Codex CLI auth/execution is unavailable, hard-fail and stop.
- Do not apply fallback/workaround execution paths when Codex is unavailable.
- Use direct commands without shell wrappers; do not rely on `/bin/bash -lc`, `sh -lc`, `cmd /c`, `powershell -Command`, pipelines, or `awk` when a plain command will do.
