# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.18`
- start_commit: `6ca6aa8c35faf681b2f9c4111d1ec369d46fc337`
- end_commit: `6ca6aa8c35faf681b2f9c4111d1ec369d46fc337`
- commits_in_range: `1`

## Highlights

- Fail CLI startup and healthy-runtime attachment when no idle WorkerPal capacity is available instead of treating merely online or busy workers as ready.
- Add and reuse a shared WorkerPal capacity timeout calculation so startup, preflight, and post-connect readiness checks use the same contract.
- Preserve prechecked absolute Git and Docker binaries when rebuilding the embedded runtime environment so SourceControlManager and WorkerPals use the exact validated executables.
- Run the Docker-backed WorkerPal precheck before startup and carry the resolved Docker binary into the embedded runtime path.
- Update RemoteBuddy startup capacity enforcement to wait for an idle worker and surface a clear unavailable reason when workers remain online but busy.
- Make DockerExecutor consistently spawn the resolved Docker executable for inspect, run, build, pull, image-inspect, logs, restart, and availability probing.
- Restore backward compatibility for legacy autonomy component budget aliases like `apps_server` and `apps-server` while still allowing arbitrary repo-relative component keys.
- Extend CLI bootstrap and invocation tests for resolved Docker env propagation, busy-worker readiness failures, and healthy-runtime worker capacity gating.
- Add shared config regression coverage for legacy autonomy component alias parsing.

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
- Tag and push: `git tag v1.0.18 && git push origin v1.0.18`.

