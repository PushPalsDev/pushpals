# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.77`
- start_commit: `c063f3b3f7d498452815c728093d4b0e3d89b616`
- end_commit: `e3eeedd525309d0dc1060331247aa72cc88b68c8`
- commits_in_range: `1`

## Highlights

- Permit repo-native `_layout.autonomy.test.ts` contract-test work without treating the file name as PushPals/autonomy internals leaking into a user repo.
- Split broad/shared mock expansion from narrow references to existing React Native mock or layout harness infrastructure during shell contract-test jobs.
- Keep rollout coaching strict for missing-path drift, full render/full-surface harness expansion, and genuinely broad shared mock work.
- Package the WorkerPal sandbox update so installed CLI workers receive the corrected rollout-coach behavior.
- Add source and packaged-runtime regression coverage for the SectorCommand shell contract-test failure shape.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `python -m unittest apps.workerpals.src.backends.openai_codex.test_openai_codex_runtime_config`
- `python -m unittest packages.cli.runtime.sandbox.apps.workerpals.src.backends.openai_codex.test_openai_codex_runtime_config.OpenAICodexRuntimeConfigTests.test_offtrack_rollout_allows_repo_native_layout_autonomy_contract_test packages.cli.runtime.sandbox.apps.workerpals.src.backends.openai_codex.test_openai_codex_runtime_config.OpenAICodexRuntimeConfigTests.test_offtrack_rollout_allows_existing_harness_for_shell_contract_guard packages.cli.runtime.sandbox.apps.workerpals.src.backends.openai_codex.test_openai_codex_runtime_config.OpenAICodexRuntimeConfigTests.test_offtrack_rollout_still_blocks_broad_mock_expansion_for_shell_contract_guard`
- `bun test tests/workerpals.quality-gate-issues.test.ts`
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
- OpenAI Codex rollout coaching still blocks missing-path drift, PushPals/autonomy internals in user repos, broad shared mock expansion, and full render/full-surface harness expansion; this release permits narrow mock/harness terminology when a repo-native shell contract-test task is reusing existing infrastructure.
- Critic-only soft-pass applies only after required validation passes; a low critic score can still block when there is enough budget for another revision, when deterministic gates find issues, or when exhausted soft-pass is disabled.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --open_config`, `pushpals --clear`, or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
