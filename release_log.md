# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.97`
- start_commit: `a2b1058ab9aa92f6b22ab2d366927981a9d8c228`
- end_commit: `a47206756b8fb55f69502cea1b47abb3fa0a3e39`
- commits_in_range: `1`

## Highlights

- Provision WorkerPal browser validation with a stable Playwright browser cache that is shared across ephemeral job worktrees for the same repo.
- Add a ValidationGate browser runtime preflight that runs the repo-matching `bunx playwright install chromium` before Playwright-backed web smoke commands.
- Improve browser-validation diagnostics so missing Playwright browsers are reported as browser-runtime/tooling blockers instead of being hidden behind `SIGTERM` timeout summaries.
- Kill validation command process trees on timeout so Expo/Metro child processes do not linger after failed browser smoke runs.
- Sync packaged CLI runtime assets so the published WorkerPal sandbox includes the browser-runtime validation fix.

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
