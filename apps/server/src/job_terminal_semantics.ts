export type JobTerminalSemanticKind = "success" | "no_change" | "failure" | "non_terminal";

export interface JobTerminalSemanticInput {
  status: unknown;
  result?: unknown;
  error?: unknown;
  summary?: unknown;
  detail?: unknown;
  failureClass?: unknown;
  terminalStage?: unknown;
  userAction?: unknown;
  additionalEvidence?: readonly unknown[];
}

export interface JobTerminalSemantics {
  kind: JobTerminalSemanticKind;
  terminal: boolean;
  noChange: boolean;
  success: boolean;
}

const TERMINAL_FAILURE_STATUSES = new Set(["failed", "abandoned", "publish_blocked"]);

function semanticText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * One semantic terminal classifier for lifecycle, autonomy outcome, health, and
 * SLO accounting. A worker may use the completed transport endpoint while
 * explicitly reporting that it produced no publishable change; that is a
 * terminal no-change attempt, never a successful result.
 */
export function classifyJobTerminalSemantics(
  input: JobTerminalSemanticInput,
): JobTerminalSemantics {
  const status = semanticText(input.status).trim().toLowerCase();
  const evidence = [
    input.result,
    input.error,
    input.summary,
    input.detail,
    input.failureClass,
    input.terminalStage,
    input.userAction,
    ...(input.additionalEvidence ?? []),
  ]
    .map(semanticText)
    .filter(Boolean)
    .join("\n")
    .normalize("NFKC")
    .toLowerCase();
  const noChange =
    status === "completed_no_change" ||
    /(?:^|[^\p{L}\p{N}])(?:completed[_ -]?)?no[_ -]?change(?:[^\p{L}\p{N}]|$)/u.test(evidence) ||
    /artifact[_ -]?only[_ -]?no[_ -]?publishable[_ -]?patch|no[_ -]?publishable[_ -]?patch|no file changes|no changes (?:to commit|made)|nothing to commit|modified 0 files?|no modified files (?:were )?detected|no file changes detected/i.test(
      evidence,
    );
  if (noChange) {
    return { kind: "no_change", terminal: true, noChange: true, success: false };
  }
  if (status === "completed") {
    return { kind: "success", terminal: true, noChange: false, success: true };
  }
  if (TERMINAL_FAILURE_STATUSES.has(status)) {
    return { kind: "failure", terminal: true, noChange: false, success: false };
  }
  return { kind: "non_terminal", terminal: false, noChange: false, success: false };
}
