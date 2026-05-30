# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.6`
- start_commit: `97ec8312cf3161fe757c74542f7201b03a835179`
- end_commit: `65018ec6e47f31c5e1407f9eb825704748e93bdc`
- commits_in_range: `3`

## Highlights

- Harden Windows CLI startup and shutdown so successful cold starts do not leave Bun waiting on uncancelled timeout timers or unbounded cleanup work.
- Bound process-output collection and Windows `taskkill` calls so timeout cleanup cannot pin the CLI when child processes or pipes misbehave.
- Skip the WorkerPal capacity wait when auto-spawn is disabled, reporting the disabled state immediately instead of spending startup time in a misleading warmup probe.
- Retry transient embedded runtime binary download failures so one flaky GitHub/curl attempt does not fail first-run startup.
- Preserve browser assertion failure context across WorkerPal repair revisions and bound quality critic execution so passing validation is not delayed by a slow critic.

## Validation

- `bun test tests/cli.runtime-bootstrap.test.ts --timeout 20000`
- `bun run test:cli:integration`
- `bun run cli:bundle`
- `git diff --check`
- Local installed CLI package smoke from a freshly packed tarball on Windows: `bun scripts/release-installed-cli-smoke.ts --package-spec <local tgz>` completed successfully and returned to the shell in 42s.

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
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
