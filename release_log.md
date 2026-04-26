# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.56`
- start_commit: `2ffc0781fde084d73580b9d09b170e6719073ffd`
- end_commit: `e7bf8cfeea47ea7564fc9d1072afc76992ef2129`
- commits_in_range: `1`

## Highlights

- Continue through chained merge-conflict rebases when `git rebase --continue` advances into the next conflicted commit instead of treating that forward progress as a terminal failure.
- Rerun the merge-conflict resolver on updated paused-rebase sandbox state with a bounded pass count so multi-commit conflict chains can finish without risking infinite loops.
- Revalidate WorkerPals merge-conflict policy and control-plane execution paths before release.

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

- None.
