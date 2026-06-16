# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.65`
- start_commit: `6243ba2b5f14d37f8f4de204da83fb0136f554bf`
- end_commit: `684bf6b4519372f2c7776037efc14559dc1295ea`
- commits_in_range: `1`

## Highlights

- Persist the runtime-only CLI host PID in repo-local state when the embedded runtime is auto-started.
- Make `pushpals --clear` verify and stop that saved runtime host process tree before deleting repo-local runtime data, preventing the supervisor from restarting services and reopening SQLite WAL/SHM files during cleanup.
- Preserve the saved runtime host identity when short-lived CLI sessions attach to an existing runtime, so `/status` or normal CLI usage does not erase the information needed for a later clear.
- Add focused coverage for runtime-host candidate selection, command-line verification, and stale-PID refusal.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `bun test tests/cli.runtime-bootstrap.test.ts`
- `bun test tests/cli.invocation-logging.test.ts -t "pushpals --clear"`
- `bun run test:cli:integration`
- `bun run test:root`
- `git diff --check`
- Manual SectorCommand smoke: stopped the pre-existing v1.1.64 runtime-only process tree once, then ran the patched `pushpals --clear`; `outputs/data` was removed and no PushPals runtime processes remained.

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
- Critic-only soft-pass applies only after required validation passes; a low critic score can still block when there is enough budget for another revision, when deterministic gates find issues, or when exhausted soft-pass is disabled.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
