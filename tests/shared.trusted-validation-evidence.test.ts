import { describe, expect, test } from "bun:test";
import {
  extractTrustedValidationFailureEvidence,
  normalizeTrustedValidationFingerprintLine,
  prioritizeTrustedValidationFailureLines,
  truncateTrustedValidationOutput,
} from "../packages/shared/src/trusted_validation";

describe("trusted validation failure evidence", () => {
  test.each([
    ["src/api.ts", "(12,3):"],
    ["src/timeout.ts", "(12,3):"],
    ["src/api.ts", ":12:3 -"],
    ["src/timeout.ts", ":12:3 -"],
  ])(
    "compiler diagnostics in %s%s outrank expected timeout logs before and after normalization",
    (path, coordinates) => {
      const diagnostic = `${path}${coordinates} error TS2322: Type string is not assignable to type number.`;
      const evidence = extractTrustedValidationFailureEvidence({
        command: "bun run validate",
        phase: "validation",
        exitCode: 1,
        output: [
          '{"level":"error","message":"request timeout is expected for negative fixture"}',
          "0 tests failed",
          diagnostic,
        ].join("\n"),
      });
      expect(evidence.failureClass).toBe("typecheck_failure");
      expect(evidence.targetPathHints).toEqual([path]);
      expect(evidence.failureLines).toEqual([
        normalizeTrustedValidationFingerprintLine(diagnostic),
      ]);
      expect(prioritizeTrustedValidationFailureLines(evidence.failureLines)).toEqual(
        evidence.failureLines,
      );
      expect(
        extractTrustedValidationFailureEvidence({
          command: "bun run validate",
          phase: "validation",
          exitCode: 124,
          output: diagnostic,
        }).failureClass,
      ).toBe("timeout");
    },
  );

  test("prioritizes runner verdicts over noisy expected application errors", () => {
    const output = [
      ...Array.from(
        { length: 80 },
        (_, index) =>
          `stderr | services/queue/test/queue.vitest.ts > queue > handles failure ${index}\n` +
          JSON.stringify({
            message: "queue formation failed",
            requestId: `request_${index}abcdef`,
            error: "EXPECTED_REJECTION",
          }),
      ),
      "FAIL services/account/test/account.vitest.ts > notification boundary > rejects invalid proof",
      "Error: Test timed out in 5000ms.",
      ...Array.from({ length: 200 }, (_, index) => `passing tail diagnostic ${index}`),
    ].join("\n");
    const evidence = extractTrustedValidationFailureEvidence({
      command: "bun run validate",
      phase: "validation",
      exitCode: 1,
      output,
    });
    expect(evidence.failedTests).toEqual(["notification boundary > rejects invalid proof"]);
    expect(evidence.targetPathHints).toEqual(["services/account/test/account.vitest.ts"]);
    expect(evidence.failureLines[0]).toStartWith("FAIL services/account/test/account.vitest.ts");
    expect(evidence.failureLines.join("\n")).toContain("Test timed out");
    expect(evidence.failureLines.join("\n")).not.toContain("queue formation failed");
    expect(evidence.failureLines.join("\n")).not.toContain("queue.vitest.ts");
    const bounded = truncateTrustedValidationOutput(output, 2_000);
    expect(bounded).toContain("notification boundary > rejects invalid proof");
    expect(bounded).toContain("Test timed out");
    expect(bounded.length).toBeLessThanOrEqual(2_000);
  });

  test("does not attribute Bun failure summaries to the last passing file", () => {
    const evidence = extractTrustedValidationFailureEvidence({
      command: "bun test",
      phase: "validation",
      exitCode: 1,
      output: [
        "tests/actual.test.ts:",
        "(fail) actual suite > preserves request contract [2ms]",
        "tests/unrelated.test.ts:",
        "(pass) unrelated suite > handles compile error [1ms]",
        "1 test failed:",
        "(fail) actual suite > preserves request contract [2ms]",
      ].join("\n"),
    });
    expect(evidence.targetPathHints).toEqual(["tests/actual.test.ts"]);
    expect(evidence.failedTests).toEqual(["actual suite > preserves request contract"]);
  });

  test("keeps diagnostics when the neighboring negative-path log is enormous", () => {
    const output = [
      "start\n" + "passing setup\n".repeat(150),
      JSON.stringify({ error: "expected rejection", payload: "x".repeat(8_000) }),
      "FAIL tests/actual.vitest.ts > actual failure",
      "Error: Test timed out in 5000ms.",
      "passing cleanup\n".repeat(200),
    ].join("\n");
    const bounded = truncateTrustedValidationOutput(output, 2_000);
    expect(bounded).toContain("FAIL tests/actual.vitest.ts > actual failure");
    expect(bounded).toContain("Error: Test timed out");
    expect(bounded.length).toBeLessThanOrEqual(2_000);
  });

  test("retains both failing files when identical names recur in the Bun summary", () => {
    const evidence = extractTrustedValidationFailureEvidence({
      command: "bun test",
      phase: "validation",
      exitCode: 1,
      output: [
        "tests/first.test.ts:",
        "(fail) common contract [1ms]",
        "tests/second.test.ts:",
        "(fail) common contract [2ms]",
        "tests/passing.test.ts:",
        "(pass) unrelated case [1ms]",
        "2 tests failed:",
        "(fail) common contract [1ms]",
        "(fail) common contract [2ms]",
      ].join("\n"),
    });
    expect(evidence.targetPathHints).toEqual(["tests/first.test.ts", "tests/second.test.ts"]);
  });

  test("passing timeout fixture names do not reclassify a compiler failure", () => {
    const evidence = extractTrustedValidationFailureEvidence({
      command: "bun run typecheck",
      phase: "validation",
      exitCode: 1,
      output:
        "(pass) worker > handles timeout [1ms]\nsrc/value.ts(3,1): error TS2322: incompatible types",
    });
    expect(evidence.failureClass).toBe("typecheck_failure");
    expect(evidence.targetPathHints).toEqual(["src/value.ts"]);
  });

  test("retains structured application failure logs when no runner diagnostic exists", () => {
    const line = '{"message":"connection failed","error":"CONNECTION_REFUSED"}';
    expect(prioritizeTrustedValidationFailureLines([line])).toEqual([line]);
    const reordered = prioritizeTrustedValidationFailureLines([
      line,
      "(pass) handles AssertionError [1ms]",
      "Error: validation service unavailable",
    ]);
    expect(reordered).toEqual(["Error: validation service unavailable"]);
  });

  test("does not treat passing Bun suite headings as repair targets", () => {
    const evidence = extractTrustedValidationFailureEvidence({
      command: "bun run validate",
      phase: "validation",
      exitCode: 1,
      output: [
        "multiplayer/client/__tests__/config.test.ts:",
        "(pass) config > reads defaults [2ms]",
        "multiplayer/client/__tests__/checkpointTransfer.test.ts:",
        "(pass) checkpoint transfer > resumes [4ms]",
        "cloudflare/account/test/account-api.vitest.ts:",
        "(fail) account deletion boundary > requires recent interactive authentication",
        "Expected: 401",
        "Received: 503",
      ].join("\n"),
    });

    expect(evidence.failureClass).toBe("test_failure");
    expect(evidence.failedTests).toEqual([
      "account deletion boundary > requires recent interactive authentication",
    ]);
    expect(evidence.targetPathHints).toEqual(["cloudflare/account/test/account-api.vitest.ts"]);
    expect(evidence.targetPathHints).not.toContain(
      "multiplayer/client/__tests__/checkpointTransfer.test.ts",
    );
    expect(evidence.failureLines.join("\n")).toContain("Received: 503");
  });

  test("extracts Vitest failed path and named test from the failing line", () => {
    const evidence = extractTrustedValidationFailureEvidence({
      command: "bun x vitest run",
      phase: "validation",
      exitCode: 1,
      output:
        "FAIL  cloudflare/account/test/account-api.vitest.ts > account boundary > rejects stale auth\nAssertionError: expected 503 to be 401",
    });

    expect(evidence.failedTests).toEqual(["account boundary > rejects stale auth"]);
    expect(evidence.targetPathHints).toEqual(["cloudflare/account/test/account-api.vitest.ts"]);
  });

  test("preserves failure neighborhoods when noisy output is truncated", () => {
    const output = [
      "start",
      ...Array.from({ length: 500 }, (_, index) => `passing diagnostic ${index}`),
      "FAIL tests/route-shell.test.ts > route shell > tears down server",
      "Error: expected process to exit",
      ...Array.from({ length: 500 }, (_, index) => `tail diagnostic ${index}`),
    ].join("\n");

    const truncated = truncateTrustedValidationOutput(output, 2_000);
    expect(truncated.length).toBeLessThanOrEqual(2_000);
    expect(truncated).toContain("route shell > tears down server");
    expect(truncated).toContain("expected process to exit");
  });

  test("normalizes volatile process, network, coordinate, and worktree identity", () => {
    const first = normalizeTrustedValidationFingerprintLine(
      "Error: job_abcdef12 process #4012 failed at 127.0.0.1:53111 in C:\\repo\\.worktrees\\job-a\\runner.ts:12:4",
    );
    const second = normalizeTrustedValidationFingerprintLine(
      "Error: job_fedcba98 process 9931 failed at 127.0.0.1:64222 in C:\\repo\\.worktrees\\job-b\\runner.ts:98:7",
    );
    expect(second).toBe(first);
    expect(first).toContain("<port>");
    expect(first).toContain("<worktree>");
    expect(first).toContain("process <pid>");
    expect(normalizeTrustedValidationFingerprintLine("src/a.py:81: Expected: 401")).toBe(
      "src/a.py:<line>: Expected: 401",
    );
  });

  test("extracts Pytest failed node and path", () => {
    const evidence = extractTrustedValidationFailureEvidence({
      command: "pytest -q",
      phase: "validation",
      exitCode: 1,
      output:
        "FAILED tests/test_accounts.py::test_rejects_stale_auth - AssertionError: expected 401",
    });
    expect(evidence.failureClass).toBe("test_failure");
    expect(evidence.failedTests).toContain("test_rejects_stale_auth");
    expect(evidence.targetPathHints).toContain("tests/test_accounts.py");
  });

  test("extracts Go test name and diagnostic path", () => {
    const evidence = extractTrustedValidationFailureEvidence({
      command: "go test ./...",
      phase: "validation",
      exitCode: 1,
      output: "--- FAIL: TestRejectsStaleAuth (0.01s)\naccount/account_test.go:42: expected 401",
    });
    expect(evidence.failureClass).toBe("test_failure");
    expect(evidence.failedTests).toContain("TestRejectsStaleAuth");
    expect(evidence.targetPathHints).toContain("account/account_test.go");
  });

  test("extracts Cargo panic test and Rust path", () => {
    const evidence = extractTrustedValidationFailureEvidence({
      command: "cargo test",
      phase: "validation",
      exitCode: 101,
      output:
        "thread 'accounts::rejects_stale_auth' panicked at src/accounts.rs:77:5:\nassertion failed: status == 401",
    });
    expect(evidence.failureClass).toBe("test_failure");
    expect(evidence.failedTests).toContain("accounts::rejects_stale_auth");
    expect(evidence.targetPathHints).toContain("src/accounts.rs");
  });

  test("extracts Ruff diagnostic path as lint evidence", () => {
    const evidence = extractTrustedValidationFailureEvidence({
      command: "ruff check .",
      phase: "validation",
      exitCode: 1,
      output: "src/accounts.py:10:5: F401 `typing.Optional` imported but unused",
    });
    expect(evidence.failureClass).toBe("lint_failure");
    expect(evidence.targetPathHints).toContain("src/accounts.py");
    expect(evidence.failureLines).toHaveLength(1);
  });
});
