# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.54`
- start_commit: `58114e9f61f8fa5b4bc152b4e9ca6c87d6bf5743`
- end_commit: `c047caa466a99dc0f99f8a489b11e9aafe6043c7`
- commits_in_range: `1`

## Highlights

- Hydrate direct isolated WorkerPal worktrees with the repo-root `node_modules` dependency artifact, matching Docker worktree behavior.
- Fix direct Windows fallback jobs whose lint/web smoke validation needs project-local dependency layout for Expo Router, ESLint import resolution, and browser review hydration.
- Keep dependency artifacts out of PR content while logging when direct worktree hydration links runtime-only artifacts.
- Add regression coverage for direct worktree dependency artifact linking and skip behavior.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `bun test tests/workerpals.direct-worktree-dependency-artifacts.test.ts tests/workerpals.docker-executor.test.ts`
- `bun test tests/workerpals.validation-command-safety.test.ts`
- `bun test tests/workerpals.direct-worktree-dependency-artifacts.test.ts tests/workerpals.session-events.test.ts`
- `bun run test:root`
- `bun run test:prompt-policy`
- `bun run test:protocol`
- `bun --cwd apps/server build`
- `bun --cwd apps/workerpals tsc --noEmit`
- SectorCommand control: temporary linked worktree passed `bun run lint` and `bun run web:e2e`
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
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
