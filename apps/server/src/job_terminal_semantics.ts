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
  return typeof value === "string" ? value : "";
}

const TYPED_TERMINAL_FIELDS = [
  "status",
  "failureClass",
  "terminalStage",
  "userAction",
  "kind",
  "outcome",
] as const;
const TERMINAL_PROSE_FIELDS = ["summary", "message", "detail"] as const;

export interface JobTerminalEvidence {
  typed: string[];
  prose: string[];
}

/** Result envelopes contain artifacts and historical logs as well as outcomes. */
export function collectJobTerminalEvidence(value: unknown, depth = 0): JobTerminalEvidence {
  const empty = (): JobTerminalEvidence => ({ typed: [], prose: [] });
  if (depth > 4 || value == null) return empty();
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return empty();
    if (/^[{\["]/.test(trimmed)) {
      try {
        return collectJobTerminalEvidence(JSON.parse(trimmed), depth + 1);
      } catch {
        // Truncated/malformed JSON is not a terminal outcome. In particular,
        // scanning it would promote text inside a truncated artifact to proof.
        return empty();
      }
    }
    return { typed: [], prose: [value] };
  }
  if (typeof value !== "object" || Array.isArray(value)) return empty();
  const record = value as Record<string, unknown>;
  const evidence = {
    typed: TYPED_TERMINAL_FIELDS.map((key) => semanticText(record[key])).filter(Boolean),
    prose: TERMINAL_PROSE_FIELDS.map((key) => semanticText(record[key])).filter(Boolean),
  };
  const include = (nested: unknown): void => {
    const child = collectJobTerminalEvidence(nested, depth + 1);
    evidence.typed.push(...child.typed);
    evidence.prose.push(...child.prose);
  };
  for (const key of ["result", "error"] as const) {
    if (record[key] !== undefined) include(record[key]);
  }
  const diagnostics = record.diagnostics;
  if (diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)) {
    include((diagnostics as Record<string, unknown>).terminal);
  }
  return evidence;
}

function isNoChangeToken(value: string): boolean {
  const token = value.normalize("NFKC").trim().toLowerCase().replace(/[ -]+/g, "_");
  return [
    "no_change",
    "completed_no_change",
    "artifact_only_no_publishable_patch",
    "no_publishable_patch",
  ].includes(token);
}

function declaresNoChange(value: string): boolean {
  // Work on no-change reporting is itself a real change. Prose must declare
  // an actual terminal outcome instead of merely mentioning that topic.
  const text = value.normalize("NFKC").trim().toLowerCase().replace(/\*\*/g, "");
  if (isNoChangeToken(text)) return true;
  return (
    /^(?:completed[_ -]?)?no[_ -]?change\s*[:;.!](?:\s|$)/.test(text) ||
    /^no changes? (?:was|were|is|are) (?:needed|required|necessary|made|produced|detected)\b/.test(
      text,
    ) ||
    /^(?:job )?completed(?: task)? (?:with no|without any) (?:file )?changes(?:[.!:;,]|$)/.test(
      text,
    ) ||
    /^no file changes(?: (?:were )?(?:detected|made|produced|required))?(?:[.!:;,]|$)/.test(text) ||
    /^no modified files (?:were )?detected(?:[.!:;,]|$)/.test(text) ||
    /^(?:no changes (?:to commit|made)|nothing to commit|modified 0 files?)(?:[.!:;,]|$)/.test(
      text,
    ) ||
    /^executed task via [a-z0-9_-]+ \(no file changes detected\)(?:[.!:;,]|$)/.test(text) ||
    /^executor (?:produced|made) no publishable (?:code )?(?:changes?|patch)\b/.test(text) ||
    /^no publishable patch (?:was |has been )?(?:produced|created|detected)\b/.test(text)
  );
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
  if (
    status !== "completed" &&
    status !== "completed_no_change" &&
    !TERMINAL_FAILURE_STATUSES.has(status)
  ) {
    return { kind: "non_terminal", terminal: false, noChange: false, success: false };
  }
  const evidence = collectJobTerminalEvidence({
    result: input.result,
    error: input.error,
    summary: input.summary,
    detail: input.detail,
    failureClass: input.failureClass,
    terminalStage: input.terminalStage,
    userAction: input.userAction,
  });
  // Legacy combined artifact/log text cannot become outcome evidence. Only
  // an exact standalone typed token from additionalEvidence is recognized.
  evidence.typed.push(...(input.additionalEvidence ?? []).map(semanticText));
  const noChange =
    status === "completed_no_change" ||
    evidence.typed.some(isNoChangeToken) ||
    evidence.prose.some(declaresNoChange);
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
