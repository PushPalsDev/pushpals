# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.38`
- start_commit: `3f72c214975468a983325aa20f391b93a43cb990`
- end_commit: `f2a445868586c86fda472faed49226e53f783432`
- commits_in_range: `1`

## Highlights

- Improve WorkerPal OpenAI Codex recovery by sharing the execution deadline across retries, refusing low-odds retries when the remaining budget is exhausted, and preserving more time for validation/repair.
- Bound endless command/tool progress during no-edit windows and make recovery attempts use faster durable-change rechecks.
- Recover once from broad/noisy small-task rollouts by restoring the isolated worker sandbox to its baseline before retrying with stricter patch-first guidance; repeated broad drift still fails safely.
- Reserve more of the planning budget for validation and lower the minimum quality-revision threshold so browser/test failures have enough time for focused repair.
- Guard RemoteBuddy autonomy git config against corrupted branch/ref values before `git fetch`, preventing invalid-refspec startup/autonomy failures.
- Sync the packaged CLI runtime sandbox and generated RemoteBuddy fallback so installed `@pushpalsdev/cli` users receive the WorkerPal and RemoteBuddy fixes.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `python apps\\workerpals\\src\\backends\\openai_codex\\test_openai_codex_runtime_config.py`
- `python packages\\cli\\runtime\\sandbox\\apps\\workerpals\\src\\backends\\openai_codex\\test_openai_codex_runtime_config.py`
- `bun test tests\\workerpals.generic-python-executor.test.ts tests\\workerpals.quality-gate-issues.test.ts apps\\remotebuddy\\src\\autonomous_engine.adjacent_possible.test.ts`
- `bun run protocol:typecheck`
- `bun run test:root`
- `bun run test:prompt-policy`
- `bun run test:protocol`
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
