# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.2`
- start_commit: `755dab48ef4fc622754f8ebb920b171588f5e52a`
- end_commit: `5b13253f36e2d86b496f07f7a5fa59c9b9ba1df8`
- commits_in_range: `1`

## Highlights

- Extend WorkerPal browser-validation convergence to eight targeted repair attempts while keeping non-browser and merge-conflict jobs on their configured revision limits.
- Hydrate browser repair guidance from recent e2e/log artifacts, preserving stage, selector, expected UI, prior-failure breadcrumbs, and relevant output when command output is compacted.
- Extend Docker WorkerPal job timeouts only for browser-validation jobs so the larger repair budget is not killed and restarted mid-convergence.
- Tighten OpenAI Codex WorkerPal guidance so long browser/e2e validation is delegated to ValidationGate by default, avoiding executor-only port/freeport false signals.
- Add regression coverage for browser retry scoping, dynamic Docker timeouts, artifact-backed repair packets, and prompt guidance.

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
