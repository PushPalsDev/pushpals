# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.62`
- start_commit: `9504b12076bf5ec5dd66dcf8907a5b18c64d105a`
- end_commit: `98b925c09aaef632aef07a8d5d3aef894ebc2fe6`
- commits_in_range: `3`

## Highlights

- Prevent competing SCM instances from both reclaiming a stale lock. A dedicated SQLite connection now holds the process-lifetime OS lock, releases automatically after a crash, and never unlinks a successor's ownership file.
- Treat ordinary guarantees such as "existing tests pass after the refactor" as validation requirements, not mandatory test-file edits. Explicit test-edit requirements and test targets remain authoritative; required validation and critic gates are unchanged.
- Preserve actual infrastructure exceptions in failed pytest summaries, including traceback-disabled output, so genuine transient failures retain one bounded retry. Parameterized test names cannot masquerade as diagnostics, and assertion/compiler/lint failures still veto retries.
- Refuse to report successful shutdown or remove worktrees/containers while service exit or a requested termination is unconfirmed. Bound the stop operation, retain unfinished termination state across retries, and avoid re-signalling an exited launcher's potentially recycled PID.
- Add 47 focused regression cases plus a hosted Linux release-preflight contract, run native Bun ownership/shutdown checks on Linux and Windows, and regenerate the packaged worker and SCM bundles. All runtime changes remain repository-generic.

## Validation

- Final hosted full root suite: `3,163` passed, `12` platform/opt-in skips, `0` failures, and `17,894` assertions across `200` files (189.88 seconds), including the native Bun abrupt-owner-death lock regression. The initial source-change run also passed all `3,163` tests before the generated bundles were committed.
- Full `cli:bundle`, monitoring UI export, package-payload verification, and WorkerPals/SCM TypeScript checks passed on a GitHub-hosted Linux runner. Local Docker returned an engine API error; no host runtime or live SectorCommand services were started for validation.
- [Initial CLI E2E run 36688499773](https://github.com/PushPalsDev/pushpals/actions/runs/36688499773) passed Linux package/real-Docker worker tests and Windows ownership, shutdown, trusted-validation, and source-only startup contracts. The manual-only Windows Host Docker E2E job was skipped as configured.
- The exact initial CI commit's generated artifact was inspected and apply-checked; only the two expected worker/SCM bundles changed. The WorkerPal source/sandbox TypeScript mirror hashes match, and the final hosted rebuild produced an empty generated-runtime diff.
- Final product commit `98b925c09aaef632aef07a8d5d3aef894ebc2fe6` passed [CLI E2E run 36689260426](https://github.com/PushPalsDev/pushpals/actions/runs/36689260426): full hosted preflight, packaged Linux CLI, real-Docker Linux worker execution, and Windows contracts/source-only startup. The manual-only Windows Host Docker E2E job was skipped as configured.
- Release publication and installed-platform smokes: pending after tagging.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.62
```

```bash
bun install -g @pushpalsdev/cli@1.2.62
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.62
```

## Artifacts

- Standalone CLI and PushPals runtime binaries for Linux x64, Windows x64, macOS x64, and macOS arm64.
- `SHA256SUMS.txt`.
- No separately vendored third-party toolchains.

## Compatibility Notes

- No configuration or application-database migration is required. SCM creates a dedicated `merge_queue.lock.sqlite` file in its state directory; do not delete or replace it while a daemon may be running. The existing JSON lock file remains diagnostic/legacy metadata.
- Live legacy owners are respected, but concurrent old/new binaries retain the old binary's unsafe stale-file protocol. Stop old instances and upgrade all contenders to obtain the new ownership guarantee.
- Required validation order, publication backpressure, exact-candidate checks, and candidate-specific lifecycle hooks remain authoritative. Failures are not converted into successful jobs or bypassed for speed.

## Known Issues

- The v1.2.60 immediate-restart lock collision had insufficient evidence to identify its exact cause. This release repairs independently reproduced ownership and incomplete-shutdown defects; it does not retrospectively prove which caused that incident.
- The general standalone CLI TypeScript check still reports 15 pre-existing diagnostics; comparison with the prior committed CLI found no new diagnostics. Scoped worker/SCM typechecks pass. This release does not claim a clean repository-wide CLI typecheck.
- A completed best-effort process-tree termination call plus launcher exit is not independent proof that every descendant is dead. Reported or pending termination failures prevent automatic cleanup; an exited root with a failed termination remains fail-closed instead of risking a recycled PID.
- Hosted tests and bounded smokes do not substitute for a long deployed Windows-host Docker soak or establish a sub-ten-minute job average, improved vision alignment, or 100% success/uptime. Development and validation did not modify the live installation or external repository.
- The npm entrypoint requires Node.js 20+ and Bun 1.3.14+. Docker-backed WorkerPal execution requires Docker to be installed and running.
- Some Windows environments require `--use-system-ca` for Bun installs or Schannel for Git remote operations.
