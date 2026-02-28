import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as vscode from "vscode";
import { formatCommandForLog, validateDockerImageName } from "./safety";
import { assertWorkspaceTrusted } from "./workspaceTrust";

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

const DEFAULT_WORKER_IMAGE = "pushpals-worker-sandbox:latest";

export class StackServiceManager implements vscode.Disposable {
  private readonly running = new Map<string, RunningService>();
  private readonly onDidChangeRunningEmitter = new vscode.EventEmitter<boolean>();
  readonly onDidChangeRunning = this.onDidChangeRunningEmitter.event;
  private stopping = false;

  constructor(private readonly output: vscode.OutputChannel) {}

  isRunning(): boolean {
    return this.running.size > 0;
  }

  async startStack(workspaceRoot: string): Promise<void> {
    if (this.isRunning()) {
      this.output.appendLine("[stack] Start skipped: stack already running.");
      return;
    }
    assertWorkspaceTrusted(vscode.workspace.isTrusted);

    this.validateLocalConfig(workspaceRoot);
    const workerImage = this.workerDockerImage();
    await this.runOneShot("bun", ["--version"], workspaceRoot, "Checking Bun runtime");
    await this.runOneShot(
      "bun",
      ["run", "protocol:build"],
      workspaceRoot,
      "Building protocol package",
    );
    await this.ensureDockerReady(workspaceRoot, workerImage);

    const definitions: ServiceDefinition[] = [
      { id: "server", label: "Server", command: "bun", args: ["run", "server:only"] },
      { id: "localbuddy", label: "LocalBuddy", command: "bun", args: ["run", "localbuddy:only"] },
      { id: "remotebuddy", label: "RemoteBuddy", command: "bun", args: ["run", "remotebuddy:only"] },
      {
        id: "workerpals",
        label: "WorkerPals",
        command: "bun",
        args: ["run", "workerpals:only:docker"],
        env: { WORKERPALS_DOCKER_IMAGE: workerImage },
      },
    ];
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
    this.onDidChangeRunningEmitter.fire(true);
  }

  async stopStack(workspaceRoot: string, options?: { bypassTrust?: boolean }): Promise<void> {
    if (!options?.bypassTrust) assertWorkspaceTrusted(vscode.workspace.isTrusted);
    if (!this.isRunning()) {
      this.output.appendLine("[stack] Stop skipped: no running services.");
      return;
    }

    this.stopping = true;
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
    this.onDidChangeRunningEmitter.dispose();
  }

  private validateLocalConfig(workspaceRoot: string): void {
    const envPath = resolve(workspaceRoot, ".env");
    const localConfigPath = resolve(workspaceRoot, "configs", "local.toml");
    const legacyLocalConfigPath = resolve(workspaceRoot, "config", "local.toml");
    const missing: string[] = [];
    if (!existsSync(envPath)) {
      missing.push(envPath);
    }
    if (!existsSync(localConfigPath) && !existsSync(legacyLocalConfigPath)) {
      missing.push(localConfigPath);
    }
    if (missing.length === 0) return;

    const rel = missing.map((entry) => entry.replace(`${workspaceRoot}\\`, "").replace(/\\/g, "/"));
    throw new Error(`Missing required local config files: ${rel.join(", ")}`);
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
    this.output.appendLine(`[stack] ${def.label} started (pid=${child.pid ?? "unknown"}).`);

    child.stdout.on("data", (chunk: Buffer) => this.appendStream(def.id, "stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => this.appendStream(def.id, "stderr", chunk));
    child.on("error", (err) => {
      this.output.appendLine(`[stack] ${def.label} process error: ${err.message}`);
      void vscode.window.showErrorMessage(`PushPals ${def.label} failed: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      this.running.delete(def.id);
      const reason = signal ? `signal=${signal}` : `code=${code ?? 0}`;
      this.output.appendLine(`[stack] ${def.label} exited (${reason}).`);
      if (!this.stopping && (code ?? 0) !== 0) {
        void vscode.window.showWarningMessage(
          `PushPals ${def.label} stopped unexpectedly (${reason}). See output for details.`,
        );
      }
      if (!this.isRunning()) this.onDidChangeRunningEmitter.fire(false);
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
