# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.16`
- start_commit: `75d33e66d975b77f896895dce0c964a820e9ec2f`
- end_commit: `1feac159c4c30da5abd6b4b4c06022be0b8a06f0`
- commits_in_range: `4`

## Highlights

- Reduce embedded startup delay by treating a healthy RemoteBuddy service as ready before waiting on a delayed session-consumer heartbeat.
- Keep repo-owned dependency artifacts out of ScopeGate publish failures so linked `node_modules` state does not poison otherwise scoped WorkerPal changes.
- Keep browser-test-only failures scoped to browser repair prompts instead of broadening into unrelated validation churn.
- Send Docker job specs over stdin instead of giant encoded command-line arguments, reducing opaque spawn failures on large jobs.
- Skip Docker retry attempts when the prior attempt already consumed most of the available timeout budget.
- Shorten managed WorkerPal worktree names and cleanup matchers to avoid Windows path-length cleanup failures.
- Compact RemoteBuddy autonomy ideation context so normal queue cycles use smaller prompt payloads before retry fallback is needed.
- Improve failed job summaries with the compact underlying error instead of a generic pre-completion failure message.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`
- `bun test tests\workerpals.docker-executor.test.ts`
- `bun test tests\remotebuddy.autonomous-engine.tick.test.ts`

## Install

```bash
npm i -g @pushpalsdev/cli
```

```bash
bun install -g @pushpalsdev/cli
```

## Artifacts

- `pushpals-linux-x64`
- `pushpals-windows-x64.exe`
- `pushpals-macos-x64`
- `pushpals-macos-arm64`
- `SHA256SUMS.txt`

## Breaking Changes

- None.

## Known Issues

- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
