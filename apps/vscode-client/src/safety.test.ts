import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCommandForLog, validateDockerImageName } from "./safety";

describe("validateDockerImageName", () => {
  it("accepts common image names", () => {
    assert.equal(
      validateDockerImageName("pushpals-worker-sandbox:latest"),
      "pushpals-worker-sandbox:latest",
    );
    assert.equal(
      validateDockerImageName("ghcr.io/org/pushpals/worker:v1.2.3"),
      "ghcr.io/org/pushpals/worker:v1.2.3",
    );
    assert.equal(
      validateDockerImageName("registry.example.com/image@sha256:abc123"),
      "registry.example.com/image@sha256:abc123",
    );
  });

  it("rejects empty and whitespace values", () => {
    assert.throws(() => validateDockerImageName(""), /cannot be empty/);
    assert.throws(() => validateDockerImageName("   "), /cannot be empty/);
  });

  it("rejects unsafe shell characters", () => {
    assert.throws(
      () => validateDockerImageName("worker:latest; echo hacked"),
      /Invalid worker Docker image/,
    );
    assert.throws(
      () => validateDockerImageName("worker:latest && whoami"),
      /Invalid worker Docker image/,
    );
    assert.throws(
      () => validateDockerImageName("worker:latest | cat"),
      /Invalid worker Docker image/,
    );
  });
});

describe("formatCommandForLog", () => {
  it("quotes only args containing whitespace", () => {
    assert.equal(formatCommandForLog("bun", ["run", "protocol:build"]), "bun run protocol:build");
    assert.equal(
      formatCommandForLog("docker", ["build", "-f", "apps/workerpals/Dockerfile.sandbox", "."]),
      "docker build -f apps/workerpals/Dockerfile.sandbox .",
    );
    assert.equal(
      formatCommandForLog("taskkill", ["/PID", "123", "/T", "/F"]),
      "taskkill /PID 123 /T /F",
    );
    assert.equal(formatCommandForLog("echo", ["hello world"]), "echo \"hello world\"");
  });
});
