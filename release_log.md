# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.15`
- start_commit: `c0fad730404f8caf6e900f8b817b02dda0f717dd`
- end_commit: `a912ac187ba5fa30be336662a1d2f75c00914945`
- commits_in_range: `1`

## Highlights

- Suppress WorkerPal job, task, status, validation, quality, Docker, and Codex session events from the interactive CLI prompt by default so operational chatter stays in logs and the monitor.
- Keep human assistant replies visible while dropping startup heartbeat messages such as `All systems online`.
- Add `PUSHPALS_CLI_SHOW_JOB_EVENTS=1` as an explicit debug opt-in for tailing job events from the terminal.
- Normalize OpenAI Codex host-timeout `SIGTERM` results into `openai_codex execution budget expired` with exit code `124` instead of exposing raw `signal 15` in job summaries.
- Sync the packaged CLI WorkerPal sandbox so embedded installs receive the same quiet CLI stream and timeout-result normalization.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`
- `bun test tests\cli.runtime-bootstrap.test.ts --filter "formatSessionEventLine"`
- `bun test tests\workerpals.generic-python-executor.test.ts`
- `bun x tsc --noEmit --project apps\workerpals\tsconfig.json`

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
