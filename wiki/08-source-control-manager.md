# 08. SourceControlManager (`apps/source_control_manager`)

## Purpose

SourceControlManager (SCM) owns integration policy.

WorkerPals executes/commits; SCM decides how those commits become branch updates and PRs.

## Key Files

- `apps/source_control_manager/src/source_control_manager_main.ts` - daemon bootstrap and completion processing.
- `apps/source_control_manager/src/review_agent.ts` - ReviewAgent polling, scoring, merge/reject actions.
- `apps/source_control_manager/src/github_pr.ts` - GitHub API operations (PR list/diff/comments/merge/delete ref).
- `apps/source_control_manager/src/git.ts` - local git operations and integration branch handling.
- `apps/source_control_manager/src/db.ts` - local merge queue persistence/logs.

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
- SCM re-review auto-enqueue is capped at `500` attempts per PR.
- SCM reuses existing PR on subsequent iterations (no duplicate PR creation for re-review).

### 2) Direct Integration Mode (`review_agent.enabled=false`)

SCM fast-forwards validated temp branch into integration branch (`main_agents` by default), pushes, and optionally opens/reuses a PR from integration to base.

## ReviewAgent Decision Policy (Important)

ReviewAgent uses score-only gating:

- approve: `critic.score >= pass_threshold`
- reject: `critic.score < pass_threshold`

The LLM may provide other fields, but merge/reject policy is controlled by threshold comparison in SCM.

## Git Backend and Auth Resolution

SCM token resolution is centralized via shared git backend logic (`packages/shared/src/git_backend.ts`):

- backend inference: GitHub / GitLab / unknown by remote URL,
- token source precedence: configured token -> env token -> provider CLI token (`gh`/`glab`) -> none.

This keeps provider-specific auth behavior in one place and reduces duplicated auth patches.

## PR Metadata and Traceability

- SCM records the processed PR URL when marking completions processed (`/completions/:id/processed` with `prUrl`).
- SCM emits pusher/status messages with created/reused PR URLs for operator visibility.
- ReviewAgent fix jobs carry structured `reviewAgent` metadata (`prNumber`, `prUrl`, `prHeadRef`, previous score/summary, etc.).

## Recovery and Safety Features

- process lock prevents dual SCM daemons on one state directory,
- clean-repo guard (optional skip in dev),
- retry/backoff on transient failures,
- bounded review diff size,
- overlap-safe poll loop (skips concurrent poll tick overlap),
- protected branch safeguards for post-merge deletion.

## Debugging Checklist

1. Confirm completion claim + check pass logs in SCM.
2. Confirm PR was created or reused in ReviewAgent mode.
3. Confirm ReviewAgent threshold and score log line.
4. If rejected, confirm fix job enqueue and session/task/job events.
5. If approved, confirm approval comment, merge result, and branch-delete log.

## Tradeoffs

Pros:

- centralized and auditable merge policy,
- deterministic threshold-driven review decisions,
- better iteration loop through PR feedback context and auto-fix requeue.

Cons:

- more moving parts (SCM + ReviewAgent + provider API),
- longer end-to-end latency in review/fix cycles,
- requires good token health and remote API reliability.
