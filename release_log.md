# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.50`
- start_commit: `c58fbfe55123f50f8ac712951032ec2d1afb73fd`
- end_commit: `ef2f8e51a1e9fe1cfadff3df13bc4e06a1d6394e`
- commits_in_range: `1`

## Highlights

- Mark required validation red after repeated failed validation runs inside a single terminal job, so PushPals does not need a second failed job before prioritizing repair.
- Treat Windows PowerShell `ModuleAnalysisCache` and `PSReadLine` cache files as runtime artifacts instead of publishable job output.
- Expand Git's untracked `Microsoft/` directory status into concrete known PowerShell cache artifact paths before WorkerPal publishability and diff-budget checks.
- Add regression coverage for single-job validation-red snapshots and Windows PowerShell cache artifact filtering in both direct and packaged WorkerPal runtime paths.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `bun test tests/server.autonomy-store.test.ts tests/remotebuddy.autonomous-engine.tick.test.ts tests/workerpals.quality-gate-issues.test.ts`
- `python -m unittest apps.workerpals.src.backends.openai_codex.test_openai_codex_runtime_config.OpenAICodexRuntimeConfigTests.test_codex_changed_paths_filters_dependency_artifacts_from_publishable_delta apps.workerpals.src.backends.openai_codex.test_openai_codex_runtime_config.OpenAICodexRuntimeConfigTests.test_codex_changed_paths_filters_windows_powershell_cache_directory`
- `bun test tests/remotebuddy.persistent-memory.test.ts -t "recalls repo history across sessions from sqlite"`
- `bun run test:prompt-policy`
- `bun run test:protocol`
- `bun run test:root`
- `bun --cwd apps/server build`
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
