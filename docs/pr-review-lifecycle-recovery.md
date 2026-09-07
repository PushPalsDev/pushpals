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
