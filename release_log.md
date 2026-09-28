# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.58`
- start_commit: `c9d9dde6d0af13e519174f701d0f2226efc33e20`
- end_commit: `5a9832ab91ebb179ca4c35a5e936731dac842e21`
- commits_in_range: `3`

## Highlights

- Distinguish health probes that fail while awaiting response headers, consuming the response body, or receiving an explicit unhealthy HTTP status. Preserve the received HTTP status when a response body stalls.
- Record time to response headers and deadline overrun alongside existing probe duration and timeout metrics. These are client observations, not a diagnosis of CPU, garbage collection, database locking, or host contention.
- Report each service's recovery explicitly, including whether a process restart was required, the failed-probe count, and the observed failure duration. Label recovery metrics as current-process measurements so a newly restarted process's zero counters cannot be mistaken for a zero-duration overall outage.
- Add regression coverage for simultaneous service timeouts, staggered independent recovery, repeated healthy probes, fresh outage counters, and real restart recovery. Keep existing hard deadlines, bounded response bodies, failure classification, and restart policy unchanged.
- Make the repeated-crash circuit regression deterministic: await the actual restart and advance the stability clock explicitly instead of assuming a loaded machine finishes timers within 100 ms. Assert that the restart-attempt counter really resets before the repeated-failure circuit opens.
- Require actual container execution in the Docker control-plane end-to-end tests. A failed image build now reports the worker's early exit and startup diagnostics instead of silently falling back to host execution and producing misleading container-path failures.

## Validation

- Full root suite: `2,902` passed, `12` platform/opt-in skips, `0` failures, and `16,315` assertions across `193` files (285.26 seconds). The initial run exposed the fixed 100-ms test assumption; the full rerun passed after its deterministic replacement.
- Full `cli:bundle`, including monitoring UI export, and package-payload verification passed in the isolated Docker fixture limited to one CPU, 768 MiB memory, and 512 PIDs. The package contains `276` files with no external toolchains; tracked generated runtime assets remained unchanged.
- The final focused CLI bootstrap suite passed all `201` tests. Both new Docker-wait helper regressions passed. Earlier focused health/CLI/HTTP validation passed all `259` tests.
- Supervisor TypeScript check, CLI bundle/help smoke, health-diagnostic file formatting, and diff checks passed in the resource-limited Docker fixture.
- Product commit `5a9832ab91ebb179ca4c35a5e936731dac842e21` passed [CLI E2E run `36381708629`](https://github.com/PushPalsDev/pushpals/actions/runs/36381708629): packaged CLI on Linux, real-Docker WorkerPal control-plane tests, and Windows worktree/recovery/trusted-validation/source-only startup contracts. The separate manual-only Windows-host Docker job was skipped as configured.
- Earlier Linux image builds encountered an upstream Codex binary tarball HTTP 404. After registry availability recovered, the final-commit Docker suites passed without changing or bypassing the runtime installer; the tests now prohibit silent host fallback.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.58
```

```bash
bun install -g @pushpalsdev/cli@1.2.58
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.58
```

## Artifacts

- Standalone CLI and PushPals runtime binaries for Linux x64, Windows x64, macOS x64, and macOS arm64.
- `SHA256SUMS.txt`.
- No separately vendored third-party toolchains.

## Compatibility Notes

- No configuration migration is needed. Health timeouts and automatic restart policy are unchanged.
- Recovery counters and observed failure duration describe the current process; pre-restart failures remain in earlier lifecycle events.
- Existing v1.2.57 discovery, validation, and cache-preserving clear behavior is retained.

## Known Issues

- This release improves health diagnostics; it does not establish or eliminate the cause of the transient v1.2.56 localhost stall. The inspected services recovered without restarting, and subsequent work published and merged. There is no evidence of a native crash in that incident.
- The new metrics do not identify the underlying cause by themselves. Do not infer database locking, Bun garbage collection, or whole-host freezing from a transport timeout.
- Linux preflight and bounded CI smoke tests do not substitute for a long deployed Windows-host Docker soak. The manual-only Windows-host Docker E2E job is not part of ordinary push-triggered gates. Development did not change the live installation or external repository.
- The npm entrypoint requires Node.js 20+ and Bun 1.3.14+. Docker-backed WorkerPal execution requires Docker to be installed and running.
- Some Windows environments require `--use-system-ca` for Bun installs or Schannel for Git remote operations.
