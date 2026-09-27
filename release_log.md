# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.55`
- start_commit: `4761ca8690ffa28f94ec0e13d63862a1cde2f222`
- end_commit: `a9f4e07af9924bdf7d46b3525a0061e9d649526c`
- commits_in_range: `2`

## Highlights

- Advance Repository Agent exploration after grounded empty opportunity results instead of repeatedly reusing one limited evidence packet. Persist bounded evidence-page progress with page-specific caches, compare-and-set ownership, cancellation/deadline fences, and snapshot verification; preserve useful positive cache reuse and downstream admission gates.
- Retain vision exclusions alongside priorities and constraints. Use the same normalized structural context for retrieval, synthesis, and cache identity so transient queue/cooldown conditions cannot become long-lived structural conclusions. All behavior is repository-generic.
- Add independent repository-analysis latency, cache, and empty/nonempty/unknown candidate metrics to the read-only run-health report. Completed analysis is never counted as dispatched work, job delivery, publication, or merge; missing and ambiguous evidence remains unknown.
- Make confirmed health recovery visible in the CLI, retain partial degradation, and avoid false healthy messages during service replacement or failed startup retries. Separate ongoing-supervision guidance from exhausted recovery and distinguish measured probe duration from outage age without widening deadlines or restart thresholds.
- Treat GitHub's exact HTTP 422 `Reference does not exist` response as already-complete branch cleanup, alongside existing 404 handling. Preserve errors for other validation responses, malformed bodies, authentication, and provider failures.
- Refresh packaged runtime bundles and add 79 regression tests covering exploration persistence, vision/cache boundaries, truthful analysis metrics, missing-branch reconciliation, and single-/multi-service recovery. Gate health recovery on Linux and Windows CI and Windows release validation; make the certificate-cache unit fixture independent of native host-store export.

## Validation

- Bun 1.3.14 passed the full CLI bundle and actual npm payload check in an isolated container limited to one CPU, 768 MiB memory, and 512 PIDs. The package contains `276` files and no external toolchains.
- The final pre-release `bun run test:root` passed `2,733` tests, with `12` platform/opt-in skips, `0` failures, and `15,558` assertions across `190` files (273.92 seconds).
- Final health/bootstrap checks passed `214` tests; SCM/workflow checks passed `198`; planning/metrics checks passed `103`. Independent review found and resolved false-recovery edge cases before publication. Formatting, packaged-asset freshness, and diff checks passed.
- The consolidated reliability harness passed all seven phases (318.913 seconds), including the final multi-service recovery regressions. Prompt-policy checks passed two tests and protocol checks passed 51. RemoteBuddy and SourceControlManager TypeScript checks passed. Local Windows and Docker-socket-dependent opt-ins remain skipped in the isolated Linux container.
- Final product/test commit `a9f4e07af9924bdf7d46b3525a0061e9d649526c` passed [CLI E2E run `36289223050`](https://github.com/PushPalsDev/pushpals/actions/runs/36289223050): Linux and Windows health recovery, Windows recovery/trusted validation and isolated runtime startup, Linux WorkerPal control-plane/dependency projection, and packaged CLI end-to-end checks. The first CI run exposed a certificate unit fixture invoking native Windows export; the fixture was isolated without changing runtime behavior or relaxing test deadlines. The separate manual-only Windows-host Docker job was skipped as configured.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.55
```

```bash
bun install -g @pushpalsdev/cli@1.2.55
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.55
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

- Astra still requires account access and a compatible Codex CLI. Explicit custom launcher pins are preserved; users retaining an older custom pin may need to upgrade it themselves. The compatibility fallback does not grant model access or bypass authentication failures.
- A post-update live Windows-host Docker cold start and long-duration job-quality soak have not been demonstrated. The observed v1.2.54 run generated zero jobs despite repeated completed analyses. Observation included an active-check gap followed by retrospective log/database inspection, not a completed continuous three-hour soak. The live installation was not modified during development. This release does not guarantee 100% uptime or job success; genuine validation failures and substantive critic findings must still block publication.
- Exploration is capped at 16 pages of six additional paths plus stable seed anchors, not a full repository audit. Broader coverage can still legitimately yield no grounded candidates and does not force job creation or establish repository-wide exhaustion. It does not prove browser acceptance or change the configured score-based PR review policy. Worker readiness printed at connection is a snapshot; use `/status` to refresh it.
- The brief observed local health timeouts recovered without a restart; their underlying host/transport cause was not established. Improved timing and recovery reporting does not establish a root-cause fix for every transient stall.
- Cold image builds and pulls retain separate ten-minute limits, startup self-checks have five minutes, and the default shared absolute startup ceiling is 27.5 minutes. These are upper bounds, not expected warm-start latency or a guarantee that unavailable dependencies will recover.
- Capability holds do not provision missing browsers or repair users' tests. Unconfirmed worker cleanup intentionally delays replacement rather than risking duplicate workers or removal of unrelated containers.
- The npm entrypoint requires Node.js 20+ and at least one Bun 1.3.14+ installation. Standalone GitHub release binaries remain available when installing Bun is not practical.
- `PUSHPALS_BUN_BIN` is authoritative when set; unset or correct it if it points to a removed or outdated runtime.
- The immutable `v1.2.44`, `v1.2.45`, and `v1.2.46` tags remain unpublished on npm; install `v1.2.47` or newer.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when auto-spawn is enabled. `pushpals --clear` treats a stopped Docker daemon as a best-effort cleanup skip.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
