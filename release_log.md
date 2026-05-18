# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.84`
- start_commit: `76cdd6a4a75ff63e9ee476c5b62bbdd02d02a8ed`
- end_commit: `14dab8fff72fd12fc1ed2c267875dbbfd182be0f`
- commits_in_range: `1`

## Highlights

- Harden WorkerPal validation tooling inference for JavaScript workspaces that use npm, pnpm, yarn, and Bun workspace command forms.
- Avoid misclassifying package-manager option values such as `pnpm --filter apps/client test` as script names, while preserving correct root-script inference.
- Resolve workspace package paths and package names for commands such as `npm --workspace @scope/app run lint`, `npm -w apps/app run lint`, and `yarn workspace @scope/app lint`.
- Preserve pnpm workspace-root semantics for `pnpm -w test` so `-w` no longer consumes the actual script name.
- Add regression coverage for workspace path options, equals-form options, scoped workspace package names, pnpm root flags, and generated packaged runtime parity.

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
