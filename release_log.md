# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.13`
- start_commit: `87b6f9da2788d5790304a2a7b455778336d30c39`
- end_commit: `57a0a27d2eda9da45f3f4cdb43846075b2aed5f3`
- commits_in_range: `2`

## Highlights

- Salvage timed-out OpenAI Codex WorkerPal attempts when publishable file changes already exist, handing the patch to validation instead of failing only on SIGTERM.
- Add a no-edit watchdog for long-running Codex attempts so compact jobs that spend too long in discovery get one patch-first recovery attempt.
- Route compact low-risk and shell-polish tasks from `xhigh` to `high` reasoning effort for faster convergence without changing heavier task defaults.
- Add route-entry and shell-polish guidance that steers workers toward behavior-owning files, small style/helper assertions, and away from broad React Native render harnesses.
- Add discovery and test-harness detour guardrails so small visual tasks switch to narrower coverage when mock/import repair starts consuming the job budget.
- Run safe fast Bun validation commands in bounded parallel batches while keeping browser/runtime validation sequential.
- Emit a concise JobRunner performance summary covering executor, quality, validation command time, and changed-file count.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`
- `python apps\workerpals\src\backends\openai_codex\test_openai_codex_runtime_config.py`
- `bun test tests\workerpals.validation-command-safety.test.ts`
- `bun test tests\workerpals.quality-gate-issues.test.ts`
- `bun test tests\cli.runtime-bootstrap.test.ts --filter "formatSessionEventLine"`

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
