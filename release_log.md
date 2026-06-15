# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.58`
- start_commit: `c187e693edd1c31516e8754f2a83300b42d23d57`
- end_commit: `489b461062b687b65c5537f9dce42cefd6ad70d6`
- commits_in_range: `1`

## Highlights

- Add a ValidationGate dependency-layout preflight for Bun projects so missing `node_modules`, missing `.bin` shims, or missing declared top-level packages are repaired before validation commands run.
- Run `bun install --offline --frozen-lockfile --ignore-scripts` only when PushPals detects an unhealthy local Bun install layout, keeping dependency repair out of publishable PR content.
- Continue into normal validation with structured logs if the offline dependency-layout repair cannot complete, so QualityGate records the real blocker instead of spending worker turns on package-manager hygiene.
- Add regression coverage for missing Bun binary shims and incomplete dependency trees before validation.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `bun test tests/workerpals.validation-command-safety.test.ts tests/shared.toolchain.test.ts`
- `bun --cwd apps/workerpals tsc --noEmit`
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

- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- The npm package still requires a working Bun runtime to launch the package entrypoint; PushPals does not vendor Bun or other external toolchains in the npm package.
- Direct GitHub release binaries are PushPals-built standalone artifacts. Removing embedded Bun runtime from those standalone artifacts would require a separate runtime distribution redesign.
- Active runtimes that were started from an older release must be restarted after installing this release before new startup or packaged-runtime behavior takes effect.
- Docker-backed WorkerPal execution can use a stalled Docker Codex startup as the signal to switch future WorkerPal spawns to direct isolated-worktree execution; if the replacement direct WorkerPal also cannot start Codex, that retry can still fail terminally and recycle the worker.
- QualityGate can still reject or request repair for a broad patch after the rollout coach hands publishable progress forward; this release changes the failure point from executor pre-validation failure to structured gate diagnostics.
- Bun dependency-layout preflight is offline and lockfile-frozen; if the local Bun cache is incomplete or the lockfile cannot be satisfied, ValidationGate will continue and report the dependency/setup blocker rather than modifying project manifests.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
