# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.57`
- start_commit: `80366bb5fea608b22de7227f0823cb3c33b4a823`
- end_commit: `ccd327875e68d008291e368bfada30f7f5e63082`
- commits_in_range: `2`

## Highlights

- Fail orphaned claimed jobs as soon as the server can prove a worker heartbeat has dropped ownership, instead of leaving the job stuck in `claimed` until the stale-claim watchdog fires minutes later.
- Add an explicit `abandoned` recovery state for retry-safe lost claims and preserve successor lineage through `resumeOfJobId`, attempt tracking, and `params.resume` metadata instead of flattening every recovery into a hard failure.
- Auto-requeue only retry-safe work such as `warmup.execute`, while keeping non-idempotent `task.execute` jobs as hard failures with clearer diagnostics and updated queue-health telemetry.
- Update server and dashboard surfaces to expose `abandoned` jobs in queue snapshots, lifecycle timing, and failure-rate style health signals, with regression coverage for both heartbeat-mismatch and stale-watchdog recovery paths.

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

- `task.execute` resume metadata is preserved for future continuation logic, but non-idempotent abandoned jobs still restart via explicit retry rather than automatic in-place continuation.
