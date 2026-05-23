# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.95`
- start_commit: `32567e810b8abc3c7342a0fdb94a0f2af722e988`
- end_commit: `444394df96c8678647351877891f0145e5d284f3`
- commits_in_range: `1`

## Highlights

- Harden Windows startup when local Git/Bun certificate verification cannot use the right Windows trust path.
- Make CLI Git commands and embedded runtime child services inherit `http.sslBackend=schannel` on Windows.
- Fall back from Bun GitHub release/API fetches to Windows-native paths when certificate verification fails: Git for latest tag resolution and `curl.exe --ssl-no-revoke` for runtime binary downloads.
- Keep Docker-backed WorkerPal startup moving after certificate fallback; local bundled CLI smoke reached ready state with WorkerPal capacity online.

## Validation

- `bun run cli:bundle`
- `bun test tests/cli.runtime-bootstrap.test.ts`
- `bun run test:root`
- `git diff --check`
- Bundled Windows startup smoke: `bun packages/cli/dist/pushpals-cli.js --runtime-root <temp> --runtime-tag v1.0.94 --status-once`
- Source-checkout Windows startup smoke: `bun scripts/pushpals-cli.ts --status-once`

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

- npm publication requires the repository `NPM_TOKEN` secret to have publish rights for `@pushpalsdev/cli` under the `@pushpalsdev` scope.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
