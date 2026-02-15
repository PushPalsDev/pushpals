import { describe, expect, test } from "bun:test";
import {
  compactJobOutput,
  extractClarificationQuestionFromOutput,
} from "../apps/workerpals/src/execute_job";

describe("workerpals OpenHands clarification detection", () => {
  test("extracts a clarification question from agent output", () => {
    const output = `
[log.stdout] Message from Agent
[log.stdout] The user wants to add another test case.
[log.stdout] Let me ask for clarification.</think>I can help add another test case.
[log.stdout] Which test file would you like me to add a new test case to?
[log.stdout] Tokens: input 25.67K cache hit 0.00% output 874 $ 0.00
`;

    expect(extractClarificationQuestionFromOutput(output)).toBe(
      "Which test file would you like me to add a new test case to?",
    );
  });

  test("returns null when no clarification request is present", () => {
    const output = `
[log.stdout] Message from Agent
[log.stdout] I updated tests/workerpals.timeout-policy.test.ts.
[log.stdout] I ran bun test tests/workerpals.timeout-policy.test.ts and it passed.
`;

    expect(extractClarificationQuestionFromOutput(output)).toBeNull();
  });

  test("compacts oversized output while keeping latest context", () => {
    const longOutput = Array.from({ length: 1200 }, (_, idx) => `line-${idx}`).join("\n");
    const compact = compactJobOutput(longOutput);

    expect(compact).toContain("lines omitted");
    expect(compact).toContain("line-1199");
    expect(compact).not.toContain("line-650");
  });
});
