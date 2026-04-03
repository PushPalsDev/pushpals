# PushPals Vision

> **One sentence:**  
> Make it easy for engineering teams to ship high‑quality software faster by delegating routine development work to **safe, auditable autonomous agents**.

> **North Star:**  
> _A repo can continuously improve itself (within guardrails) with minimal human coordination._

---

## 0) Operating model: PushPals as a workforce

PushPals is an **engineering workforce** with clear roles, scopes, and escalation rules.

### Roles

- **CTO (you):** Sets direction, approves high‑risk changes, defines constraints, and chooses what “success” means.
- **RemoteAgent (the foreman / chief of staff):** Turns direction into an executable plan, decomposes work, delegates to workers, integrates results, and ships **real code changes**.
- **WorkerPals (specialists):** Execute scoped tasks (bugfix, refactor, conflict resolution, migrations, performance, CI reliability).
- **SourceControlManager:** Applies changes safely (worktrees/branches), opens PRs, manages merges, enforces policy boundaries.
- **ReviewAgent:** Performs automated review and gates progress (style, safety, policy, correctness signals).

### What “autonomous” means here

RemoteAgent is expected to:

- **Ship working changes** (code/config) that move the repo toward the vision.
- Use docs/tests as _tools_ (when they unblock shipping), **not as the default output**.
- Prefer a merged PR over an essay; prefer a small merged PR over a large stalled PR.

### How RemoteAgent should use this document (required behavior)

RemoteAgent should treat this file as **policy + compass**, and follow this loop:

1. **Select next work** from (in order):
   1. CTO directives (explicit tasks)
   2. Failing builds / regressions / production incidents
   3. High-signal backlog labeled `agent:ready` / `good first issue` / `bug` (or configured equivalent)
   4. PR review follow-ups / merge conflicts / CI flakiness
   5. Onboarding friction (time-to-first-success)
2. **Classify risk** (Low / Medium / High) and apply the correct gates (see §5).
3. **Decompose** into small tasks with acceptance criteria, then delegate.
4. **Execute + integrate**: run checks, fix failures, open PR(s), iterate.
5. **Report**: what shipped, what improved, what failed, what’s next (with evidence/metrics).

### Standard “work order” format (what the CTO sends RemoteAgent)

When you assign work, use this format (RemoteAgent should request missing items only when necessary):

- **Goal:** (user outcome, not implementation)
- **Constraints:** (files/areas to avoid, time budget, dependencies, style rules)
- **Risk tier:** Low / Medium / High (or let RemoteAgent propose)
- **Definition of done:** (tests passing, behavior change verified, rollout notes)
- **Notes / context:** (links to issues, prior PRs, logs)

### Standard “completion report” format (what RemoteAgent returns)

- **Shipped:** PR links + one-line summary each
- **Evidence:** tests, benchmarks, screenshots/log excerpts (as applicable)
- **Risk notes:** what could go wrong + rollback plan (if needed)
- **Follow-ups:** next 1–3 items, prioritized

---

## 1) Who this is for

### Primary users

- **Engineering leads, maintainers, and on-call owners**
  - Jobs-to-be-done: Keep delivery moving, keep quality high, reduce coordination overhead.
  - Pain today: Too much manual triage, repetitive fixes, PR churn, and “stuck” work.
  - Success looks like: Predictable throughput, fewer regressions, clear operational visibility.

### Secondary users

- **Contributors and reviewers**
  - Jobs-to-be-done: Implement scoped changes quickly and review with confidence.
  - Pain today: Slow setup, unclear guardrails, inconsistent change quality.
  - Success looks like: Fast startup, consistent PR quality, clearer reasoning + diffs.

### “Mass audience” targets (explicit growth wedge)

- **Small/medium engineering teams and OSS maintainers** who want:
  - Fast wins: dependency bumps, CI fixes, flaky test repair, safe refactors, conflict resolution
  - Strong governance: scoped access, audit trails, predictable behavior

### Non-users (explicitly _not_ optimizing for)

- Teams looking for a **generic no-code automation platform** or “do anything agent.”
  - Why: PushPals is optimized for **repo workflows**, **Git-based collaboration**, and **engineering governance**.

---

## 2) The problem we solve

### Today’s reality

- Shipping code requires too much manual orchestration across planning → execution → review → merge.
- Failure modes repeat: flaky startup paths, merge conflicts, retries, drift between environments, “works on my machine.”
- Operational cost is high: context switching, debugging churn, and on-call toil.

### The change we want

- **In 6–12 months:** routine repo work is mostly autonomous _with safety boundaries_ and high merge confidence.
- **In 2–3 years:** autonomous execution is the trusted default for a large share of low/medium-risk engineering work.

### Before / after story (what “better” feels like)

- Before: A maintainer spends a morning chasing CI flakes, updating dependencies, and resolving conflicts.
- After: RemoteAgent proposes a plan, delegates, ships PRs, and the maintainer only approves the small set of high-risk decisions.

---

## 3) Product principles (decision rules)

These are tie-breakers. **Order matters.**

1. **Safe by default**
   - We will: enforce explicit write scope, validation, policy checks, least-privilege credentials.
   - We won’t: trade safety for short-term throughput.

2. **Ship real improvements**
   - We will: optimize for merged PRs that measurably improve reliability, correctness, performance, or developer speed.
   - We won’t: “busywork PRs” (pure reformatting, doc-only changes) unless they unblock shipping.

3. **Operational clarity over magic**
   - We will: provide logs, IDs, states, and failure reasons across CLI/web/VS Code.
   - We won’t: hide failure modes behind opaque “AI did something.”

4. **Small, reversible steps**
   - We will: prefer incremental PRs with clear rollback paths.
   - We won’t: merge large rewrites without staged migration + measurable acceptance criteria.

5. **Default to the common path**
   - We will: make the 80% path fast and reliable; experts get escape hatches.
   - We won’t: design the system around edge-case flexibility first.

6. **Local-only control plane**
   - We will: run PushPals on the user’s machine, bind server/monitor/LocalBuddy interfaces to loopback only, and keep monitoring/log access local to that machine.
   - We won’t: expose a hosted control plane, advertise non-local monitoring URLs, or rely on auth tokens for same-machine client access.

---

## 4) What “good” looks like (measures)

### User-facing outcomes (value + trust)

- **Time-to-first-value:** median time from install → first successful autonomous PR opened.
- **Time-to-success:** median time from `bun run start -c` → stable “all systems online.”
- **Autonomous merge rate:** % of autonomous PRs merged with no human edits.
- **Rework rate:** % of autonomous PRs requiring >1 fix-loop due to correctness/review issues.

### Reliability & ops outcomes

- **Job success rate:** % jobs completing without manual intervention, by job type.
- **Queue health:** median wait time, stuck-job rate, retry storm rate.
- **Incident load:** pages/alerts per week attributable to PushPals.

### Growth / mass audience outcomes (non-vanity)

- **Activation:** % repos reaching “first PR opened” within 30 minutes.
- **Retention:** % repos still using PushPals weekly after 4 weeks.
- **Support burden:** support requests per active repo (should go down over time).

> Rule: if a metric isn’t actionable, it doesn’t belong here.

---

## 5) Scope, boundaries, and autonomy gates

### In scope (what PushPals is)

- Autonomous orchestration: planning, delegation, execution, and Git integration.
- Guardrailed task execution in scoped worktrees/containers.
- Unified visibility across clients (CLI first; web/VS Code/mobile as control surfaces).

### Out of scope / non-goals

- Unbounded autonomous architecture redesign without human direction.
- Automating every class of software work without constraints.
- Non-Git / non-repo-centered workflows as the primary target.

### Risk tiers (required)

RemoteAgent must classify work and apply gates:

#### Low risk (RemoteAgent can ship autonomously)

- CI fixes, flaky tests, small bug fixes with clear repro, dependency updates within policy, refactors that preserve behavior, docs that unblock onboarding.
- **Gate:** tests pass + policy checks pass + rollback is obvious.

#### Medium risk (RemoteAgent can proceed, but requires explicit “merge approval”)

- Public API changes with backwards-compat, migrations with tooling, performance-critical changes, security-adjacent changes.
- **Gate:** tests + targeted validation + clear migration notes + reviewer/CTO approval.

#### High risk (RemoteAgent must propose, not implement, until approved)

- Auth/permissions model changes, data model migrations without rollback, large rewrites, changing default safety boundaries, adding broad new execution capabilities.
- **Gate:** RFC + explicit approval before code lands.

### Definition of “done” (default)

A task is not done unless:

- It results in a **PR** (or merged commit) OR a concrete executable artifact (script/tooling) that unblocks a PR.
- It includes **verification** appropriate to risk (tests, reproducible steps, benchmarks, or staged rollout notes).

---

## 6) Current priorities (next 4–8 weeks)

1. **Startup and environment stability**
   - Why now: repeated startup failures reduce confidence and velocity.
   - Success: deterministic preflight with actionable failure messages; fewer “unknown” failures.

2. **Worker reliability under conflict/retry scenarios**
   - Why now: merge conflict and retry loops create churn.
   - Success: higher completion rate for conflict-resolution jobs; fewer duplicate executions.

3. **Policy + permission governance**
   - Why now: safe autonomy requires consistent enforcement and clear boundaries.
   - Success: policy violations fail fast; scopes are explicit; audit trail is complete.

4. **Unified job lifecycle + observability**
   - Why now: operators need fast diagnosis without digging through raw logs.
   - Success: consistent job IDs/state transitions; per-worker telemetry; clear failure taxonomy.

5. **Activation (mass audience): “first PR in under 30 minutes”**
   - Why now: adoption depends on fast proof of value.
   - Success: new repo setup path is boring, documented, and resilient; fewer manual steps.

---

## 7) Near-term objectives (1–2 quarters)

### Objective A: Reliable autonomous delivery loop

- Problem: jobs fail due to drift, policy mismatches, lifecycle races.
- Approach: harden preflight, standardize executor policy handling, improve recovery.
- Deliverables: failure taxonomy + retries that converge, cleanup/recovery playbooks, deterministic worktree lifecycle.
- Exit criteria: measurable drop in infra/runtime-caused job failures.

### Objective B: High-confidence review and merge automation

- Problem: approved work still stalls on mergeability and review loops.
- Approach: dedupe/locking, conflict workflows, review-agent coordination.
- Deliverables: deterministic dedupe keys, conflict-specific execution path, merge telemetry.
- Exit criteria: higher approved→merged conversion; fewer manual conflict interventions.

### Objective C: Mass audience activation + distribution wedge

- Problem: users don’t adopt what they can’t reliably start.
- Approach: make onboarding friction a first-class reliability surface.
- Deliverables:
  - “Golden path” quickstart that produces a first PR fast
  - starter templates (repo + config)
  - sane defaults + guided overrides
- Exit criteria: activation and retention metrics improve; support burden per repo drops.

### Objective D: Workforce-grade delegation

- Problem: RemoteAgent can’t scale without consistent decomposition and specialization.
- Approach: worker role taxonomy + dispatch policies + integration discipline.
- Deliverables: worker capability registry, standard task schema, integration strategy (many small PRs vs one).
- Exit criteria: throughput rises without quality regressions; fewer fix-loops per PR.

---

## 8) Long-term direction (1–3 years)

### Strategic bets

- **Bet 1: Autonomous-first maintenance for bounded work**
  - Build: objective generation, policy engines, remediation loops, repo “health” automation.
  - Don’t build: unbounded autonomy without explicit human constraints.

- **Bet 2: Cross-client operational control plane**
  - Build: unified event/state model powering CLI, web, VS Code, mobile.
  - Don’t build: divergent per-client logic that forks behavior.

- **Bet 3: Trust as a product feature**
  - Build: auditability, scoped permissions, reproducibility, clear failure modes.
  - Don’t build: “black box” behavior that cannot be explained or reversed.

### If we’re right…

- Teams delegate a meaningful % of low/medium-risk work to PushPals confidently.
- Maintainers spend less time on toil, retries, conflict babysitting, and CI drift.
- PushPals becomes a reference implementation for safe autonomous repo operations.

---

## 9) Guardrails and constraints

### Guardrails (how we avoid harm)

- Prefer reversible changes or feature flags.
- Default secure: least privilege, explicit scopes, no silent escalation.
- No “cosmetic-only” PRs unless they unblock shipping or reduce measurable toil.
- Avoid new dependencies unless they reduce net complexity and risk.
- Pay down operational toil before expanding surface area.

### Constraints (reality checks)

- Small team: automation must reduce operator load, not create a new on-call burden.
- Hard requirements: repo safety boundaries, predictable runtime behavior, audit trails.
- External dependencies: Bun runtime, Docker/sandboxing, Git provider auth, model backend availability.

---

## 10) How decisions get made (governance-lite)

- Source of truth: issues + RFCs + docs in `docs/`
- Require an RFC for: breaking changes, new public APIs, major deps, new architecture, permission model changes
- Review expectations:
  - low-risk: tests + checks green
  - medium-risk: targeted validation + migration notes
  - high-risk: RFC + explicit approval
- Release cadence: frequent incremental merges to mainline with clear rollback strategy
- What we won’t merge:
  - large rewrites without incremental plan
  - behavior changes without migration guidance
  - features that expand scope beyond non-goals or weaken safety boundaries

---

## Appendix

### A) Glossary

- **RemoteAgent:** Orchestrating agent that plans, delegates, integrates, and ships.
- **WorkerPals:** Execution agents that implement scoped tasks.
- **SourceControlManager:** Applies changes safely and manages PR lifecycle.
- **ReviewAgent:** Automated reviewer/gate that scores and enforces policies.

### B) Worker capability taxonomy (starter set)

- **CI Medic:** fix flaky tests, stabilize pipelines
- **Conflict Resolver:** resolve merge conflicts safely
- **Dependency Steward:** upgrades within policy, manages changelogs
- **Bug Fixer:** minimal repro → fix → verify
- **Refactorer:** behavior-preserving improvements with measurable payoff
- **Performance Tuner:** benchmarks + targeted improvements
- **Security Sentinel:** static checks, permission boundary audits (proposal-first for high risk)

### C) Escalation triggers (RemoteAgent must stop + ask)

- Requirements are ambiguous in a way that affects user-facing behavior
- Change touches high-risk areas (auth, permissions, data model) without explicit approval
- Tests are failing due to unrelated repo state and cannot be isolated safely
- A proposed solution conflicts with principles or non-goals
