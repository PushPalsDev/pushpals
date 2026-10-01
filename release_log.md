# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.63`
- start_commit: `5b87b0c69b2b0802a6451f09a827149375e8aa9f`
- end_commit: `7cf5434750bb496ffe376dd2f98dd74c4eaca623`
- commits_in_range: `2` (one product fix and the prior release's verification record)

## Highlights

- Check shared Docker execution capability before claiming jobs. Known infrastructure outages leave queued attempts untouched, keep controller heartbeats alive, and use bounded recovery probes rather than repeated failed coding jobs or worker respawn loops.
- Distinguish setup-only infrastructure failures from implementation outcomes. Healthy workers can take work targeted to a blocked worker, existing claims remain replayable, and shutdown fences prevent late readiness probes from recreating resources.
- Pause expensive autonomous discovery while workers explicitly report blocked execution. Confirmed, unchanged bounded-discovery exhaustion pauses repeated analysis for at most 30 minutes; fresh repository evidence or changed eligibility reopens discovery without inventing work.
- Report review quality from actual observed review outcomes. Jobs that never reached review cannot produce a perfect first-pass rate; successful publication is not itself a revision, and retained revisions cannot age into first-pass success.
- Preserve bounded structured stall diagnostics separately from truncated health previews, including recent lag, slow operations, CPU-window deltas, RSS, and fixed-label active operations. These measurements support correlation without claiming a proven stall cause.
- Expand regression and Windows CI coverage, require the new readiness helper in the published package, and refresh bundled runtimes. All changes remain repository-generic and preserve candidate-specific hooks, final validation, review, and publication gates.

## Validation

- Isolated Linux container regression run: `3,231` passed, `12` platform/opt-in skips, `0` failures, and `18,289` assertions across `202` files (331.33 seconds). One unrelated Metro test was excluded because the offline image lacked Expo; this is not a claim that the full local root suite passed.
- Final packaging, Windows-workflow contract, and runtime-mirror tests: `33` passed, `0` failures. CLI entrypoint and all service bundles built; actual npm package payload verification passed with `279` files and no vendored external toolchains.
- Server, WorkerPals, RemoteBuddy, shared, and SourceControlManager TypeScript checks passed. Formatting and diff checks passed; changed raw runtime mirrors match source hashes.
- Hosted release preflight passed the full CLI bundle and monitoring UI export, actual package-payload verification, WorkerPals/SCM typechecks, and the complete root suite: `3,235` passed, `12` platform/opt-in skips, `0` failures across `203` files (183.47 seconds). This includes the Metro test unavailable in the offline container and the final packaging regression.
- Final product commit `7cf5434750bb496ffe376dd2f98dd74c4eaca623` passed [CLI E2E run 36780559155](https://github.com/PushPalsDev/pushpals/actions/runs/36780559155): full Linux preflight, packaged CLI, real-Docker worker execution, and Windows contracts/source-only runtime startup. The manual-only Windows Host Docker E2E job was skipped as configured.
- The exact commit's generated-runtime artifact was downloaded and inspected: `runtime-assets.patch` is empty, confirming the committed runtime bundles match the hosted build.
- [Release CLI run 36819202328](https://github.com/PushPalsDev/pushpals/actions/runs/36819202328) passed all `16` jobs, including the container-backed reliability harness, five-minute Windows runtime smoke, and published-package installation smokes on Linux and Windows. npm `latest` is `1.2.63`; the GitHub release contains all `25` assets. Trusted publishing succeeded without reauthentication.
- The first Windows installed-package attempt failed before PushPals started because Bun's package index had not yet exposed the version, although exact-version metadata and the tarball were available. After both full and abbreviated indexes listed `1.2.63`, only the failed Windows smoke was rerun and passed its `150,000ms` runtime observation. npm publication and successful jobs were not repeated.
- Local execution stayed inside a disposable container capped at one CPU and 2 GiB RAM, with no network or Docker socket. The container was removed afterward; no live SectorCommand installation or services were changed.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.63
```

```bash
bun install -g @pushpalsdev/cli@1.2.63
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.63
```

## Artifacts

- Standalone CLI and PushPals runtime binaries for Linux x64, Windows x64, macOS x64, and macOS arm64.
- `SHA256SUMS.txt`.
- No separately vendored third-party toolchains.

## Compatibility Notes

- No configuration or application-database migration is required. Legacy workers without an explicit execution-readiness signal remain compatible and are treated as unknown, not permanently blocked; upgrade all workers for the full admission guarantee.
- Docker readiness recovery uses a 30-second positive cache, a bounded shared probe, and failure backoff capped at five minutes. Candidate-specific dependency installation and lifecycle hooks still run per job.
- Required validation order, publication backpressure, exact-candidate checks, and candidate-specific lifecycle hooks remain authoritative. Failures are not converted into successful jobs or bypassed for speed.

## Known Issues

- Exact-version metadata/tarball visibility can precede the package-index visibility needed by Bun installation. The current availability gate does not check both package-index variants; retry only a failed installed-package smoke after confirming propagation, never npm publication.
- Readiness admission cannot repair Docker itself or guarantee that infrastructure stays healthy after a successful probe. A job can still fail if Docker becomes unavailable after admission; that failure is retained and subsequent claims are blocked until recovery.
- This release does not claim a clean repository-wide standalone CLI TypeScript check; the scoped service/package checks listed above passed.
- Hosted tests and bounded smokes do not substitute for a long deployed Windows-host Docker soak or establish a sub-ten-minute job average, improved vision alignment, or 100% success/uptime. Development and validation did not modify the live installation or external repository.
- The npm entrypoint requires Node.js 20+ and Bun 1.3.14+. Docker-backed WorkerPal execution requires Docker to be installed and running.
- Some Windows environments require `--use-system-ca` for Bun installs or Schannel for Git remote operations.
