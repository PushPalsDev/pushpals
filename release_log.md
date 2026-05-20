# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.91`
- start_commit: `bde7cc36581c41616a49f6567d8cfb5aa038f4e9`
- end_commit: `73d5e15f2ea2e86c4e8e47ce6562c829deaa99ec`
- commits_in_range: `2`

## Highlights

- Force WorkerPal recycle promptly after known-bad Codex backend failures, including command-policy/workaround failures, so CI and runtime supervisors do not wait behind Docker cleanup before replacing the worker.
- Skip the misleading idle heartbeat on Codex recycle paths; the worker now reports offline best-effort and exits with the expected recycle code.
- Keep Docker/worktree cleanup best-effort during Codex recycle while bounding replacement latency with a hard force-exit timer.
- Add npm publish-token preflight diagnostics so release runs fail early with a concrete token/package-access message instead of spending time building a tarball and failing with npm's opaque scoped-package `E404`.
- Clean the CLI package `bin` path so npm no longer auto-corrects `bin[pushpals]` during publish.

## Validation

- `bun x prettier --check .github/workflows/release-cli.yml packages/cli/package.json`
- `npm pack --dry-run --ignore-scripts` from `packages/cli`
- `bun test ./tests/integration/workerpals.control-plane.e2e.ts -t "worker reports a codex policy violation"`
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

- `v1.0.87`, `v1.0.88`, `v1.0.89`, and `v1.0.90` were tagged but did not publish to npm; `v1.0.89` did publish GitHub release assets before the npm token failure.
- npm publication requires the repository `NPM_TOKEN` secret to have publish rights for `@pushpalsdev/cli` under the `@pushpalsdev` scope.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
