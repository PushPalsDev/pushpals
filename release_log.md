# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.62`
- start_commit: `4b50ff571db53ad548ff8b87921ec383e74de86d`
- end_commit: `a988ec892e2e21fc6f5a880307f83c2fdbdd2954`
- commits_in_range: `1`

## Highlights

- Scrub transient untracked `.codex` artifacts out of WorkerPal job worktrees before rebase-based branch sync so successful task commits do not get blocked by Git checkout protection during finalization.
- Keep Codex state outside repo worktrees even when `PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME` is set to a relative path, and log the fallback to the user home Codex directory for visibility.
- Move command-router wrapper policy guidance into [prompts/workerpals/openai_codex_command_router_policy.md] so the base guidance, recovery message, and rejection detail stay editable in one prompt-managed place while preserving mirrored runtime behavior.

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

- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately and passes on native WSL Bun.
- Per-app `tsc --noEmit` still trips over the existing unrelated shared-config typing issue in `packages/shared/src/config.ts`; release validation for this change relied on targeted WorkerPals regressions and end-to-end suites instead.
