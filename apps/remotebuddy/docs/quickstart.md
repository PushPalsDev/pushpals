# RemoteBuddy Quickstart

_Last updated: 27 Feb 2026 — validated against RemoteBuddy v2026.02 on Bun 1.1.x._

This playbook turns a fresh workstation into a deterministic RemoteBuddy operator node. Follow
every numbered step in order—each one is self-contained and rerunnable so you can recover quickly
after failures or host rebuilds.

## Prerequisites

### Tooling baseline

| Item | Required version | Purpose | Verification |
| --- | --- | --- | --- |
| Git | ≥ 2.44 | Clone repo + keep worktrees in sync | `git --version` |
| Bun | 1.1.x (latest stable) | Runtime + package manager | `bun --version` |
| Docker Desktop / Engine | ≥ 24.0 | WorkerPals auto-spawn (default `workerpal_docker=true`) | `docker version` |
| Python | 3.11+ on PATH | WorkerPals OpenHands + MiniSWE backends | `python3 --version` |
| Codex CLI | Latest (auto-updates) | Mandatory orchestration/runtime integration | `codex --version && codex login` |
| jq | ≥ 1.6 | Inspect `/system/status` responses | `jq --version` |

> Keep Docker running and signed in before starting any services. Codex CLI auth must succeed—do
> not bypass it. If `codex login` fails, stop and resolve credentials before proceeding.

### Secrets, env vars, and services

Populate these in `.env` (or export them in your shell) before starting services:

- `PUSHPALS_AUTH_TOKEN` – bearer token for Server/RemoteBuddy/WorkerPals RPCs.
- `OPENAI_API_KEY` (or per-service overrides such as `REMOTEBUDDY_LLM_API_KEY`) — required when
  `remotebuddy.llm.backend=openai`.
- `PUSHPALS_SERVER_URL` (default `http://localhost:3001`) — matches the Server listener address.
- `REMOTE_STABLE_ID` – freeform identifier for this RemoteBuddy pod, used in telemetry threads.
- `WORKERPALS_API_URL` – URL RemoteBuddy hits for worker control-plane operations.
- Optional Git access (`PUSHPALS_GIT_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`) if RemoteBuddy must push
  commits via SourceControlManager.

Required background services/resources:

- Docker daemon up with the `pushpals-worker-sandbox:latest` image pulled (the `start` script can
  build it, but pulling ahead avoids first-run latency).
- LLM endpoint reachable at the URL specified in `config/local.toml` (OpenAI, LM Studio, etc.).
- Network access to the Git remote used by SourceControlManager (`origin/main_agents` by default).

## Step 1 – Install Bun 1.1.x

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
exec $SHELL -l
bun --version  # expect 1.1.x

# Windows PowerShell / WSL
irm https://bun.sh/install.ps1 | iex
bun --version
```

If you already have Bun, upgrade deterministically via `bun upgrade --canary --exact 1.1.x`.

## Step 2 – Clone (or update) the repo

```bash
git clone git@github.com:pushpals/pushpals.git
cd pushpals
# or, if the repo is present already
git fetch origin && git switch main_agents && git pull
```

All following commands assume you run them from the repo root.

## Step 3 – Configure the environment

```bash
cp .env.example .env            # only if .env does not exist yet
cp config/local.example.toml config/local.toml
mkdir -p outputs/data

# Append required secrets (replace placeholders!)
cat <<'EOF' >> .env
PUSHPALS_AUTH_TOKEN=replace-me
REMOTE_STABLE_ID=remotebuddy-dev-01
WORKERPALS_API_URL=http://localhost:3004
OPENAI_API_KEY=replace-me
PUSHPALS_SERVER_URL=http://localhost:3001
EOF

# Verify Codex CLI auth so RemoteBuddy/WorkerPals may delegate to it later
codex --version
codex login
```

Update `config/local.toml` if you need to point `remotebuddy.llm.endpoint` or data directories to
non-default locations. Keep `paths.data_dir` aligned with `PUSHPALS_DATA_DIR`.

## Step 4 – Install dependencies and build shared protocol

```bash
bun install                 # installs root + workspace deps
bun run protocol:build      # generates protocol artifacts RemoteBuddy imports
```

Run `bun install` again whenever `bun.lock` changes to keep local packages deterministic.

## Step 5 – Bootstrap the SQLite stores (database migration)

The Server and RemoteBuddy components auto-migrate their SQLite schemas on startup (see
`apps/server/src/db.ts`, `apps/server/src/requests.ts`, and `apps/remotebuddy/src/idempotency.ts`).
Run the Server once to create `outputs/data/pushpals.db`, then stop it so you can proceed with a
clean state.

```bash
PUSHPALS_DATA_DIR=outputs/data \
REMOTEBUDDY_DB_PATH=outputs/data/remotebuddy-state.db \
bun run server:only --env-file .env
# wait for "[server] listening on http://localhost:3001" then Ctrl+C

ls -lh outputs/data/pushpals.db                 # confirms migrations ran
```

RemoteBuddy will initialize `outputs/data/remotebuddy-state.db` automatically the first time the
process starts; no manual SQL is required.

## Step 6 – Start core services

Launch each service in its own terminal so logs stay isolated:

1. **Server (queue + SSE)**

   ```bash
   PUSHPALS_DATA_DIR=outputs/data bun run server:only --env-file .env
   ```

2. **WorkerPals (Docker-backed workers)**

   ```bash
   # Requires Docker daemon + pushpals-worker-sandbox:latest image
   PUSHPALS_DATA_DIR=outputs/data \
   WORKERPALS_DOCKER_IMAGE=pushpals-worker-sandbox:latest \
   bun run workerpals:only:docker
   ```

3. **RemoteBuddy**

   ```bash
   # Uses .env + config/local.toml for auth, LLM, and queue endpoints
   bun run remotebuddy:only
   ```

RemoteBuddy logs `planner ready` once it has claimed its first request cursor. Use
`bun run remotebuddy:only:watch` if you prefer the live-reload dev loop.

## Step 7 – Validate the stack

1. Confirm Server health and queue metrics:

   ```bash
   curl -sS http://localhost:3001/system/status | \
     jq '{queue_p95: .slo.requests.queueWaitMs.p95, pending: .queues.requests.pending, workers: .workers.online}'
   ```

   Expect low pending counts and ≥1 worker per lane.

2. Run the docs linter to ensure the repo is in a lint-clean state before committing or opening a
   PR:

   ```bash
   bun run lint:docs
   ```

   Address any failures before distributing the quickstart or shipping a change.

Once these checks pass, RemoteBuddy is ready to take traffic or enqueue synthetic smoke tests.
