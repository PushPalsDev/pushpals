# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.44`
- start_commit: `bd6122beb64830557ca80a2b1939b408c08db412`
- end_commit: `491e0abe0f6af2bd059e3a28178e2b9d61da05a1`
- commits_in_range: `2`

## Highlights

- Make the RepositoryAgent a generic, shared capability for every PushPals service, with evidence-bounded analysis, durable leases, structural caching, and repository-scoped memory reinforcement.
- Fence autonomous dispatch with a fail-closed two-phase reservation protocol so disabled, expired, replayed, or unconfirmed objectives cannot leak into worker execution.
- Enforce one monotonic end-to-end WorkerPal deadline across setup, execution, retries, validation, and host finalization while preserving a bounded cleanup reserve and cumulative model-usage evidence.
- Retain exact candidate commits through trusted-host validation and add HMAC-scoped SCM repair authority, durable repair lifecycles, startup reconciliation, and cross-job failure circuit breaking.
- Improve quality and speed with focused-first validation DAGs, invariant-gate reuse, rollout/no-edit watchdog recovery, candidate-aware repair, and accurate terminal semantics for unchanged or blocked work.
- Isolate concurrent Linux dependency projections with copy-on-write snapshots instead of shared writable hardlink inodes, while keeping deterministic LF worktrees and bounded dependency preparation telemetry.
- Expand lifecycle, timeout, crash, publication, memory, package-parity, and observability harnesses across source and embedded runtime assets.

## Validation

- `bun run test:root` passed `1,944` tests with `7` intentional platform-gated skips, `0` failures, and `15,403` assertions across `168` files on Windows with Bun 1.3.14.
- `bun run harness:reliability` passed all `7` phases, including `125` Python WorkerPal watchdog tests and `469` runtime-boundary tests with the same `7` platform-gated skips.
- RepositoryAgent/memory, two-phase autonomy dispatch, durable SCM repair, publication recovery, monotonic deadline, cleanup-reserve, and dependency-projection regression suites passed both focused and full runs.
- `bun run cli:bundle` rebuilt all packaged service runtimes and source mirrors successfully, and runtime mirror parity checks passed.
- `bun run cli:verify-package-payload` verified `269` package files with no external toolchain files.
- Shared, RemoteBuddy, Server, SourceControlManager, and WorkerPal typechecks passed; two independent review passes found no remaining actionable issue; `git diff --check` passed.

## Install

```bash
npm i -g @pushpalsdev/cli@1.2.44
```

```bash
bun install -g @pushpalsdev/cli@1.2.44
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

- Docker-backed WorkerPal execution still requires Docker to be installed and running when auto-spawn is enabled. `pushpals --clear` treats a stopped Docker daemon as a best-effort cleanup skip.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
