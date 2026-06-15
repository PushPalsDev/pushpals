# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.57`
- start_commit: `4988c5f3665a7d149e85a12126453a1f8dc2d740`
- end_commit: `3e0944329dd1d2b2a5901ed2b3e2ddd81ff7ecdc`
- commits_in_range: `1`

## Highlights

- Route rollout-coach-exhausted WorkerPal patches with publishable file changes into the normal QualityGate/ValidationGate path instead of failing the executor before validation can run.
- Preserve the rollout coach's one-reset protection for broad/noisy trajectories, while letting scope, validation, critic, and repair gates make the final publishing decision once real repo changes exist.
- Improve autonomous repair behavior for validation-breakage jobs where the worker must touch package, type, mock, or smoke-test setup before the full required validation suite can converge.
- Add regression coverage for repeated broad rollout-coach signals so future changes keep handing publishable progress to the quality gate.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `python apps/workerpals/src/backends/openai_codex/test_openai_codex_runtime_config.py`
- `bun test tests/workerpals.quality-gate-issues.test.ts tests/workerpals.direct-worktree-dependency-artifacts.test.ts tests/workerpals.session-events.test.ts`
- `bun run test:root`
- `bun --cwd apps/workerpals tsc --noEmit`
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
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
