# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.3`
- start_commit: `c807176ae9e14114dd66385e5b6e11cf0baacaf1`
- end_commit: `f4d971000ec54b12f02baa786ec29780d023d1d4`
- commits_in_range: `1`

## Highlights

- Improve WorkerPal browser-validation convergence for repeated Playwright/browser assertion failures by shifting repair guidance toward diagnostic-first investigation after repeated misses.
- Preserve exact browser failure context while nudging later repair attempts to inspect screenshots, artifacts, DOM state, and current e2e harness behavior before changing assertions again.
- Keep the expanded browser repair loop scoped to true browser validation failures so normal validation and non-browser quality gates retain their configured retry behavior.
- Add regression coverage for repeated browser assertion guidance and convergence behavior.

## Validation

- `bun run cli:bundle`
- `bun test tests/remotebuddy.task-dedupe.test.ts`
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
