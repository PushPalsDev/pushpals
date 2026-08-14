# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.31`
- start_commit: `1ffa2a1a1d8ba7d22a6bec86dff6ecb52044c0bd`
- end_commit: `c48e432b5dd5a26865496ca5fc932628f2d5d087`
- commits_in_range: `1`

## Highlights

- Use one validation-safe dependency fingerprint across Docker preparation and WorkerPal validation so a fast Linux-native projection is not discarded and reinstalled before validation.
- Keep dependency snapshots and per-job projections in repository-scoped Docker volumes, with accurate preparation phases, cache-hit telemetry, and bounded timeouts.
- Isolate each OpenAI Codex worker in a repository-and-worker-scoped Linux volume while mounting only the host `auth.json` read-only; preserve container-refreshed credentials until the host credential actually changes.
- Require the enabled worker critic to meet the final ReviewAgent threshold before handing a candidate to trusted-host validation, and provide the final-review rubric and prior findings to the worker critic.
- Persist autonomy objectives in a durable `gated` reservation before enqueueing work, validate reservation identity and idempotency server-side, and reconcile interrupted reservations on startup and stale-claim sweeps.
- Suppress overlapping active or recently attempted target paths before LLM scoring, record rejected candidates as unselected, and cap compact ideation timeout retries at 30 seconds.
- Refresh the Windows CA bundle once per CLI process without destroying the last valid bundle when export fails, and treat a stopped Docker Desktop pipe as unavailable during best-effort cleanup.
- Bound failed-launch process exit and output-stream draining, then finalize service-manager shutdown without allowing one service to hold another open.
- Ship synchronized server, RemoteBuddy, WorkerPal, prompts, documentation, and packaged CLI runtime assets with expanded regression coverage.

## Validation

- The complete root suite passed `1,159` tests with `5` intentional platform or opt-in skips and `0` failures on Windows with Bun 1.3.14.
- The focused autonomy, reservation, Docker executor, quality-gate, review-fix, and validation-safety suite passed `259` tests with `2` Docker integration skips and `0` failures.
- The combined CLI lifecycle, invocation, autoscaling, and completion-persistence suite passed `200` tests with `2` intentional skips and `0` failures.
- Server, RemoteBuddy, WorkerPals, and shared-package TypeScript checks passed.
- Protocol integration passed all `44` checks, and prompt-policy enforcement passed both checks.
- `bun run cli:bundle` completed and synchronized packaged runtime source, generated service bundles, prompts, and monitor assets.
- `bun run cli:verify-package-payload` verified `227` package files with no external toolchain files.
- Maintained source, tests, prompts, and documentation passed Prettier checks; `git diff --check` passed.
- Runtime mirror hashes match their source WorkerPal, prompt, and environment-template files.

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

- Docker Desktop was intentionally stopped before implementation validation, so the new opt-in Windows-host/Linux-container cache-and-Codex-volume integration was added but not executed locally. Command construction, cache fingerprinting, mount isolation, state migration, and timeout behavior are covered by the normal suite.
- The first dependency preparation for a new Bun version, lockfile, platform, or workspace still requires installation; later jobs reuse the container-native snapshot.
- Repository-scoped dependency volumes and repository-and-worker-scoped Codex volumes intentionally persist across warm-container restarts. Obsolete lockfile snapshots and retired worker volumes are not yet automatically garbage-collected.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when auto-spawn is enabled. `pushpals --clear` treats a stopped Docker daemon as a best-effort cleanup skip.
- The observed pre-release session averaged 14.37 minutes per terminal job and 50% first-pass PR approval. This release removes measured bottlenecks and quality-gate gaps, but a new downstream soak is still required to quantify the resulting runtime and approval-rate changes.
- Active runtimes started from an older release must be restarted after installing this release before the new dependency, critic, reservation, and service-lifecycle behavior takes effect.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
