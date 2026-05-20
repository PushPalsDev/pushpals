# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.88`
- start_commit: `31be2277d4dff1b55e4a581a62a9b5e695e36f31`
- end_commit: `c5e10446591ae0b61168b2bb6238cb0e1a7488e1`
- commits_in_range: `1`

## Highlights

- Bound Docker cleanup during Codex-unavailable WorkerPal recycle so policy-violation and incompatible-Codex workers exit promptly with the expected recycle code instead of hanging behind slow container shutdown.
- Preserve best-effort Docker cleanup while allowing RemoteBuddy to replace a known-bad WorkerPal quickly after the job failure has already been reported.
- Add an injectable fetch path for RemoteBuddy orchestration and shared communication so tests no longer fight over process-global `fetch` mocks during full root-suite runs.
- Harden RemoteBuddy session routing, task dedupe, and autoscale tests to use scoped fetch implementations, removing cross-test flakiness exposed by the release baseline.
- Sync packaged CLI runtime and sandbox assets so installed CLI users receive the WorkerPal recycle and RemoteBuddy communication updates.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `bun run test:workerpals:e2e`
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

- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
