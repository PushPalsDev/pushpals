# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.47`
- start_commit: `5f868d89563bc11712aa6489dd3692be43effea3`
- end_commit: `fcdac97b3a680637f1a94907f3007dddfc95e398`
- commits_in_range: `1`

## Highlights

- Narrow OpenAI Codex workaround detection so generic "workaround" language does not trigger false policy violations.
- Fail OpenAI Codex jobs quickly when the command router keeps rejecting disallowed shell-wrapper commands instead of letting them drift into stale worker claims.
- Include rejected wrapper command samples in worker failure details so merge-conflict and review-fix diagnostics are easier to act on.

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
- Tag and push: `git tag v1.0.46 && git push origin v1.0.46`.
