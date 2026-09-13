import { describe, expect, test } from "bun:test";
import {
  CapabilityRevisionCircuit,
  withCapabilityBlockedResult,
} from "../apps/workerpals/src/capability_revision_circuit";
import { inferWorkerTerminalFailureClass } from "../apps/workerpals/src/workerpals_main";

const observation = () => ({
  executorResult: {
    ok: true,
    summary: "Preserved the implementation. This executor cannot obtain browser screenshots.",
  },
  mustFix: ["Attach actual viewport captures and computed measurements."],
  criticRequiresRevision: true,
  deterministicIssues: [] as string[],
  deterministicBlocker: false,
  targetPaths: ["src/widget.ts", "tests/widget.test.ts"],
});

describe("unavailable browser evidence revision circuit", () => {
  test("stops at two equivalent observations despite changed prose and target ordering", () => {
    const circuit = new CapabilityRevisionCircuit();
    expect(circuit.observe(observation())).toBeNull();
    const blocked = circuit.observe({
      ...observation(),
      executorResult: {
        ok: true,
        summary: "The Chromium executable is missing; no screenshots were produced.",
      },
      mustFix: ["Provide screenshots of the rendered control before accepting the change."],
      targetPaths: ["tests\\widget.test.ts", "./src/widget.ts", "src/widget.ts"],
    });
    expect(blocked).toMatchObject({
      version: 1,
      capability: "browser_capture",
      occurrences: 2,
      disposition: "await_capability",
      requiredEvidence: ["rendered_artifacts"],
    });
    expect(blocked?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test.each([
    "The browser probe failed with listen EPERM on 127.0.0.1.",
    "No provisioned browser tool is available to this executor.",
    "I can’t inspect screenshots in this executor.",
    "The configured Chromium is missing and startup failed.",
  ])("recognizes observed capability failure: %s", (summary) => {
    const circuit = new CapabilityRevisionCircuit();
    const input = { ...observation(), executorResult: { ok: true, summary } };
    expect(circuit.observe(input)).toBeNull();
    expect(circuit.observe(input)?.occurrences).toBe(2);
  });

  test.each([
    { ...observation(), criticRequiresRevision: false },
    { ...observation(), mustFix: ["Fix the incorrect opacity calculation."] },
    { ...observation(), deterministicIssues: ["ValidationGate: type error"] },
    { ...observation(), deterministicBlocker: true },
    {
      ...observation(),
      executorResult: { ok: true, summary: "Captured both viewport screenshots successfully." },
    },
    {
      ...observation(),
      executorResult: { ok: true, summary: "Add a test for the unavailable browser error case." },
    },
    {
      ...observation(),
      executorResult: {
        ok: true,
        summary: "Captured both viewport screenshots successfully.",
        stderr: "Earlier browser probe failed with listen EPERM before environment recovery.",
      },
    },
    {
      ...observation(),
      executorResult: {
        ok: true,
        summary: "Browser was unavailable earlier but now captured both screenshots.",
      },
    },
    {
      ...observation(),
      executorResult: {
        ok: true,
        summary: "Executed task and modified two files",
        stdout:
          "The browser was unavailable initially.\nSuccessfully captured both viewport screenshots after provisioning.",
      },
    },
    {
      ...observation(),
      executorResult: {
        ok: true,
        summary: "Executed task and modified two files",
        stdout:
          "Codex event trace:\n- item.completed | Browser is unavailable.\nChanged files:\n- src/widget.ts",
      },
    },
    {
      ...observation(),
      executorResult: {
        ok: true,
        summary: "Executed task and modified two files",
        stdout:
          "[OpenAICodexExecutor] [codex] item.completed | This executor cannot obtain browser screenshots.\nUpdated the capture harness.",
      },
    },
  ])("does not turn unrelated failure or passing evidence into a capability hold", (input) => {
    const circuit = new CapabilityRevisionCircuit();
    circuit.observe(observation());
    expect(circuit.observe(input)).toBeNull();
    // Reset prevents a later, separate capability failure from inheriting a stale streak.
    expect(circuit.observe(observation())).toBeNull();
  });

  test("a different target starts a separate streak", () => {
    const circuit = new CapabilityRevisionCircuit();
    circuit.observe(observation());
    expect(circuit.observe({ ...observation(), targetPaths: ["src/unrelated.ts"] })).toBeNull();
  });

  test("retains candidate, validation and usage evidence without granting publication success", () => {
    const circuit = new CapabilityRevisionCircuit();
    circuit.observe(observation());
    const blocker = circuit.observe(observation())!;
    const validationRuns = [{ command: "bun test", passed: true }];
    const held = withCapabilityBlockedResult(
      {
        ok: true,
        summary: "Updated capture harness; actual visual evidence still missing",
        usage: { promptTokens: 20, completionTokens: 10 },
        validationBlocked: {
          category: "environment",
          summary: "Docker unavailable",
          detail: "An unrelated aggregate command requires host validation",
          commands: ["bun run validate"],
        },
        candidateState: {
          status: "partial",
          reason: "existing_checkpoint",
          changedPaths: ["src/widget.ts"],
          checkpoint: {
            ref: "refs/pushpals/candidates/worker/job",
            sha: "a".repeat(40),
            capturedAt: "2026-09-11T00:00:00Z",
          },
        },
        diagnostics: { validationRuns, terminal: { metadata: { original: true } } },
      },
      blocker,
      ["src/widget.ts"],
    );
    expect(held.ok).toBe(false);
    expect(held.validationBlocked).toBeUndefined();
    expect(held.publishBlocked).toBeUndefined();
    expect(held.candidateState?.status).toBe("held");
    expect(held.candidateState?.checkpoint?.sha).toBe("a".repeat(40));
    expect(held.diagnostics?.validationRuns).toEqual(validationRuns);
    expect(held.usage?.promptTokens).toBe(20);
    expect(held.diagnostics?.metadata?.capabilityBlocker).toEqual(blocker);
    expect(held.diagnostics?.terminal?.metadata).toMatchObject({
      original: true,
      capabilityBlocker: blocker,
    });
    expect(inferWorkerTerminalFailureClass(held)).toBe("environment.browser");
  });
});
