# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.16`
- start_commit: `c1458d1166e886a48410935a3156145bfc1ecfd2`
- end_commit: `75e97f07fe42436ba400fcb901daf5d9e7a0bbff`
- commits_in_range: `1`

## Highlights

- Move direct Windows WorkerPal writable environments from the long `%TEMP%\pushpals-worker-env` tree to `%USERPROFILE%\.ppe\<repo-key>`, keeping Workerd, Expo, package-manager, application-data, and PowerShell cache paths within a bounded profile-root path.
- Use compact, case-insensitive per-job keys for isolated writable state and a stable per-repository `pw` browser cache so jobs remain isolated without repeatedly downloading Playwright browsers.
- Prefer the actual Windows `USERPROFILE` over a potentially longer `HOME` override when selecting the bounded environment root.
- Keep source and packaged runtime implementations synchronized and add explicit regression coverage for Windows path budgets, writable directory creation, per-job isolation, and stable browser caches.

## Validation

- Release-playbook root suite on Bun 1.3.14: 1,029 passed, 2 intentional skips, 0 failed, 4,006 assertions across 119 files.
- Focused worktree, sandbox-environment, cleanup, runtime-bootstrap, and validation-command suite on Bun 1.3.14: 229 passed, 1 intentional skip, 0 failed, 816 assertions.
- WorkerPals TypeScript check passed.
- A published v1.2.15 SectorCommand job passed its focused route-shell test, Worker deploy dry-run, typecheck, and lint before Workerd failed during the aggregate Worker validation stage.
- The exact fully-localized job worktree passed 126 of 126 Worker tests with the normal host environment, reproduced 34 of 39 matchmaker failures with the v1.2.15 `%TEMP%\pushpals-worker-env` redirects, and passed 126 of 126 through the proposed source-generated `%USERPROFILE%\.ppe` environment.
- `bun run cli:bundle`
- `bun run cli:verify-package-payload`: 221 package files, no external toolchain files.
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

- WorkerPal sandboxes intentionally do not receive the host Docker socket. Repositories whose required validation starts nested containers are retained as validation-stage `publish_blocked` candidates until the same gate can run in a trusted environment.
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
