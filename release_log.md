# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.59`
- start_commit: `bcfdffdebf131afe9419f6747304e35d771cb9dc`
- end_commit: `8cda6b2f303139c678a17e98769762d4b1bcc881`
- commits_in_range: `1`

## Highlights

- Continue repository discovery beyond the first 96 ranked paths instead of replaying an exhausted final page indefinitely. Persist bounded window progress across restarts, migrate old exhausted-page cache state without clearing memory, and revisit earlier evidence when relevant files or temporary exclusions change. Preserve vision constraints, admission limits, and exact-snapshot checks.
- Request review promptly after confirmed PR publication and awaited worktree cleanup. Coalesce publication notifications with the existing single-review lane, preserve fairness and provider cooldowns, and drain or cancel work safely during shutdown.
- Speed up Windows `--clear` directory removal with at most four disjoint deletion tasks and bounded shallow partitioning. Keep physical-path and junction protections, sequential top-level targets, cache preservation, and draining before retries; do not leave detached cleanup running after completion.
- Retain bounded Server/SCM event-loop-delay and slow-stage diagnostics after recovery. Use monotonic timing, a small copied history, fixed stage identifiers, and rate-limited structured logs. Diagnostic clock, timer, cancellation, and logging faults cannot replace task outcomes or alter existing stall/restart decisions.
- Keep first-pass merge rates unknown when provider evidence is missing, partial, or truncated. Preserve approval-only metrics and confirmed observed counts instead of treating unknown merges as failures.
- Add discovery/cache migration, review scheduling, safe cleanup, diagnostic lifecycle/fault isolation, health-route, and provider-evidence regression coverage. Regenerate the packaged runtime assets, including the new diagnostics source module.

## Validation

- Full root suite: `2,955` passed, `12` platform/opt-in skips, `0` failures, and `16,635` assertions across `194` files (296.48 seconds).
- Full `cli:bundle`, including monitoring UI export, and package-payload verification passed in a fresh Docker checkout limited to one CPU, 768 MiB memory, and 512 PIDs. The package contains `277` files with no external toolchains. New source-file permissions in the Linux copy were normalized to their non-executable Git modes before the successful check; no payload rule was bypassed.
- Focused follow-up validation passed all `263` tests across ten files. Shared TypeScript checking and Server/SCM builds passed. Independent review and re-review findings were fixed and covered by regressions.
- Earlier focused discovery, publication, and cleanup tests passed. A small Windows/Bun fixture benchmark reduced median deletion time from 228.73 ms to 104.59 ms; this is a synthetic measurement, not a prediction for a user's worktree.
- Product commit `8cda6b2f303139c678a17e98769762d4b1bcc881` passed [CLI E2E run `36465914313`](https://github.com/PushPalsDev/pushpals/actions/runs/36465914313): packaged CLI and real-Docker WorkerPal control-plane tests on Linux, plus Windows worktree/recovery/trusted-validation/source-only startup contracts. The separate manual-only Windows-host Docker job was skipped as configured.
- Eight-hour read-only observation of installed v1.2.58 recorded 96 cached empty discovery results, no new jobs, and one correlated transport stall that recovered without restarting. This informed the changes but is not a soak test of v1.2.59.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.59
```

```bash
bun install -g @pushpalsdev/cli@1.2.59
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.59
```

## Artifacts

- Standalone CLI and PushPals runtime binaries for Linux x64, Windows x64, macOS x64, and macOS arm64.
- `SHA256SUMS.txt`.
- No separately vendored third-party toolchains.

## Compatibility Notes

- No configuration migration is required. Existing discovery memory is retained.
- Required validation gates, health timeouts, and automatic restart policy are unchanged.
- Runtime diagnostic history is bounded and process-local; emitted log records remain the cross-restart evidence. Slow asynchronous operations include awaited I/O, not just CPU time.
- Non-Windows clear behavior remains unchanged. Reusable caches remain preserved unless explicitly requested for removal.

## Known Issues

- The new diagnostics do not establish or eliminate the cause of the observed transient localhost stall. Timer lateness is not proof of database locking, garbage collection, host contention, or exact downtime.
- The monitored old-version run generated no new jobs, so it cannot establish a new average execution time, first-pass PR quality, or the live effectiveness of these patches. No 100% success or uptime guarantee is claimed.
- Linux preflight and bounded CI smoke tests do not substitute for a long deployed Windows-host Docker soak. The manual-only Windows-host Docker E2E job is not part of ordinary push-triggered gates. Development and monitoring did not modify the live installation or external repository.
- The npm entrypoint requires Node.js 20+ and Bun 1.3.14+. Docker-backed WorkerPal execution requires Docker to be installed and running.
- Some Windows environments require `--use-system-ca` for Bun installs or Schannel for Git remote operations.
