# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.99`
- start_commit: `6bc8e40c79b5b9564d9572ff299cf044df90bf29`
- end_commit: `d897046ed9f911ae3cb8279891188fabe6fc5a45`
- commits_in_range: `1`

## Highlights

- Harden WorkerPal ValidationGate command execution so browser/e2e commands that exit early while child processes keep stdio open report the real exit code and captured error output instead of looking like a 10-minute timeout.
- Default WorkerPal sandbox Node startup to IPv4-first DNS resolution and `REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1`, improving Expo and React Native loopback startup behavior in Docker-backed validation.
- Classify Expo bad-port and loopback permission failures as environment blockers so WorkerPals do not burn all validation auto-revisions trying to edit unrelated application code.
- Add regression coverage for failed browser launchers that leave inherited pipes open, plus sandbox environment tests for the new Expo-friendly defaults and explicit override preservation.
- Sync packaged CLI runtime assets so the published WorkerPal sandbox includes the validation-exit and loopback-startup fixes.

## Validation

- `bun test tests/workerpals.validation-command-safety.test.ts tests/workerpals.sandbox-env.test.ts`
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
