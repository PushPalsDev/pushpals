# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.98`
- start_commit: `5594ad8093317d153ae8f50d62f3483e75522548`
- end_commit: `ba2f5bcdca483221cac64d95a21393bfad3a22bf`
- commits_in_range: `1`

## Highlights

- Teach WorkerPal ValidationGate to infer Playwright browser targets from repo e2e scripts and command flags instead of assuming every browser smoke uses bundled Chromium.
- Provision requested Playwright targets such as `msedge`, `chrome`, `firefox`, and `webkit` before running repo browser validation, fixing sandboxes where the app's smoke harness launches a browser channel.
- Track browser-runtime preflight readiness per browser target so mixed browser commands install only the missing targets.
- Improve browser preflight logs to name the exact Playwright target(s) being provisioned or failing.
- Sync packaged CLI runtime assets so the published WorkerPal sandbox includes the browser-target preflight fix.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`
- `bun test tests/workerpals.sandbox-env.test.ts tests/workerpals.validation-command-safety.test.ts`
- `bunx tsc -p apps/workerpals/tsconfig.json --noEmit`

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
