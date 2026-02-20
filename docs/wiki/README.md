# PushPals Wiki

This wiki is written for two audiences:

- New engineers who need a clear system mental model.
- Maintainers who need precise operational and architectural details.

## Recommended Reading Paths

## Path A: New Engineer (first 60 minutes)

1. `docs/wiki/01-system-overview.md`
2. `docs/wiki/02-runtime-architecture.md`
3. `docs/wiki/09-client-surfaces.md`
4. `docs/wiki/12-operations-testing-and-roadmap.md`

## Path B: Runtime and Reliability

1. `docs/wiki/04-server-control-plane.md`
2. `docs/wiki/06-remotebuddy.md`
3. `docs/wiki/07-workerpals.md`
4. `docs/wiki/08-source-control-manager.md`

## Path C: Platform and Contracts

1. `docs/wiki/03-configuration-and-environments.md`
2. `docs/wiki/10-shared-packages-and-protocol.md`
3. `docs/wiki/11-prompts-llm-and-safety.md`

## Core Principle

PushPals is intentionally split into small services with strict boundaries:

- `apps/server` is the queue and event control plane.
- Planning is isolated in `apps/remotebuddy`.
- Execution is isolated in `apps/workerpals`.
- Integration is isolated in `apps/source_control_manager`.
- User surfaces stay thin (`apps/client`, `apps/vscode-client`).

This separation increases observability and recoverability, at the cost of higher orchestration complexity.

## Documentation Quality Bar

Each component page should answer, at minimum:

- What this component owns.
- What it explicitly does not own.
- How data enters and leaves it.
- What breaks most often.
- How to debug it quickly.
- What tradeoffs we accepted.
- What improvements are next.

## How To Use This Wiki While Coding

- Before editing a component:
  - read that component page end-to-end.
- While implementing:
  - keep open the related architecture and config pages.
- Before opening a PR:
  - confirm docs still match behavior.
  - update the component page if ownership or flow changed.
