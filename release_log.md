# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.4`
- start_commit: `d02f95b87ec91bbb13cdb65f2413ad735628178b`
- end_commit: `37b3765c507d598281ce74c4dc83922f63a6b7fa`
- commits_in_range: `2`

## Highlights

- Treat task target paths and write globs as relevance hints rather than hard WorkerPal write boundaries, while preserving review and quality gates as the enforcement layer.
- Improve browser-validation convergence by recognizing successful browser smoke sentinels and terminating leaked child process trees instead of waiting for a ValidationGate timeout.
- Route Playwright/browser assertion failures back to WorkerPal as task-scope repair instructions, so workers fix failing smoke behavior instead of treating it as an unrelated repo blocker.
- Preserve a fully validated patch during post-validation ScopeGate/CriticGate cleanup, avoiding late rewrites that can destabilize a passing browser path.
- Hand Codex-produced patches to ValidationGate/CriticGate when shell-wrapper command rejections happen after file changes, rather than burning the full executor timeout on recovery retries.
- Add regression coverage for browser success-sentinel shutdown, browser assertion failure scoping, validation-preserving cleanup guidance, and Codex shell-wrapper convergence.

## Validation

- `bun run cli:bundle`
- `bun test tests/workerpals.validation-command-safety.test.ts tests/workerpals.quality-gate-issues.test.ts`
- `python apps/workerpals/src/backends/openai_codex/test_openai_codex_runtime_config.py`
- `bun run test:root`
- `git diff --check`
- Local replay of SectorCommand job `59cfcfcd-7c17-41a7-950a-a28d24f0d0ef` completed as replay job `6792fd2f-284b-475d-b4b0-005bb3c38ccb`; ValidationGate passed `bun test`, `bun x tsc --noEmit`, `bun run lint`, and `bun run web:e2e`, then opened `https://github.com/PiyushDatta/SectorCommand/pull/53`.

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
