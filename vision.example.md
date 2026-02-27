# Vision

> **One sentence:** What does this repo exist to make true in the world?
>
> Example: “Make it easy for developers to ship <X> reliably, without needing deep expertise in <Y>.”

---

## 1) Who this is for

### Primary users
- **User type A:** (e.g., app developers, SREs, analysts, end-users)
  - Jobs-to-be-done: …
  - Pain today: …
  - Success looks like: …

### Secondary users
- **User type B:** …
  - Jobs-to-be-done: …
  - Pain today: …
  - Success looks like: …

### Non-users (explicitly *not* optimizing for)
- **Not for:** …
  - Why: …

> **Guidance:** Keep this section concrete. If you can’t name the user and their job, you’ll argue about priorities forever.

---

## 2) The problem we solve

### Today’s reality
- What is hard / slow / risky today?
- What failures happen repeatedly? (bugs, incidents, misconfig, confusion)
- What is expensive? (time, money, cognitive load, coordination)

### The change we want
- In 6–12 months, what should feel *meaningfully easier*?
- In 2–3 years, what should be *obviously different*?

> **Optional:** Add a 3–5 line “story” of a user before vs after.

---

## 3) Product principles (decision rules)

These are **tie-breakers** when tradeoffs happen. Put them in priority order.

1. **Principle 1:** (e.g., “Safe by default”)
   - We will: …
   - We won’t: …
2. **Principle 2:** (e.g., “Make the common path fast”)
   - We will: …
   - We won’t: …
3. **Principle 3:** (e.g., “Prefer boring, maintainable solutions”)
   - We will: …
   - We won’t: …

> **Guidance:** A principle is only useful if it can help you say “no” to a PR.

---

## 4) What “good” looks like (measures)

Pick a small set of metrics you can actually track.

### User-facing outcomes
- **Time-to-success:** e.g., median time from install → first successful use
- **Quality:** e.g., bug rate / support tickets per active user
- **Trust:** e.g., SLO compliance, error rate, crash-free sessions

### Developer / maintainer outcomes
- **Change velocity:** PR cycle time, lead time to release
- **Operational burden:** pages/alerts per week, toil hours
- **Maintainability:** test coverage for critical paths, build time, flake rate

> **Guidance:** Avoid vanity metrics. Prefer “time, errors, incidents, support load, cost”.

---

## 5) Scope and boundaries

### In scope (what we *are*)
- Core capability A: …
- Core capability B: …
- Core capability C: …

### Out of scope / non-goals (what we are *not*)
- Not a replacement for: …
- Not trying to support: …
- Not optimizing for: …

### Compatibility & support policy (optional)
- Supported platforms / versions: …
- Breaking changes policy: …
- Deprecation timeline: …

> **Guidance:** This section prevents “just one more feature” creep.

---

## 6) Current priorities (next 4–8 weeks)

Pick 3–5 items max. Each should be **outcome-oriented**.

1. **Priority:** …
   - Why now: …
   - Success criteria: …
   - Owner / area: …
2. **Priority:** …
3. **Priority:** …

> **Tip:** If everything is a priority, nothing is.

---

## 7) Near-term objectives (1–2 quarters)

These are “bets” with explicit results.

### Objective A: <name>
- **Problem:** …
- **Approach:** …
- **Deliverables:** …
- **Risks:** …
- **Exit criteria:** How we’ll know it worked (measurable)

### Objective B: <name>
- …

---

## 8) Long-term direction (1–3 years)

Describe where this repo is going, without over-promising.

### Strategic bets
- **Bet 1:** …
  - Why it matters: …
  - What we’ll likely build: …
  - What we likely won’t build: …
- **Bet 2:** …

### “If we’re right, then…”
- Users will be able to: …
- Maintainers will spend less time on: …
- The ecosystem will have: …

---

## 9) Guardrails and constraints

### Guardrails (how we avoid harm / churn)
- Prefer changes that are **reversible** or behind flags.
- Default to **secure / safe** settings.
- Optimize for the **common path**; support escape hatches for experts.
- Avoid adding new dependencies unless they reduce net complexity.
- Pay down operational toil before adding big surface area.

### Constraints (reality checks)
- Staffing level / maintainer bandwidth: …
- Hard requirements (privacy, compliance, perf, cost): …
- External dependencies: …

---

## 10) How decisions get made (governance-lite)

- **Source of truth:** issues + RFCs + docs in `docs/`
- **When we require an RFC:** breaking changes, new public APIs, major deps, new architecture
- **Review expectations:** tests required for critical paths, docs for user-facing behavior
- **Release cadence:** …
- **What we won’t merge:** (examples)
  - large rewrites without an incremental plan
  - behavior changes without migration guidance
  - features that expand scope beyond the non-goals

---

### Appendix (optional but powerful)

### A) Glossary
- Term: definition…

### B) Personas (one-page each)
- Persona, environment, constraints, success criteria…

### C) Example “no” responses (template)
- “Thanks — this is valuable, but it conflicts with our non-goal X…”
- “We’d reconsider if metric Y becomes a problem…”
