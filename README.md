# Push Pals
**Multi-agent coding orchestration with observability and security in mind.**

Push Pals is a self-hostable “coding team” that lives alongside your repo. You talk to it from any device (including your phone), and it coordinates multiple code-capable agents on a remote server to plan, implement, test, and propose changes—without silently doing risky operations.

Instead of one monolithic agent doing everything, Push Pals acts like a tiny engineering org:
- a **Local Companion** (mobile/desktop) that understands your intent and keeps you in the loop
- a **Remote Orchestrator** (self-hosted on your cloud box) that manages workspaces, runs agents, and enforces policy
- a set of **Worker Agents** (e.g., OpenHands or other tooling) that do focused tasks and report back

---

## What Push Pals does

### Ship features from your phone
Tell Push Pals what you want:
- “Add a settings screen”
- “Fix this crash and add a test”
- “Refactor the combat system module”
- “Make the build faster”
  
... and keep talking and assigning to it while background agents work on other tasks! You can even get status reports on all the tasks while they are running! Agent to agent communication in the background without foreground ever being blocked!

Push Pals will:
1. create a plan and a small backlog of tasks
2. run multiple workers in parallel (each on a small, scoped ticket)
3. run tests/lint/build checks
4. set a **reviewable diff** and a **proposed commit/PR**
5. local agent notify you of this commit and ask you to approve before it commits/pushes
6. Optional: If you give agent permission, it can just auto-commit the changes, move on, and you can review later on your own time.

### Improve your codebase continuously
Push Pals can proactively propose improvements based on repo signals:
- failing tests / flaky tests
- lint/typecheck errors
- performance bottlenecks (build time, bundle size)
- risky patterns (security footguns, unsafe config)
- missing docs/devex friction

You stay in control—changes become PRs, not surprises.

---

## Design goals

### 1) Orchestration that feels like a team
- Multiple helpers working in parallel
- One orchestrator coordinating tasks and consolidating results
- Small PRs with clear scopes

### 2) Security first (no “agent chaos”)
Push Pals is built around **capabilities and approvals**:
- workers run in isolated workspaces/sandboxes
- commands are allowlisted by default
- secrets are never committed
- network access can be restricted
- anything risky triggers a clear approval request

### 3) Observability by default
Every run produces a full audit trail:
- which tools ran
- which commands ran (and outputs)
- diffs produced
- tests executed and results
- approvals requested and granted/denied

### 4) Proactive codebase improvement
Push Pals doesn’t just respond to requests — it can continuously propose high-leverage improvements:
- detect failing/flaky tests, lint/type errors, and CI regressions
- surface performance bottlenecks (slow builds, slow tests, large bundles)
- identify risky patterns (security footguns, unsafe configs, dependency issues)
- suggest refactors and cleanup (dead code, duplicated logic, TODO hotspots)
- improve developer experience (docs, scripts, setup, tooling)
- bundle suggestions into small, reviewable PRs with clear rationale
  
This makes it safe to use in real repos.

---

## How it works

### Components

**Local PushPal (Client + Companion)**
- Runs on phone/desktop
- Chat UI + “intent shaping”
- Shows diffs, logs, artifacts
- Handles approvals (“Commit?”, “Push?”, “Open PR?”)

**Remote PushPal (Orchestrator)**
- You self-host it (e.g., EC2, or even on the same computer!)
- Owns repo workspaces (clones), branches, sandboxes
- Spawns and coordinates workers
- Enforces policy (command allowlist, network rules)
- Requests approvals for risky actions

**Workers**
- Code-capable agents (e.g., OpenHands) and/or other tooling
- Receive a scoped task, produce artifacts, run checks
- Never push to main directly

---

## Safety model (high level)

Push Pals treats a repo like production equipment:
- changes happen on a branch
- results come back as diffs + proposed commits
- **push/commit/PR creation require approval**
- unapproved commands don’t run

---

## Use cases
- Build features while away from your laptop
- Coordinate multiple code agents without losing control
- Keep a repo healthy with automated improvements
- Run safe refactors with tight audit trails
- Turn “idea → PR” into a fast, reviewable workflow

---

## Status
Early-stage / under active development.

If you’re interested in contributing, feel free to open a PR. Or get in touch via `push.pals.dev@gmail.com`
