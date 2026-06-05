# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.21`
- start_commit: `e49ab68bb0553945a0d6b848595a15775fb8c398`
- end_commit: `6abbfd7817bb9f648c7c697821756bfe4b4288c6`
- commits_in_range: `1`

## Highlights

- Reserve explicit validation and repair runway for OpenAI Codex WorkerPal jobs so a primary coding turn cannot consume the whole job budget before deterministic validation can run.
- Retry browser route/startup smoke failures once when they look like transient runtime or browser-startup issues, while preserving normal assertion failures as real task feedback.
- Add focused merge-conflict recovery guidance and a bounded retry when a resolver returns with rebase conflict markers still present.
- Skip low-value second critic retries when compacting barely reduces the prompt, and skip critic entirely for clean default jobs where the primary Codex turn already timed out after producing a validated patch.
- Bound and bypass LLM commit-message generation for broad diffs so publish finalization falls back quickly to deterministic commit messages instead of burning minutes.
- Ship the updated WorkerPal runtime and sandbox mirror in the packaged CLI assets.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`
- `bun test tests/workerpals.generic-python-executor.test.ts tests/workerpals.quality-gate-issues.test.ts tests/workerpals.merge-conflict-job.test.ts tests/workerpals.commit-message-generation.test.ts`

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
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
