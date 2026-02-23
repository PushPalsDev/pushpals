# remotebuddy - RemoteBuddy Orchestrator

RemoteBuddy is the always-on planner/scheduler. It claims requests from the server queue, decides whether a request is lightweight chat or WorkerPal-owned execution, and enqueues scoped jobs for WorkerPals.

## Runtime Role

- Claims queued requests: `POST /requests/claim`
- Emits session events via `CommunicationManager`:
  - `assistant_message`
  - `task_created`, `task_started`, `task_progress`
  - `job_enqueued`
- Schedules WorkerPals:
  - picks idle workers
  - optionally auto-spawns workers
  - waits/retries when capacity is full
- Marks requests complete: `POST /requests/:id/complete`

## Usage

```bash
bun run dev
bun run start

bun run src/remotebuddy_main.ts \
  --server http://localhost:3001 \
  --sessionId dev \
  --token <auth-token>
```

## Worker Routing Notes

- Lightweight non-actionable prompts can be answered directly.
- Non-trivial actionable prompts are delegated to WorkerPals.
- Architecture/explanation intents can be routed as `project.summary`.
- Code-change intents are routed as `task.execute`.

## Event/Data Flow

```text
LocalBuddy -> POST /requests/enqueue -> Server Request Queue
RemoteBuddy -> POST /requests/claim -> plan -> POST /jobs/enqueue
WorkerPals -> POST /jobs/:id/complete|fail (+ optional /completions/enqueue)
SourceControlManager -> POST /completions/claim -> merge/push -> POST /completions/:id/processed|fail
```

## Operational Runbook

### Checklist Structure

**One-time prerequisites (single pass; never loop these again):**
1. Confirm the most recent RemoteBuddy backup/snapshot per platform SLO before taking any action, then log the timestamp.
2. Pin work to the issued worktree (for example `/repo/.worktrees/job-…/apps/remotebuddy`) by running `git rev-parse --show-toplevel` and documenting the resolved path.
3. Start evidence capture (shell transcript or screen recording) that spans the entire intervention; restart it only if it stops unexpectedly.

**Repeatable runtime health checks (loop only these when told to “re-check”):**
1. `GET /jobs?status=running&scope=remotebuddy&sessionId=<current-session>` must return zero rows; anything else blocks progress.
2. The scoped Windows PID list is limited to RemoteBuddy processes tied to the active worktree and entrypoint path (details below).
3. The session record for the active `sessionId` is closed (`status=idle|closed`) or absent.
4. No locks remain for the `sessionId` or worktree in `GET /locks?owner=remotebuddy`.

Whenever the runbook says “re-check,” rerun the **repeatable runtime health checks** list above verbatim; never repeat the one-time prerequisites unless the environment materially changes (for example, a new worktree is issued or evidence capture fails).

### Running Jobs Acceptance Criteria

RemoteBuddy uses a **strict zero-running-jobs** contract everywhere in the workflow:

1. Call `GET /jobs?status=running&scope=remotebuddy&sessionId=<current-session>`.
2. **Pass rule:** response array length is zero.
3. **Fail rule:** any non-zero length, any job referencing another session, or any transport error. Failures block promotion and require either waiting for the queue to drain or pausing WorkerPals manually—there are no baselines or carve-outs.
4. Document every polling attempt (request parameters, timestamp, response JSON) until a zero-length response is observed, then proceed.

Apply this exact check before remediation, again after each stop/force-stop attempt, and throughout the final verification loop so acceptance never diverges between stages.

### Windows Process Control

Replace broad `tasklist` usage with RemoteBuddy-scoped filtering and keep that PID list immutable for every stop scenario.

```powershell
$worktree   = (Get-Item $env:CODEX_WORKTREE).FullName
$entryPoint = Join-Path $worktree 'apps\remotebuddy\src\remotebuddy_main.ts'

$scoped = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -ieq 'bun.exe' -and
    $_.ExecutablePath -like "$worktree*" -and
    $_.CommandLine -match [Regex]::Escape($entryPoint)
  } |
  Select-Object ProcessId, ExecutablePath, CommandLine

if (-not $scoped) {
  Write-Error 'No RemoteBuddy processes found in this worktree.'
}
```

- **Stop step:** `Stop-Process -Id $scoped.ProcessId -PassThru` (graceful attempt uses only the stored `$scoped` IDs).
- **Force-stop step:** `Stop-Process -Id $scoped.ProcessId -Force -PassThru` (run only if the graceful attempt fails, still using the same `$scoped` set).

Do **not** collect new processes between attempts or pass unfiltered PIDs to `Stop-Process`/`taskkill`; every command must stay bound to the vetted `$scoped` set to avoid collateral WorkerPal outages.

### Session and Lock Post-Verification Rules

Treat session and lock outcomes as separate gates:

**Session cleanup**
- *Pass:* `GET /sessions/<sessionId>` returns HTTP 404 or a JSON `status` in `{ "idle", "closed" }` once RemoteBuddy has shut down.
- *Fail:* Any other status (active, blocked, closing) observed more than 60 seconds after the last stop command, or if the endpoint continues returning the session with `workerId` assigned.

**Lock cleanup**
- *Pass:* `GET /locks?owner=remotebuddy&sessionId=<sessionId>` returns an empty array and `GET /locks?worktree=<path>` shows no entries tied to the scoped worktree.
- *Fail:* Any lock row referencing the same `sessionId` or worktree persists beyond the same 60-second window.

Escalate if either check fails independently; do not allow a passing session check to mask a stuck lock or vice versa.

### Recovery Loop Template

1. Run the repeatable health checks.
2. If the running-jobs check fails, pause further action until it returns zero; capture timestamps for every poll.
3. If scoped PIDs exist, apply the stop then force-stop commands (only with the saved PID set) and immediately return to step 1.
4. Once jobs are zero and the PID list is empty, evaluate the session rule followed by the lock rule; continue looping through the repeatable health checks until both are in a pass state.
5. Exit the loop only after two consecutive passes of all repeatable checks; otherwise continue remediation or escalate per incident policy.
