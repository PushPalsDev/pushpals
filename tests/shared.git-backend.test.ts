import { describe, expect, test } from "bun:test";
import {
  inferGitBackendFromRemote,
  parseGitRemoteHost,
  resolveGitTokenForRemote,
  type CommandCaptureResult,
} from "../packages/shared/src/git_backend";

describe("shared git backend token resolution", () => {
  test("parses remote host for HTTPS and SSH remotes", () => {
    expect(parseGitRemoteHost("https://github.com/PushPalsDev/pushpals.git")).toBe("github.com");
    expect(parseGitRemoteHost("git@github.com:PushPalsDev/pushpals.git")).toBe("github.com");
    expect(parseGitRemoteHost("ssh://git@gitlab.example.com/org/repo.git")).toBe(
      "gitlab.example.com",
    );
  });

  test("infers backend from remote host", () => {
    expect(inferGitBackendFromRemote("https://github.com/org/repo.git")).toBe("github");
    expect(inferGitBackendFromRemote("https://gitlab.com/org/repo.git")).toBe("gitlab");
    expect(inferGitBackendFromRemote("https://example.com/org/repo.git")).toBe("unknown");
  });

  test("prefers configured token over env/cli", async () => {
    const result = await resolveGitTokenForRemote({
      remoteUrl: "https://github.com/org/repo.git",
      configuredToken: " configured-token ",
      env: { GITHUB_TOKEN: "env-token" },
      runCommand: async () => ({
        ok: true,
        stdout: "cli-token",
        stderr: "",
        exitCode: 0,
      }),
    });

    expect(result.source).toBe("configured");
    expect(result.token).toBe("configured-token");
  });

  test("uses backend-specific env token when configured token is absent", async () => {
    const result = await resolveGitTokenForRemote({
      remoteUrl: "https://gitlab.com/org/repo.git",
      configuredToken: "",
      env: { GL_TOKEN: "gitlab-env-token" },
    });

    expect(result.backend).toBe("gitlab");
    expect(result.source).toBe("env");
    expect(result.token).toBe("gitlab-env-token");
  });

  test("falls back to gh auth token for github when env token is missing", async () => {
    const commands: string[][] = [];
    const runCommand = async (command: string[]): Promise<CommandCaptureResult> => {
      commands.push([...command]);
      return {
        ok: true,
        stdout: "cli-gh-token",
        stderr: "",
        exitCode: 0,
      };
    };

    const result = await resolveGitTokenForRemote({
      remoteUrl: "https://github.com/org/repo.git",
      configuredToken: "",
      env: {},
      runCommand,
    });

    expect(commands.length).toBe(1);
    expect(commands[0]).toEqual(["gh", "auth", "token"]);
    expect(result.source).toBe("cli");
    expect(result.token).toBe("cli-gh-token");
  });

  test("returns none when no token sources are available", async () => {
    const result = await resolveGitTokenForRemote({
      remoteUrl: "https://github.com/org/repo.git",
      configuredToken: "",
      env: {},
      runCommand: async () => ({
        ok: false,
        stdout: "",
        stderr: "not logged in",
        exitCode: 1,
      }),
    });

    expect(result.source).toBe("none");
    expect(result.token).toBe("");
  });

  test("tries gh then glab CLI for unknown backend", async () => {
    const commands: string[][] = [];
    const result = await resolveGitTokenForRemote({
      remoteUrl: "https://example.com/org/repo.git",
      configuredToken: "",
      env: {},
      runCommand: async (command: string[]) => {
        commands.push([...command]);
        if (command[0] === "gh") {
          return { ok: false, stdout: "", stderr: "no gh auth", exitCode: 1 };
        }
        return { ok: true, stdout: "glab-cli-token", stderr: "", exitCode: 0 };
      },
    });

    expect(commands).toEqual([
      ["gh", "auth", "token", "--hostname", "example.com"],
      ["glab", "auth", "token"],
    ]);
    expect(result.backend).toBe("unknown");
    expect(result.source).toBe("cli");
    expect(result.token).toBe("glab-cli-token");
  });
});
