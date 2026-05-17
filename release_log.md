# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.83`
- start_commit: `6f066bb0ac6394eda3359e3cd384028001b8742d`
- end_commit: `4e13eee6de5d8d8990c63f4177d6aeb542ae69c5`
- commits_in_range: `1`

## Highlights

- Make WorkerPal validation tooling inference workspace-aware so package scripts such as `bun run lint` do not require globally installed Node CLIs like `expo`, `vite`, or `tsc`.
- Scan referenced validation scripts, including workspace-relative scripts under `bun --cwd`, so hidden tool dependencies inside commands such as `bun scripts/web-e2e.ts` are detected before validation runs.
- Run WorkerPal validation commands with writable temp `HOME`, cache, npm, and Expo directories plus non-interactive CI defaults, reducing false sandbox failures from CLIs that write user-level state.
- Preserve real repo validation failures while reducing false missing-tool blockers for repo-local JavaScript tooling.
- Add regression coverage for package-script Node CLI inference, hidden validation script scanning, and package-cwd script path resolution.

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
