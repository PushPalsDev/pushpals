# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.42`
- start_commit: `2a7b1b0da2779500913c6ae3c1c79868caebc240`
- end_commit: `d82ee7d5f3d9feb26fa172c49c5b4dee7d6b2a79`
- commits_in_range: `2`

## Highlights

- Isolate merge-conflict repair work inside a WorkerPal sandbox clone so rebases and force-pushes update the PR branch without switching or mutating the user's active checkout.
- Specialize rejected ReviewAgent follow-up jobs with `review_fix` metadata, targeted validation, focused planner guidance, and stricter local quality gating so retries are more surgical and more likely to clear the approval threshold in one pass.
- Prevent wasted re-review churn by failing rejected review-fix retries that produce no code changes instead of re-enqueueing an unchanged branch for another ReviewAgent pass.

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
- Tag and push: `git tag v1.0.42 && git push origin v1.0.42`.
