# 08. SourceControlManager (`apps/source_control_manager`)

## Purpose

SourceControlManager (SCM) integrates worker completions into the integration branch and optionally creates pull requests.

It is intentionally separate from WorkerPals:

- WorkerPals executes and commits in job branches/refs.
- SCM owns integration policy and push/PR behavior.

## Key Files

- `apps/source_control_manager/src/source_control_manager_main.ts` - daemon bootstrap and completion loop.
- `apps/source_control_manager/src/config.ts` - SCM-specific runtime config.
- `apps/source_control_manager/src/git.ts` - git operation abstraction and branch handling.
- `apps/source_control_manager/src/runner.ts` - merge/check/requeue workflow.
- `apps/source_control_manager/src/db.ts` - local merge queue persistence and logs.
- `apps/source_control_manager/src/github_pr.ts` - PR open/reuse logic.

## Integration Pipeline

For each claimed completion:

1. Sync refs and ensure integration branch baseline.
2. Create temp integration branch.
3. Apply completion changes (strategy: `cherry-pick`, `no-ff`, or `ff-only`).
4. Run configured checks.
5. Fast-forward integration branch to validated temp head.
6. Push integration branch.
7. Optionally create/reuse PR.
8. Mark completion processed or failed.

## Merge Strategy Notes

- `cherry-pick`:
  - best when worker output should be applied as discrete commits.
- `no-ff`:
  - best when preserving merge topology is valuable.
- `ff-only`:
  - strictest linear-history mode, best for clean branch discipline.

Choose strategy based on repository governance, not personal preference.

## Why Separate SCM Exists

Separating integration from execution gives:

- centralized merge policy enforcement,
- deterministic handling of branch races/conflicts,
- one place for PR and integration branch automation.

## Recovery and Safety Features

- File lock to prevent dual SCM daemons.
- Persistent local DB for queue and run logs.
- Requeue logic on transient race conditions (e.g., branch advanced).
- Skip/fail policies after max attempts.
- Optional clean-repo guard.

## Debugging Checklist

1. Confirm completion was claimed from server queue.
2. Confirm remote refs were fetched and expected branch exists.
3. Confirm apply step result (merge/cherry-pick/ff-only).
4. Confirm check-command outcomes and retry state.
5. Confirm push and optional PR creation logs.

## Tradeoffs

Pros:

- integration logic is explicit and auditable,
- easier to reason about branch state transitions,
- safer than letting each worker push directly to integration.

Cons:

- additional moving part and service lifecycle,
- integration latency can grow under high completion volume,
- merge strategy complexity must stay well-tested.

## Future Improvements

- Add batched completion integration for burst throughput.
- Add policy-based check profiles by component area.
- Add automatic conflict diagnostics attached to failed completion events.
