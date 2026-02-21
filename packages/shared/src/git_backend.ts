export type GitBackendId = "github" | "gitlab" | "unknown";
export type GitTokenSource = "configured" | "env" | "cli" | "none";

export interface CommandCaptureResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ResolveGitTokenOptions {
  remoteUrl: string;
  configuredToken?: string | null;
  env?: Record<string, string | undefined>;
  cwd?: string;
  runCommand?: (command: string[], cwd?: string) => Promise<CommandCaptureResult>;
}

export interface GitTokenResolution {
  backend: GitBackendId;
  host: string;
  token: string;
  source: GitTokenSource;
}

function trimToken(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function firstNonEmpty(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = trimToken(env[key]);
    if (value) return value;
  }
  return "";
}

export function parseGitRemoteHost(remoteUrl: string): string {
  const raw = trimToken(remoteUrl);
  if (!raw) return "";

  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?([^/:?#]+)(?::\d+)?(?:[/?#].*)?$/i,
    /^ssh:\/\/(?:[^@/]+@)?([^/:?#]+)(?::\d+)?(?:[/?#].*)?$/i,
    /^(?:[^@:\s]+@)?([^:/\s]+):[^?\s]+$/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const host = match?.[1] ? trimToken(match[1]) : "";
    if (host) return host.toLowerCase();
  }
  return "";
}

export function inferGitBackendFromRemote(remoteUrl: string): GitBackendId {
  const host = parseGitRemoteHost(remoteUrl);
  if (!host) return "unknown";
  if (host === "github.com" || host.endsWith(".github.com") || host.includes("github")) {
    return "github";
  }
  if (host === "gitlab.com" || host.endsWith(".gitlab.com") || host.includes("gitlab")) {
    return "gitlab";
  }
  return "unknown";
}

async function defaultRunCommand(
  command: string[],
  cwd?: string,
): Promise<CommandCaptureResult> {
  try {
    const proc = Bun.spawn(command, {
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

async function resolveGitHubCliToken(
  host: string,
  runCommand: (command: string[], cwd?: string) => Promise<CommandCaptureResult>,
  cwd?: string,
): Promise<string> {
  const useHostname = host && host !== "github.com";
  const command = useHostname ? ["gh", "auth", "token", "--hostname", host] : ["gh", "auth", "token"];
  const result = await runCommand(command, cwd);
  return result.ok ? trimToken(result.stdout) : "";
}

async function resolveGitLabCliToken(
  runCommand: (command: string[], cwd?: string) => Promise<CommandCaptureResult>,
  cwd?: string,
): Promise<string> {
  const result = await runCommand(["glab", "auth", "token"], cwd);
  return result.ok ? trimToken(result.stdout) : "";
}

export async function resolveGitTokenForRemote(
  options: ResolveGitTokenOptions,
): Promise<GitTokenResolution> {
  const configuredToken = trimToken(options.configuredToken);
  const host = parseGitRemoteHost(options.remoteUrl);
  const backend = inferGitBackendFromRemote(options.remoteUrl);
  const env = options.env ?? (process.env as Record<string, string | undefined>);

  if (configuredToken) {
    return { backend, host, token: configuredToken, source: "configured" };
  }

  const envVarOrder =
    backend === "gitlab"
      ? (["PUSHPALS_GIT_TOKEN", "GITLAB_TOKEN", "GL_TOKEN"] as const)
      : backend === "github"
        ? (["PUSHPALS_GIT_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] as const)
        : (["PUSHPALS_GIT_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "GL_TOKEN"] as const);

  const envToken = firstNonEmpty(env, envVarOrder);
  if (envToken) {
    return { backend, host, token: envToken, source: "env" };
  }

  const runCommand = options.runCommand ?? defaultRunCommand;
  let cliToken = "";
  if (backend === "github") {
    cliToken = await resolveGitHubCliToken(host, runCommand, options.cwd);
  } else if (backend === "gitlab") {
    cliToken = await resolveGitLabCliToken(runCommand, options.cwd);
  } else {
    // Unknown remotes still try both CLIs as a best-effort fallback.
    cliToken = await resolveGitHubCliToken(host, runCommand, options.cwd);
    if (!cliToken) {
      cliToken = await resolveGitLabCliToken(runCommand, options.cwd);
    }
  }
  if (cliToken) {
    return { backend, host, token: cliToken, source: "cli" };
  }

  return { backend, host, token: "", source: "none" };
}
