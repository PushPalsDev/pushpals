# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.87`
- start_commit: `5c0e3c93123f4593b835b813c3299ade78428326`
- end_commit: `07feb10d5f5afadf4c2c232477f2859c2a7752b2`
- commits_in_range: `1`

## Highlights

- Retry aggregate browser validation inside ValidationGate when its nested Worker suite hits a cold-sandbox teardown or test-timeout failure, instead of spending an AI repair revision on an unchanged candidate patch.
- Allow at most two bounded aggregate reruns, matching the observed warm-up sequence while still blocking deterministic failures after the final attempt.
- Keep browser and Worker retry classification scoped to aggregate commands that actually resolve to browser work; ordinary lint and unrelated test failures are not retried by this policy.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `bun test tests/workerpals.validation-command-safety.test.ts tests/workerpals.quality-gate-issues.test.ts`: 97 passed, 0 failed, 321 assertions.
- `bun run test:root`: 931 passed, 1 Windows signal-handling skip, 0 failed.
- `bun run test`: 931 passed, 1 Windows signal-handling skip, 0 failed, plus prompt-policy and protocol integration.
- `bun x tsc --noEmit -p apps/workerpals/tsconfig.json`
- `bun x tsc --noEmit -p packages/cli/runtime/sandbox/apps/workerpals/tsconfig.json`
- Live v1.1.86 SectorCommand job `d0aca370-2bd4-47cd-a018-579d3aedf91b` proved the dependency repair completed at 190,654ms, then reproduced the nested Worker sequence: 27/27 assertions passed with a teardown error, the next aggregate run hit a 5-second Worker timeout, and the third aggregate run passed all required validation plus web E2E before publishing PR #497.
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

- The first Docker-backed WorkerPal startup after upgrading rebuilds the sandbox image and downloads the Node, Python-agent, Playwright, and Chromium layers; subsequent starts reuse Docker's cached layers.
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
- OpenAI Codex rollout coaching still blocks missing-path drift, PushPals/autonomy internals in user repos, broad shared mock expansion, and full render/full-surface harness expansion; this release permits narrow mock/harness terminology when a repo-native shell contract-test task is reusing existing infrastructure.
- Critic-only soft-pass applies only after required validation passes; a low critic score can still block when there is enough budget for another revision, when deterministic gates find issues, or when exhausted soft-pass is disabled.
- Codex `gpt-5.6-sol` requires Codex CLI `0.144.1` or another compatible version; older Codex CLIs fall back once to `gpt-5.5` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --open_config`, `pushpals --clear`, or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
