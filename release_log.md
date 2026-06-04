# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.19`
- start_commit: `8c1892210ad5907f8f65ab92e94dc0d292854edb`
- end_commit: `cf65e23b70377a7c5906c03bb724f3e3f378a4d6`
- commits_in_range: `1`

## Highlights

- Improve WorkerPal convergence safeguards with generic stale-target hint sanitation before workers chase missing repo paths.
- Skip long browser/e2e validation when deterministic fast validation already proves the patch cannot publish, so retries focus on the real blocker first.
- Add repo/job-family validation remedy memory and rollout scoring signals to improve future revision guidance without repo-specific rules.
- Sync the packaged CLI sandbox WorkerPal and RemoteBuddy runtimes so installed CLI releases receive the same convergence behavior.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`
- `bun test tests\workerpals.validation-command-safety.test.ts`
- `bun test tests\workerpals.quality-gate-issues.test.ts`
- `python apps\workerpals\src\backends\openai_codex\test_openai_codex_runtime_config.py`

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
