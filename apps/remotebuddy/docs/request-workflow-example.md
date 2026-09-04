# Request workflow example: "Add two more tests"

This walkthrough follows the current durable request-to-publication path. Identifiers and model output are illustrative; route names and ownership match the implementation.

## 1. Ingress

The Expo client, CLI, or VS Code client first joins a session with `POST /sessions`, then submits:

```http
POST /sessions/SESSION_ID/message
Content-Type: application/json

{"text":"Add two tests for request-status failure handling."}
```

Server validates the message, emits a session `message` event, and enqueues an `interactive` request. The response can include `requestId`, `queuePosition`, and `etaMs`.

LocalBuddy is an optional alternative ingress. `POST /message` answers status/read-only/lightweight prompts locally; other prompts, or `/ask_remote_buddy <request>`, are sent to Server's `POST /requests/enqueue`. LocalBuddy is not between the normal clients and Server.

## 2. Planning claim

RemoteBuddy polls `POST /requests/claim` with its fixed agent ID and a three-minute lease. Server returns the next claimable request in priority/FIFO order with a unique claim token and generation.

RemoteBuddy immediately starts a 30-second renewal heartbeat and serializes this request behind any planner work already in progress. The corresponding logs resemble:

```text
[RemoteBuddy] Claimed request ...
[RemoteBuddy] Planning request ... priority=interactive queueWait=...ms
```

## 3. Structured plan

`AgentBrain` classifies this as repository work and returns a structured worker plan. RemoteBuddy then:

- Resolves and checks target-path hints against the current repository.
- Ensures write globs cover concrete target hints.
- Supplies an acceptance criterion if a forced-worker request omitted one.
- Normalizes validation commands and includes required validation criteria extracted from `vision.md`.
- Selects a deterministic or agentic execution lane, normally the worker lane for an open-ended edit.
- Adds bounded recent session and job context.

For an ordinary user request, a malformed non-forced worker plan fails before enqueue when required contract fields cannot be established. An autonomous request is always worker-required and retains its server-validated scope metadata.

## 4. Worker selection and durable enqueue

RemoteBuddy prefers an idle online WorkerPal. If none is idle and auto-spawn is enabled below `max_workerpals`, it starts another worker and waits for its heartbeat. If workers are online but busy, the job can remain untargeted for the first available compatible worker.

RemoteBuddy posts a schema-v2 `task.execute` job to `POST /jobs/enqueue`. The payload contains:

- The canonical user instruction and optional planner guidance.
- `requestId`, `sessionId`, and origin.
- Target paths and structured scope/discovery hints.
- Acceptance criteria and validation steps.
- Queue priority plus queue, execution, and finalization budgets.
- A stable dedupe identity; retries reuse the exact serialized payload.

Only after Server returns a durable job ID does RemoteBuddy emit `task_created`, `task_started`, `task_progress`, and `job_enqueued` session events. If an active matching job exists, the enqueue can return that job with `deduped=true`.

## 5. Durable handoff

RemoteBuddy records the exact job with:

```text
POST /requests/REQUEST_ID/worker-handoff
POST /requests/REQUEST_ID/complete
```

Both transitions require the current request claim token. The planning request is now complete, but Server's request read model projects its `outcomeStatus` from the linked job until execution reaches a terminal outcome.

If the job was durably created and either callback response is lost, RemoteBuddy does not reverse the result or enqueue another job. It leaves the handoff for Server reconciliation.

## 6. WorkerPal execution

A WorkerPal claims the job with its own fenced lease, crosses the explicit `/jobs/:id/start` boundary, prepares an isolated worktree/container as configured, inspects the repository, edits the test files, and runs the planned/required quality checks.

Activity is persisted through `/jobs/:id/log`, structured tool runs, heartbeats, and diagnostics. WorkerPal's bounded quality loop—not RemoteBuddy—decides whether the candidate is ready to hand to SourceControlManager.

If execution fails, Server makes the job terminally failed or applies its stale-claim retry-safety rules. RemoteBuddy observes the `job_failed` session event and can fetch a bounded failure-log summary for the user. It does not automatically create the previously documented generic `fix_up` job.

## 7. Completion and publication

For publishable changes, WorkerPal commits an immutable candidate and enqueues a completion. Server moves the job to `finalizing`.

SourceControlManager then:

1. Claims the completion with a separate fenced lease.
2. Revalidates candidate identity and clean repository state.
3. Applies/integrates the candidate and runs trusted-host validation.
4. Publishes according to the configured branch/PR policy.
5. Calls the completion `processed` or `fail` route with its current authority.

Only the acknowledged processed callback makes the job `completed` and emits the authoritative `job_completed` event. A failed publication can become `publish_blocked`; it is not reported as successful simply because WorkerPal produced a commit.

## Failure ownership

| Failure                                      | Durable evidence                                                 | Owner/recovery                                            |
| -------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| Message validation or queue enqueue rejected | Error response/session `error`; no accepted request              | Client or Server input/configuration                      |
| Planner/model failure before a job exists    | Failed request and RemoteBuddy planning log                      | Fix planner/backend/request, then submit a new request    |
| Ambiguous job enqueue                        | Possible job plus claimed request                                | Server handoff reconciliation; do not duplicate           |
| No online WorkerPal                          | Pending job or failed pre-handoff request plus worker/spawn logs | RemoteBuddy autoscaler or manually started WorkerPal      |
| Worker execution failure                     | Job logs/tool runs/diagnostics and terminal job state            | WorkerPal/runtime; follow retry-safety classification     |
| Publication failure                          | Finalizing/publish-blocked job, completion row, candidate ref    | SourceControlManager                                      |
| Status appears inconsistent                  | `GET /requests/:id`, `GET /jobs`, and session cursor history     | Use durable rows as authority; there is no webhook replay |

## Observe the example

```bash
curl -sS "http://127.0.0.1:3001/requests?status=all&limit=20"
curl -sS "http://127.0.0.1:3001/jobs?status=all&limit=20"
curl -sS "http://127.0.0.1:3001/completions?status=all&limit=20"
curl -sS http://127.0.0.1:3001/system/status
```

Use the session's SSE or WebSocket cursor stream, or the client UI, for human-readable progress. Use queue rows and fenced transitions as lifecycle authority.
