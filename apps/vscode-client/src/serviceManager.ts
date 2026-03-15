import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import * as vscode from "vscode";
import { normalizeVscodeServerUrl } from "./local_server_url";
import { looksLikePushPalsSourceCheckout } from "./repo";
import { formatCommandForLog, validateDockerImageName } from "./safety";
import {
  computeLocalBuddyRestartBackoffMs,
  DEFAULT_LOCALBUDDY_PORT,
  loadRuntimeConfigSnapshotFromFiles,
  resolveLocalBuddyRuntimeAction,
  resolveLocalBuddyStartGate,
  type RuntimeConfigSnapshot,
} from "./runtimeServicePolicy";
import { assertWorkspaceTrusted } from "./workspaceTrust";

type StackLaunchMode = "source_checkout" | "installed_cli";

type ServiceDefinition = {
  id: string;
  label: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

type RunningService = {
  def: ServiceDefinition;
  process: ChildProcessWithoutNullStreams;
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type CliManagedRuntime = {
  command: string;
  args: string[];
  process: ChildProcessWithoutNullStreams;
  workspaceRoot: string;
  stopRequested: boolean;
};

const DEFAULT_WORKER_IMAGE = "pushpals-worker-sandbox:latest";
const DEFAULT_SERVER_URL = "http://127.0.0.1:3001";
const DEFAULT_CLI_BOOT_TIMEOUT_MS = 90_000;
const LOCALBUDDY_RUNTIME_CONFIG_POLL_MS = 2_000;
const LOCALBUDDY_STABLE_UPTIME_MS = 10_000;
const LOCALBUDDY_MAX_CONSECUTIVE_FAILURES = 5;

export class StackServiceManager implements vscode.Disposable {
  private readonly running = new Map<string, RunningService>();
  private readonly onDidChangeRunningEmitter = new vscode.EventEmitter<boolean>();
  readonly onDidChangeRunning = this.onDidChangeRunningEmitter.event;
  private stopping = false;
  private stackWorkspaceRoot: string | null = null;
  private launchMode: StackLaunchMode | null = null;
  private cliRuntime: CliManagedRuntime | null = null;
  private localBuddyRuntimeEnabled = false;
  private localBuddyPort = DEFAULT_LOCALBUDDY_PORT;
  private localBuddyConfigPollTimer: ReturnType<typeof setInterval> | null = null;
  private localBuddyConfigPollInFlight = false;
  private localBuddyStopRequested = false;
  private localBuddyStabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private localBuddyConsecutiveFailures = 0;
  private localBuddyRetryAfterMs = 0;
  private localBuddyRestartLimitLogged = false;

  constructor(private readonly output: vscode.OutputChannel) {}

  isRunning(): boolean {
    return this.running.size > 0 || this.cliRuntime !== null;
  }

  async startStack(workspaceRoot: string): Promise<void> {
    if (this.isRunning()) {
      this.output.appendLine("[stack] Start skipped: stack already running.");
      return;
    }
    assertWorkspaceTrusted(vscode.workspace.isTrusted);
    this.stackWorkspaceRoot = workspaceRoot;
    this.launchMode = looksLikePushPalsSourceCheckout(workspaceRoot)
      ? "source_checkout"
      : "installed_cli";

    if (this.launchMode === "installed_cli") {
      await this.startInstalledCliRuntime(workspaceRoot);
      return;
    }

    const workerImage = this.workerDockerImage();
    await this.runOneShot("bun", ["--version"], workspaceRoot, "Checking Bun runtime");
    await this.runSharedPreflight(workspaceRoot);
    await this.runOneShot(
      "bun",
      ["run", "protocol:build"],
      workspaceRoot,
      "Building protocol package",
    );
    await this.ensureDockerReady(workspaceRoot, workerImage);
    const runtimeSnapshot = await this.readRuntimeConfigSnapshot(workspaceRoot);
    this.localBuddyRuntimeEnabled = runtimeSnapshot.localbuddy.enabled;
    this.localBuddyPort = runtimeSnapshot.localbuddy.port;
    this.localBuddyStopRequested = false;
    this.clearLocalBuddyStabilityTimer();
    this.resetLocalBuddyRestartBudget();
    if (this.localBuddyRuntimeEnabled) {
      await this.ensureLocalBuddyStartReady(workspaceRoot);
    }

    const definitions: ServiceDefinition[] = [
      { id: "server", label: "Server", command: "bun", args: ["run", "server:only"] },
      { id: "remotebuddy", label: "RemoteBuddy", command: "bun", args: ["run", "remotebuddy:only"] },
      {
        id: "workerpals",
        label: "WorkerPals",
        command: "bun",
        args: ["run", "workerpals:only:docker"],
        env: { WORKERPALS_DOCKER_IMAGE: workerImage },
      },
    ];
    if (this.localBuddyRuntimeEnabled) {
      definitions.splice(1, 0, this.localBuddyServiceDefinition());
    }
    if (this.includeSourceControlManager()) {
      definitions.push({
        id: "source_control_manager",
        label: "Source Control Manager",
        command: "bun",
        args: ["run", "source_control_manager:only:dev"],
      });
    }

    this.output.appendLine(`[stack] Starting ${definitions.length} services...`);
    for (const def of definitions) this.spawnService(def, workspaceRoot);
    this.startLocalBuddyRuntimeConfigPolling(workspaceRoot);
    this.onDidChangeRunningEmitter.fire(true);
  }

  async stopStack(workspaceRoot: string, options?: { bypassTrust?: boolean }): Promise<void> {
    if (!options?.bypassTrust) assertWorkspaceTrusted(vscode.workspace.isTrusted);
    if (!this.isRunning()) {
      this.stopLocalBuddyRuntimeConfigPolling();
      this.clearLocalBuddyStabilityTimer();
      this.stackWorkspaceRoot = null;
      this.launchMode = null;
      this.localBuddyStopRequested = false;
      this.resetLocalBuddyRestartBudget();
      this.output.appendLine("[stack] Stop skipped: no running services.");
      return;
    }

    if (this.cliRuntime) {
      await this.stopInstalledCliRuntime(workspaceRoot);
      return;
    }

    this.stopping = true;
    this.stopLocalBuddyRuntimeConfigPolling();
    this.clearLocalBuddyStabilityTimer();
    const services = [...this.running.values()].reverse();
    const failures: string[] = [];
    for (const service of services) {
      try {
        await this.stopService(workspaceRoot, service);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        failures.push(`${service.def.label}: ${detail}`);
        this.output.appendLine(`[stack] ${service.def.label} stop error: ${detail}`);
      }
    }
    await Promise.all(services.map((service) => this.waitForExit(service.process, 1_500)));
    this.stopping = false;

    if (this.running.size === 0) {
      this.onDidChangeRunningEmitter.fire(false);
      this.stackWorkspaceRoot = null;
      this.launchMode = null;
      this.localBuddyRuntimeEnabled = false;
      this.localBuddyPort = DEFAULT_LOCALBUDDY_PORT;
      this.localBuddyStopRequested = false;
      this.resetLocalBuddyRestartBudget();
      this.output.appendLine("[stack] All services stopped.");
      return;
    }

    const stillRunning = [...this.running.values()].map(
      (service) => `${service.def.label} (pid=${service.process.pid ?? "unknown"})`,
    );
    const problems = [...failures, ...stillRunning.map((entry) => `${entry}: still running`)];
    throw new Error(`Failed to stop all services: ${problems.join("; ")}`);
  }

  dispose(): void {
    this.stopLocalBuddyRuntimeConfigPolling();
    this.clearLocalBuddyStabilityTimer();
    this.cliRuntime = null;
    this.launchMode = null;
    this.onDidChangeRunningEmitter.dispose();
  }

  private async runSharedPreflight(workspaceRoot: string): Promise<void> {
    await this.runOneShot(
      "bun",
      ["run", "scripts/client-preflight.ts", "--client", "vscode"],
      workspaceRoot,
      "Running shared startup preflight",
    );
  }

  private cliCommand(): string {
    const configured = String(
      vscode.workspace.getConfiguration("pushpals").get<string>("cliCommand") ?? "",
    ).trim();
    if (configured) return configured;
    return process.platform === "win32" ? "pushpals.cmd" : "pushpals";
  }

  private cliRuntimeArgs(): string[] {
    return ["--runtime-only"];
  }

  private serverUrl(): string {
    const configured =
      vscode.workspace.getConfiguration("pushpals").get<string>("serverUrl") ??
      DEFAULT_SERVER_URL;
    return normalizeVscodeServerUrl(configured);
  }

  private async probeServerHealth(timeoutMs = 1_000): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.serverUrl()}/healthz`, {
        method: "GET",
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async startInstalledCliRuntime(workspaceRoot: string): Promise<void> {
    if (await this.probeServerHealth()) {
      throw new Error(
        `PushPals server is already listening at ${this.serverUrl()}. Stop the existing local runtime before starting a VS Code-managed runtime for this repo.`,
      );
    }

    const command = this.cliCommand();
    const args = this.cliRuntimeArgs();
    this.output.appendLine(
      `[stack] Starting installed PushPals CLI runtime: ${formatCommandForLog(command, args)}`,
    );

    const child = spawn(command, args, {
      cwd: workspaceRoot,
      shell: false,
      stdio: "pipe",
      windowsHide: true,
      env: process.env,
    }) as ChildProcessWithoutNullStreams;
    const runtime: CliManagedRuntime = {
      command,
      args,
      process: child,
      workspaceRoot,
      stopRequested: false,
    };
    this.cliRuntime = runtime;

    child.stdout.on("data", (chunk: Buffer) => this.appendStream("pushpals-cli", "stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => this.appendStream("pushpals-cli", "stderr", chunk));

    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) {
          runtime.stopRequested = true;
          try {
            runtime.process.kill();
          } catch {
            // best effort
          }
          if (this.cliRuntime?.process === child) {
            this.cliRuntime = null;
          }
          rejectPromise(error);
          return;
        }
        resolvePromise();
      };

      child.once("error", (error) => {
        const detail = error.message || String(error);
        settle(
          new Error(
            `Failed to launch ${command}: ${detail}. Install the PushPals CLI and ensure \`${command}\` is available on PATH.`,
          ),
        );
      });

      child.once("exit", (code, signal) => {
        const activeRuntime = this.cliRuntime;
        if (activeRuntime?.process === child) {
          this.cliRuntime = null;
        }
        const reason = signal ? `signal=${signal}` : `code=${code ?? 0}`;
        this.output.appendLine(`[stack] Installed PushPals CLI runtime exited (${reason}).`);
        const expectedExit = this.stopping || runtime.stopRequested;
        if (!expectedExit) {
          void vscode.window.showWarningMessage(
            `PushPals CLI runtime stopped unexpectedly (${reason}). See extension output for details.`,
          );
        }
        if (!this.isRunning()) {
          this.stopLocalBuddyRuntimeConfigPolling();
          this.stackWorkspaceRoot = null;
          this.launchMode = null;
          this.localBuddyStopRequested = false;
          this.onDidChangeRunningEmitter.fire(false);
        }
        settle(new Error(`Installed PushPals CLI runtime exited before startup completed (${reason}).`));
      });

      const deadline = Date.now() + DEFAULT_CLI_BOOT_TIMEOUT_MS;
      const poll = async () => {
        while (!settled && Date.now() < deadline) {
          if (await this.probeServerHealth()) {
            this.output.appendLine("[stack] Installed PushPals CLI runtime is healthy.");
            settle();
            return;
          }
          await new Promise((resolveLater) => setTimeout(resolveLater, 250));
        }
        if (!settled) {
          settle(
            new Error(
              `Installed PushPals CLI runtime did not become healthy within ${DEFAULT_CLI_BOOT_TIMEOUT_MS}ms.`,
            ),
          );
        }
      };
      void poll();
    });

    this.onDidChangeRunningEmitter.fire(true);
  }

  private async stopInstalledCliRuntime(workspaceRoot: string): Promise<void> {
    const runtime = this.cliRuntime;
    if (!runtime) {
      return;
    }

    this.stopping = true;
    runtime.stopRequested = true;
    this.output.appendLine("[stack] Stopping installed PushPals CLI runtime...");

    try {
      runtime.process.stdin.write("exit\n");
      runtime.process.stdin.end();
    } catch {
      // best effort
    }

    await this.waitForExit(runtime.process, 8_000);
    if (runtime.process.exitCode == null && runtime.process.signalCode == null) {
      try {
        if (process.platform === "win32" && runtime.process.pid) {
          await this.runOneShot(
            "taskkill",
            ["/PID", String(runtime.process.pid), "/T", "/F"],
            workspaceRoot,
            "Stopping installed PushPals CLI runtime",
            true,
          );
        } else {
          runtime.process.kill("SIGTERM");
        }
      } catch {
        // fall through to final verification
      }
      await this.waitForExit(runtime.process, 2_000);
      if (
        process.platform !== "win32" &&
        runtime.process.exitCode == null &&
        runtime.process.signalCode == null
      ) {
        try {
          runtime.process.kill("SIGKILL");
        } catch {
          // best effort
        }
        await this.waitForExit(runtime.process, 1_000);
      }
    }

    this.stopping = false;
    if (runtime.process.exitCode == null && runtime.process.signalCode == null) {
      throw new Error("Installed PushPals CLI runtime did not exit cleanly.");
    }

    if (this.cliRuntime?.process === runtime.process) {
      this.cliRuntime = null;
    }
    this.stackWorkspaceRoot = null;
    this.launchMode = null;
    this.localBuddyRuntimeEnabled = false;
    this.localBuddyPort = DEFAULT_LOCALBUDDY_PORT;
    this.localBuddyStopRequested = false;
    this.resetLocalBuddyRestartBudget();
    this.onDidChangeRunningEmitter.fire(false);
    this.output.appendLine("[stack] Installed PushPals CLI runtime stopped.");
  }

  private includeSourceControlManager(): boolean {
    return vscode.workspace
      .getConfiguration("pushpals")
      .get<boolean>("includeSourceControlManager", false);
  }

  private workerDockerImage(): string {
    return validateDockerImageName(
      vscode.workspace.getConfiguration("pushpals").get<string>("workerDockerImage") ??
        DEFAULT_WORKER_IMAGE,
    );
  }

  private localBuddyServiceDefinition(): ServiceDefinition {
    return {
      id: "localbuddy",
      label: "LocalBuddy",
      command: "bun",
      args: ["run", "localbuddy:only"],
    };
  }

  private resetLocalBuddyRestartBudget(): void {
    this.localBuddyConsecutiveFailures = 0;
    this.localBuddyRetryAfterMs = 0;
    this.localBuddyRestartLimitLogged = false;
  }

  private clearLocalBuddyStabilityTimer(): void {
    if (!this.localBuddyStabilityTimer) return;
    clearTimeout(this.localBuddyStabilityTimer);
    this.localBuddyStabilityTimer = null;
  }

  private markLocalBuddyUnexpectedFailure(reason: string): void {
    this.localBuddyConsecutiveFailures += 1;
    this.clearLocalBuddyStabilityTimer();
    this.localBuddyRetryAfterMs =
      Date.now() + computeLocalBuddyRestartBackoffMs(this.localBuddyConsecutiveFailures);
    if (this.localBuddyConsecutiveFailures >= LOCALBUDDY_MAX_CONSECUTIVE_FAILURES) {
      if (!this.localBuddyRestartLimitLogged) {
        this.localBuddyRestartLimitLogged = true;
        this.output.appendLine(
          `[stack] LocalBuddy restart limit reached after ${this.localBuddyConsecutiveFailures} consecutive failure(s). Toggle localbuddy.enabled off and on after fixing the cause to retry. Last failure: ${reason}`,
        );
      }
      return;
    }
    const delayMs = Math.max(0, this.localBuddyRetryAfterMs - Date.now());
    this.output.appendLine(
      `[stack] LocalBuddy start/restart failed (${reason}). Retrying in ${delayMs}ms (failure ${this.localBuddyConsecutiveFailures}/${LOCALBUDDY_MAX_CONSECUTIVE_FAILURES}).`,
    );
  }

  private async readRuntimeConfigSnapshot(workspaceRoot: string): Promise<RuntimeConfigSnapshot> {
    return loadRuntimeConfigSnapshotFromFiles(workspaceRoot, process.env);
  }

  private async ensureLocalBuddyStartReady(workspaceRoot: string): Promise<void> {
    await this.runOneShot(
      "bun",
      [
        "--cwd",
        "apps/localbuddy",
        "--env-file",
        "../../.env",
        "run",
        "src/localbuddy_main.ts",
        "--validate-config",
      ],
      workspaceRoot,
      "Validating LocalBuddy runtime config",
    );
  }

  private async isPortAvailable(port: number): Promise<boolean> {
    return await new Promise<boolean>((resolveAvailability) => {
      const server = createServer();
      let settled = false;

      const settle = (available: boolean) => {
        if (settled) return;
        settled = true;
        resolveAvailability(available);
      };

      server.once("error", () => {
        try {
          server.close();
        } catch {
          // best effort
        }
        settle(false);
      });

      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.close(() => settle(true));
      });
    });
  }

  private startLocalBuddyRuntimeConfigPolling(workspaceRoot: string): void {
    if (this.localBuddyConfigPollTimer) return;
    this.localBuddyConfigPollTimer = setInterval(() => {
      void this.syncLocalBuddyRuntimeConfig(workspaceRoot);
    }, LOCALBUDDY_RUNTIME_CONFIG_POLL_MS);
  }

  private stopLocalBuddyRuntimeConfigPolling(): void {
    if (!this.localBuddyConfigPollTimer) return;
    clearInterval(this.localBuddyConfigPollTimer);
    this.localBuddyConfigPollTimer = null;
  }

  private async syncLocalBuddyRuntimeConfig(workspaceRoot: string): Promise<void> {
    if (this.localBuddyConfigPollInFlight || this.stopping || !this.isRunning()) return;
    this.localBuddyConfigPollInFlight = true;
    try {
      const snapshot = await this.readRuntimeConfigSnapshot(workspaceRoot);
      const previousEnabled = this.localBuddyRuntimeEnabled;
      const nextEnabled = Boolean(snapshot.localbuddy.enabled);
      if (previousEnabled !== nextEnabled) {
        this.resetLocalBuddyRestartBudget();
      }
      this.localBuddyRuntimeEnabled = nextEnabled;
      this.localBuddyPort = snapshot.localbuddy.port;

      const action = resolveLocalBuddyRuntimeAction(this.running.has("localbuddy"), nextEnabled);
      if (action === "start") {
        const startGate = resolveLocalBuddyStartGate({
          nowMs: Date.now(),
          retryAfterMs: this.localBuddyRetryAfterMs,
          consecutiveFailures: this.localBuddyConsecutiveFailures,
          maxConsecutiveFailures: LOCALBUDDY_MAX_CONSECUTIVE_FAILURES,
        });
        if (startGate === "retry_exhausted" || startGate === "backoff") {
          return;
        }

        const portAvailable = await this.isPortAvailable(this.localBuddyPort);
        if (!portAvailable) {
          this.markLocalBuddyUnexpectedFailure(`port ${this.localBuddyPort} is unavailable`);
          return;
        }

        this.output.appendLine(
          previousEnabled !== nextEnabled
            ? "[stack] LocalBuddy enabled via runtime config (localbuddy.enabled=true); starting LocalBuddy."
            : "[stack] LocalBuddy is enabled but not running; starting LocalBuddy.",
        );
        try {
          await this.ensureLocalBuddyStartReady(workspaceRoot);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.output.appendLine(`[stack] LocalBuddy readiness preflight failed: ${detail}`);
          this.markLocalBuddyUnexpectedFailure(`preflight failed: ${detail}`);
          return;
        }
        this.spawnService(this.localBuddyServiceDefinition(), workspaceRoot);
        return;
      }

      if (action === "stop") {
        this.output.appendLine(
          previousEnabled !== nextEnabled
            ? "[stack] LocalBuddy disabled via runtime config (localbuddy.enabled=false); stopping LocalBuddy."
            : "[stack] LocalBuddy is disabled but still running; stopping LocalBuddy.",
        );
        const service = this.running.get("localbuddy");
        if (service) {
          await this.stopService(workspaceRoot, service);
        }
        this.resetLocalBuddyRestartBudget();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[stack] LocalBuddy runtime config poll failed: ${detail}`);
    } finally {
      this.localBuddyConfigPollInFlight = false;
    }
  }

  private async ensureDockerReady(workspaceRoot: string, image: string): Promise<void> {
    await this.runOneShot(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      workspaceRoot,
      "Checking Docker daemon",
    );

    const inspect = await this.runOneShot(
      "docker",
      ["image", "inspect", image],
      workspaceRoot,
      `Checking Docker image ${image}`,
      true,
    );
    if (inspect.code === 0) {
      this.output.appendLine(`[stack] Docker image present: ${image}`);
      return;
    }

    this.output.appendLine(`[stack] Docker image missing: ${image}. Building...`);
    if (image === DEFAULT_WORKER_IMAGE) {
      await this.runOneShot(
        "bun",
        ["--cwd", "apps/workerpals", "run", "docker:build"],
        workspaceRoot,
        `Building ${DEFAULT_WORKER_IMAGE}`,
      );
      return;
    }

    await this.runOneShot(
      "docker",
      ["build", "-f", "apps/workerpals/Dockerfile.sandbox", "-t", image, "."],
      workspaceRoot,
      `Building custom worker image ${image}`,
    );
  }

  private spawnService(def: ServiceDefinition, workspaceRoot: string): void {
    const child = spawn(def.command, def.args, {
      cwd: workspaceRoot,
      shell: false,
      stdio: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true,
      env: { ...process.env, ...def.env },
    }) as ChildProcessWithoutNullStreams;

    this.running.set(def.id, { def, process: child });
    if (def.id === "localbuddy") {
      this.localBuddyStopRequested = false;
      this.clearLocalBuddyStabilityTimer();
      this.localBuddyStabilityTimer = setTimeout(() => {
        const current = this.running.get("localbuddy");
        if (current?.process === child && this.localBuddyRuntimeEnabled) {
          this.resetLocalBuddyRestartBudget();
        }
        this.localBuddyStabilityTimer = null;
      }, LOCALBUDDY_STABLE_UPTIME_MS);
    }
    this.output.appendLine(`[stack] ${def.label} started (pid=${child.pid ?? "unknown"}).`);

    child.stdout.on("data", (chunk: Buffer) => this.appendStream(def.id, "stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => this.appendStream(def.id, "stderr", chunk));
    child.on("error", (err) => {
      this.output.appendLine(`[stack] ${def.label} process error: ${err.message}`);
      void vscode.window.showErrorMessage(`PushPals ${def.label} failed: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      this.running.delete(def.id);
      if (def.id === "localbuddy") {
        this.clearLocalBuddyStabilityTimer();
      }
      const reason = signal ? `signal=${signal}` : `code=${code ?? 0}`;
      this.output.appendLine(`[stack] ${def.label} exited (${reason}).`);
      if (def.id === "localbuddy") {
        const expectedExit =
          this.stopping || this.localBuddyStopRequested || !this.localBuddyRuntimeEnabled;
        if (!expectedExit) {
          this.markLocalBuddyUnexpectedFailure(reason);
          void vscode.window.showWarningMessage(
            `PushPals ${def.label} stopped unexpectedly (${reason}). See output for details.`,
          );
        }
      } else if (!this.stopping && (code ?? 0) !== 0) {
        void vscode.window.showWarningMessage(
          `PushPals ${def.label} stopped unexpectedly (${reason}). See output for details.`,
        );
      }
      if (!this.isRunning()) {
        this.stopLocalBuddyRuntimeConfigPolling();
        this.stackWorkspaceRoot = null;
        this.localBuddyStopRequested = false;
        this.onDidChangeRunningEmitter.fire(false);
      }
    });
  }

  private appendStream(id: string, stream: "stdout" | "stderr", chunk: Buffer): void {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      this.output.appendLine(`[${id}][${stream}] ${line}`);
    }
  }

  private async stopService(workspaceRoot: string, service: RunningService): Promise<void> {
    const pid = service.process.pid;
    this.output.appendLine(`[stack] Stopping ${service.def.label}...`);
    if (service.def.id === "localbuddy") {
      this.localBuddyStopRequested = true;
      this.clearLocalBuddyStabilityTimer();
    }
    if (!pid) {
      service.process.kill();
      return;
    }

    if (process.platform === "win32") {
      const result = await this.runOneShot(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        workspaceRoot,
        `Stopping ${service.def.label}`,
        true,
      );
      if (result.code !== 0) {
        this.output.appendLine(
          `[stack] taskkill returned ${result.code} for ${service.def.label}. Verifying process exit...`,
        );
      }
      await this.waitForExit(service.process, 4_000);
      if (service.process.exitCode == null && service.process.signalCode == null) {
        try {
          service.process.kill("SIGKILL");
        } catch {
          // best effort
        }
        await this.waitForExit(service.process, 1_500);
      }
      if (service.process.exitCode == null && service.process.signalCode == null) {
        throw new Error(`Unable to terminate pid ${pid}.`);
      }
      return;
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        service.process.kill("SIGTERM");
      } catch {
        // best effort
      }
    }
    await this.waitForExit(service.process, 5_000);
    if (service.process.exitCode == null && service.process.signalCode == null) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          service.process.kill("SIGKILL");
        } catch {
          // best effort
        }
      }
    }
    if (service.process.exitCode == null && service.process.signalCode == null) {
      throw new Error(`Unable to terminate pid ${pid}.`);
    }
  }

  private waitForExit(processRef: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    if (processRef.exitCode != null || processRef.signalCode != null) return Promise.resolve();

    return new Promise((resolvePromise) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        resolvePromise();
      };

      const timer = setTimeout(done, timeoutMs);
      processRef.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
  }

  private runOneShot(
    command: string,
    args: string[],
    cwd: string,
    label: string,
    tolerateFailure = false,
  ): Promise<CommandResult> {
    this.output.appendLine(`[preflight] ${label}: ${formatCommandForLog(command, args)}`);
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, {
        cwd,
        shell: false,
        env: process.env,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        this.appendPrefixedLines("preflight", "stdout", text);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        this.appendPrefixedLines("preflight", "stderr", text);
      });
      child.on("error", (error) => rejectPromise(error));
      child.on("close", (code) => {
        const result: CommandResult = { code: code ?? 1, stdout, stderr };
        if (result.code !== 0 && !tolerateFailure) {
          const detail = (stderr || stdout).trim() || `${label} failed with code ${result.code}`;
          rejectPromise(new Error(detail));
          return;
        }
        resolvePromise(result);
      });
    });
  }

  private appendPrefixedLines(source: string, stream: "stdout" | "stderr", text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      this.output.appendLine(`[${source}][${stream}] ${line}`);
    }
  }
}
