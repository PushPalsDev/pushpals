# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.68`
- start_commit: `1998f4064b01d61bfa5cbacf1e9fb63f6581b40b`
- end_commit: `089ce6dd6aeaf7daec50e4bf065f8d5253a0e72f`
- commits_in_range: `1`

## Highlights

- Add a `SourceControlApi` abstraction with a Git-backed implementation and provider normalization for future Sapling/Mercurial support.
- Route SourceControlManager merge operations through the source-control API factory while preserving `GitOps` compatibility for existing callers.
- Resolve WorkerPal commit author/committer identity from explicit PushPals/Git env values or `git config user.name` / `user.email`, instead of GitHub user APIs.
- Set both author and committer identity on WorkerPal commits so commits can attribute to the configured user email and count toward GitHub contribution graphs when that email is linked to the account.
- Add regression coverage for provider selection, unsupported provider rejection, Git config identity lookup, and WorkerPal commit identity behavior.

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

- Sapling and Mercurial provider names are recognized for planning/configuration, but runtime operations still intentionally support Git only.
- GitHub contribution credit requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
- Per-app `tsc --noEmit` still trips over existing unrelated shared-config typing issues; release validation for this change used focused SourceControlManager and WorkerPal tests.
