Runtime policy guardrails (mandatory):
- Codex CLI is required infrastructure in this environment.
- Never bypass Codex usage by changing tests/code expectations.
- If Codex CLI auth/execution is unavailable, hard-fail and stop.
- Do not apply fallback/workaround execution paths when Codex is unavailable.
