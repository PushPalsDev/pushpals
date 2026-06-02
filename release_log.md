# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.12`
- start_commit: `0c824666d55d87b550b05a0423eda24c300a5078`
- end_commit: `def7a3135098980e009eecc293b79d47ba4c8fc3`
- commits_in_range: `2`

## Highlights

- Stop raw server event validation errors from flooding the interactive CLI prompt; low-level server `error` events remain in logs instead of user chat output.
- Accept WorkerPal `job_log.payload.phase` in the protocol schema so current worker phase events validate cleanly instead of being converted into repeated event errors.
- Cap OpenAI Codex WorkerPal execution to the job planning budget instead of allowing the inner Codex process to outlive the Docker job timeout.
- Reduce default background, review-fix, and merge-conflict execution budgets to a 20-minute target while preserving separate finalization and validation budgets.
- Add timeout provenance to WorkerPal executor logs so traces show whether a timeout came from config or a planning-budget cap.
- Add a hard-kill fallback after graceful WorkerPal backend timeout termination so stuck child processes do not wait for Docker to kill the whole job.
- Preserve one concise executor budget line in the CLI while continuing to suppress repetitive Codex internals.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`
- `bun test tests/cli.runtime-bootstrap.test.ts --filter formatSessionEventLine`
- `bun test tests/workerpals.generic-python-executor.test.ts`
- `bun test tests/server.runtime-config-mutations.test.ts`
- `bun test tests/workerpals.docker-executor.test.ts --filter timeout`
- `bun x tsc --noEmit --project apps/workerpals/tsconfig.json`
- `bun x tsc --noEmit --project packages/cli/runtime/sandbox/apps/workerpals/tsconfig.json`
- `bun x tsc --noEmit --project apps/server/tsconfig.json`
- `bun x tsc --noEmit --project apps/source_control_manager/tsconfig.json`

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
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
