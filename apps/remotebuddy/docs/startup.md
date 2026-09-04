# RemoteBuddy startup and readiness

The supported source-checkout entrypoint is the repository-level startup supervisor:

```bash
bun run start
```

It performs the real preflight work for the complete stack: configuration/template checks, dependencies, `vision.md`, LLM/Codex readiness, port ownership, Git integration/worktree safety, WorkerPal Docker image preparation, optional warmup, and managed service supervision.

## Prerequisites

- Run from the target Git repository root.
- Bun must be 1.3.14 or newer.
- Install workspace dependencies with `bun install` when they are not already present.
- Create machine-specific configuration in `configs/local.toml` and secrets in `.env` as needed for the selected model/backend.
- Ensure the configured Server port is available.
- Ensure Docker is running when the effective WorkerPal configuration requires Docker.

The canonical key set and defaults are in [`configs/default.toml`](../../../configs/default.toml). RemoteBuddy accepts only `--server`, `--sessionId`, and `--token` as direct CLI flags. The current local-only network policy normalizes Server to loopback and ignores the token flag.

## Full-stack startup

`bun run start` is preferred because it checks the dependencies that RemoteBuddy itself does not validate before entering its polling loop. It starts Server before the dependent services and supervises their process trees.

LocalBuddy is optional. RemoteBuddy and WorkerPals are the services required to turn a queued repository request into executed work. SourceControlManager is required for configured publication/finalization behavior.

Do not use `bun run dev:full` as an operational preflight substitute. It is a development convenience that launches processes concurrently and deliberately skips the complete startup checks.

## RemoteBuddy-only startup

When Server and the rest of the runtime are already managed separately:

```bash
bun run protocol:build
bun run remotebuddy:only
```

`remotebuddy:only` runs `src/remotebuddy_supervisor.ts`, which starts `remotebuddy_main.ts`. For development, `bun run remotebuddy:only:watch` runs the main process directly and bypasses crash supervision.

RemoteBuddy-only startup does not:

- Start Server.
- Run the repository-level preflight suite.
- Build or validate the WorkerPal Docker image.
- Start SourceControlManager.
- Prove that a WorkerPal can execute a job.

It does retry Server session creation indefinitely with exponential backoff capped at 30 seconds. Once connected, WorkerPal prewarming runs asynchronously; the planner can be online while worker capacity is still starting or unavailable.

## Readiness evidence

Check Server first:

```bash
curl -sS http://127.0.0.1:3001/healthz
curl -sS http://127.0.0.1:3001/system/status
```

RemoteBuddy readiness is established by its process logs and session status event; it has no HTTP health endpoint. Expected logs include:

```text
[RemoteBuddy] PushPals RemoteBuddy Orchestrator
[RemoteBuddy] Using session: ...
[RemoteBuddy] Worker scheduler: min=... max=... autoSpawn=...
[RepositoryAgent] Started shared repository capability (...)
[RemoteBuddy] Starting polling loop (every ...ms)
```

Worker execution readiness is separate:

```bash
curl -sS "http://127.0.0.1:3001/workers?ttlMs=15000"
curl -sS "http://127.0.0.1:3001/workers/autoscale?ttlMs=15000"
```

An online worker has a current heartbeat and `isOnline=true`. If auto-spawn is enabled, RemoteBuddy logs prewarming, spawning, startup timeout, and cooldown outcomes.

For an end-to-end readiness check, submit a bounded request through a normal client and follow its returned request/job IDs. Do not use a fabricated `probe.remote_startup` metric as proof; no production synthetic-probe integration exists in this repository.

## Crash supervision

The supervisor reads:

- `remotebuddy.crash_restart_enabled`
- `remotebuddy.crash_restart_max_restarts`
- `remotebuddy.crash_restart_backoff_ms`

It restarts only unexpected nonzero exits, up to the configured number of restarts. Exit 0 and normal SIGINT/SIGTERM shutdowns are not restarted. It forwards shutdown by terminating the child process tree and strips the SCM repair-authority secret from the child environment.

If the limit is reached, the log is explicit:

```text
[RemoteBuddySupervisor] RemoteBuddy exited with code ...; restart limit reached (.../...)
```

## Common startup failures

| Symptom                          | Check                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| Repeated `Server unavailable`    | Server process, loopback URL/port, then `/healthz`.                                          |
| Planner starts but requests fail | Effective `[remotebuddy.llm]` backend, endpoint, model, and Codex/API authentication.        |
| `Auto-spawn disabled`            | WorkerPal runtime bundle/entrypoint availability and packaged Windows launcher inputs.       |
| Worker did not report online     | Docker availability/image when required, WorkerPal process logs, configured startup timeout. |
| Auto-spawn enters cooldown       | Prior spawn error/exit and `crash_restart_backoff_ms`.                                       |
| RepositoryAgent unhealthy        | `[RepositoryAgent]` logs and `queues.repositoryAgentHealth` in `/system/status`.             |
| Autonomy does not start          | `remotebuddy.autonomy.enabled`, kill switch, startup grace, and safety/eligibility state.    |

## Configuration reload behavior

RemoteBuddy periodically reloads configuration only to apply `remotebuddy.autonomy.enabled`. Restart it after changing model, memory, polling, worker scheduling, Docker, budget, or supervisor settings.

## Shutdown and restart

Use the owning supervisor's normal stop mechanism or Ctrl+C. RemoteBuddy stops autonomy and RepositoryAgent work, closes event subscriptions, closes its recent-job/planning-memory database handles, emits a shutting-down status, and terminates WorkerPals it spawned. The separately instantiated legacy `IdempotencyStore` has no explicit shutdown call in the current main path; process exit releases that handle.

Keep `outputs/data/pushpals.db` and `outputs/data/remotebuddy-state.db` for ordinary restarts. `bun run start -c` deliberately clears scoped runtime data and must not be used as a routine recovery command.

## About `src/startup/checklist.ts`

The `startup/checklist.ts` module defines and tests a dependency-injected checklist abstraction for Bun, Docker, repository, alert, synthetic, and dispatch checks. No production source imports or invokes `runStartupPreflight` today. Its Alertmanager and synthetic-probe interfaces are test doubles/contracts, not proof that those integrations exist.

Use `scripts/start.ts` (`bun run start`) as the source of truth for current startup behavior. If the checklist module is wired into production later, update this document in the same change.
