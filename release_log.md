# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.82`
- start_commit: `0eee94aa255548a89c9434f6e6efb772205ff1d4`
- end_commit: `62d9c4f6c5246e72ebff7a6c37524e2a1366a04b`
- commits_in_range: `1`

## Highlights

- Add WorkerPal validation toolchain preflight so required `vision.md` validation fails fast when commands need missing executables instead of waiting through long per-command timeouts.
- Infer validation dependencies from runnable commands, package scripts, repo-native build signals, and declared environment files such as devcontainers, Dockerfiles, mise/asdf, and Nix files.
- Expand the WorkerPal sandbox baseline with Node/npm and native build tooling (`build-essential`, `cmake`, `pkg-config`) so common JavaScript, Expo, TypeScript, and native-build validation paths work out of the box.
- Classify missing toolchain executables as environment blockers with explicit skipped-command diagnostics, while preserving normal repo/test failures as real validation failures.
- Add shared toolchain inference tests covering Bun, Node-backed CLIs, package-manager script routing, native compiler detection, and declared repo environment detection.

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
