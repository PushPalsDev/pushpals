# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.100`
- start_commit: `250de11af911e745d2e656acff58821f7ab7e427`
- end_commit: `d0cfda05d56a8e7f6afd85801e5a32b3692faf73`
- commits_in_range: `2`

## Highlights

- Stop leaked browser/e2e validation process trees after a captured fatal browser failure goes idle, so WorkerPal jobs preserve the actionable failure instead of burning the full ValidationGate timeout.
- Recognize Playwright locator failures such as `locator.waitFor: Timeout ... exceeded`, `Call log:`, and `waiting for getByTestId(...)` as browser smoke failures that should fail fast.
- Keep browser/e2e validation output useful by extracting the specific Playwright, network, and browser launch failure lines into validation digests.
- Clarify WorkerPal Codex execution guidance so the deterministic ValidationGate owns repo-required `vision.md` validation, while the edit turn prefers focused checks instead of repeatedly running long `web:e2e` smoke commands.
- Sync packaged CLI runtime and prompt assets so published WorkerPal sandboxes receive the browser-validation watchdog and prompt updates.

## Validation

- `bun test tests/workerpals.validation-command-safety.test.ts`
- `bunx tsc -p apps/workerpals/tsconfig.json --noEmit`
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
