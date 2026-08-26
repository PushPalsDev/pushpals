# 13. RepositoryAgent and Shared Memory

## Purpose

RepositoryAgent is PushPals' shared repository-understanding capability. It answers questions such as:

- which component owns a behavior,
- how a proposed change affects the architecture,
- which work best matches repository priorities,
- what likely caused a failure,
- what validation would provide useful evidence.

It is a **logical capability**, not a new required service process. The worker is currently hosted inside RemoteBuddy so it can use RemoteBuddy's assigned LLM and repository tooling. Any PushPals service can call it through a typed client and the Server broker; callers never import RemoteBuddy code or call the hosted worker directly.

RepositoryAgent provides advice, not authority. Deterministic policy, validation, tests, review, lease, and publication gates always make the final decision.

## Ownership and Boundaries

| Layer                   | Owns                                                                                                                         | Does not own                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Calling service         | Question, purpose, context, deadline, idempotency key, and how advice is used                                                | RepositoryAgent worker placement or queue persistence       |
| `packages/shared`       | Typed RepositoryAgent and memory contracts, bounded clients, stable identity, and snapshot resolution                        | Runtime state or SQLite                                     |
| Server                  | Canonical snapshot validation, durable RepositoryAgent queue, leases/deadlines, result broker, and shared memory persistence | Model inference or repository judgment                      |
| RemoteBuddy host        | RepositoryAgent poll loop, assigned LLM invocation, bounded evidence retrieval, evidence validation, cache/fact use          | Caller policy, Server database, or authoritative validation |
| Deterministic consumers | Scope, command, test, review, merge, and publication decisions                                                               | Treating model confidence as proof                          |

This arrangement keeps the logical API stable if the worker later moves to a dedicated process or another compatible host.

## End-to-End Flow

1. A caller runs `resolveRepositorySnapshot(repoRoot)` to obtain a stable identity, canonical root, exact commit revision, content-tree fingerprint, and dirty flag.
2. The caller submits a schema-versioned request through `RepositoryAgentClient`.
3. Server maps a non-host path onto its registered repository identity when appropriate, resolves the canonical snapshot, and rejects identity, revision, or tree drift.
4. Server persists the request in the RepositoryAgent queue. `(repository identity, caller service, session, idempotency key)` is unique and bound to a canonical request fingerprint. An exact retry returns the existing request; changed question, context, or snapshot data within that caller scope receives `409 idempotency_conflict` instead of another request's answer.
5. The RemoteBuddy-hosted worker claims the next compatible request with a token, generation, and lease expiry.
6. The worker renews the lease while it validates the worktree, checks exact cache, recalls evidence-backed memory, and invokes the assigned LLM. On a cache miss, a bounded discovery pass may select additional tracked files from the path index before final analysis. Deadlines and shutdown signals propagate into HTTP bodies and whole subprocess trees; the worker waits for bounded provider cleanup before releasing its lease or starting a fallback pass.
7. The worker validates every cited repository path/blob, rejects symlink/reparse traversal, restricts citations to files actually supplied in the final evidence packet, and checks the repository snapshot again after analysis.
8. Server accepts completion only from the live claim generation and only when the result describes the requested identity, revision, and tree.
9. The caller receives the structured result and runs its own deterministic gates.

RepositoryAgent has a separate queue from interactive requests, execution jobs, and publication completions. A slow analysis therefore cannot hold one of those queue claims. It still shares RemoteBuddy process and machine resources, so bounded calls, leases, and runtime supervision remain important.

## Typed Request and Result

The current contract is `schemaVersion: 1`.

A request carries:

- caller service plus optional instance/session/correlation IDs,
- purpose: `architecture`, `priority`, `ownership`, `validation`, `debug`, `impact`, or `general`,
- repository identity, absolute caller root, revision, tree fingerprint, and dirty state,
- question and bounded JSON context,
- priority: `interactive`, `normal`, or `background`,
- absolute ISO deadline,
- freshness: `cache_preferred`, `fresh_required`, or `cache_only`,
- idempotency key for the logical operation.

A result carries:

- the request ID and analyzed repository identity/revision/tree,
- answer, compact summary, and optional purpose-specific structured data,
- confidence in `[0, 1]`,
- repository-relative evidence with revision, blob hash, lines, excerpt, and rationale where available,
- prioritized recommendations,
- direct-argv validation proposals,
- exact-cache metadata,
- memory references and completion time.

The shared client sanitizes request and response shapes, caps payload sizes, requires exact positive acknowledgements, supports bearer authentication, and distinguishes invalid input, abort, timeout, transport, HTTP, malformed-response, and remote terminal errors.

## Caller Example

Any service can use the same interface:

```ts
import { randomUUID } from "crypto";
import { createRepositoryAgentServiceClients, resolveRepositorySnapshot } from "shared";

const repository = await resolveRepositorySnapshot(repoRoot, { timeoutMs: 5_000 });
const correlationId = randomUUID();
const deadlineAt = new Date(Date.now() + 2 * 60_000).toISOString();

// Create this once at the service composition root, then inject the bundle.
// Construction is inert: it performs no HTTP, Git, polling, or model work.
const repositoryServices = createRepositoryAgentServiceClients({
  serverUrl,
  callerService: "source_control_manager",
  callerInstanceId: processId,
  authToken,
  requestTimeoutMs: 10_000,
  askTimeoutMs: 90_000,
});

const result = await repositoryServices.repositoryAgent.ask(
  {
    caller: { sessionId, correlationId },
    purpose: "validation",
    repository,
    question: "Which focused checks best validate the changed ownership boundary?",
    context: { affectedPaths },
    priority: "normal",
    deadlineAt,
    freshness: "cache_preferred",
    idempotencyKey: `validation:${correlationId}`,
  },
  { signal: shutdownSignal, timeoutMs: 90_000 },
);

// Advice is input to policy; it is not permission to execute commands.
for (const proposal of result.validationProposals) {
  await validateAndMaybeRunTrustedProposal(proposal);
}

await repositoryServices.close();
```

Use `submit` plus `get` when the calling loop should not await the result. Use `ask` for a bounded submit-and-poll operation. An `ask` timeout ends only the local wait; it does not cancel the durable request. The typed timeout error exposes its `requestId`, which a later `get(requestId)` can use to observe the durable outcome.

Server, LocalBuddy, RemoteBuddy, WorkerPals, and SourceControlManager each create one `RepositoryAgentServiceClients` bundle at their composition root. The bundle exposes `repositoryAgent` and the independent `memoryStore` through typed interfaces, so code inside any service can request repository help or use memory without importing another service. Tests may inject either capability independently; `close()` never takes ownership of an injected store.

Choose an idempotency key that is stable for one logical operation and different for unrelated questions. Do not include credentials or sensitive prompt content in it.

## Broker Endpoints

RepositoryAgent and memory endpoints use the same loopback-only control-plane boundary as the rest of Server. They are not an isolation boundary between mutually untrusted local services.

Caller endpoints:

- `POST /repository-agent/requests` - validate and durably submit a request.
- `GET /repository-agent/requests/:id` - read current status, result, or typed failure.

Worker-control endpoints:

- `POST /repository-agent/requests/claim` - claim the next compatible request.
- `POST /repository-agent/requests/:id/lease/renew` - heartbeat the fenced claim.
- `POST /repository-agent/requests/:id/complete` - persist a validated result.
- `POST /repository-agent/requests/:id/fail` - persist a typed worker failure.

Shared memory endpoints:

- `PUT /memory/records`
- `POST /memory/get`
- `POST /memory/search`
- `POST /memory/invalidate`
- `POST /memory/reinforce`
- `POST /memory/prune`

Services should normally use `createRepositoryAgentServiceClients` instead of hand-writing these requests. Direct `RepositoryAgentClient` and `MemoryHttpClient` construction remains available for specialized integrations. No service other than Server should open the shared SQLite file.

Every memory request carries typed `x-pushpals-memory-caller` identity. The dedicated hosted worker additionally carries `x-pushpals-memory-authority: repository_agent`; ordinary RemoteBuddy code does not. RepositoryAgent cache/fact namespaces require that narrow authority for reads and writes. The worker may reinforce only its own validated cache hit as `confirmed`; authoritative success/failure/contradiction and internal pruning remain Server-owned. Other services retain normal operations in their own namespaces, including scoped pruning, while global pruning requires Server authority. These headers provide an auditable least-privilege boundary between cooperating loopback services, but they are not secrets and cannot defend against a malicious local process that can impersonate another service.

## Leases, Deadlines, and Recovery

RepositoryAgent queue ownership is independent of request/job/completion ownership:

- priority orders eligible claims, then age,
- claim token and monotonically increasing generation fence every renew/complete/fail operation,
- heartbeats extend a bounded lease,
- a lost or expired lease is recovered to `pending` on the next queue claim when the request deadline still permits work,
- a passed deadline becomes a terminal failure,
- completion after lease or deadline expiry is rejected,
- retryable worker failures use bounded exponential backoff and stop after three claims,
- requests cannot set a deadline more than one hour in the future,
- exhausted retries dead-letter with a typed terminal error,
- seven-day terminal-row retention keeps queue health and storage bounded,
- duplicate submissions converge only when their canonical request fingerprints match.

This prevents a dead worker, lost HTTP response, or late callback from owning the queue indefinitely or overwriting a newer result. Callers must still choose a realistic absolute deadline; unlimited model work is intentionally unsupported.

`/system/status` exposes `queues.repositoryAgentHealth`, including current counts, oldest pending/claimed age, delayed retries, stale claims, past-deadline active rows, exhausted pending rows, and the attempt cap. `queues.repositoryAgentMemoryFeedback` reports pending, processing, applied, failed, oldest-pending, and stale-claim state plus the feedback worker lifecycle. Reconciliation errors are guarded and recorded instead of escaping the watchdog timer.

## Stable Repository Identity and Exact Snapshot

`resolveRepositoryIdentity` derives a credential-free stable ID from normalized `origin` plus repository root commit when available. That lets equivalent HTTPS/SSH remote spellings and linked worktrees converge. Repositories without a usable origin fall back to the canonical Git common directory, which remains stable across linked worktrees on that host but is not portable across unrelated clones.

`resolveRepositorySnapshot` uses bounded direct Git argv with no shell:

- clean worktrees use `HEAD^{tree}`,
- dirty worktrees use a deterministic, domain-separated digest of `HEAD`, porcelain status, bounded staged/unstaged binary diffs, and raw-content object IDs for ordinary untracked files,
- two complete dirty-state captures recheck HEAD, tree, status, diffs, and untracked content so same-status races fail closed,
- Git errors, timeouts, stream-drain stalls, invalid object IDs, output truncation, or detected repository changes fail closed.

Server accepts only its canonical root or an exact path reported by that repository's authoritative `git worktree list`; registered worktrees may live outside the checkout, including short Windows-host paths such as `~/.ppw`. Before selecting an external worktree, Server proves that its stable repository identity and canonical Git common directory match the configured repository, then resolves the exact revision/tree/dirty snapshot. Existing but unregistered host paths are rejected, while nonexistent foreign/container paths remain advisory and are mapped by identity plus exact snapshot to a registered host worktree. This supports divergent PR heads without trusting caller-provided paths. The worker analyzes that selected worktree, verifies the request snapshot before and after, and disables all durable cache/fact writes for dirty worktrees.

Every assigned LLM receives a bounded evidence packet. For a clean snapshot, packet content and host-refreshed citation excerpts come from the exact Git blob at `<revision>:<path>`; checkout CRLF conversion and clean/smudge filters cannot silently change the evidence under that blob identity. A dirty snapshot instead uses the validated filesystem overlay. A model-guided discovery pass can select a small additional set of tracked paths; host code validates those paths and applies the same total file/character caps before the final pass. Final citations must come from that exact packet, not merely from some other tracked path the model names. Lexically tracked paths whose real canonical file traverses a symlink or Windows junction are excluded so an untracked target cannot inherit a tracked blob identity. For a Codex-backed client, the CLI runs in a disposable neutral Git repository with project docs, user rules, shell, apps, and web disabled. It never receives the target root as `cwd`. Repository instructions such as `AGENTS.md` therefore remain untrusted data rather than executable instruction layers.

## Shared Memory Architecture

Shared memory is a separate interface, not hidden RepositoryAgent state. `MemoryStore` supports `put`, `get`, `search`, `invalidate`, `reinforce`, `prune`, and `close`; Server provides the durable SQLite implementation and services use `MemoryHttpClient`.

Every record includes:

- namespace plus optional stable repository/session scope,
- key, kind, subject, summary, typed JSON value, and tags,
- repository-relative evidence and provenance,
- confidence, usefulness, status, revision, timestamps, optional expiry, and a bounded reinforcement-observation history.

The compare-and-set `expectedRevision` option prevents lost updates. Ordinary upserts preserve learned scores, status, expiry, original provenance, and outcome observations; an explicit compare-and-set is required to intentionally replace learned scores. Reusing an observation ID with an identical normalized payload is an idempotent retry; reusing it for different feedback is a visible conflict. Status and expiry keep invalid or superseded knowledge out of ordinary recall. Address components have one backend-independent limit and are rejected rather than truncated, preventing distinct namespaces or keys from aliasing. Search charges the complete serialized record, including values, evidence, and observations, against its character budget, skips records that cannot fit, and caps the recency candidate window before application-level ranking. Server periodically prunes expired records and old terminal knowledge.

### Exact cache

RepositoryAgent exact-cache keys include schema version, repository identity, revision/tree, purpose, question/context, assigned model, and prompt version. Only clean snapshots with a cache-permitting freshness policy are eligible. On a hit, cited blob evidence is revalidated before use. A stale hit is invalidated; `cache_only` returns a typed miss rather than silently invoking the model. When the provider reports the model actually used, including a compatibility fallback, cache and fact provenance record the normalized `provider/model` attribution rather than the requested label.

### Durable facts

For clean snapshots, host-verified evidence observations are stored as immutable, repository-scoped facts with longer expiry. Model answers, recommendations, runtime advice, raw caller questions, caller context, and hashes of caller-derived terms are not promoted to repository truth. Facts use only the allowlisted purpose as their durable recall topic. At query time, caller text may improve relevance only when it resolves through the current tracked-path index to an exact repository-owned path already safe to appear as evidence. Facts retain a bounded set of path/blob/line coordinates and optional excerpt digests, never the excerpts themselves, so multi-file facts remain eligible under the ordinary bounded-search character budget. Recall requires active status plus valid authoritative path/blob evidence in the current worktree. Records with changed or missing evidence are invalidated rather than presented to the model as current truth. Dirty snapshots are analyzed but never written to durable facts or exact cache.

### Outcome reinforcement

Memory supports `confirmed`, `successful`, `failed`, and `contradicted` observations. These adjust confidence/usefulness while preserving the original provenance and appending a bounded, durable observation containing the effective weight, time, evidence, and outcome provenance. Each result reference carries a role: `analysis_cache`, `evidence_fact`, or `recalled_fact`. Delivery success/failure trains only the analysis cache; a fact changes only after explicit direct-evidence confirmation or contradiction.

For autonomy work, Server accepts only a completed, Server-owned RepositoryAgent request ID from the selected objective. It resolves repository identity and memory record references from that durable result; planner-supplied addresses cannot redirect learning. A reconciler then consumes immutable authoritative lifecycle events. PR-backed work learns only from terminal provider outcomes. Non-PR work learns success only after its completion handoff is processed and both job and objective are terminal; explicit rejection, no-change, and quality/validation failures may learn failure. Environment, infrastructure, timeout, cancellation, and other non-quality execution failures are excluded. The reconciler writes an immutable feedback ledger row and applies it through the separate memory interface.

Feedback delivery itself uses claim tokens, monotonically increasing generations, bounded leases, retries, and dead-letter state. Claims are taken one at a time immediately before delivery and serialize outcomes within an objective while allowing unrelated objectives to progress. Record-ID fencing prevents delayed feedback from changing a new record that reused an old namespace/key after pruning, including across the HTTP memory client. The observation ID is derived from the objective and immutable autonomy outcome, so a crash after reinforcement but before acknowledgement safely replays without double learning. Failed deliveries use bounded backoff and remain visible in health telemetry. The model never reinforces its own conclusion.

RemoteBuddy's existing session-planning `remotebuddy_memory` backend remains a private compatibility layer. It is not the shared store and should not be used as a cross-service database.

## Fallback Behavior

RepositoryAgent is assistance, so failure behavior must be explicit and bounded:

- On timeout, abort, transport failure, malformed response, stale snapshot, or model failure, release the caller's wait promptly.
- Use an existing bounded deterministic or legacy path when that path is independently safe. RemoteBuddy autonomy does this for ideation.
- If repository advice is required to make a safety decision, fail closed and surface the typed error. Never interpret absence of advice as approval.
- Never skip scope, command, test, review, lease, or publication gates because RepositoryAgent succeeded or failed.
- Do not use stale memory merely to keep work moving; invalidate it or request fresh analysis.

The caller should log the RepositoryAgent request ID and correlation ID so a durable result can be inspected after a local timeout.

## Debugging Checklist

When a RepositoryAgent call appears stuck or wrong:

1. Confirm the submitted deadline is still in the future.
2. Inspect request status, claim generation, lease expiry, and last heartbeat in Server state.
3. Confirm a RemoteBuddy-hosted RepositoryAgent worker is polling and uses the expected assigned model.
4. Compare caller and Server repository identity, revision, tree, dirty state, and root mapping.
5. Inspect result evidence, blob hashes, cache hit/key, and memory references.
6. Check whether the caller timed out while the durable request later completed.
7. Confirm the consumer still ran its deterministic gates.

For memory issues:

1. Check namespace, repository ID, session scope, key, and record status.
2. Check expiry and compare-and-set revision conflicts.
3. Verify evidence paths are repository-relative and blob IDs still match.
4. Inspect reinforcement observations before trusting a high usefulness score.

## Tests That Define the Boundary

- `tests/shared.repository-agent-client.test.ts` - sanitization, auth, bounded polling, errors, and worker-control calls.
- `tests/shared.repository-identity.test.ts` - stable, credential-free identity behavior.
- `tests/shared.repository-snapshot.test.ts` - clean/dirty snapshots and fail-closed bounded Git behavior.
- `tests/server.repository-agent-queue.test.ts` - idempotency, fencing, heartbeats, deadlines, restart persistence, and stale recovery.
- `tests/server.repository-agent-context.test.ts` - canonical root mapping and stale snapshot rejection.
- `tests/server.memory-repository-agent-routes.test.ts` - broker and memory HTTP integration.
- `tests/memory-store-conformance.test.ts` - one behavioral contract run against in-memory and SQLite implementations.
- `tests/shared.memory.test.ts` and `tests/server.memory-store.test.ts` - scope, evidence, expiry, compare-and-set, reinforcement observations, and restart persistence.
- `tests/remotebuddy.llm-repository-context.test.ts` - neutral Codex workspace and disabled instruction/tool surfaces.
- `tests/remotebuddy.repository-agent.test.ts` - bounded model-guided retrieval, evidence validation, caching, dirty-snapshot policy, deadlines, and shutdown.

## Tradeoffs

Benefits:

- one repository-understanding interface for every service,
- no duplicated per-service Git-discovery logic,
- durable, recoverable model work without coupling callers to its host,
- reusable learning with evidence, provenance, and outcome feedback,
- exact-cache savings without treating stale answers as current.

Costs:

- another queue and state machine to observe,
- snapshot strictness can reject useful work during active repository changes,
- shared memory needs disciplined scope, invalidation, and reinforcement,
- model-guided retrieval can add one bounded LLM call on a cache miss,
- the current single RemoteBuddy-hosted worker limits RepositoryAgent concurrency.
