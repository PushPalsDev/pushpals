# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.70`
- start_commit: `d391d634a3dda1ac711dfce3d6bd106159701eaa`
- end_commit: `dfac5e7828d31ed1b4ea0a4e60a2f50c5efba89a`
- commits_in_range: `1`

## Highlights

- Add `[workerpals] execution_platform` with `auto`, `windows`, and `linux_docker` modes.
- Let repos that need Windows host validation set `execution_platform = "windows"` to force direct WorkerPal execution even when older Docker toggles are still enabled.
- Let operators set `execution_platform = "linux_docker"` when they explicitly want Docker-backed WorkerPals; the default `auto` preserves existing Docker config behavior.
- Support `WORKERPALS_EXECUTION_PLATFORM` and `PUSHPALS_WORKERPALS_EXECUTION_PLATFORM` overrides, and ship the new option through default/example configs plus packaged runtime assets.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `bun test tests\shared.config.execution-platform.test.ts tests\shared.config.workerpals-quality-threshold.test.ts`
- `bun test tests\cli.runtime-bootstrap.test.ts`
- `bun test tests\server.runtime-config-mutations.test.ts tests\server.runtime-config-route.test.ts tests\remotebuddy.worker-spawn-command.test.ts`
- `bun x tsc --noEmit --project packages\shared\tsconfig.json`
- `bun x tsc --noEmit --project apps\workerpals\tsconfig.json`
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

- `execution_platform = "windows"` selects direct host WorkerPal execution so validation inherits the Windows host environment; it does not convert Docker Desktop Linux containers into Windows containers.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out, and still reports a clear failure if Windows keeps a runtime-data path locked after the retry window.
- Active runtime-only supervisors started from v1.1.64 or older did not write the new runtime-host PID state, so they may need to be stopped once manually before this release can prevent future `outputs/data` EBUSY loops.
- The npm package still requires a working Bun runtime to launch the package entrypoint; PushPals does not vendor Bun or other external toolchains in the npm package.
- Direct GitHub release binaries are PushPals-built standalone artifacts. Removing embedded Bun runtime from those standalone artifacts would require a separate runtime distribution redesign.
- Active runtimes that were started from an older release must be restarted after installing this release before new startup or packaged-runtime behavior takes effect.
- PushPals does not currently read Codex TUI `/status` directly; by default it avoids enforcing an independent local session-token pause and relies on the active Codex/LLM provider budget. Users who need a local safety cap can set `session_token_budget` or `PUSHPALS_SESSION_TOKEN_BUDGET`.
- Docker-backed WorkerPal execution can use a stalled Docker Codex startup as the signal to switch future WorkerPal spawns to direct isolated-worktree execution; if the replacement direct WorkerPal also cannot start Codex, that retry can still fail terminally and recycle the worker.
- QualityGate can still reject or request repair for a broad patch after the rollout coach hands publishable progress forward; this release changes the failure point from executor pre-validation failure to structured gate diagnostics.
- Bun dependency-layout preflight is offline and lockfile-frozen; if the local Bun cache is incomplete or the lockfile cannot be satisfied, ValidationGate blocks validation and reports the dependency/setup blocker rather than running later validation against an incomplete dependency tree or modifying project manifests.
- Expo Router browser validation now removes linked `node_modules` artifacts before dependency repair; if the offline Bun cache is incomplete, the browser validation may still report a local dependency/setup blocker.
- OpenAI Codex WorkerPal jobs can still fail if Codex produces no publishable edit after the final no-edit recovery attempt or if the shared executor budget is already too low for another recovery.
- OpenAI Codex WorkerPal jobs still fail fast on truly broad/noisy publishable diffs after timeout; tracked paths with no staged or unstaged Git content delta are now filtered before ScopeGate and quality diagnostics.
- OpenAI Codex rollout coaching still blocks missing-path drift, PushPals/autonomy internals in user repos, and full render/full-surface harness expansion; this release only permits mock/harness terminology when the task explicitly requests that repair surface.
- Critic-only soft-pass applies only after required validation passes; a low critic score can still block when there is enough budget for another revision, when deterministic gates find issues, or when exhausted soft-pass is disabled.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --open_config`, `pushpals --clear`, or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
