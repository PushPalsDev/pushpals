import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

function decodeOutput(data: string | Uint8Array | null | undefined): string {
  if (typeof data === "string") return data;
  if (!data) return "";
  return Buffer.from(data).toString("utf8");
}

async function waitForExitWithTimeout(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<number> {
  return await Promise.race([
    proc.exited,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out waiting for process exit after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

test(
  "host manager exits non-zero when a fatal managed service reaches restart exhaustion",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-service-manager-host-e2e-"));
    try {
      const harnessPath = join(root, "host-manager-e2e.ts");
      const serviceManagerModulePath = resolve(
        import.meta.dir,
        "..",
        "..",
        "scripts",
        "start_runtime_services.ts",
      ).replace(/\\/g, "\\\\");

      writeFileSync(
        harnessPath,
        `
import { ServiceManager } from "${serviceManagerModulePath}";

const fatalManagedServiceNames = new Set(["server", "remotebuddy"]);
let exiting = false;

const manager = new ServiceManager({
  pollMs: 25,
  maxRestartAttempts: 1,
  computeRestartBackoffMs: () => 25,
  onEvent: (level, line) => {
    console.log(\`EVENT \${level} \${line}\`);
  },
  onServiceDegraded: (name, reason) => {
    console.log(\`DEGRADED \${name} \${reason}\`);
    if (!fatalManagedServiceNames.has(name) || exiting) return;
    exiting = true;
    manager.stop();
    process.exit(1);
  },
});

manager.startService({
  name: "server",
  color: "blue",
  command: [process.execPath, "-e", "process.exit(17)"],
  cwd: process.cwd(),
});

setInterval(() => {}, 1_000);
        `.trimStart(),
        "utf8",
      );

      const proc = Bun.spawn([process.execPath, harnessPath], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        waitForExitWithTimeout(proc, 15_000),
      ]);
      const combined = `${stdout}\n${stderr}`;

      expect(exitCode).toBe(1);
      expect(combined).toContain("EVENT warn Managed server exited");
      expect(combined).toContain("EVENT error Managed server exited");
      expect(combined).toContain("DEGRADED server reached restart limit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
