# 10. Shared Packages and Protocol

## Component Contract

- `packages/protocol` owns versioned wire shapes and validation shared by producers and consumers.
- `packages/shared` owns reusable runtime behavior such as configuration, deadlines, policy, and validation primitives.
- Neither package owns service lifecycle, queue/session persistence, or app-specific orchestration.

## `packages/protocol`

`packages/protocol` defines the contract language for cross-service communication.

Responsibilities:

- protocol version constant,
- event and request/response types,
- validation functions for envelope integrity.

Important files:

- `packages/protocol/src/version.ts`
- `packages/protocol/src/types.ts`
- `packages/protocol/src/validate.ts`
- `packages/protocol/src/index.ts`
- `packages/protocol/src/index.browser.ts`

Design goal: every service can validate inbound/outbound payloads against the same source.

## `packages/shared`

`packages/shared` contains cross-cutting infrastructure that should not be duplicated in apps.

Key modules:

- `packages/shared/src/config.ts`
  - typed config loader and normalization.
- `packages/shared/src/communication.ts`
  - common emit/subscribe helpers for session transport.
- `packages/shared/src/autonomy_policy.ts`
  - path normalization, glob matching, scope invariants, policy scoring helpers.
- `packages/shared/src/repo.ts`
  - repo root detection/context helpers.
- `packages/shared/src/prompts.ts`
  - prompt template loading.
- `packages/shared/src/bounded_fetch.ts` and `packages/shared/src/bounded_process.ts`
  - complete-exchange HTTP and child-process deadlines.
- `packages/shared/src/trusted_validation.ts`
  - safe validation-command normalization and failure evidence.
- `packages/shared/src/repository_identity.ts`
  - credential-free stable repository identity shared across linked worktrees and matching clones.
- `packages/shared/src/repository_snapshot.ts`
  - bounded, direct-Git resolution of canonical root, exact revision/content-tree fingerprint, and dirty state.
- `packages/shared/src/repository_agent.ts`
  - versioned RepositoryAgent request/result contracts plus bounded service and lease-worker clients.
- `packages/shared/src/memory.ts`
  - separate `MemoryStore` contract, in-memory implementation, and bounded Server HTTP client.

## RepositoryAgent Contract

`RepositoryAgent` is the service-facing interface: `submit`, `get`, and `ask`. A caller identifies itself, supplies a purpose, stable repository snapshot, question/context, priority, absolute deadline, freshness policy, and idempotency key. Results contain the analyzed snapshot, answer/summary, confidence, evidence, recommendations, validation proposals, cache metadata, and memory references.

The shared client deliberately targets the Server broker rather than RemoteBuddy. That keeps all apps independent of the current worker host. `ask` bounds each HTTP exchange and the overall submit/poll loop; timing out the local wait does not cancel already-durable work.

Each backend service constructs one inert `RepositoryAgentServiceClients` bundle at its composition root and injects it where needed. The bundle exposes the same `RepositoryAgent` interface to Server, LocalBuddy, RemoteBuddy, WorkerPals, and SourceControlManager, alongside a separate `MemoryStore`. Construction performs no network, Git, polling, or model work, and injected capabilities keep their original lifecycle ownership.

`RepositoryAgentWorkerControl` adds `claim`, `renewLease`, `complete`, and `fail` for worker hosts. These methods carry claim tokens and generations so stale workers cannot commit a terminal result.

## Shared Memory Contract

`MemoryStore` is independent of RepositoryAgent and can be used by any service. It provides `put`, `get`, `search`, `invalidate`, `reinforce`, `prune`, and `close`. Records have an explicit scope, stable key, typed value, evidence, original provenance, confidence/usefulness, revision, status, expiry, and bounded outcome-observation history. The in-memory and SQLite implementations run through the same conformance suite.

Use the bundle's `memoryStore` (a `MemoryHttpClient` by default) from service processes. Server is the only runtime owner of durable memory SQLite. Direct database access from callers would bypass validation and compare-and-set semantics and create cross-process contention.

RepositoryAgent is one consumer: it stores an exact cache separately from longer-lived evidence-backed facts. Memory references declare whether they identify an analysis cache, newly verified fact, or recalled fact. Other services may consume or reinforce memory only through the interface and should derive outcome reinforcement from authoritative job, review, validation, or publication results rather than model self-assessment. Delivery outcomes train analysis usefulness without incorrectly treating an execution failure as contradictory repository evidence.

## Ownership Rule of Thumb

- Put code in `packages/shared` only if:
  - at least two apps need it,
  - behavior must stay consistent across those apps,
  - the abstraction can be tested independently.

Otherwise keep it local to the owning app.

## Why This Split Is Important

Without shared packages:

- each app would parse config differently,
- protocol drift would be likely,
- policy logic would fork and become inconsistent.

With shared packages:

- behavior is more consistent across services,
- migrations happen in one place,
- onboarding is easier once engineers understand package boundaries.

## Tradeoffs

Pros:

- reduced duplication,
- stronger consistency guarantees,
- easier to test shared logic once and reuse everywhere.

Cons:

- shared packages can become dumping grounds if not curated,
- backward compatibility concerns can slow refactors.

## Safe Change Checklist

When changing shared exports:

1. Update type contracts first.
2. Confirm all importing apps still compile.
3. For RepositoryAgent callers, test timeout/abort, malformed responses, idempotent submission, and stale snapshot behavior.
4. For shared memory users, test scope isolation, compare-and-set conflicts, evidence invalidation, expiry, and reinforcement.
5. Validate runtime behavior in at least one end-to-end flow.
6. Document any migration/deprecation in wiki and templates.

## Future Improvements

- Add explicit API stability levels for shared exports.
- Add contract tests that run each service against protocol fixtures.
- Add config deprecation tooling with warning windows and migration hints.
