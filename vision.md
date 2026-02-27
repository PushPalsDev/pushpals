# Vision

> **One sentence:** What does this repo exist to make true in the world?
>
> Make it easy for engineering teams to ship high-quality software faster by delegating routine development work to safe, auditable autonomous agents.

---

## 1) Who this is for

### Primary users
- **Engineering leads and maintainers**
  - Jobs-to-be-done: Keep delivery moving, keep repo quality high, and reduce coordination overhead.
  - Pain today: Too much manual triage, repetitive fixes, and PR churn.
  - Success looks like: Predictable throughput, fewer regressions, and clear operational visibility.

### Secondary users
- **Contributors and reviewers**
  - Jobs-to-be-done: Implement scoped changes quickly and review with confidence.
  - Pain today: Slow setup, unclear guardrails, and inconsistent change quality.
  - Success looks like: Fast local startup, clear policies, and cleaner PRs.

### Non-users (explicitly *not* optimizing for)
- **Not for:** Teams looking for a generic no-code automation platform.
  - Why: PushPals is optimized for code-repo workflows, Git-based collaboration, and engineering governance.

> **Guidance:** Keep this section concrete. If you cannot name the user and their job, you will argue about priorities forever.

---

## 2) The problem we solve

### Today's reality
- Shipping code still requires too much manual orchestration across planning, execution, review, and merge.
- Repeated failures happen around flaky startup paths, merge conflicts, retries, and environment drift.
- Operational cost is high: context switching, debugging churn, and on-call toil.

### The change we want
- In 6-12 months, routine repo work (small fixes, conflict resolution, review follow-ups) should be mostly autonomous with strong safety boundaries.
- In 2-3 years, autonomous execution should be a trusted default path for a large share of low-risk engineering work.

> **Optional:** Add a 3-5 line "story" of a user before vs after.

---

## 3) Product principles (decision rules)

These are **tie-breakers** when tradeoffs happen. Put them in priority order.

1. **Safe by default**
   - We will: Enforce explicit write scope, validation, and policy checks.
   - We won't: Trade away safety for short-term throughput.
2. **Operational clarity over magic**
   - We will: Expose clear logs, IDs, status, and failure reasons across client surfaces.
   - We won't: Hide failure modes behind opaque "AI did something" behavior.
3. **Reliable incremental progress**
   - We will: Prefer small, reversible, testable changes over broad rewrites.
   - We won't: Merge large speculative edits without measurable acceptance criteria.

> **Guidance:** A principle is only useful if it can help you say "no" to a PR.

---

## 4) What "good" looks like (measures)

Pick a small set of metrics you can actually track.

### User-facing outcomes
- **Time-to-success:** Median time from `bun run start -c` to stable "all systems online".
- **Quality:** Rework rate on autonomous PRs (rejections, fix loops, post-merge defects).
- **Trust:** Approved-and-merged rate for autonomous PRs with no manual intervention.

### Developer / maintainer outcomes
- **Change velocity:** Median cycle time from request enqueue to merged PR.
- **Operational burden:** Incidents/pages related to queue health, worker reliability, and startup failures.
- **Maintainability:** Flake rate in critical tests and policy compliance pass rate.

> **Guidance:** Avoid vanity metrics. Prefer "time, errors, incidents, support load, cost".

---

## 5) Scope and boundaries

### In scope (what we *are*)
- Autonomous orchestration for planning, worker execution, and source-control integration.
- Guardrailed task execution in scoped worktrees/containers.
- Unified client interface for visibility across web/CLI/VS Code (and future mobile).

### Out of scope / non-goals (what we are *not*)
- Not a replacement for engineering judgment on high-risk architecture decisions.
- Not trying to automate every class of software work without constraints.
- Not optimizing for non-Git or non-repo-centered workflows.

### Compatibility & support policy (optional)
- Supported platforms / versions: Bun-first workflow across local Windows/Linux/macOS development.
- Breaking changes policy: Prefer backward-compatible config changes; gate incompatible behavior behind explicit migration.
- Deprecation timeline: Remove legacy paths only after docs and migration guidance are in place.

> **Guidance:** This section prevents "just one more feature" creep.

---

## 6) Current priorities (next 4-8 weeks)

Pick 3-5 items max. Each should be **outcome-oriented**.

1. **Priority:** Startup and environment stability
   - Why now: Repeated startup failures reduce confidence and velocity.
   - Success criteria: Deterministic preflight outcomes with actionable failure messages.
   - Owner / area: Runtime + startup scripts
2. **Priority:** Worker reliability under conflict/retry scenarios
   - Why now: Merge-conflict and retry loops create avoidable churn.
   - Success criteria: Higher completion rate for conflict-resolution jobs and fewer duplicate executions.
   - Owner / area: WorkerPals + SCM integration
3. **Priority:** Policy and prompt governance
   - Why now: Consistency and compliance are required for safe autonomy.
   - Success criteria: Prompt policy tests stay green and violations fail fast.
   - Owner / area: Shared prompts + executor backends
4. **Priority:** Unified observability in client surfaces
   - Why now: Operators need fast diagnosis without digging through raw logs.
   - Success criteria: Clear per-job IDs, worker IDs, and queue/task state visibility.
   - Owner / area: Client + server event model

> **Tip:** If everything is a priority, nothing is.

---

## 7) Near-term objectives (1-2 quarters)

These are "bets" with explicit results.

### Objective A: Reliable autonomous delivery loop
- **Problem:** Autonomous jobs still fail from environment drift, policy mismatches, and lifecycle race conditions.
- **Approach:** Harden preflight, tighten executor policy handling, and standardize worktree cleanup/recovery.
- **Deliverables:** Stable startup pipeline, stronger failure classification, and auto-recovery playbooks.
- **Risks:** Over-constraining automation could reduce useful throughput.
- **Exit criteria:** Significant drop in failed autonomous jobs caused by infra/runtime issues.

### Objective B: High-confidence review and merge automation
- **Problem:** Approved work can still stall on mergeability and repeated review cycles.
- **Approach:** Improve dedupe/locking, conflict handling workflows, and review-agent coordination.
- **Deliverables:** Deterministic dedupe keys, conflict-specific execution paths, and clearer merge telemetry.
- **Risks:** Extra control logic can add complexity if not measured and simplified.
- **Exit criteria:** Higher approved-to-merged conversion with lower manual conflict intervention.

---

## 8) Long-term direction (1-3 years)

Describe where this repo is going, without over-promising.

### Strategic bets
- **Bet 1:** Autonomous-first software maintenance for scoped, low-risk work
  - Why it matters: Most engineering time is spent on repetitive, bounded tasks.
  - What we'll likely build: Stronger objective generation, policy engines, and automated remediation loops.
  - What we likely won't build: Unbounded fully autonomous architecture redesign without human direction.
- **Bet 2:** Cross-client operational control plane
  - Why it matters: Operators need one coherent source of truth.
  - What we'll likely build: Unified event/state model shared by web, CLI, VS Code, and mobile clients.
  - What we likely won't build: Divergent per-client logic that forks behavior and meaning.

### "If we're right, then..."
- Users will be able to: Route and complete more engineering work autonomously with clear guardrails.
- Maintainers will spend less time on: Manual retries, conflict babysitting, and startup/debug toil.
- The ecosystem will have: A practical reference implementation for safe autonomous repo operations.

---

## 9) Guardrails and constraints

### Guardrails (how we avoid harm / churn)
- Prefer changes that are **reversible** or behind flags.
- Default to **secure / safe** settings.
- Optimize for the **common path**; support escape hatches for experts.
- Avoid adding new dependencies unless they reduce net complexity.
- Pay down operational toil before adding big surface area.

### Constraints (reality checks)
- Staffing level / maintainer bandwidth: Small team; automation must reduce, not increase, operator load.
- Hard requirements (privacy, compliance, perf, cost): Strong repo safety boundaries and predictable runtime behavior.
- External dependencies: Bun runtime, Docker for worker sandboxing, Git provider auth, and Codex backend availability.

---

## 10) How decisions get made (governance-lite)

- **Source of truth:** issues + RFCs + docs in `docs/`
- **When we require an RFC:** breaking changes, new public APIs, major deps, new architecture
- **Review expectations:** tests required for critical paths, docs for user-facing behavior
- **Release cadence:** Continuous integration on `main_agents` with frequent incremental merges
- **What we won't merge:** (examples)
  - large rewrites without an incremental plan
  - behavior changes without migration guidance
  - features that expand scope beyond the non-goals

---

## Appendix (optional but powerful)

### A) Glossary
- RemoteBuddy: Orchestrator that plans and dispatches work.
- WorkerPals: Execution agents that implement scoped tasks.
- SourceControlManager: Service that applies completions and manages PR lifecycle.
- ReviewAgent: Automated reviewer that scores and gates PR progression.

### B) Personas (one-page each)
- Engineering lead, on-call operator, and contributor personas with constraints and success criteria live in operational docs.

### C) Example "no" responses (template)
- "Thanks - this is valuable, but it conflicts with our non-goal around unbounded autonomous scope."
- "We'd reconsider if the measured incident or throughput metrics show this is now a top blocker."
