import { parseArgs } from "util";
import { resolve, join } from "path";
import { mkdirSync, existsSync } from "fs";
import { MergeQueueDB } from "./db";
import { FileLock } from "./lock";
import { GitOps } from "./git";
import { createStatusServer } from "./http";
import {
  loadConfig,
  applyCliOverrides,
  validateConfig,
  type SerialPusherConfig,
  type CheckConfig,
} from "./config";

type GitCmdResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const defaultSerialPusherRepoPath = join(repoRoot, ".worktrees", "serial-pusher");

// ─── CLI ────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    config: { type: "string", short: "c" },
    repo: { type: "string", short: "r" },
    server: { type: "string", short: "s" },
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
  -r, --repo <path>         Git repository path (default: $SERIAL_PUSHER_REPO_PATH or <repo>/.worktrees/serial-pusher)
  -s, --server <url>        PushPals server URL (default: http://localhost:3001)
  -p, --port <number>       HTTP status server port (default: 3002)
      --remote <name>       Git remote (default: origin)
  -b, --branch <name>       Integration branch name (default: $PUSHPALS_INTEGRATION_BRANCH or main_agents)
      --prefix <prefix>     Agent branch prefix (default: agent/)
  -i, --interval <seconds>  Poll interval in seconds (default: 10)
      --state-dir <path>    State directory for DB & lock (default: $PUSHPALS_DATA_DIR/serial-pusher)
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
if (typeof args.server === "string") cliOverrides.serverUrl = args.server;
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
const integrationBaseBranch = (process.env.PUSHPALS_INTEGRATION_BASE_BRANCH ?? "").trim() || "main";
const integrationBaseRef = `${config.remote}/${integrationBaseBranch}`;
const hasRepoPathOverride =
  typeof args.repo === "string" || (process.env.SERIAL_PUSHER_REPO_PATH ?? "").trim().length > 0;
const usingDefaultRepoPath =
  !hasRepoPathOverride && resolve(config.repoPath) === resolve(defaultSerialPusherRepoPath);

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

// ── Git Operations ─────────────────────────────────────────────────────────

const gitOps = new GitOps(config);

// ── HTTP server ─────────────────────────────────────────────────────────────

let server: ReturnType<typeof createStatusServer> | undefined;
try {
  server = createStatusServer(db, config.port);
  console.log(`[${ts()}] Status server listening on http://127.0.0.1:${config.port}`);
} catch (err: unknown) {
  const code = err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
  if (code === "EADDRINUSE") {
    console.error(`[${ts()}] Port ${config.port} already in use — status server disabled.`);
    console.error(`  TIP: kill the old process or use --port <N> / config "port" to pick another.`);
  } else {
    throw err;
  }
}

// ─── Poll loop ──────────────────────────────────────────────────────────────

let running = true;

async function tick(): Promise<void> {
  try {
    // ── Poll Completion Queue ──────────────────────────────────────────
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.authToken) {
      headers["Authorization"] = `Bearer ${config.authToken}`;
    }

    const pusherId = `pusher-${Math.random().toString(36).substring(2, 10)}`;

    const response = await fetch(`${config.serverUrl}/completions/claim`, {
      method: "POST",
      headers,
      body: JSON.stringify({ pusherId }),
    });

    if (!response.ok) {
      if (response.status !== 404) {
        console.error(`[${ts()}] Failed to claim completion: ${response.status}`);
      }
      return;
    }

    const data = (await response.json()) as {
      ok: boolean;
      completion?: {
        id: string;
        jobId: string;
        sessionId: string;
        commitSha: string;
        branch: string;
        message: string;
        status: string;
        pusherId: string;
        createdAt: string;
        updatedAt: string;
      };
      message?: string;
    };

    if (!data.ok || !data.completion) {
      return; // No completions available
    }

    const completion = data.completion;
    console.log(
      `[${ts()}] Claimed completion ${completion.id}: ${completion.branch} (${completion.commitSha.slice(0, 8)})`,
    );

    if (dryRun) {
      console.log(`[${ts()}] Dry run mode — skipping processing`);
      return;
    }

    // ── Process completion ─────────────────────────────────────────────
    try {
      // 1. Fetch branch from remote
      console.log(`[${ts()}] Fetching branch ${completion.branch}...`);
      await gitOps.fetchPrune();

      // 2. Create temp branch and merge
      const tempBranch = `_serial-pusher/${completion.id}`;
      console.log(`[${ts()}] Creating temp branch ${tempBranch}...`);

      await gitOps.resetToClean();
      await gitOps.checkoutMain();
      await gitOps.pullMainFF();
      await gitOps.syncMainWithBaseBranch();
      await gitOps.createTempBranch(tempBranch);

      console.log(`[${ts()}] Merging ${completion.branch} into ${tempBranch}...`);
      const mergeResult =
        config.mergeStrategy === "no-ff"
          ? await gitOps.mergeNoFF(completion.branch, `Merge ${completion.branch}`)
          : await gitOps.mergeFFOnly(completion.branch);

      if (!mergeResult.ok) {
        throw new Error(`Merge failed: ${mergeResult.stderr || mergeResult.stdout}`);
      }

      // 4. Run checks
      console.log(`[${ts()}] Running checks...`);
      for (const check of config.checks) {
        console.log(`[${ts()}]   - Running check: ${check.name}`);
        const checkResult = await runCheck(config.repoPath, check);

        if (!checkResult.ok) {
          throw new Error(`Check "${check.name}" failed: ${checkResult.output}`);
        }

        console.log(`[${ts()}]   ✓ Check passed: ${check.name}`);
      }

      // 5. Merge to main
      console.log(`[${ts()}] Merging ${tempBranch} to ${config.mainBranch}...`);
      await gitOps.checkoutMain();
      const ffResult = await gitOps.mergeFFOnlyRef(tempBranch);

      if (!ffResult.ok) {
        throw new Error(`FF merge to main failed: ${ffResult.stderr || ffResult.stdout}`);
      }

      console.log(`[${ts()}] ✓ Successfully merged ${completion.branch} to ${config.mainBranch}`);
      if (config.pushMainAfterMerge) {
        console.log(`[${ts()}] Pushing ${config.mainBranch} to ${config.remote}...`);
        const pushResult = await gitOps.pushMain();
        if (!pushResult.ok) {
          throw new Error(`Push failed: ${pushResult.stderr || pushResult.stdout}`);
        }
        console.log(`[${ts()}] Push succeeded for ${config.mainBranch}`);
      } else {
        console.log(`[${ts()}] pushMainAfterMerge=false - skipping push`);
      }

      // 6. Clean up temp branch
      await gitOps.deleteTempBranch(tempBranch);

      // 7. Mark completion as processed
      const markResponse = await fetch(
        `${config.serverUrl}/completions/${completion.id}/processed`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        },
      );

      if (!markResponse.ok) {
        console.error(`[${ts()}] Failed to mark completion processed: ${markResponse.status}`);
      } else {
        console.log(`[${ts()}] Marked completion ${completion.id} as processed`);
      }
    } catch (err: any) {
      console.error(`[${ts()}] Failed to process completion ${completion.id}: ${err.message}`);

      // Mark completion as failed
      const failResponse = await fetch(`${config.serverUrl}/completions/${completion.id}/fail`, {
        method: "POST",
        headers,
        body: JSON.stringify({ error: err.message }),
      });

      if (!failResponse.ok) {
        console.error(`[${ts()}] Failed to mark completion failed: ${failResponse.status}`);
      }
    }
  } catch (err: any) {
    console.error(`[${ts()}] Poll error: ${err.message}`);
  }
}

// Helper function to run a check
async function runCheck(
  repoPath: string,
  check: CheckConfig,
): Promise<{ ok: boolean; output: string }> {
  const timeoutMs = check.timeoutMs ?? 300_000;
  const isWindows = process.platform === "win32";
  const shell = isWindows ? ["cmd", "/c"] : ["sh", "-c"];

  const proc = Bun.spawn([...shell, check.command], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return { ok: exitCode === 0, output };
}

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolveAnswer) => {
    rl.question(`${question} [y/N]: `, (value) => resolveAnswer(value));
  });
  rl.close();

  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

async function runGitCapture(args: string[], cwd = repoRoot): Promise<GitCmdResult> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      ok: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: String(err),
      exitCode: 127,
    };
  }
}

async function ensureDefaultSerialPusherWorktree(): Promise<void> {
  if (!usingDefaultRepoPath) return;

  const probe = await runGitCapture(["-C", config.repoPath, "rev-parse", "--is-inside-work-tree"]);
  if (probe.ok) return;

  mkdirSync(resolve(config.repoPath, ".."), { recursive: true });

  const seedCandidates = [
    `${config.remote}/${config.mainBranch}`,
    config.mainBranch,
    integrationBaseRef,
    "HEAD",
  ];
  let seedRef = "HEAD";
  for (const ref of seedCandidates) {
    const exists = await runGitCapture(["rev-parse", "--verify", "--quiet", ref]);
    if (exists.ok) {
      seedRef = ref;
      break;
    }
  }

  const addResult = await runGitCapture(["worktree", "add", "--detach", config.repoPath, seedRef]);
  if (!addResult.ok) {
    throw new Error(
      `Failed to create default serial-pusher worktree (${config.repoPath}) from ${seedRef}: ${
        addResult.stderr || addResult.stdout
      }`,
    );
  }

  console.log(
    `[${ts()}] Created default serial-pusher worktree: ${config.repoPath} (seed: ${seedRef})`,
  );
}

async function ensureIntegrationBranchExists(): Promise<void> {
  const remoteRef = `${config.remote}/${config.mainBranch}`;
  if (await gitOps.revParse(remoteRef)) return;

  console.warn(`[${ts()}] Integration branch ${remoteRef} does not exist.`);

  const autoCreate = TRUTHY.has(
    (process.env.SERIAL_PUSHER_AUTO_CREATE_MAIN_BRANCH ?? "").toLowerCase(),
  );

  let approved = autoCreate;
  if (!approved) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        `Missing ${remoteRef}. Re-run interactively to approve creation, or set SERIAL_PUSHER_AUTO_CREATE_MAIN_BRANCH=1.`,
      );
    }

    approved = await promptYesNo(
      `Create ${config.mainBranch} from ${integrationBaseRef} and push ${config.mainBranch} to ${config.remote}?`,
    );
  }

  if (!approved) {
    throw new Error(`User declined creation of ${remoteRef}.`);
  }

  await gitOps.bootstrapMainBranchFromBase();
  console.log(
    `[${ts()}] Created ${remoteRef}; serial-pusher local integration branch is based on ${integrationBaseRef}.`,
  );
}

async function main(): Promise<void> {
  await ensureDefaultSerialPusherWorktree();
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

  await ensureIntegrationBranchExists();

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
  server?.stop();
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
