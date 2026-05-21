# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.92`
- start_commit: `15382700dbb2cd894fb629396cce950ca95a05e8`
- end_commit: `a9e94d02d7b4764240fa3769af7a4fb4bc99816d`
- commits_in_range: `1`

## Highlights

- Fix the npm publish-token preflight to use the supported `npm access list packages` command form, matching the npm CLI version used by GitHub Actions.
- Preserve the existing package owner and read-write permission checks, but avoid failing valid publish tokens because of an invalid npm access subcommand.
- Keep GitHub release asset publication gated behind successful npm publication so failed npm auth/preflight runs do not create partial releases.

## Validation

- `bun x prettier --check .github/workflows/release-cli.yml`
- `npm access list packages '@pushpalsdev' --json --registry=https://registry.npmjs.org`
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

- `v1.0.87`, `v1.0.88`, `v1.0.89`, `v1.0.90`, and `v1.0.91` were tagged but did not publish to npm; `v1.0.89` did publish GitHub release assets before the npm token failure, while later releases were blocked before GitHub release asset publication.
- npm publication requires the repository `NPM_TOKEN` secret to have publish rights for `@pushpalsdev/cli` under the `@pushpalsdev` scope.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
