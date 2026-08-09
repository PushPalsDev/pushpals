# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.29`
- start_commit: `c9470137605406208a46092aae93b5621b8d14b9`
- end_commit: `c321a3c38051a91d4c5765993d22ae13591f52e9`
- commits_in_range: `2`

## Highlights

- Requeue retained publication candidates after the exact trusted-host validation command later passes, allowing already-useful work to resume instead of remaining permanently `publish_blocked`.
- Reconcile persisted trusted-host passes during server startup so upgrading and restarting recovers blockers that were recorded by an older PushPals release.
- Bound recovery to three attempts per candidate and require the original requested command, candidate SHA, and baseline SHA to match before any completion is requeued.
- Restore recovered parent jobs to `finalizing` and clear stale terminal diagnostics while preserving the retained candidate ref for SourceControlManager publication.
- Validate missing OpenAI API-key configuration before probing the Codex executable, producing the actionable credential error consistently even in offline environments.
- Ship synchronized server and RemoteBuddy runtime assets so installed CLI users receive both the publication recovery and preflight fixes.

## Validation

- All 96 focused completion lifecycle, autonomy, diagnostics, and SourceControlManager trusted-validation tests passed with 871 assertions in a resource-capped Docker container on Bun 1.3.14.
- The broader root suite completed 1,121 tests successfully with 7 intentional Windows-only platform skips and 0 failures.
- The focused LLM preflight suite passed all 3 tests, and the RemoteBuddy TypeScript project build completed successfully.
- `bun run cli:bundle`
- `bun run cli:verify-package-payload`: 227 package files, no external toolchain files, verified from a Linux-native checkout.
- A disposable copy of the live SectorCommand database reconciled all 3 matching blockers from `publish_blocked` to `finalizing`, requeued all 3 failed completions, and recorded recovery attempt 1 without modifying the live database.
- Regression coverage includes exact-command recovery, startup reconciliation, bounded retries, unrelated and unrequested pass rejection, parent-job restoration, and stale-diagnostic cleanup.
- Rebuilt packaged runtime source mirrors include the complete server and RemoteBuddy changes.
- `git diff --check` passed.

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

- A recovered candidate can still fail publication when its retained patch has a candidate-specific conflict or validation failure; PushPals retries matching trusted-validation recovery at most three times rather than looping indefinitely.
- End-to-end job duration still depends on task scope, model latency, repository validation, and publication work; the next live SectorCommand soak should confirm whether the steady-state average reaches the ten-minute target.
- The first dependency preparation for a new Bun version, lockfile, platform, or affected workspace can still require registry access; later jobs reuse the validated snapshot.
- Docker Desktop exposes Windows bind-mounted files as executable inside Linux containers. The package mode guard must run against a Linux-native checkout or the release workflow rather than directly against the Windows bind mount.
- Trusted-host install caching skips only an unchanged frozen install; trusted validation commands still run for every publication candidate.
- Explicit positive `max_token_usage_per_hour` and `max_runtime_ms_per_hour` values remain enforced as opt-in safety caps; set either value to `0` for unlimited usage.
- WorkerPal sandboxes intentionally do not receive the host Docker socket. Docker-dependent gates now resume through SourceControlManager's trusted host worktree, but that host still needs Docker installed and running; otherwise the candidate remains retained and unpublished with the host validation failure attached.
- The first Docker-backed WorkerPal startup after upgrading rebuilds the sandbox image and downloads the Node, Python-agent, Playwright, and Chromium layers; subsequent starts reuse Docker's cached layers.
- `execution_platform = "windows"` selects direct host WorkerPal execution so validation inherits the Windows host environment; it does not convert Docker Desktop Linux containers into Windows containers.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out, and still reports a clear failure if Windows keeps a runtime-data path locked after the retry window.
- The npm package requires Bun 1.3.14 or newer to launch the package entrypoint; PushPals refuses older runtimes and does not vendor Bun or other external toolchains in the npm package.
- Direct GitHub release binaries are PushPals-built standalone artifacts. Removing embedded Bun runtime from those standalone artifacts would require a separate runtime distribution redesign.
- Active runtimes that were started from an older release must be restarted after installing this release before new startup or packaged-runtime behavior takes effect.
- PushPals does not currently read Codex TUI `/status` directly; by default it avoids enforcing an independent local session-token pause and relies on the active Codex/LLM provider budget. Users who need a local safety cap can set `session_token_budget` or `PUSHPALS_SESSION_TOKEN_BUDGET`.
- Docker-backed WorkerPal execution can use a stalled Docker Codex startup as the signal to switch future WorkerPal spawns to direct isolated-worktree execution; if the replacement direct WorkerPal also cannot start Codex, that retry can still fail terminally and recycle the worker.
- QualityGate can still reject or request repair for a broad patch after the rollout coach hands publishable progress forward; this release changes the failure point from executor pre-validation failure to structured gate diagnostics.
- Bun dependency-layout preflight is offline and lockfile-frozen; if the local Bun cache is incomplete or the lockfile cannot be satisfied, ValidationGate blocks validation and reports the dependency/setup blocker rather than running later validation against an incomplete dependency tree or modifying project manifests.
- The first Bun-lockfile job in a fresh WorkerPal container creates a frozen Linux-native dependency snapshot; it can require registry access when the container's Bun download cache is cold, while later jobs reuse the cached downloads and prepared snapshot.
- OpenAI Codex WorkerPal jobs can still fail if Codex produces no publishable edit after the final no-edit recovery attempt or if the shared executor budget is already too low for another recovery.
- OpenAI Codex WorkerPal jobs still fail fast on truly broad/noisy publishable diffs after timeout; tracked paths with no staged or unstaged Git content delta are now filtered before ScopeGate and quality diagnostics.
- OpenAI Codex rollout coaching still blocks missing-path drift, PushPals/autonomy internals in user repos, broad shared mock expansion, and full render/full-surface harness expansion; this release permits narrow mock/harness terminology when a repo-native shell contract-test task is reusing existing infrastructure.
- Critic-only soft-pass applies only after required validation passes; a low critic score can still block when there is enough budget for another revision, when deterministic gates find issues, or when exhausted soft-pass is disabled.
- Codex `gpt-5.6-sol` requires a compatible Codex CLI; packaged WorkerPal defaults now pin `0.146.0`, while older explicitly configured CLIs still fall back once to `gpt-5.5` when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` values that use the shipped legacy unversioned WorkerPal launcher are migrated to `0.146.0`; explicit custom commands and explicit version pins are preserved.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
