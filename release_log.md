# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.54`
- start_commit: `2a3715962ace5b4f26480ed4f63c8b6e9404b36a`
- end_commit: `39ddc7f06434e1f813552b2c852bc6082c1883e8`
- commits_in_range: `2`

## Highlights

- Remove a duplicate foreground WorkerPal readiness wait that delayed SourceControlManager launch. Background worker warmup continues independently; the CLI checks capacity once after embedded services start.
- Keep worker-status requests, retries, and sleeps within one finite startup deadline. Recognize manually started workers when auto-spawn is disabled, and distinguish failed or malformed status responses from a valid empty worker list without aborting service startup.
- Report bounded initial connection refusals as startup instead of immediately recommending a restart. Preserve explicit unhealthy responses, crash recovery, post-readiness outages, and existing restart deadlines.
- Distinguish durably deferred PR feedback from provider failures. Expose pending feedback, retain backoff and reconciliation, log the server's reason, and reject contradictory or malformed acknowledgements rather than treating them as success.
- Expand Repository Agent evidence beyond file prefixes using bounded original-line windows, fair UTF-8 budgets, and request-relevant excerpts. Preserve repository and snapshot authority, reject citations into omitted or partial lines, and invalidate the older limited-evidence cache version without inventing tasks.
- Refresh embedded runtime bundles and strengthen regression coverage for startup deadlines, manual workers, feedback authority, evidence boundaries, and multilingual retrieval. Gate worker readiness in Linux/Windows CI and Windows release validation as well as the consolidated reliability harness.

## Validation

- Bun 1.3.14 passed the full CLI bundle and actual npm payload check in an isolated container limited to one CPU, 768 MiB memory, and 512 PIDs. The package contains `276` files and no external toolchains.
- The final pre-release `bun run test:root` passed `2,654` tests, with `12` platform/opt-in skips, `0` failures, and `15,170` assertions across `190` files (245.16 seconds).
- Existing CLI/startup/deadline checks passed `205` tests. The new readiness, harness, and workflow checks passed `54` tests. Independent review found no remaining release blocker; formatting, packaged-asset freshness, and diff checks passed.
- The preceding product commit's consolidated reliability harness passed all seven phases. RemoteBuddy, Server, and SourceControlManager TypeScript checks passed for those runtime changes; the final CLI change also passed bundle and actual npm payload verification. Local Windows and Docker-socket-dependent opt-ins remain skipped in the isolated Linux container.
- Final product commit `39ddc7f06434e1f813552b2c852bc6082c1883e8` passed CLI E2E run `36187635494`: Linux and Windows worker readiness, Windows recovery/trusted validation and isolated runtime startup, Linux WorkerPal control-plane/dependency projection, and packaged CLI end-to-end checks. The separate manual-only Windows-host Docker job was skipped as configured.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.54
```

```bash
bun install -g @pushpalsdev/cli@1.2.54
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.54
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
- A post-update live Windows-host Docker cold start and long-duration job-quality soak have not been demonstrated. The observed v1.2.53 session stayed responsive but generated no new jobs; it is not evidence of successful new-job throughput. This release does not guarantee 100% uptime or job success; genuine validation failures and substantive critic findings must still block publication.
- Broader evidence coverage can still legitimately yield no grounded candidates. It does not force job creation, prove browser acceptance, or change the configured score-based PR review policy. Worker readiness printed at connection is a snapshot; use `/status` to refresh it.
- Cold image builds and pulls retain separate ten-minute limits, startup self-checks have five minutes, and the default shared absolute startup ceiling is 27.5 minutes. These are upper bounds, not expected warm-start latency or a guarantee that unavailable dependencies will recover.
- Capability holds do not provision missing browsers or repair users' tests. Unconfirmed worker cleanup intentionally delays replacement rather than risking duplicate workers or removal of unrelated containers.
- The npm entrypoint requires Node.js 20+ and at least one Bun 1.3.14+ installation. Standalone GitHub release binaries remain available when installing Bun is not practical.
- `PUSHPALS_BUN_BIN` is authoritative when set; unset or correct it if it points to a removed or outdated runtime.
- The immutable `v1.2.44`, `v1.2.45`, and `v1.2.46` tags remain unpublished on npm; install `v1.2.47` or newer.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when auto-spawn is enabled. `pushpals --clear` treats a stopped Docker daemon as a best-effort cleanup skip.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
