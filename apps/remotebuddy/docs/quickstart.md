# RemoteBuddy Quickstart (Deterministic Runbook)

_Last updated: 27 Feb 2026 — applies to the RemoteBuddy v2026.02 train._

> **Scope:** Every command is written for Bash/WSL shells launched from the PushPals repo root. Use WSL2 on Windows for parity; native PowerShell is intentionally out of scope so that each step stays deterministic.

This runbook turns a blank or previously used host into a reproducible RemoteBuddy stack. The numbered steps can be rerun as often as needed; the reset and verification commands make each iteration start from the same state.

## One-time prerequisites (per host)

1. **Codex CLI auth (manual prerequisite).** Codex CLI is required infrastructure. Sign in once on the host so later steps can run unattended:
   ```bash
   bunx --yes @openai/codex login
   codex login status
   ```
   - Keep the session alive (the start script will refuse to continue if Codex auth is missing).
   - **Non-interactive alternative:** If you cannot complete an interactive login (CI, remote shell), set the following in `.env` and skip the login prompt altogether:
     ```bash
     export OPENAI_API_KEY="sk-your-key"
     export PUSHPALS_OPENAI_CODEX_AUTH_MODE=api_key
     ```
     With API-key mode enabled the CLI relies purely on the key you provide, so no `codex login` prompt is triggered.
2. **Helper tooling.** Ensure `jq` and `sqlite3` are installed (macOS: `brew install jq sqlite`; Debian/Ubuntu/WSL: `sudo apt-get update && sudo apt-get install -y jq sqlite3`).

## Step 1 – Pin and verify Bun 1.1.30

RemoteBuddy is tested against Bun **1.1.30**. Install/upgrade to that exact patch so dependency resolution and runtime behavior match CI.

```bash
export BUN_VERSION="bun-v1.1.30"
curl -fsSL https://bun.sh/install | bash -s -- "$BUN_VERSION"
# Reload your shell so ~/.bun/bin is on PATH
test -x "$HOME/.bun/bin/bun" && exec "$SHELL" -l
bun --version  # should print 1.1.30
```
- Re-run the same install command any time you need to upgrade/downgrade; it is idempotent.
- If Bun lives outside `~/.bun`, set `BUN_INSTALL=/opt/bun` before running the installer.

## Step 2 – Install workspace dependencies deterministically

```bash
bun install --frozen-lockfile
bun run protocol:build
```
- `--frozen-lockfile` ensures `bun.lock` is honored exactly; deletions or additions abort instead of mutating the lockfile.
- When re-running after a failed attempt, first execute `bun pm cache rm --all` if you suspect cache corruption, then re-run the two commands above.

## Step 3 – Prepare `.env` and config via idempotent upserts

1. Seed local copies only if they do not exist:
   ```bash
   if [ ! -f .env ]; then cp .env.example .env; fi
   if [ ! -f config/local.toml ]; then cp config/local.example.toml config/local.toml; fi
   ```
2. Use the helper below whenever you need to set or update a key in `.env`. It replaces existing values instead of blindly appending duplicate lines:
   ```bash
   upsert_env() {
     python3 - "$1" "$2" <<'PY'
import os, sys
from pathlib import Path
key, value = sys.argv[1:3]
path = Path('.env')
lines = path.read_text().splitlines() if path.exists() else []
key_line = f"{key}="
updated = False
for idx, line in enumerate(lines):
    if line.startswith(key_line):
        lines[idx] = f"{key}={value}"
        updated = True
        break
if not updated:
    lines.append(f"{key}={value}")
path.write_text("\n".join(lines) + "\n")
PY
   }

   upsert_env PUSHPALS_AUTH_TOKEN "dev-local-token"
   upsert_env OPENAI_API_KEY "sk-your-key"
   # Force API-key auth if you used the non-interactive Codex path
   upsert_env PUSHPALS_OPENAI_CODEX_AUTH_MODE "api_key"
   ```
   Replace the placeholder values with your actual secrets. Re-run `upsert_env KEY VALUE` any time you need to change a value; the helper is safe to call repeatedly.

## Step 4 – Reset + verify the Server SQLite database (`outputs/data/pushpals.db`)

```bash
mkdir -p outputs/data
rm -f outputs/data/pushpals.db{,-shm,-wal}
sqlite3 outputs/data/pushpals.db <<'SQL'
PRAGMA journal_mode=WAL;
PRAGMA user_version;
SQL
sqlite3 outputs/data/pushpals.db 'PRAGMA integrity_check;'
```
- The `rm` call wipes any previous queue/session state so reenqueues behave identically between runs.
- `PRAGMA integrity_check` must print `ok`; anything else indicates disk or schema corruption and you should stop before proceeding.

## Step 5 – Reset + verify the RemoteBuddy SQLite database (`outputs/data/remotebuddy-state.db`)

```bash
rm -f outputs/data/remotebuddy-state.db{,-shm,-wal}
sqlite3 outputs/data/remotebuddy-state.db <<'SQL'
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS _bootstrap(key TEXT PRIMARY KEY, value TEXT);
SQL
sqlite3 outputs/data/remotebuddy-state.db 'PRAGMA integrity_check;'
```
- This file stores idempotency + session memory. Removing it before each deterministic run guarantees RemoteBuddy will not skip or replay prior requests.
- Keep a backup only when you intentionally need to preserve long-running context; otherwise treat the reset above as mandatory.

## Step 6 – Start the supporting services (new terminals)

1. **Server (Terminal A):**
   ```bash
   bun run server:only
   ```
   The script automatically points to `.env`. Wait for `Listening on http://0.0.0.0:3001`.
2. **WorkerPals (Terminal B):**
   ```bash
   bun run workerpals:only
   ```
   Confirm the log shows at least the configured idle workers coming online. Leave both terminals running for the remainder of the session.

## Step 7 – Launch RemoteBuddy and gate on readiness

1. **Start RemoteBuddy (Terminal C):**
   ```bash
   mkdir -p logs
   bun run remotebuddy:only 2>&1 | tee logs/remotebuddy.log
   ```
   Wait for the log line `planner ready` but do not proceed until the readiness loop passes.
2. **Run the readiness retry loop (Terminal D):** this polls `/system/status` until queue depth and worker idleness are healthy before you continue. It bails out after 10 attempts (≈2 minutes).
   ```bash
   set -a; source .env; set +a
   export PUSHPALS_AUTH_TOKEN=${PUSHPALS_AUTH_TOKEN:?set in .env}
   readiness_check() {
     curl -sf -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" \
       http://localhost:3001/system/status | \
       jq '(
            (.queues.requests.pending // 0) < 5 and
            (.queues.jobs.pending // 0) == 0 and
            (.workers.idle // 0) >= 2
          )'
   }

   attempt=0
   until readiness_check | grep -q true; do
     attempt=$((attempt + 1))
     if [ "$attempt" -ge 10 ]; then
       echo "[ready] RemoteBuddy did not become ready within 10 polls." >&2
       echo "Inspect logs/remotebuddy.log and /system/status for blockers." >&2
       exit 1
     fi
     echo "[ready] Pending queues still draining (attempt $attempt)..."
     sleep 12
   done
   echo "[ready] Queue + worker health gates satisfied."
   ```
   Do **not** continue to health assertions or smoke tests until the loop reports success; this guarantees every rerun waits for the same starting conditions. If it exits non-zero, resolve the underlying issue, re-run Steps 4–7, and document the failure in `#pushpals-ops`.

## Step 8 – Smoke test RemoteBuddy + verify DB state

1. **Enqueue a deterministic request:**
   ```bash
   curl -sS -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" \
     -H "Content-Type: application/json" \
     http://localhost:3001/requests/enqueue \
     -d '{"sessionId":"dev","prompt":"remotebuddy quickstart smoke","priority":"interactive","metadata":{"source":"quickstart"}}'
   ```
   Note the `requestId` returned.
2. **Confirm RemoteBuddy handled it:** tail `logs/remotebuddy.log` for the `requestId` and wait for `request completed`.
3. **Verify the databases captured the run:**
   ```bash
   sqlite3 outputs/data/pushpals.db 'SELECT count(*) FROM requests WHERE metadata LIKE "%quickstart%";'
   sqlite3 outputs/data/remotebuddy-state.db 'SELECT count(*) FROM idempotency WHERE request_id IS NOT NULL;'
   ```
   Both commands should return a value ≥ 1; rerunning the smoke test after a reset should increment consistently.
4. **Queue/worker assertion:**
   ```bash
   curl -sS -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" http://localhost:3001/system/status \
     | jq '{pending: .queues.requests.pending, jobPending: .queues.jobs.pending, idle: .workers.idle}'
   ```
   Healthy output shows `pending: 0`, `jobPending: 0`, and `idle >= 2` immediately after the smoke completes. If any field violates those bounds, stop RemoteBuddy, repeat Steps 4–7, and only then accept traffic.

## Rerun checklist

For every subsequent startup on the same host, repeat Steps **4–8** in order. That sequence clears residual queue state, revalidates the SQLite files, and enforces the readiness gate before you trust worker/queue health again.
