import { parseArgs } from "util";
import { resolve, join } from "path";
import { mkdirSync, existsSync } from "fs";
import { MergeQueueDB } from "./db";
import { FileLock } from "./lock";
import { GitOps } from "./git";
import { JobRunner } from "./runner";
import { createStatusServer } from "./http";
import { loadConfig, applyCliOverrides, validateConfig, type SerialPusherConfig } from "./config";

// ─── CLI ────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    config: { type: "string", short: "c" },
    repo: { type: "string", short: "r" },
    port: { type: "string", short: "p" },
    remote: { type: "string" },
    branch: { type: "string", short: "b" },
    prefix: { type: "string" },
    interval: { type: "string", short: "i" },
    "state-dir": { type: "string" },
    "delete-after-merge": { type: "boolean" },
    "dry-run": { type: "boolean" },
    "skip-clean-check": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  strict: false,
});

if (args.help) {
  console.log(`
serial-pusher — Git merge queue daemon

Usage:
  bun run apps/serial-pusher/src/index.ts [options]

Options:
  -c, --config <path>       Config file path (default: serial-pusher.config.json)
  -r, --repo <path>         Git repository path (default: cwd)
  -p, --port <number>       HTTP status server port (default: 3002)
      --remote <name>       Git remote (default: origin)
  -b, --branch <name>       Main branch name (default: main)
      --prefix <prefix>     Agent branch prefix (default: agent/)
  -i, --interval <seconds>  Poll interval in seconds (default: 10)
      --state-dir <path>    State directory for DB & lock (default: ./state)
      --delete-after-merge  Delete remote branch after merge
      --dry-run             Discover and enqueue only, do not process
      --skip-clean-check    Skip the clean-repo guard (for dev working copies)
  -h, --help                Show this help
`);
  process.exit(0);
}

// ─── Config ─────────────────────────────────────────────────────────────────

const configPath =
  args.config && typeof args.config === "string" ? resolve(args.config) : undefined;

// Search for config: explicit path > cwd > app-local default
function resolveConfigPath(): string | undefined {
  if (configPath) return configPath;
  const candidates = [
    resolve("serial-pusher.config.json"),
    resolve("apps/serial-pusher/serial-pusher.config.json"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

const resolvedConfig = resolveConfigPath();
let config = loadConfig(resolvedConfig);

const cliOverrides: Partial<SerialPusherConfig> = {};
if (typeof args.repo === "string") cliOverrides.repoPath = resolve(args.repo);
if (typeof args.port === "string") {
  const n = parseInt(args.port, 10);
  if (Number.isFinite(n) && n > 0) cliOverrides.port = n;
  else {
    console.error(`Invalid --port value: ${args.port}`);
    process.exit(1);
  }
}
if (typeof args.remote === "string") cliOverrides.remote = args.remote;
if (typeof args.branch === "string") cliOverrides.mainBranch = args.branch;
if (typeof args.prefix === "string") cliOverrides.branchPrefix = args.prefix;
if (typeof args.interval === "string") {
  const n = parseInt(args.interval, 10);
  if (Number.isFinite(n) && n > 0) cliOverrides.pollIntervalSeconds = n;
  else {
    console.error(`Invalid --interval value: ${args.interval}`);
    process.exit(1);
  }
}
if (typeof args["state-dir"] === "string") cliOverrides.stateDir = resolve(args["state-dir"]);
if (args["delete-after-merge"]) cliOverrides.deleteAfterMerge = true;

config = applyCliOverrides(config, cliOverrides);

// Validate config before proceeding
try {
  validateConfig(config);
} catch (err: any) {
  console.error(err.message);
  process.exit(1);
}

const dryRun = args["dry-run"] === true;
const TRUTHY = new Set(["1", "true", "yes", "on"]);
const skipCleanCheckFlag = args["skip-clean-check"] === true;
const skipCleanCheckEnv = TRUTHY.has(
  (process.env.SERIAL_PUSHER_SKIP_CLEAN_CHECK ?? "").toLowerCase(),
);
const skipCleanCheck = skipCleanCheckFlag || skipCleanCheckEnv;

// ─── Bootstrap ──────────────────────────────────────────────────────────────

const ts = () => new Date().toISOString();

console.log(`[${ts()}] serial-pusher starting`);
console.log(`[${ts()}]   config:   ${resolvedConfig ?? "(defaults)"}`);
console.log(`[${ts()}]   repo:     ${config.repoPath}`);
console.log(`[${ts()}]   remote:   ${config.remote}`);
console.log(`[${ts()}]   main:     ${config.mainBranch}`);
console.log(`[${ts()}]   prefix:   ${config.branchPrefix}`);
console.log(`[${ts()}]   interval: ${config.pollIntervalSeconds}s`);
console.log(`[${ts()}]   state:    ${config.stateDir}`);
console.log(`[${ts()}]   port:     ${config.port}`);
console.log(`[${ts()}]   checks:   ${config.checks.length}`);
if (dryRun) console.log(`[${ts()}]   mode:     DRY RUN`);
if (skipCleanCheck) {
  const source = skipCleanCheckFlag
    ? "--skip-clean-check flag"
    : "SERIAL_PUSHER_SKIP_CLEAN_CHECK env";
  console.log(`[${ts()}]   mode:     SKIP CLEAN CHECK (${source})`);
}

// Ensure state directory exists
mkdirSync(config.stateDir, { recursive: true });

// ── Lock ────────────────────────────────────────────────────────────────────

const lock = new FileLock(config.stateDir);
if (!lock.acquire()) {
  console.error(`[${ts()}] Another serial-pusher instance is already running. Exiting.`);
  process.exit(1);
}
console.log(`[${ts()}] Lock acquired`);

// ── Database ────────────────────────────────────────────────────────────────

const dbPath = join(config.stateDir, "merge_queue.db");
const db = new MergeQueueDB(dbPath);
console.log(`[${ts()}] Database opened: ${dbPath}`);

// Recover any jobs stuck in 'running' from a previous crash
const recovered = db.recoverStuckJobs();
if (recovered > 0) {
  console.log(`[${ts()}] Recovered ${recovered} stuck running job(s) -> queued`);
}

// ── Git + Runner ────────────────────────────────────────────────────────────

const gitOps = new GitOps(config);
const runner = new JobRunner(config);

// ── HTTP server ─────────────────────────────────────────────────────────────

const server = createStatusServer(db, config.port);
console.log(`[${ts()}] Status server listening on http://127.0.0.1:${config.port}`);

// ─── Poll loop ──────────────────────────────────────────────────────────────

let running = true;

async function tick(): Promise<void> {
  try {
    // ── Fetch & discover ──────────────────────────────────────────────
    await gitOps.fetchPrune();
    const branches = await gitOps.discoverAgentBranches();

    // ── Enqueue new branches ──────────────────────────────────────────
    let enqueued = 0;
    for (const { branch, sha } of branches) {
      const lastSeen = db.getSeenSha(config.remote, branch);
      if (lastSeen === sha) continue; // No new commits

      const jobId = db.enqueue(config.remote, branch, sha);
      if (jobId !== null) {
        enqueued++;
        console.log(`[${ts()}] Enqueued: ${branch} (sha: ${sha.slice(0, 8)}) -> job #${jobId}`);
        db.updateSeen(config.remote, branch, sha);
      } else {
        // UNIQUE constraint hit — job already existed for this sha.
        // Still update seen so we don't re-attempt enqueue next tick.
        db.updateSeen(config.remote, branch, sha);
      }
    }

    if (enqueued > 0) {
      console.log(`[${ts()}] Enqueued ${enqueued} new job(s)`);
    }

    // Prune seen rows for branches that no longer exist on the remote
    const activeBranchSet = new Set(branches.map((b) => b.branch));
    const pruned = db.pruneSeenBranches(config.remote, activeBranchSet);
    if (pruned > 0) {
      console.log(`[${ts()}] Pruned ${pruned} stale seen branch(es)`);
    }

    // ── Process queue (drain all available jobs in this tick) ─────────
    if (dryRun) return;

    let job = db.claimNext();
    while (job) {
      console.log(`[${ts()}] Processing job #${job.id}: ${job.branch} (attempt ${job.attempts})`);

      const result = await runner.processJob(job, db);

      console.log(`[${ts()}] Job #${job.id} result: ${result.status} — ${result.message}`);

      // Claim next immediately (still serial — one at a time)
      job = db.claimNext();
    }
  } catch (err: any) {
    console.error(`[${ts()}] Poll error: ${err.message}`);
  }
}

async function main(): Promise<void> {
  // ── Startup safety check ──────────────────────────────────────────────
  // Skip source is already logged in the boot banner (mode: SKIP CLEAN CHECK).
  if (!skipCleanCheck) {
    // Ensure the repo is clean before we start. We don't run git clean -fd
    // during normal operation, so a dirty repo is a sign of misconfiguration.
    // Retry if `git status` itself fails (e.g. transient I/O error), but
    // always crash if the repo is genuinely dirty.
    let clean: boolean | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        clean = await gitOps.isRepoClean();
        break;
      } catch (err: any) {
        if (attempt >= 10) throw err; // give up after 10 tries
        const delay = Math.min(2000 * 2 ** (attempt - 1), 30_000);
        console.error(
          `[${ts()}] git status failed (${err.message}), retrying in ${(delay / 1000).toFixed(1)}s… (attempt ${attempt})`,
        );
        await Bun.sleep(delay);
      }
    }

    if (!clean) {
      console.error(
        `[${ts()}] ERROR: Repository at ${config.repoPath} has uncommitted or untracked changes.`,
      );
      console.error(`[${ts()}] The serial-pusher requires a dedicated clean clone. Exiting.`);
      console.error(`[${ts()}] WARNING: Do not run this daemon in a developer working copy.`);
      console.error(`[${ts()}] TIP: Pass --skip-clean-check to bypass this guard in dev.`);
      shutdown();
      process.exit(1);
    }
    console.log(`[${ts()}] Repo is clean`);
  }

  // Initial tick — retry on transient errors (e.g. remote unreachable)
  for (let attempt = 1; ; attempt++) {
    try {
      await tick();
      break;
    } catch (err: any) {
      if (attempt >= 10) throw err;
      const delay = Math.min(2000 * 2 ** (attempt - 1), 30_000);
      console.error(
        `[${ts()}] Initial tick failed (${err.message}), retrying in ${(delay / 1000).toFixed(1)}s… (attempt ${attempt})`,
      );
      await Bun.sleep(delay);
    }
  }

  // Polling loop
  while (running) {
    await Bun.sleep(config.pollIntervalSeconds * 1000);
    await tick();
  }
}

// ─── Shutdown ───────────────────────────────────────────────────────────────

function shutdown(): void {
  if (!running) return;
  running = false;
  console.log(`\n[${ts()}] Shutting down...`);
  server.stop();
  db.close();
  lock.release();
  console.log(`[${ts()}] Goodbye.`);
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(130);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(143);
});

// ─── Start ──────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`[${ts()}] Fatal: ${err.message}`);
  shutdown();
  process.exit(1);
});
