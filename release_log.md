# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.60`
- start_commit: `d2ffff8b7546520acbb95cfbe1c0dd9148b8fc1d`
- end_commit: `2b5012261fc388ca3ca50cc6511ed412ae9f252b`
- commits_in_range: `1`

## Highlights

- Soft-pass critic-only quality revisions when the patch is publishable, required validation has passed, `quality_soft_pass_on_exhausted=true`, and the remaining execution budget is too small for another worker turn.
- Preserve hard failures for deterministic quality blockers, required validation failures, non-publishable changes, and configurations where exhausted soft-pass is disabled.
- Keep the existing revision-budget guard for unsafe cases while preventing validated browser-passing work from becoming a terminal failed job solely because the critic wanted another refinement.
- Add regression coverage for the critic-only budget-exhaustion decision path.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `bun test tests/workerpals.quality-gate-issues.test.ts`
- `bun --cwd apps/workerpals tsc --noEmit`
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
- The npm package still requires a working Bun runtime to launch the package entrypoint; PushPals does not vendor Bun or other external toolchains in the npm package.
- Direct GitHub release binaries are PushPals-built standalone artifacts. Removing embedded Bun runtime from those standalone artifacts would require a separate runtime distribution redesign.
- Active runtimes that were started from an older release must be restarted after installing this release before new startup or packaged-runtime behavior takes effect.
- Docker-backed WorkerPal execution can use a stalled Docker Codex startup as the signal to switch future WorkerPal spawns to direct isolated-worktree execution; if the replacement direct WorkerPal also cannot start Codex, that retry can still fail terminally and recycle the worker.
- QualityGate can still reject or request repair for a broad patch after the rollout coach hands publishable progress forward; this release changes the failure point from executor pre-validation failure to structured gate diagnostics.
- Bun dependency-layout preflight is offline and lockfile-frozen; if the local Bun cache is incomplete or the lockfile cannot be satisfied, ValidationGate will continue and report the dependency/setup blocker rather than modifying project manifests.
- Expo Router browser validation now removes linked `node_modules` artifacts before dependency repair; if the offline Bun cache is incomplete, the browser validation may still report a local dependency/setup blocker.
- Critic-only soft-pass applies only after required validation passes; a low critic score can still block when there is enough budget for another revision, when deterministic gates find issues, or when exhausted soft-pass is disabled.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
