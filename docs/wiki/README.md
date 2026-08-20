# PushPals Wiki

This wiki is written for two audiences:

- New engineers who need a clear system mental model.
- Maintainers who need precise operational and architectural details.

`docs/wiki` is the canonical source. The
[`publish-wiki`](https://github.com/PushPalsDev/pushpals/actions/workflows/publish-wiki.yml)
workflow publishes it to the GitHub wiki; edit these files rather than the
published copy.

## Recommended Reading Paths

### Path A: New Engineer (first 60 minutes)

1. [System overview](https://github.com/PushPalsDev/pushpals/wiki/01-system-overview)
2. [Runtime architecture](https://github.com/PushPalsDev/pushpals/wiki/02-runtime-architecture)
3. [Client surfaces](https://github.com/PushPalsDev/pushpals/wiki/09-client-surfaces)
4. [Operations and testing](https://github.com/PushPalsDev/pushpals/wiki/12-operations-testing-and-roadmap)

### Path B: Runtime and Reliability

1. [Server control plane](https://github.com/PushPalsDev/pushpals/wiki/04-server-control-plane)
2. [RemoteBuddy](https://github.com/PushPalsDev/pushpals/wiki/06-remotebuddy)
3. [WorkerPals](https://github.com/PushPalsDev/pushpals/wiki/07-workerpals)
4. [SourceControlManager](https://github.com/PushPalsDev/pushpals/wiki/08-source-control-manager)

### Path C: Platform and Contracts

1. [Configuration and environments](https://github.com/PushPalsDev/pushpals/wiki/03-configuration-and-environments)
2. [Shared packages and protocol](https://github.com/PushPalsDev/pushpals/wiki/10-shared-packages-and-protocol)
3. [Prompts, LLMs, and safety](https://github.com/PushPalsDev/pushpals/wiki/11-prompts-llm-and-safety)

## Component Map

The common candidate-producing execution path is:

`CLI/UI -> Server session ingress -> request queue -> RemoteBuddy -> job queue -> WorkerPals -> completion queue -> SourceControlManager`

LocalBuddy is an optional fast ingress that can answer locally or enqueue into
the same Server request queue.

| Component                    | Contract                                                                                                      | Detailed guide                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| CLI and clients              | Collect user intent, supervise local runtimes, and project durable Server state; they do not own queue state. | [Client surfaces](https://github.com/PushPalsDev/pushpals/wiki/09-client-surfaces)              |
| LocalBuddy                   | Turns `POST /message` into a quick reply or a durable queued request; it does not plan or execute jobs.       | [LocalBuddy](https://github.com/PushPalsDev/pushpals/wiki/05-localbuddy)                        |
| Server                       | Owns sessions, events, queues, leases, and worker state; it does not plan, execute, or publish code.          | [Server control plane](https://github.com/PushPalsDev/pushpals/wiki/04-server-control-plane)    |
| RemoteBuddy                  | Turns a claimed request into a direct response or scoped job; it does not mutate the repository.              | [RemoteBuddy](https://github.com/PushPalsDev/pushpals/wiki/06-remotebuddy)                      |
| WorkerPals                   | Turns an authorized job into a terminal result or validated candidate commit; it does not decide publication. | [WorkerPals](https://github.com/PushPalsDev/pushpals/wiki/07-workerpals)                        |
| SourceControlManager         | Validates and publishes completion candidates; it does not execute the original coding job.                   | [SourceControlManager](https://github.com/PushPalsDev/pushpals/wiki/08-source-control-manager)  |
| Protocol and shared packages | Define wire contracts and reusable runtime behavior; they own no service state.                               | [Shared packages](https://github.com/PushPalsDev/pushpals/wiki/10-shared-packages-and-protocol) |

## Core Principle

PushPals is intentionally split into small services with strict boundaries:

- `apps/server` is the queue and event control plane.
- Planning is isolated in `apps/remotebuddy`.
- Execution is isolated in `apps/workerpals`.
- Integration is isolated in `apps/source_control_manager`.
- User surfaces stay thin (`packages/cli`, `apps/client`, `apps/vscode-client`).

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
