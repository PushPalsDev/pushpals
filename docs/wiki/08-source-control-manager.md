# 08. SourceControlManager (`apps/source_control_manager`)

## Purpose

SourceControlManager (SCM) owns integration policy.

WorkerPals executes/commits; SCM decides how those commits become branch updates and PRs.

## Component Contract

- Receives: immutable completion records containing candidate commit and branch metadata.
- Owns: trusted validation, merge strategy, push/PR policy, and publication recovery.
- Produces: an integrated branch or PR plus a processed/failed completion acknowledgement.
- Does not own: the original coding execution or authoritative Server job/completion queue state.

The publication path is `claim completion -> validate candidate -> publish -> acknowledge processed/failed`.

## Key Files

- `apps/source_control_manager/src/source_control_manager_main.ts` - daemon bootstrap and completion processing.
- `apps/source_control_manager/src/review_agent.ts` - ReviewAgent polling, scoring, merge/reject actions.
- `apps/source_control_manager/src/github_pr.ts` - GitHub API operations (PR list/diff/comments/merge/delete ref).
- `apps/source_control_manager/src/git.ts` - local git operations and integration branch handling.
- `apps/source_control_manager/src/db.ts` - local merge queue persistence/logs.
- `apps/source_control_manager/src/completion_lease.ts` - shared lease-renewal barrier.
- `apps/source_control_manager/src/completion_callback.ts` - bounded authoritative callback retries.
- `apps/source_control_manager/src/trusted_validation.ts` - trusted-host validation orchestration.
- `apps/source_control_manager/src/dependency_artifact_cache.ts` - reusable native package artifacts, separate from candidate validation.
- `apps/source_control_manager/src/validation_substeps.ts` - bounded, observation-only aggregate-stage timing.

## Current Operating Modes

SCM now has two distinct modes.

### 1) ReviewAgent Mode (`source_control_manager.review_agent.enabled=true`)

For each completion:

1. SCM validates the completion on a temp branch (including configured checks).
2. SCM creates or reuses an individual PR for that completion branch.
3. SCM writes metadata into PR body (`pushpals-jobId`, `pushpals-sessionId`) for requeue routing.
4. ReviewAgent polls open PRs under configured head prefix and base branch.
5. ReviewAgent runs Codex review and parses JSON verdict.
6. Final decision is programmatic: approve iff `score >= pass_threshold`.

When approved:

- SCM posts an approval comment including score, threshold, why it passed, and potential improvements.
- SCM merges PR using configured `merge_method`.
- Merge commit title/body is derived from the source commit message when available, and SCM appends a `ReviewAgent:` section with threshold, score, and PR URL.
- SCM deletes merged PR head branch via GitHub API unless protected/unsafe (`main`, `main_agent`, `main_agents`, base-branch match, invalid ref).

When rejected:

- SCM posts rejection comment with issues.
- SCM auto-enqueues a fix job tied to the same PR/session context.
- SCM includes recent PR feedback comments as additional context for that fix job.
- SCM persists a PR/head repair lifecycle with bounded strategy-changing
  attempts and a terminal exhausted tombstone that survives restart.
- SCM reuses existing PR on subsequent iterations (no duplicate PR creation for re-review).

### 2) Direct Integration Mode (`review_agent.enabled=false`)

SCM applies the validated candidate using the configured `cherry-pick`, `no-ff`, or `ff-only` strategy, pushes the integration branch (`main_agents` by default), and optionally opens or reuses a PR from integration to base.

## ReviewAgent Decision Policy (Important)

ReviewAgent uses score-only gating:

- approve: `critic.score >= pass_threshold`
- reject: `critic.score < pass_threshold`

The LLM may provide other fields, but merge/reject policy is controlled by threshold comparison in SCM.

The current poller marks an unchanged PR revision as reviewed and skips further
action when its provider diff is empty or exceeds 300,000 characters. It does
not comment, merge, close, or enqueue repair for that revision; the PR becomes
eligible again only when its head/base fingerprint changes or another explicit
force condition applies. Operators must handle those skipped PRs manually.

## Git Backend and Auth Resolution

SCM token resolution is centralized via shared git backend logic (`packages/shared/src/git_backend.ts`):

- backend inference: GitHub / GitLab / unknown by remote URL,
- token source precedence: configured token -> env token -> provider CLI token (`gh`/`glab`) -> none.

This keeps provider-specific auth behavior in one place and reduces duplicated auth patches.

## PR Metadata and Traceability

- Confirmed new/reused PR publication nudges the existing review lane after SCM
  finishes checkout/ref cleanup. Requests coalesce; they do not overlap reviews,
  change one-PR-per-poll fairness, or accelerate provider reconciliation. Disabled
  or stopped review agents ignore nudges, and shutdown drains any active review.
- SCM records the processed PR URL when marking completions processed (`/completions/:id/processed` with `prUrl`).
- SCM emits pusher/status messages with created/reused PR URLs for operator visibility.
- ReviewAgent fix jobs carry structured `reviewAgent` metadata (`prNumber`, `prUrl`, `prHeadRef`, previous score/summary, etc.).
- A published PR remains an awaiting-review delivery until the provider confirms
  `merged` or `closed_unmerged`; approval alone is not counted as successful
  delivery.
- Provider reconciliation remains active when AI review is disabled or its
  runtime is temporarily unready. Readiness changes update the live agent in
  place, preserving provider cursors, retries, and review fairness state.
- Durable normalized PR outcomes resolve every job linked to the same PR while
  retaining newer jobs if a previously closed PR is reopened. Provider event
  timestamps and job generations prevent delayed close events from masking a
  newer attempt, while a confirmed merge remains monotonic.

## Recovery and Safety Features

A claim is identified by `pusherId`, `claimToken`, and `claimGeneration`. Server mutations are fenced by the pusher and token, while the generation identifies immutable recovery checkpoints. Lease renewals and processed/failed callbacks require an explicit JSON `{ "ok": true }`; a `409` loses the lease, and a malformed success remains unconfirmed rather than being treated as publication authority.

- a dedicated `merge_queue.lock.sqlite` connection holds an exclusive SQLite
  transaction for SCM's lifetime. Contention returns immediately; process death
  releases the OS lock without deleting stale files. Never unlink/replace this
  database while SCM may be running. `merge_queue.lock` is legacy/diagnostic
  metadata only; live legacy owners are respected, but concurrent mixed-version
  starts retain the old binary's unsafe stale-file protocol until all are upgraded,
- completion claims use renewable leases and stable pusher ownership; expired,
  legacy, and same-pusher restart claims are reconciled back to FIFO pending work,
- processed/failed callbacks verify lease ownership so a stale publisher cannot
  finalize a completion reclaimed by another SCM instance,
- a successful publication command receives bounded exact-ref proof checks;
  delayed visibility retains the validated checkpoint for reconciliation rather
  than falsely marking the candidate `publish_blocked`,
- `/health` becomes unhealthy when an active tick stops making progress or an
  old publication backlog remains idle; the embedded supervisor then terminates
  the full Windows process tree with `taskkill /T /F` and restarts SCM,
- an explicit unhealthy HTTP response uses three consecutive probes, while
  transport timeouts require at least 60 seconds of sustained unavailability
  as well as three failures. Brief shared localhost outages therefore do not
  immediately discard an active validation. Probes remain bounded at 2.5 seconds;
  only a confirmed healthy response resets the failure window, including when
  HTTP errors and transport failures alternate. A termination that returns
  without a confirmed process exit is retried after bounded exit confirmation,
- health probes use fresh connections rather than Bun's shared keep-alive pool;
  a silent reused socket cannot itself make a responsive listener look down.
  A raw TCP regression demonstrates this isolation on Bun 1.3.14. This is not
  proof of the underlying cause of the September 11 cross-service Windows outage,
- Server `/healthz` is also observed for correlated local outages, without
  health-directed Server restarts that could cascade into other services.
  Structured `embeddedRuntimeHealth` records distinguish HTTP failures from
  transport failures and report failure duration and last confirmed health,
- health-directed restarts emit `embedded_runtime_exit`, not native-crash
  events. A replacement process emits `restart_started`; only a successful
  health probe emits `recovered`. Services without health probes report only
  process/launcher readiness, which is not evidence of service uptime,
- `/health.reviewProvider` reports provider poll timestamps, consecutive
  failures, retry backlog, `pendingFeedbackCount`, and the durable-link cursor.
  Provider API outages are exposed as a degraded component without restarting
  the otherwise healthy publication loop,
- explicitly retryable server feedback authority gaps remain pending on bounded
  backoff without marking provider health degraded. Logs retain the server's
  reason and disposition; an unclassified ignore or HTTP/authentication failure
  still degrades provider health. Missing job authority is durably terminalized
  only after the existing three-observation/ten-minute stale window (or explicit
  pruning), and terminal ignores still require a positive acknowledgement,
- missing provider credentials, an unsupported remote, or an unresolved remote
  are reported as an explicit degraded provider state instead of disappearing
  from health telemetry; a provider poll that remains in flight for five minutes
  is reported as stalled and makes `/health` restartable,
- runtime reconfiguration retires a ReviewAgent only after its active polls
  drain, preventing the old and replacement agents from publishing overlapping
  provider outcomes,
- GitHub open/closed scans keep bounded page cursors, so each poll has a fixed
  API-work ceiling while long-running reconciliation still reaches PRs beyond
  the newest page window,
- trusted validation and configured checks terminate their Windows descendant
  trees on timeout and stop draining inherited output pipes after a bounded grace;
  trusted-host commands default to an eight-minute ceiling,
- an immediate trusted-command retry is bounded to one known infrastructure
  failure. Concrete assertion, compiler, or lint diagnostics veto that retry;
  infrastructure phrases in test titles are not failure evidence. Exception
  suffixes in failed pytest summaries remain diagnostics, even without tracebacks;
  assertion suffixes still veto a retry. An ambiguous
  container exit alone does not qualify. Completion/retry progress events include
  the exit code, failure class, and failed-test count without copying child output
  or test names into the streaming log,
- retained candidates are automatically retried only once, and only after a
  same-command pass on the same baseline proves recovery from a transient host
  failure without named test evidence; test, lint, and typecheck failures stay
  blocked until a new repair candidate is produced,
- trusted dependency preparation is single-flight per repository. Reuse is
  keyed by the exact candidate/base tree, toolchain, platform, lockfiles, and
  normalized affected paths; candidate-sensitive validation commands always
  rerun,
- startup and watchdog reconciliation page unresolved repair lifecycles rather
  than repeatedly rewriting a newest-only terminal-job window. Settled and
  exhausted rows are monotonic and idempotent,
- clean-repo guard (optional skip in dev),
- retry/backoff on transient failures,
- bounded review diff size,
- overlap-safe poll loop (skips concurrent poll tick overlap),
- protected branch safeguards for post-merge deletion.

Review-fix and merge-conflict jobs derive validation from the target
repository's changed paths and nearest manifests. They do not assume PushPals'
package manager or test command.

Trusted-host validation is a trust boundary, not an OS sandbox. SCM parses
allowlisted commands without a shell, proves the candidate SHA and clean tree
around each command, and enforces process-tree deadlines. Permitted package
scripts can nevertheless execute candidate-controlled repository code on the
host, with only narrowly sensitive PushPals authority removed from the child
environment. Enable trusted-host commands only for repositories and candidates
allowed to run under the SCM process identity.

Transport references: Bun documents per-request connection isolation via
[`keepalive: false`](https://bun.sh/docs/runtime/networking/fetch).
[RFC 9112 section 9.3](https://www.rfc-editor.org/rfc/rfc9112.html#section-9.3)
requires fully consuming a request body or closing its connection before reuse.
Server's bounded memory/Repository Agent request reader therefore drains rejected
oversized uploads before returning `413`: it discards arriving bytes until EOF,
with a 250ms absolute drain deadline and a 64KiB additional-discard threshold
after the chunk that exceeded the accepted body limit. Thresholds are checked
after each delivered chunk, so one chunk can cross the threshold. Declared
oversized uploads have not been read yet, so their discard threshold is the route
limit plus 64KiB; discarded bytes are not retained or accepted as JSON.
If those bounds expire, it cancels without awaiting cancellation and returns
`Connection: close`. Bun 1.3.14 has been observed keeping that socket open and
reusing it despite the response header, so a rejected sender that does not finish
within the drain bounds must abandon its connection. Fresh health probes remain
isolated; this does not claim to repair Bun's native socket lifecycle. Regression
tests verify finite chunked uploads finish before rejection, stalled senders
receive bounded rejection, and subsequent ordinary pooled health
requests remain usable; raising limits or hiding failed responses is not recovery.

## Debugging Checklist

### Dependency artifacts versus candidate validation

By default, SCM keeps Bun's existing native artifact-cache/backend behavior,
including a warm global cache. Set `PUSHPALS_TRUSTED_ISOLATED_ARTIFACT_CACHE=1`
in the SCM process environment to opt into isolated artifact reuse. This mode
retains Bun's native package artifacts under the repository Git metadata
directory at `pushpals/dependencies/trusted-packages/<toolchain-key>`. Normal CLI
`--clear` preserves this existing dependency-cache boundary; `--clear
--include-caches` removes it. Native platform, architecture, and the selected
Bun executable distinguish cache namespaces. Explicit `BUN_INSTALL_CACHE_DIR`,
project/user/XDG `.npmrc` cache settings, or project/global Bun cache/backend
configuration keeps its existing behavior instead of being silently replaced.
Explicit `npm_config_cache`, `npm_config_userconfig`, or `npm_config_globalconfig`
environment overrides also disable this optional override (case-insensitively),
without assuming npm and Bun resolve them identically. Configuration inspection
rejects special files, symlinks, unreadable/oversized files, and unfamiliar npmrc
declarations conservatively; it never expands or logs credentials. Unavailable
cache directories disable the optional cache mode.

This cache is not a snapshot of a worker's or an earlier candidate's mutable
`node_modules`. New candidates still run `bun install --frozen-lockfile`, with
their lifecycle hooks enabled, before the unchanged validation sequence. The
scoped artifact path uses Bun's `copyfile` backend so an install hook patching a
dependency cannot modify the reusable package-cache inode. An exact-candidate
install marker is still distinct from a package artifact: only the former can
skip an already-completed install for the same inputs. Validation commands are
not cached. See Bun's [install and backend documentation](https://bun.sh/docs/pm/cli/install)
and [lifecycle-script contract](https://bun.sh/docs/pm/lifecycle).

A new cache can initially be colder than an existing global cache, and copying
has filesystem cost. The native regression proves offline artifact reuse and
candidate-hook isolation, not a production speedup or a sub-ten-minute SLO.
Compare warm/cold dependency-preparation timings separately from validation.

### Aggregate validation substeps

Trusted commands stream bounded `trustedValidationSubstep` events before the
aggregate exits. An optional generic adapter recognizes ordered output such as
`[build checks 1/3] [types/check] Type checks` followed by
`[ok] Type checks (123.4 ms)`. No repository-specific script names are assumed,
and scripts that do not emit this format simply retain command-level timings.
This does not split or reorder required aggregates.

Each event carries the job/completion/candidate IDs, redacted command, attempt,
ordinal, total, and generated `substep-N` ID. Raw labels/tokens/output are not
copied into these events. `durationMs` is the observed monotonic time between
markers; `reportedDurationMs` is the separate, untrusted duration printed by the
child. Missing completions retain `durationMs: null` and a fixed incomplete
reason, rather than implying a zero-duration success. Map ordinals to the
repository's ordered validation script to identify expensive stages.

The collector has fixed stage, line, and length caps, exposes truncation, and
starts fresh on each command attempt. Duplicate or nested/conflicting start
headers sharing a label leave that stage incomplete: a completion marker has
no reliable stage identity. A bounded private prefix identifies the first
aggregate; differently prefixed nested headers cannot consume its ordinals.
Unprefixed aggregates remain supported. This is conservative correlation, not
a parser for arbitrary nested protocols. Unrelated headers do not invalidate
already tracked labels. Ignored-header label history is also bounded; when it
fills, later new labels remain uncorrelated and the report exposes truncation.
A child's `[ok]` marker never proves that
the command passed, renews a health/claim deadline, or authorizes publication.
Observer failures do not affect gate results. Server validates and persists the
final observations in `job_validation_runs.metadataJson.substeps`, exposed in
job diagnostics; live observations are in the SCM service log.

SCM `/health` includes bounded, process-local `diagnostics`: event-loop delay and
slow `integration_maintenance`, `completion_claim`, and `completion_ref_gc`
operation samples. Sampling uses monotonic time, retains the last 16 slow events,
and emits at most one structured `runtimeDiagnostics` log per second. Healthy
probes do not erase recent slow evidence. The health route reads this history
without database or network calls. Slow I/O is not automatically event-loop
blocking, and these measurements do not weaken existing stall/restart decisions.

1. Confirm completion claim + check pass logs in SCM.
2. Confirm PR was created or reused in ReviewAgent mode.
3. Confirm ReviewAgent threshold and score log line.
4. If rejected, confirm fix job enqueue and session/task/job events.
5. If approved, confirm approval comment, merge result, and branch-delete log.

`--dry-run` is discovery-only, but the current loop still claims a Server
completion before skipping processing. It does not explicitly release that
claim; Server returns it to pending after lease expiry. Do not leave a dry-run
SCM polling against a live completion queue because it can repeatedly delay
real publication.

## Tradeoffs

Pros:

- centralized and auditable merge policy,
- deterministic threshold-driven review decisions,
- better iteration loop through PR feedback context and auto-fix requeue.

Cons:

- more moving parts (SCM + ReviewAgent + provider API),
- longer end-to-end latency in review/fix cycles,
- requires good token health and remote API reliability.
