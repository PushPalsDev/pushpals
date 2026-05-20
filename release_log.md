# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.89`
- start_commit: `928bb745812c6e572594627774a5d761ea4fd1f3`
- end_commit: `e6cca7ab71bdcd835a8f2ff7910c09589dae6769`
- commits_in_range: `1`

## Highlights

- Fix the Windows runtime release smoke so it does not require Docker-backed WorkerPal startup on GitHub's Windows runner, where the Linux sandbox image cannot be built from Windows-container mode.
- Keep the smoke exercising real compiled runtime services by starting WorkerPal through the packaged Windows executable in direct mode.
- Teach the smoke to recognize direct WorkerPal child startup logs as a valid warmup outcome instead of waiting only for Docker-oriented or RemoteBuddy warmup summary messages.
- Add a regression test for the generated Windows smoke config so future release changes do not accidentally reintroduce Docker-required WorkerPal startup.

## Validation

- `bun test tests/release-windows-runtime-smoke.test.ts`
- `bun run scripts/release-windows-runtime-smoke.ts --runtime-bin-dir dist/runtime-windows-x64 --prompts-root . --duration-ms 10000`
- `bun run test:root`
- `git diff --check`

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

- `v1.0.88` was tagged but did not publish because the Windows runtime smoke required Docker-backed WorkerPal startup; `v1.0.89` contains the follow-up release-smoke fix.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
