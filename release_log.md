# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.20`
- start_commit: `b49dc371bedb0cad706abe8ab3526fef57c448d9`
- end_commit: `245bcf1ef01df539469ae518f7ea5a7411727b67`
- commits_in_range: `3`

## Highlights

- Resume Docker-dependent validation automatically after a sandboxed WorkerPal retains a candidate: SourceControlManager now applies the exact handoff commit, runs the blocked commands on its trusted host worktree, and only continues publication after they pass.
- Persist trusted-validation commands, summary, and blocker detail through a backward-compatible completion-queue migration instead of terminating the job at `publish_blocked` with no recovery owner.
- Execute trusted validation as bounded direct argv commands, reject shell controls, inline-code escape forms, absolute executables, unsupported tools, and oversized payloads, and stop at the first failed gate.
- Preserve immutable candidate refs when completion handoff or trusted validation fails so useful work is never silently discarded or published without its required gate.
- Extend exact review-head lease E2E coverage plus Windows LF, compact-path, sandbox isolation, cleanup, and packaged-runtime parity regressions across pull requests, releases, and the long runtime soak.

## Validation

- Release-playbook root suite on Bun 1.3.14: 1,066 passed, 2 intentional skips, 0 failed, 8,911 assertions across 122 files.
- Focused trusted-validation, completion migration, WorkerPal handoff, and packaged-runtime parity suite: 31 passed, 0 failed.
- SourceControlManager and related WorkerPal publication/reconciliation suite: 172 passed, 0 failed, 573 assertions across 16 files.
- Shared, Server, WorkerPals, and SourceControlManager TypeScript checks passed.
- SourceControlManager production bundle compiled successfully with the trusted-validation runner.
- `bun run cli:bundle`
- `bun run cli:verify-package-payload`: 222 package files, no external toolchain files.
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
