# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.5`
- start_commit: `a9a5e437933bef6f0056ba80be93864dbcc3cbf0`
- end_commit: `875f5d1f2fdc2087bb8e4808a46f68280726d983`
- commits_in_range: `1`

## Highlights

- Pin Expo Router route discovery to each WorkerPal's isolated worktree instead of allowing Windows dependency junctions to resolve routes from the shared checkout.
- Remove Node's incompatible `--preserve-symlinks` option only for detected Expo Router repositories while retaining it for other projected dependency layouts.
- Override stale inherited `EXPO_ROUTER_APP_ROOT` values and prefer the repository's `src/app` route root before `app`.
- Add regression coverage for isolated `app` and `src/app` layouts, stale host route roots, explicit Node options, and unrelated repositories.

## Validation

- Full root suite on Bun 1.3.14: 1,010 passed, 2 intentional skips, 0 failed, 3,890 assertions across 118 files.
- Focused sandbox-environment suite: 12 passed, 0 failed, 44 assertions.
- WorkerPals TypeScript check passed.
- `bun run cli:bundle`
- `bun run cli:verify-package-payload`: 220 package files, no external toolchain files.
- The exact previously failing detached SectorCommand worktree completed its full Expo browser suite through the patched WorkerPals environment.
- A controlled comparison confirmed that the same worktree renders Expo's stock tutorial with `EXPO_ROUTER_APP_ROOT` plus `--preserve-symlinks`, and loads all SectorCommand routes when the incompatible option is removed.
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
- Codex `gpt-5.6-sol` requires Codex CLI `0.144.1` or another compatible version; older Codex CLIs fall back once to `gpt-5.5` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --open_config`, `pushpals --clear`, or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
