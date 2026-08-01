# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.21`
- start_commit: `2a1515319005bf684bcdec9f89e53a7bb08eb908`
- end_commit: `375fe7fd4599d81330dc614efda155c844d58eee`
- commits_in_range: `7`

## Highlights

- Isolate Windows npm CLI service startup behind a small Bun launcher process so a blocked or crashed service cannot hold the main CLI event loop or prevent the remaining services from starting.
- Start Server, LocalBuddy, RemoteBuddy, WorkerPal, and SourceControlManager from packaged source bundles on Windows instead of directly launching large downloaded standalone executables, and skip downloading those unused Windows binaries.
- Bound every launcher readiness handshake with a 15-second deadline, terminate only the failed launcher, retain per-service diagnostics, and keep shutdown off synchronous process-tree cleanup paths.
- Follow the configured embedded LocalBuddy port when the CLI owns LocalBuddy startup while preserving explicit remote LocalBuddy URLs.
- Make clean CLI E2E builds deterministic by building the protocol workspace before packaging, and verify every required source runtime asset in the npm payload.
- Exercise complete source-only Windows startup on GitHub-hosted Windows runners, preserve failure logs as artifacts, and keep the resource-intensive self-hosted Windows Docker job manual-only.

## Validation

- Release-playbook root suite in Docker on Bun 1.3.14: 1,075 passed, 7 intentional Windows-only skips, 0 failed, 4,555 assertions across 124 files.
- Focused CLI runtime-bootstrap suite: 154 passed, 0 failed.
- GitHub CLI E2E run 30690575582 passed the WorkerPals control-plane Linux E2E, packaged CLI Linux E2E, and GitHub-hosted Windows source-only startup jobs; the self-hosted Windows job was skipped by its manual-only guard.
- `bun run cli:bundle`
- Normalized `bun run cli:verify-package-payload`: 228 package files, no external toolchain files.
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

- WorkerPal sandboxes intentionally do not receive the host Docker socket. Docker-dependent gates now resume through SourceControlManager's trusted host worktree, but that host still needs Docker installed and running; otherwise the candidate remains retained and unpublished with the host validation failure attached.
- The first Docker-backed WorkerPal startup after upgrading rebuilds the sandbox image and downloads the Node, Python-agent, Playwright, and Chromium layers; subsequent starts reuse Docker's cached layers.
- `execution_platform = "windows"` selects direct host WorkerPal execution so validation inherits the Windows host environment; it does not convert Docker Desktop Linux containers into Windows containers.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out, and still reports a clear failure if Windows keeps a runtime-data path locked after the retry window.
- The npm package still requires a working Bun runtime to launch the package entrypoint; PushPals does not vendor Bun or other external toolchains in the npm package.
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
