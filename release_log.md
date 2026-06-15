# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.56`
- start_commit: `7434b5f49b59237faf8af4b7f4ada15000fb4e5d`
- end_commit: `383e29e671f4d547b45f946ca5525a416e235bcd`
- commits_in_range: `1`

## Highlights

- Add OpenAI Codex `--add-dir` sandbox wiring for linked direct-worktree dependency artifacts such as `node_modules`, so local worker checks can traverse repo dependencies without false out-of-worktree permission failures.
- Give repo validation blockers a guarded fourth repair turn while preserving the normal configured quality budget for non-validation churn.
- Improve validation-repair convergence when a target repo has broken project validation setup, such as lint/typecheck dependency resolution failures that are outside the original task scope.
- Add regression coverage for linked dependency sandbox dirs and the extended repo-validation repair budget.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `python apps/workerpals/src/backends/openai_codex/test_openai_codex_runtime_config.py`
- `bun test tests/workerpals.quality-gate-issues.test.ts tests/workerpals.direct-worktree-dependency-artifacts.test.ts tests/workerpals.session-events.test.ts`
- `bun run test:root`
- `bun --cwd apps/workerpals tsc --noEmit`
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
