# v1.2.60 worker quality and speed review

## Evidence and limits

Read-only snapshot of the external repository's September 29 run, from startup at
05:33 UTC through 08:26 UTC: CLI attachment, live service logs, and SQLite job,
validation, and Repository Agent records. No external repository, database, or
installed runtime was modified. These are observations, not a soak-test guarantee.

## Outcomes

- Ten jobs dispatched: nine completed and one failed. PRs #790 through #798 were
  approved on their first PR review and merged. Worker-side revisions still occurred
  on three jobs; first-pass PR approval is not first-pass worker success.
- The failed job declined to change onboarding copy because the proposed victory
  description contradicted the implemented game mode. No publishable patch was
  produced. Refusing the unsupported edit was correct; it remains a failed job,
  not a successful implementation.
- Completed jobs took approximately 10.7–31.8 minutes, averaging 15.8 minutes.
  The longest included an ambiguous local database-reset failure and retained
  publication recovery. Another trusted validation recovered on one allowed retry
  after an explicit test-hook timeout.
- Successful trusted aggregate validation averaged about five minutes. Unit tests,
  database integration, and browser smoke accounted for approximately 78% of it.
  Warm candidate dependency preparation was already only 0.31–0.45 seconds;
  the first cold install took 107.8 seconds. Required final checks must not be
  skipped to meet a speed target.
- Final PR review took 8.4–36.4 seconds. Historical empty-diff PR rechecks consumed
  only about three seconds total and made no model calls; they are not a priority.
- The pasted health-probe stalls recovered without restart. They do not establish
  crashes or a deadlock, nor do they establish uninterrupted availability.

## Avoidable work addressed

1. A lint-only change received two ScopeGate revisions despite critic scores above
   nine because conditional "update tests or documentation ... if ... changes"
   guidance was treated as mandatory test authoring. Scope intent now distinguishes
   conditional maintenance from explicit test targets and required test-edit clauses,
   including formatted lists. Validation and critic authority are unchanged.
2. Discovery performed 138 analyses in the sampled log: 121 returned empty results.
   Of 37 cache hits, 32 redelivered an excluded candidate. Any exclusion-set change
   previously cleared deferrals and could rewind earlier windows, even when all old
   exclusions remained. Durable, fingerprint-bound path metadata now preserves
   deferrals under additions; removal, legacy state, or malformed metadata still
   replays conservatively. This does not prove every repeated page was avoidable.
3. Trusted validation could retry a real assertion/compiler/lint failure because
   an unrelated test title mentioned a network failure. Concrete deterministic
   diagnostics now veto the retry; test titles alone cannot justify it. Known
   infrastructure failures retain one bounded retry. Exit code, failure class,
   and failed-test count are emitted without raw child diagnostics.
4. The preceding release's npm publication was accepted before public metadata
   became installable. A bounded registry-availability gate now runs ahead of
   installed-release smoke tests, not a repeated publication or skipped smoke.

## Quality and prioritization limits

Most dispatched work covered shell polish, documentation, tooling, and robustness.
None directly advanced the first two vision priorities in this snapshot. Early
Repository Agent packets did include those areas, but the model reported insufficient
evidence of a specific missing behavior or defect. Do not manufacture speculative
jobs to make the queue look busy. More grounded rendered interaction evidence is a
future opportunity; exclusion progress alone does not solve product prioritization.

The required final validation sequence, publication backpressure, exact-candidate
checks, and ambiguous-failure recovery policy remain intact. No domain-specific
paths, test names, gameplay rules, or commands are added to PushPals behavior.
## Validation

- Root suite: 3,115 passed, 12 platform/opt-in skips, zero failures (338.20 seconds).
- WorkerPals, RemoteBuddy, and SCM TypeScript checks passed. The new registry helper
  and its tests also passed standalone strict typechecking.
- Final release-helper/workflow/installed-smoke contracts: 39 passed, zero failures.
- Full CLI bundle and npm payload verification passed: 278 files, no vendored
  external toolchains. Generated sandbox and runtime fallback assets were refreshed.
- Tests ran serially in an owned Docker fixture limited to one CPU, 768 MiB memory,
  and 512 PIDs. An initial lease test failure was traced to duplicate shared-module
  identity in the fixture's dependency links; fixing the fixture resolved it without
  changing the production lease logic.
- The optional live registry check from that container could not establish TLS
  trust under the local managed CA; it was stopped without bypassing TLS validation.
  Windows' trusted certificate store confirmed the exact public metadata shape.
  Published Linux and Windows CI smokes must exercise the live availability gate.

Cross-platform CI and final publication results are recorded in `release_log.md`.
