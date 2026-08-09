# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.28`
- start_commit: `98d587b17f955ea6af5cd8f0539d2b746c61d2e8`
- end_commit: `8d1b9882513932fe37c58190e949349aed3e5bb4`
- commits_in_range: `1`

## Highlights

- Persist trusted-host validation evidence with canonical candidate and baseline SHAs, stable failure fingerprints, failed test names, affected paths, and bounded command output.
- Circuit-break repeated trusted-host publication failures after two distinct jobs reproduce the same root cause, then dispatch one exact repair instead of continuing unrelated autonomy work.
- Resolve a trusted-host incident only after a later trusted-host pass for the same failure; sandbox-only success can no longer hide a host publication blocker.
- Reject unrequested trusted-validation callback commands and derive the candidate SHA from server-owned completion state before host execution.
- Preserve every existing autonomy safety boundary: required repairs can bypass stale cooldown and recent-success suppression, but not freezes, budgets, concurrency, repository safety, or the kill switch.
- Ship synchronized server, RemoteBuddy, SourceControlManager, and shared runtime mirrors so installed CLI users receive the complete recovery contract.

## Validation

- All 99 focused trusted-validation, autonomy-store, completion-queue, and RemoteBuddy repair tests passed with 728 assertions in a resource-capped Docker container on Bun 1.3.14.
- The broader root suite completed 1,113 tests successfully with 7 intentional platform skips; four environment/toolchain checks were inapplicable in the offline Linux container (Codex CLI preflight, npm fixture semantics in the base image, and a Windows linked-package assertion). Every changed subsystem suite passed.
- `bun run cli:bundle`
- `bun run cli:verify-package-payload`: 201 package files, no external toolchain files, verified from a Linux-native checkout.
- Server, RemoteBuddy, SourceControlManager, and shared-package TypeScript project builds passed.
- Regression coverage includes cross-job deduplication, stable fingerprints, equal-timestamp ordering, distinct failure separation, stale incident rejection, exact repair dispatch, safety guardrails, untrusted command rejection, and trusted-pass-only resolution.
- Rebuilt packaged runtime source mirrors include the complete server, RemoteBuddy, SourceControlManager, and shared validation changes.
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
