# Durable PR review recovery

SourceControlManager records review decisions in the `review_decisions` table of
its existing `merge_queue.db`. The key includes repository, PR number, exact head
and base, model/launcher, review threshold, reviewer instructions, merge policy,
comment cap, and the PR title/body supplied to the reviewer.
Repository identities are credential-free and shared across HTTPS and SSH remote
spellings, so changing transport does not reset a verdict or its repair count.

A parsed verdict is saved before comments, repair dispatch, or merge. After a
restart or transient admission failure, the same evidence resumes the same
verdict; an unchanged rejected patch is not scored repeatedly until it passes.
An explicit re-review request does not discard a finalized exact decision. New
head/base or review inputs are independently eligible. Repair enqueue counters
also survive process restarts.

Before reviewing or merging, SCM checks the server's bounded, read-only
`GET /jobs/review-repair-lifecycle` endpoint using the repository, PR number,
head, and base. Active repair ownership applies across base movements for the
same head. Exhausted/succeeded records apply only to the exact head/base.
This also protects work created before the local review journal existed.
The route uses the server's existing authentication check.

Database upgrades add the repository-identity column before its lookup index.
Legacy identities are backfilled only from unambiguous persisted PR URLs matching
the recorded PR number. Historical terminal tuples remain denial-only evidence;
the migration does not mint repair capabilities or reset exhausted attempts.

Pending, claimed, and finalizing repair jobs block competing review/merge work.
Finalizing includes trusted validation and publication, not just worker coding.
Unavailable or malformed authority responses and journal failures fail closed.
The review/provider lanes remain separate so blocked AI review does not prevent
closed-PR outcome reconciliation.

Rejected revisions awaiting repairs remain eligible for lifecycle checks using
their retained verdict. Exhausted repair admission closes the rejected PR through
the existing give-up workflow instead of rescoring it or repeatedly enqueueing
work. Provider head/base and review inputs are checked immediately before closure
and repair dispatch. Merges additionally send GitHub the exact reviewed head SHA,
so an unreviewed concurrent head cannot be merged.

## Target-branch movement is publication coordination

The PR provider's reported comparison base is not assumed to be the current
target-branch tip. ReviewAgent resolves the exact target branch separately before
building its review, journal, and repair-lifecycle snapshot. It repeats that
authority check before side effects. Missing or malformed branch authority defers
the review; it never falls back to the historical PR base.

An in-flight review repair retains its immutable worker candidate when the target
branch advances. SourceControlManager reconciles that candidate with the fresh
target base in its disposable host worktree, then validates the resulting exact
SHA. A prior validation pass is not proof for a newly reconciled tree. Publication
still requires the original PR to remain open, its leased head to remain current,
and the exact expected-head force-with-lease.

For a reconciled candidate, validation includes the full original worker plan,
including checks that passed before reconciliation, plus deferred commands. The
server snapshots complete worker validation evidence independently of later SCM
diagnostics. Partial uploads do not establish a complete plan, and the host never
truncates an oversized plan into a passing subset. Missing evidence gets a bounded
claim retry for the diagnostics-upload race; persistently missing or invalid
evidence holds the retained candidate as `publication_validation_unavailable`
instead of publishing unchecked changes or blocking the queue indefinitely.

Base movement during validation defers the same completion for fenced claim
recovery, instead of cloning the coding task with its obsolete base. Immutable
checkpoints survive restarts. Each claim performs bounded work, and ordinary
branch movement does not spend another code-quality repair attempt or close the
PR. Real content conflicts become `publish_blocked` with a retained candidate and
a `held` lifecycle keyed to the observed conflict base. They leave the active
completion queue so unrelated publication can proceed. Unchanged held work is
neither regenerated nor automatically closed; it needs explicit resolution or a
changed head/base. The original repair capability is not rewritten to invent new
authority. Conflicts are never resolved by dropping changes or bypassing checks.

A closed PR or a replaced head can settle an obsolete repair as `abandoned` with
`publication_superseded`, without exhausting code-quality retries. These typed
outcomes use the existing fenced completion callback and the original durable
repair owner. Stale owners and mismatched publication tuples cannot settle newer
work. A repair never creates a replacement PR when the original is closed.

Successful trusted-host validation remains successful evidence even if a later
publication step fails. Terminal classification uses the actual candidate's
latest command results, not the mere presence of configured trusted commands.
Baseline probes and earlier failures recovered by a passing retry do not turn a
later publication problem into a test failure.

Approved but unmergeable revisions are also nonterminal while conflict recovery
is dispatched, deduplicated, circuit-blocked, or waiting for publication to settle.
A successful enqueue is not a successful merge. After a restart these revisions
resume lifecycle checks with their retained verdict, so repair exhaustion can be
reconciled and expired settle windows cannot permanently suppress recovery.

Regression coverage lives in `tests/source-control-manager.review-journal.test.ts`,
the server repair-scheduling and HTTP-route suites, and the GitHub PR adapter
tests. It includes real SQLite close/reopen, pre-journal exhausted work, publication
ownership, policy changes during review, stale-head closure prevention, transient
admission recovery, and malformed/unavailable authority responses.
Conflict-repair cases cover pending/claimed/finalizing ownership, deduplicated
admission, settle-window expiry, exhausted recovery, and new-head review after
publication, including SQLite close/reopen between polls.
