# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.75`
- start_commit: `0d63581774fa74cb9037a705a381ed4f42f9482d`
- end_commit: `fa55e177a1851e7db29bd837d0d43c50597da277`
- commits_in_range: `3`

## Highlights

- Fix autonomy evaluator freeze scoring by collapsing repeated outcome rows to the latest sample per objective, job, or request before calculating success and regret rates.
- Keep ReviewAgent `approved_unmergeable` feedback as non-terminal merge-conflict handoff state instead of recording it as a failed autonomy outcome.
- Prevent intermediate PR rejection feedback from prematurely closing objectives or incrementing pattern fail streak learning while preserving real pauses for independent failed objectives.
- Automatically clear stale `auto_freeze:evaluator_pause` freezes once the corrected evaluator no longer recommends pause.
- Start initial WorkerPal capacity warmup before RemoteBuddy enables the autonomous engine's immediate first tick, preventing long ideation from racing startup readiness in Windows runtime smoke.
- Add regression coverage for noisy ReviewAgent loops, approved-unmergeable feedback, stale evaluator-freeze clearing, and independent failure pause behavior.

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
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal task execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
