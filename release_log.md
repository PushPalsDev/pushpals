# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.31`
- start_commit: `c5cebf4260c4689f593696ad7f8e433bb866a3dd`
- end_commit: `03ce70d300542d4c92fe1103f8150e65e1544f4b`
- commits_in_range: `3`

## Highlights

- Harden embedded CLI startup on Windows by removing wasted prechecks from the attach path, making slow WorkerPal warmup non-fatal, and emitting compact per-phase startup timing summaries for faster diagnosis when Docker or runtime boot is slow.
- Add explicit WorkerPal execution readiness reporting in the CLI with `ready`, `warming`, and `blocked` states plus actionable guidance, so users can distinguish normal warmup from hard startup blockers like Docker being unavailable.
- Add packaged CLI end-to-end coverage that exercises the real bundled CLI against a temp local git repo, local bare `origin`, real Docker happy-path startup, and deterministic Docker-unavailable failure handling.
- Wire packaged CLI E2E smoke coverage into GitHub Actions with a hosted Linux lane and an optional self-hosted Windows Docker smoke lane for release confidence on the actual shipped artifact.

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
- Tag and push: `git tag v1.0.31 && git push origin v1.0.31`.

