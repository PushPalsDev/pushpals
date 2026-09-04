# PushPals Server

`apps/server` is the durable control plane for PushPals. It owns session history,
request/job/completion queues, worker presence, runtime configuration, autonomy
state, RepositoryAgent requests, and shared memory. It does not plan tasks,
execute repository changes, run repository analysis models, or publish commits.

## Quick Start

Run from the repository root:

```bash
bun install
bun run server
```

`bun run server` builds the shared protocol first, then starts the Server in watch mode. If the protocol is already current, use `bun run server:only`. App-local commands are `bun run dev`, `bun run start`, and `bun run build` from `apps/server`.

The default endpoint is `http://127.0.0.1:3001`; `GET /healthz` is the smallest readiness check.

## Component Contract

- Receives session messages and queue mutations from clients, LocalBuddy, RemoteBuddy, WorkerPals, and SourceControlManager.
- Persists events before broadcasting them over SSE or WebSocket. A reconnect
  replays one bounded page of at most 1,000 events after the supplied cursor;
  clients must not interpret `after=0` as an unbounded history export.
- Owns all queue transitions. Callers propose a mutation; the Server validates ownership and commits it atomically.
- Exposes queue snapshots, job logs and diagnostics, worker health, runtime configuration, and autonomy endpoints.

The candidate-producing pipeline is:

```text
request -> RemoteBuddy claim -> job -> WorkerPal claim/start -> completion -> SCM publication
```

## Durable State and Recovery

The configured `paths.shared_db_path` is the shared SQLite database; it defaults
to `outputs/data/pushpals.db`. It stores sessions, replayable events, queues, job
activity, worker state, autonomy records, RepositoryAgent work, and shared
memory. Server owns the write-side validation and lifecycle for that state.

Worker-owned job writes are fenced by `workerId` plus `claimGeneration`. A claim is pre-execution until `POST /jobs/:id/start` is positively acknowledged. Stale-claim sweeps, lease recovery, lifecycle reconciliation, and the durable WorkerPal runtime circuit recover interrupted work without accepting late writes from an old owner. Completion processing similarly uses renewable, fenced claims.

## Auth and Exposure

PushPals currently runs in local-only mode. The Server binds to `127.0.0.1` by default and explicitly ignores configured auth tokens. Do not expose it on an untrusted interface without first adding and validating an authentication boundary.

## Key Entrypoints

- `src/server_main.ts` - HTTP routing and lifecycle orchestration.
- `src/events.ts` and `src/db.ts` - durable session events and replay.
- `src/requests.ts`, `src/jobs.ts`, `src/completions.ts` - queue state machines.
- `src/autonomy.ts` - objectives, snapshots, policy evidence, and locks.
- `src/lifecycle_reconciliation.ts` - bounded recovery watchdog.

For endpoint families, invariants, and on-call guidance, see the [Server Control Plane wiki](../../docs/wiki/04-server-control-plane.md).
