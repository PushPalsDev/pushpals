# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.37`
- start_commit: `91553547b51990e6504f16d20a3d6e03c358ac3a`
- end_commit: `d9e133b596ff59c44db5d8c25441e5a0501aed47`
- commits_in_range: `1`

## Highlights

- Preserve WorkerPal repair budget after OpenAI Codex makes real progress: durable publishable file changes now stop the Codex child early so validation and quality-revision turns still have time to run.
- Remove the process-start cap from no-edit command grace so later Codex command/tool progress receives a fresh bounded patch window instead of being killed by an old deadline.
- Skip Codex critic review when deterministic gates already require a revision and the remaining execution budget must be reserved for that repair turn.
- Add regression coverage for late command progress, durable publishable-progress finalization, and critic-budget preservation.
- Sync the packaged CLI runtime sandbox so installed `@pushpalsdev/cli` users receive the WorkerPal executor and quality-gate fixes.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `python apps\\workerpals\\src\\backends\\openai_codex\\test_openai_codex_runtime_config.py`
- `python packages\\cli\\runtime\\sandbox\\apps\\workerpals\\src\\backends\\openai_codex\\test_openai_codex_runtime_config.py`
- `bun test tests\\workerpals.quality-gate-issues.test.ts`
- `bun x tsc -p apps\\workerpals\\tsconfig.json --noEmit`
- `bun run lint`
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
- Docker-backed WorkerPal execution can use a stalled Docker Codex startup as the signal to switch future WorkerPal spawns to direct isolated-worktree execution; this release hardens budget preservation once Codex produces publishable changes, but the original Docker stall is still treated as a worker-recycle event.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
