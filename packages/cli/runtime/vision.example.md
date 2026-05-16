# Vision

> **One sentence:** What does this repo exist to make true in the world?
>
> Example: Make it easy for developers to ship `<X>` reliably without needing deep expertise in `<Y>`.

---

## 1) Who this is for

### Primary users

- **User type A:** Who depends on this repo most?
  - Jobs-to-be-done: What are they trying to accomplish?
  - Pain today: What is slow, confusing, risky, or broken?
  - Success looks like: What should be easier or more trustworthy?

### Secondary users

- **User type B:** Who benefits indirectly?
  - Jobs-to-be-done: ...
  - Pain today: ...
  - Success looks like: ...

### Non-users

- **Not for:** Who or what are we explicitly not optimizing for?
  - Why: ...

---

## 2) The problem we solve

### Today's reality

- What repeatedly fails, confuses users, wastes time, or creates operational risk?
- What is expensive in time, money, cognitive load, or coordination?
- Which current limitations block the repo from delivering its core value?

### The change we want

- In the next few months, what should become meaningfully easier?
- In the longer term, what should be obviously different because this repo succeeds?

---

## 3) Product principles

Put these in priority order. They should help say "no" to tempting but wrong work.

1. **Principle 1:** e.g. Safe by default.
   - We will: ...
   - We will not: ...
2. **Principle 2:** e.g. Make the common path fast.
   - We will: ...
   - We will not: ...
3. **Principle 3:** e.g. Prefer maintainable, reversible changes.
   - We will: ...
   - We will not: ...

---

## 4) What good looks like

### User-facing outcomes

- Users can complete the core workflow with less time, confusion, or failure.
- The most important behavior is observable and trustworthy.
- Regressions in the core path are caught before they reach users.

### Product quality measures

- Reliability: ...
- Performance: ...
- Validation coverage: ...
- Maintainability: ...

---

## 5) Scope and boundaries

### In scope

- Core capability A: ...
- Core capability B: ...
- Core capability C: ...

### Out of scope / non-goals

- Not trying to support: ...
- Not optimizing for: ...
- Not a replacement for: ...

---

## 6) Current priorities

Pick 3-7 outcome-oriented priorities. Put the most important first; PushPals uses this order.

1. **Priority 1 title**
   - Why now: ...
   - Success criteria: ...
   - Expected validation: ...
2. **Priority 2 title**
   - Why now: ...
   - Success criteria: ...
   - Expected validation: ...
3. **Priority 3 title**
   - Why now: ...
   - Success criteria: ...
   - Expected validation: ...

---

## 7) Near-term objectives

### Objective A: <name>

- Problem: ...
- Approach: ...
- Deliverables: ...
- Risks: ...
- Exit criteria: ...
- Expected validation: ...

### Objective B: <name>

- Problem: ...
- Approach: ...
- Deliverables: ...
- Risks: ...
- Exit criteria: ...
- Expected validation: ...

---

## 8) Long-term direction

### Strategic bets

- **Bet 1:** ...
  - Why it matters: ...
  - What we will likely build: ...
  - What we likely will not build: ...
- **Bet 2:** ...

### If we are right, then

- Users will be able to: ...
- Maintainers will spend less time on: ...
- The project will be known for: ...

---

## 9) Guardrails and constraints

### Guardrails

- Prefer small, reversible changes with clear validation.
- Protect the core user workflow before widening scope.
- Do not hide validation failures or claim untested work is complete.
- Avoid new dependencies unless they reduce net complexity.

### Constraints

- Supported platforms / runtimes: ...
- Performance or cost limits: ...
- External dependencies: ...
- Maintainer bandwidth: ...

### Agent validation policy

- Agents must name the validation path before starting work.
- If the expected validation cannot run, agents must surface that as a blocker.
- User-facing or UI-affecting work should include an end-to-end or rendered-surface check when available.

### Risk policy

- Core-path regressions are more serious than missing stretch features.
- High-risk architecture or behavior changes require explicit maintainer review.

---

## 10) How decisions get made

- Source of truth: this `vision.md`, issues, and repo docs.
- Prefer work that advances section 6 priorities and section 7 objectives.
- Require tests or equivalent validation for critical-path changes.
- Do not merge broad rewrites without an incremental plan and rollback path.

---

## 11) Active repo autonomy loop

- PushPals should compile section 6 priorities and section 7 objectives into small, ranked autonomous work items.
- Every selected objective should include:
  - Source signal: which priority/objective/guardrail triggered it.
  - Weight: why it matters now.
  - Scope: files or areas expected to change.
  - Guardrail check: what the work must not break.
  - Validation path: the command or manual check that proves the change.
- PushPals should favor repo-native work over meta/autonomy work unless this repo's own vision makes meta/autonomy infrastructure a top priority.

---

## 12) Testing criteria

This is the user-owned validation contract for autonomous work.
Fill this section with the exact repo commands WorkerPals must run before submitting a PR or revision.
PushPals treats command-like bullet items in this section as required validation and blocks publication when they fail.

- Add repo-required test commands as separate bullet items after they exist in this repository.
- Keep conditional or manual checks in section 9 unless they are mandatory for every WorkerPal PR or revision.
