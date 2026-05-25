# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.1`
- start_commit: `c15a6e9e9a0fca80a003772801f93e3ac2149e9b`
- end_commit: `e0ef0245a6fd5dc4a7a1a70a7fd5a2b4ea6b95bb`
- commits_in_range: `1`

## Highlights

- Improve WorkerPal browser-validation convergence for repo-native `web:e2e` jobs by turning browser failures into focused repair packets with stage, selector, expected UI, prior-failure breadcrumb, and relevant output.
- Extend the browser-validation retry budget to five targeted repair attempts while keeping other ValidationGate failures on the configured retry budget.
- Hydrate Docker WorkerPal ephemeral worktrees with repo dependency artifacts such as `node_modules`, so Expo/Playwright smoke checks run against the same installed dependencies as the source checkout.
- Prevent sandbox artifacts, including linked `node_modules`, from being staged into WorkerPal commits.
- Treat browser smoke harness scripts as test harnesses without forcing app-test positive/negative assertion-balance rules onto e2e launcher scripts.
- Add `bun run replay:worker-job` for replaying a specific durable WorkerPal job against a running local PushPals server, making convergence bugs reproducible without running the full app workflow.
- Confirmed the previously failing SectorCommand replay passed all required validation, including default `bun run web:e2e`, and produced a clean PR without committing `node_modules`.

## Validation

- `bun run cli:bundle`
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

- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
