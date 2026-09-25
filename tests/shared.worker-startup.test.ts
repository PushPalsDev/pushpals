import { describe, expect, test } from "bun:test";
import {
  isWorkerStartupPhase,
  workerStartupAllowanceMs,
  workerStartupPhaseTimeoutMs,
} from "../packages/shared/src/worker_startup";

describe("shared worker startup budget contract", () => {
  test("direct workers retain their normal timeout; Docker phases share a finite ceiling", () => {
    expect(workerStartupAllowanceMs(120_000, false)).toBe(120_000);
    expect(workerStartupAllowanceMs(120_000, true)).toBe(1_650_000);
    expect(workerStartupAllowanceMs(30_000, true)).toBe(1_560_000);
  });

  test("phase allowances distinguish cold builds, fallback pulls, and complete self-checks", () => {
    expect(workerStartupPhaseTimeoutMs("docker-startup-preflight", 45_000)).toBe(45_000);
    expect(workerStartupPhaseTimeoutMs("docker-image-build", 45_000)).toBe(600_000);
    expect(workerStartupPhaseTimeoutMs("docker-image-pull", 45_000)).toBe(600_000);
    expect(workerStartupPhaseTimeoutMs("docker-startup-selfcheck", 45_000)).toBe(300_000);
  });

  test("unknown phases and malformed values cannot become startup evidence", () => {
    for (const phase of [null, undefined, "", "ready", "job", {}, ["docker-image-build"]]) {
      expect(isWorkerStartupPhase(phase)).toBe(false);
    }
    for (const phase of [
      "docker-startup-preflight",
      "docker-image-build",
      "docker-image-pull",
      "docker-startup-selfcheck",
    ]) {
      expect(isWorkerStartupPhase(phase)).toBe(true);
    }
  });

  test("invalid configured timeouts never create an infinite startup ceiling", () => {
    for (const timeout of [NaN, Infinity, -Infinity, 0, -1]) {
      expect(workerStartupAllowanceMs(timeout, true)).toBe(1_650_000);
      expect(workerStartupPhaseTimeoutMs("docker-startup-preflight", timeout)).toBe(120_000);
    }
    expect(workerStartupAllowanceMs(0.5, false)).toBe(1);
  });
});
