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

## Maintenance and Recovery

All commands below target `http://localhost:3001`; swap in the real control-plane origin when operating in another environment. Do not proceed unless you can complete every checklist item—skipping any gate invalidates the cleanup.

### Pre-cleanup verification checklist (run top-to-bottom)
- **Requests:**
  - `curl -s http://localhost:3001/requests?status=claimed | jq '.items | length'` — must be `0` so no claims are mid-flight.
  - `curl -s http://localhost:3001/requests?status=queued | jq '.items | length'` — record the intentionally pending count for post-check comparison.
- **Jobs:**
  - `curl -s http://localhost:3001/jobs?status=claimed | jq '.items | length'` — must be `0`; pause maintenance if any job claims exist.
  - `curl -s http://localhost:3001/jobs?status=running | jq '.items | length'` — ensure all WorkerPal jobs have finished or are explicitly approved to keep running.
- **Sessions:** `curl -s http://localhost:3001/sessions/active | jq '.[] | {id, worker, status}'` — confirm interactive/autonomy sessions are closed or that you are tailing them intentionally.
- **Autonomy locks:** `curl -s http://localhost:3001/locks/autonomy | jq '.[] | {resource, holder}'` — document any lock you plan to restore.
- **State backup:** `cp apps/remotebuddy/remotebuddy-state.db /tmp/remotebuddy-state.$(date +%s).db` (Linux/macOS) or `Copy-Item .\apps\remotebuddy\remotebuddy-state.db "$env:TEMP\remotebuddy-state.$(Get-Date -Format yyyyMMddHHmmss).db"` (PowerShell), then verify the file exists.
- **Worktree confirmation:** declare the exact worktree(s) you plan to touch and prove they exist before editing anything.
  - Linux/macOS: `TARGET_WORKTREE="/repo/.../job-xxxx"; realpath "$TARGET_WORKTREE"; ls -ld "$TARGET_WORKTREE"; ls -ld "$(dirname "$TARGET_WORKTREE")"` — abort if `realpath` points outside the intended repo scope.
  - Windows PowerShell: `$TargetWorktree = "C:\repo\...\job-xxxx"; Resolve-Path $TargetWorktree; Get-ChildItem -Force (Split-Path $TargetWorktree -Parent) | Where-Object { $_.FullName -eq $TargetWorktree }` — abort if the directory is missing or the resolved path differs from the plan.
- **Log evidence:** capture timestamped command output for every check above. You will need it for the post-cleanup comparison.

### Controlled shutdown procedure
1. **Non-destructive discovery (always first).** Enumerate every RemoteBuddy PID and command line before touching anything—never jump straight to `pkill`/`Stop-Process -Force`.
   - Linux/macOS: `pgrep -fal remotebuddy_main | tee /tmp/remotebuddy-processes.txt` plus `pgrep -f remotebuddy_main > /tmp/remotebuddy.pids`, or `ps -eo pid,ppid,start,time,command | grep remotebuddy_main | grep -v grep`. Keep these files immutable until cleanup finishes.
   - Windows PowerShell: `Get-Process -Name remotebuddy*,bun -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, StartTime, Path | Tee-Object -FilePath $env:TEMP\remotebuddy-processes.txt | Export-Csv -Path $env:TEMP\remotebuddy-processes.csv -NoTypeInformation`. This preserves typed PID metadata for later import.
2. **Graceful stop gate.** Work only with the captured PIDs.
   - Linux/macOS: send SIGTERM (`kill -15 <pid>`) to each RemoteBuddy PID and wait for the processes to exit.
   - Windows PowerShell: `Stop-Process -Id <pid>` **without** `-Force` for each recorded PID.
   - Re-run the pre-cleanup checklist commands until request/job counts and autonomy/sessions match the recorded baseline.
3. **Mandatory safety gates before destructive actions.** Do **not** attempt forceful termination until all of the following are true:
   - RemoteBuddy services (bun dev/start or systemd units) are already stopped gracefully.
   - `requests?status=claimed`, `requests?status=queued`, `jobs?status=claimed`, and `jobs?status=running` all match the acceptable counts captured earlier.
   - The `remotebuddy-state.db` backup above completed successfully, the backup file exists off the repo path, and you have noted its location.
   - Target worktree paths to be touched are explicitly listed; `realpath`/`Resolve-Path` still points to the intended directories, and `ls`/`Get-ChildItem` output of their parents confirms no collateral directories.
4. **Destructive termination (last resort, document the reason).** If a PID refuses to exit but the gates above hold, force-kill **only** the specific PIDs from Step 1. Never blanket-kill `bun` or unrelated processes.
   - Linux/macOS example: `cat /tmp/remotebuddy.pids | xargs -n1 -I{} sh -c 'echo "Force-killing PID {}"; kill -9 {}'` where `/tmp/remotebuddy.pids` contains the previously captured PIDs.
   - Windows PowerShell example: `$processLog = Import-Csv $env:TEMP\remotebuddy-processes.csv; $processLog | Where-Object { $_.ProcessName -like "remotebuddy*" } | ForEach-Object { $pid = [int]$_.Id; Write-Host "Force-killing PID $pid ($($_.ProcessName))"; Stop-Process -Id $pid -Force }`. This keeps the force-kill list typed and auditable.
   - After forcing a PID down, immediately re-run the pre-cleanup checklist (including the job-claim check) to ensure queues, sessions, and locks remain in the expected state.

### Data and worktree safety gates
- Stop every RemoteBuddy service (CLI `bun run dev/start`, process supervisors, or systemd units) before touching `apps/remotebuddy` artifacts.
- Rerun the request/job/session/lock commands until `requests?status=claimed` and `jobs?status=claimed` return `0`, running-job counts match the baseline you captured, and session/lock output still matches expectations.
- Create fresh compressed backups of `remotebuddy-state.db` and any worktree directories slated for deletion (`tar -czf /tmp/remotebuddy-worktree.$(date +%s).tgz <worktree>` for Linux/macOS or `Compress-Archive -Path <worktree> -DestinationPath "$env:TEMP\remotebuddy-worktree.$(Get-Date -Format yyyyMMddHHmmss).zip"`). Keep the backup path in your maintenance log and confirm the archive exists.
- Write down each worktree path you will modify or remove, then `realpath`/`Resolve-Path` them and `ls` / `Get-ChildItem` the parent directory immediately before executing destructive commands to confirm scope and avoid collateral damage.

### Post-cleanup verification checklist
- **Requests:** `curl -s http://localhost:3001/requests?status=claimed | jq '.items | length'` must return `0`, and the queued count (`requests?status=queued`) must match the `Pre-cleanup` baseline.
- **Jobs:** both `curl -s http://localhost:3001/jobs?status=claimed | jq '.items | length'` and `curl -s http://localhost:3001/jobs?status=running | jq '.items | length'` must return `0`; reconcile any difference before declaring success.
- **Sessions:** `curl -s http://localhost:3001/sessions/active | jq '.[] | {id, worker, status}'` should show no unexpected sessions or locks.
- **Autonomy locks:** `curl -s http://localhost:3001/locks/autonomy | jq '.[] | {resource, holder}'` should be empty or match the documented restores.
- **Processes:** rerun the non-destructive process-list commands from Step 1 to confirm no RemoteBuddy-related PID is alive. If anything restarted, return to the graceful stop gate.
- **Evidence:** attach the before/after command output in the maintenance log so future operators can validate the cleanup deterministically.

Document these results (timestamps + command output) in the maintenance log so future operators can prove the cleanup completed deterministically.
