# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.51`
- start_commit: `77188a1f83805acde259980a6bd03b52def26b88`
- end_commit: `8dc356356107587c43ad7402a078dcbddb477630`
- commits_in_range: `1`

## Highlights

- Recognize autonomy-origin required-validation repair prompts as diagnostic repair work instead of ordinary background ideation.
- Give validation repair jobs longer no-edit and command-progress budgets so browser smoke reproduction and root-cause diagnosis are not interrupted prematurely.
- Keep rollout-coach semantic drift detection for validation repair jobs, while ignoring artifact-only Windows PowerShell cache dirt as a standalone off-track signal.
- Add regression coverage proving validation repair continues past `Microsoft/Windows/PowerShell/ModuleAnalysisCache` noise in both source and packaged WorkerPal runtime paths.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `python -m unittest apps.workerpals.src.backends.openai_codex.test_openai_codex_runtime_config.OpenAICodexRuntimeConfigTests.test_validation_repair_prompt_gets_diagnostic_watchdogs apps.workerpals.src.backends.openai_codex.test_openai_codex_runtime_config.OpenAICodexRuntimeConfigTests.test_run_codex_task_validation_repair_ignores_artifact_only_rollout_progress`
- `python -m unittest apps.workerpals.src.backends.openai_codex.test_openai_codex_runtime_config`
- `bun test tests/workerpals.quality-gate-issues.test.ts`
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
