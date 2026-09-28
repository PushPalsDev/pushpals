# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.57`
- start_commit: `5d253009391cff8e6af8aa5f2d8c2077fe39d21c`
- end_commit: `11d469b5e7aadc2a1a6556be6584fac33d832eec`
- commits_in_range: `1`

## Highlights

- Reduce idle discovery waits: schedule bounded 30-second follow-ups after durable progress through empty or currently excluded evidence pages, instead of always waiting for the five-minute baseline. Every accelerated tick rechecks idle capacity, resource and dispatch budgets, publication health, admission, and the dispatch lock. Successful dispatch, failures, unavailable capacity, and exhausted coverage retain the ordinary cadence.
- Preserve repository discovery progress across unrelated commits and completed jobs using reviewed Git blob fingerprints. Revisit changed evidence and reset for changed vision, policy, or model; keep candidate answers fenced to the current tree and executed outcomes. This is visitation history, not permission to reuse stale answers.
- Avoid repeatedly replaying proposals for active or recently completed targets. Apply exclusions only to delivery, preserve nonoverlapping siblings and the structural cached answer, and qualify deferred pages by the current exclusion set.
- Reduce duplicate executor validation: direct editing passes toward focused checks and explicit sandbox capabilities. Apply capability preflight to parallel validation batches as well as sequential commands. Runnable child checks, mandatory trusted-host validation, exact-candidate checks, and PR review remain intact.
- Make ordinary `pushpals --clear` faster to use repeatedly by preserving the reusable WorkerPal image and legacy host dependency cache. Add `--clear --include-caches` for their explicit removal. Filesystem removal is asynchronous and reports per-target progress and elapsed-time heartbeats while retaining bounded retries and protected-root guards.
- Persist host-computed discovery progress through the Repository Agent broker, add timer/cache/cleanup/validation regressions, update the reliability harness and Windows release contracts, and regenerate the tracked runtime bundles, sandbox source, and prompts.

## Validation

- Full `cli:bundle`, including monitoring UI export, and actual npm package-payload verification passed in the isolated Docker fixture limited to one CPU, 768 MiB memory, and 512 PIDs. The package contains `276` files with no external toolchains.
- Final root suite after rebuilding generated assets: `2,900` passed, `12` platform/opt-in skips, `0` failures, and `16,231` assertions across `193` files (282.81 seconds).
- All `134` Python executor tests passed. RemoteBuddy, WorkerPals, and shared-package typechecks passed. Changed-file formatting and diff checks passed.
- Regressions cover unchanged and changed blob history, executed-outcome invalidation, exclusions and viable siblings, failed/concurrent memory writes, broker persistence, unavailable telemetry, timer collisions, pause/stop, capacity/budget fences, protected cleanup roots, and capability-aware validation.
- Product commit `11d469b5e7aadc2a1a6556be6584fac33d832eec` passed [CLI E2E run `36376896896`](https://github.com/PushPalsDev/pushpals/actions/runs/36376896896): packaged CLI on Linux, Linux WorkerPal control-plane/dependency projection, and Windows cleanup/worktree/recovery/trusted-validation/source-only startup contracts. The separate manual-only Windows-host Docker job was skipped as configured.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.57
```

```bash
bun install -g @pushpalsdev/cli@1.2.57
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.57
```

## Artifacts

- `pushpals-linux-x64`
- `pushpals-windows-x64.exe`
- `pushpals-macos-x64`
- `pushpals-macos-arm64`
- `SHA256SUMS.txt`

## Compatibility Notes

- Normal `--clear` still removes repository-local PushPals state and cleans lingering WorkerPal warm containers. It now retains the reusable image and legacy host dependency cache; use `--clear --include-caches` to remove those too. The modifier is invalid without `--clear`.
- Neither clear mode is a global Docker purge. Named dependency volumes, downloaded runtime assets, and runtime configuration are not removed by the new cache modifier.
- Requested Docker cleanup that cannot be confirmed still produces an incomplete summary and exit code `1`, even though local cleanup proceeds. Startup and shutdown cleanup remain best-effort.
- The new `repository-agent-v9-resumable-discovery` cache/prompt version starts fresh discovery metadata without clearing a running installation's older memory.

## Known Issues

- Live throughput and first-review acceptance gains have not yet been measured on the released version. The observed v1.2.56 sample had four completed jobs, three merged PRs, about six minutes of mean worker execution, and 75–80-minute gaps between new autonomous requests. These fixes target the observed waiting and duplication; they do not guarantee every job finishes within ten minutes, 100% job success, or 100% uptime.
- Mandatory trusted-host validation took about 4.5–4.9 minutes per candidate in that run and remains required. Genuine test failures and substantive review findings must still block publication.
- Discovery remains bounded to sixteen pages of six additional paths plus seed evidence, not a full repository audit. Exhaustion does not establish repository-wide absence of useful work, and PushPals must not manufacture tasks to keep workers occupied.
- Linux validation does not substitute for a deployed Windows-host Docker cold-start and long-duration quality soak. The separate manual-only Windows-host Docker CI job is not part of ordinary push-triggered gates. Development did not modify the live installation or external repository.
- Astra requires account access and a compatible Codex CLI. Explicit custom launcher pins are preserved; older custom pins may need updating.
- The npm entrypoint requires Node.js 20+ and Bun 1.3.14+. `PUSHPALS_BUN_BIN` is authoritative when set. Docker-backed WorkerPal execution requires Docker to be installed and running.
- The immutable `v1.2.44`, `v1.2.45`, and `v1.2.46` tags remain unpublished on npm; install `v1.2.47` or newer.
- Some Windows Git installations need Schannel for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
