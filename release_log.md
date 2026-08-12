# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.30`
- start_commit: `8f5cd16ce49b2a8d583248cc80f703466d699e4f`
- end_commit: `c9f478923c97c4e6297720cb6efea6f301fc58c7`
- commits_in_range: `1`

## Highlights

- Terminate timed-out Windows process trees with `taskkill /T /F`, bounded output capture, and bounded stream draining across trusted validation, managed runtime services, and Docker job execution.
- Protect completion publication with durable leases, periodic heartbeats, owner-checked callbacks, expired-claim recovery, and stable-pusher startup reconciliation.
- Mark SourceControlManager unhealthy when an active tick stops progressing or an old finalization backlog remains idle, allowing the embedded supervisor to terminate and restart the stalled service.
- Move dependency snapshots and recursive hardlink projection into a Linux-native Docker volume instead of copying dependency trees through a Windows bind mount.
- Report dependency-preparation phases, percentage progress, elapsed time, artifacts, and a configurable five-minute default timeout.
- Apply autonomy backpressure while publication is unhealthy or backed up, then resume dispatch safely when idle WorkerPal capacity is available.
- Ship synchronized server, SourceControlManager, RemoteBuddy, WorkerPal, shared-config, and CLI runtime assets with expanded regression coverage.

## Validation

- The complete root suite passed `1,138` tests with `9` intentional platform or opt-in skips and `0` failures in the production WorkerPal image on Bun 1.3.14 with a 3 GB memory and 2 CPU limit.
- All `108` focused completion, supervision, SourceControlManager, dependency-projection, autonomy, and configuration regression tests passed with `2` expected skips and `0` failures.
- Server, SourceControlManager, WorkerPals, and RemoteBuddy TypeScript checks passed.
- The opt-in real Linux dependency-projection integration passed using a Docker-native dependency volume and confirmed cache reuse without copying dependencies into the host bind path.
- Packaged WorkerPal runtime parity passed all `3` tests.
- `bun run cli:bundle` completed and synchronized the packaged runtime and monitor assets.
- `bun run cli:verify-package-payload` verified `227` package files with no external toolchain files from a Linux-native checkout.
- Maintained source, tests, and documentation passed Prettier checks; `git diff --check` passed.
- Regression coverage includes expired lease recovery, stale-owner callback rejection, stable-pusher reconciliation, stalled-tick health, old-finalization health, supervisor restart, forced Windows tree-kill command construction, bounded timeout draining, publication backpressure, safe idle-worker use, dependency telemetry, and dependency timeout propagation.

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

- The real descendant-process termination integration is Windows-only and was not executed inside the local Linux validation container; the cross-platform command and bounded-drain behavior are covered by unit tests.
- The first dependency preparation for a new Bun version, lockfile, platform, or workspace can still require registry access; later jobs reuse the container-native snapshot.
- Repository-scoped Docker dependency volumes intentionally persist across warm-container restarts for cache reuse. Old lockfile-keyed snapshots are not yet automatically garbage-collected.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when auto-spawn is enabled.
- A SourceControlManager restart can interrupt an in-flight publication, but its completion lease expires or is reconciled on startup and the disposable publication worktree is reset before retry.
- Active runtimes started from an older release must be restarted after installing this release before the new supervision, lease, and dependency-projection behavior takes effect.
- Docker Desktop exposes Windows bind-mounted files as executable inside Linux containers, so the package mode guard must run against a Linux-native checkout or in the release workflow.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
