# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.45`
- start_commit: `cb304e3e6c6059f7e49380d9dfd002c6483716ad`
- end_commit: `71a507f6e6bc34674792d2e9d0770d2379ef1472`
- commits_in_range: `1`

## Highlights

- Tighten the OpenAI Codex worker prompt and runtime policy so merge-conflict repairs prefer direct git commands instead of shell wrappers like `/bin/bash -lc`, `sh -lc`, `cmd /c`, or `powershell -Command`.
- Extend merge-conflict sandbox planner guidance with explicit `git add` plus `git -c core.editor=true rebase --continue` instructions for prepared mid-rebase workspaces.
- Add regression coverage confirming the direct-command rule is present in the Codex prompt and merge-conflict planner guidance.

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

## Release Checklist

- Confirm `release_log.md` content before tagging.
- Tag and push: `git tag v1.0.45 && git push origin v1.0.45`.
