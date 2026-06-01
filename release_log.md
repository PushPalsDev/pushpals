# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.10`
- start_commit: `53510e35fd5ef3f2f44f32a01762ee19fe6fd055`
- end_commit: `8ac9b08a79894ff261edc423fabf56a36cdd40df`
- commits_in_range: `4`

## Highlights

- Stream richer WorkerPal job progress from the embedded CLI, including job enqueue/claim events, periodic log snippets, failure details, and completion summaries so slow jobs no longer look silent.
- Pass structured WorkerPal planning guidance through the executor so Codex receives explicit acceptance criteria, discovery scope, validation expectations, and relevance-hint semantics before editing.
- Persist browser-validation failure fingerprints per repo/job family and seed future retries with known issue/remedy context to reduce repeated failed revisions.
- Include browser artifact summaries directly in retry prompts, including stage, selector, URL, and latest verified checkpoint details.
- Add a lightweight worker phase contract covering discovery, editing, focused validation, full validation handoff, and final diff review.
- Require browser assertion repairs to read diagnostic artifacts before editing, and warn workers when small repair tasks start churning too many unrelated files.
- Package the WorkerPal sandbox runtime copy with the same planning, progress, and convergence guidance behavior for installed CLI users.

## Validation

- `bun run cli:bundle`
- `bun test tests/workerpals.quality-gate-issues.test.ts`
- `bun x tsc --noEmit --project apps/workerpals/tsconfig.json`
- `bun x tsc --noEmit --project packages/cli/runtime/sandbox/apps/workerpals/tsconfig.json`
- `python apps/workerpals/src/backends/openai_codex/test_openai_codex_runtime_config.py`
- `bun run lint` completed with 2 pre-existing client warnings.
- `bun run test:root` completed successfully: 773 pass, 1 skip, 0 fail.
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
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
