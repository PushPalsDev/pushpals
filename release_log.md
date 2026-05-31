# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.8`
- start_commit: `df2fb20c11148e27595fe53759de27d6792e9eda`
- end_commit: `21e39e1e318d450e62086a0e9da2b573e09bd1c2`
- commits_in_range: `1`

## Highlights

- Harden ReviewAgent convergence so active review-fix jobs no longer suppress needed merge-conflict repair jobs for the same PR head.
- Resolve autonomy PR feedback through ReviewAgent `sourceJobId` metadata, preserving pattern learning for review-fix and merge-conflict follow-up jobs.
- Make WorkerPal merge-conflict continuation more resilient by boundedly continuing or skipping empty prepared rebase commits instead of failing as soon as a Git rebase sequencer remains active.
- Package the WorkerPal sandbox runtime copy with the same merge-conflict continuation behavior for installed CLI users.

## Validation

- `bun run cli:bundle`
- `bun test tests/source-control-manager.review-agent.test.ts`
- `bun test tests/server.autonomy-store.test.ts`
- `bun test tests/workerpals.merge-conflict-job.test.ts`
- `bun x --bun tsc --noEmit -p apps/server/tsconfig.json`
- `bun x --bun tsc --noEmit -p apps/source_control_manager/tsconfig.json`
- `bun x --bun tsc --noEmit -p apps/workerpals/tsconfig.json`
- `bun x --bun tsc --noEmit -p packages/cli/runtime/sandbox/apps/workerpals/tsconfig.json`
- `bun run lint` completed with 2 pre-existing client warnings.
- `bun run test:root` completed successfully: 763 pass, 1 skip, 0 fail.
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
