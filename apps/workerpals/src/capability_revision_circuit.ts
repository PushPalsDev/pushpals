import { createHash } from "crypto";
import type { JobResult } from "./common/types.js";

/** This is a stop/re-route signal, never evidence that a quality gate passed. */
export interface CapabilityRevisionBlocker {
  version: 1;
  capability: "browser_capture";
  fingerprint: string;
  occurrences: number;
  requiredEvidence: ["rendered_artifacts"];
  disposition: "await_capability";
  classificationOwner: "worker_capability_circuit";
}

function reportsUnavailableBrowser(executorResult: JobResult): boolean {
  // Use observed executor output, not the task instruction or prior review prompt.
  // stderr can retain an earlier failed probe even after the executor recovered.
  // Require the executor's current outcome to report the unavailable capability.
  const text = [executorResult.summary, executorResult.stdout]
    .filter(Boolean)
    .join("\n")
    // Codex may return a bounded event trace when no final response exists.
    // Intermediate tool narration cannot prove the final capability state.
    .split(/\b(?:Previous )?Codex event trace(?: excerpt)?:/i)[0]!
    .split(/\r?\n/)
    .filter((line) => !/\b(?:item|thread|turn)\.(?:started|completed)\s*(?:\||$)/i.test(line))
    .join("\n")
    .replace(/[\u2019\u2018]/g, "'");
  // A current successful capture statement invalidates a historical failure
  // narrative. The critic still owns whether those artifacts satisfy the task;
  // this merely prevents misclassifying further requested evidence as outage.
  if (
    /\b(?:now|successfully|finally)\b[^\r\n]{0,100}\b(?:captured|obtained|produced)\b[^\r\n]{0,100}\b(?:screenshots?|captures?|rendered evidence)\b/i.test(
      text,
    ) ||
    /\b(?:captured|obtained|produced)\b[^\r\n]{0,100}\b(?:screenshots?|captures?)\b[^\r\n]{0,60}\bsuccessfully\b/i.test(
      text,
    )
  )
    return false;
  return (
    /\b(?:browser|chromium|playwright)\b[^\r\n]{0,200}\b(?:failed (?:before|to|with)|(?:is|was|executable is) missing|(?:is|was) unavailable|denied socket|listen EPERM)\b/i.test(
      text,
    ) ||
    /\b(?:listen EPERM|socket operation (?:was )?denied)\b[^\r\n]{0,200}\b(?:browser|capture|executor)\b/i.test(
      text,
    ) ||
    /\b(?:no|neither) (?:callable |working |provisioned[- ]|available )*(?:browser|chromium)[^\r\n]{0,140}\b(?:available|accessible|exposed|tool|interface)\b/i.test(
      text,
    ) ||
    /\b(?:this executor|this sandbox|I) (?:cannot|can't)[^\r\n]{0,100}\b(?:run|launch|produce|obtain|capture|inspect)[^\r\n]{0,100}\b(?:browser|screenshots?|captures?)\b/i.test(
      text,
    )
  );
}

function requestsRenderedArtifacts(mustFix: string[]): boolean {
  return mustFix.some((finding) =>
    /\b(?:attach|capture|obtain|retain|execute|run|inspect|supply|provide)\b[^\r\n]{0,220}\b(?:screenshots?|viewport captures?|overlap captures?|browser[- ]measured|rendered (?:evidence|measurements)|visual (?:evidence|acceptance))\b/i.test(
      finding,
    ),
  );
}

/**
 * Stop only after a second consecutive observation of an unmet browser evidence
 * requirement. Changed prose or additional handoff docs cannot make an absent
 * capability available. A repaired capability, passing review, or deterministic
 * code failure resets the streak instead of being mistaken for infrastructure.
 */
export class CapabilityRevisionCircuit {
  private previousFingerprint: string | null = null;
  private occurrences = 0;

  observe(options: {
    executorResult: JobResult;
    mustFix: string[];
    criticRequiresRevision: boolean;
    deterministicIssues: string[];
    deterministicBlocker: boolean;
    targetPaths: string[];
  }): CapabilityRevisionBlocker | null {
    if (
      !options.criticRequiresRevision ||
      options.deterministicIssues.length > 0 ||
      options.deterministicBlocker ||
      !requestsRenderedArtifacts(options.mustFix) ||
      !reportsUnavailableBrowser(options.executorResult)
    ) {
      this.previousFingerprint = null;
      this.occurrences = 0;
      return null;
    }
    const targets = [
      ...new Set(
        options.targetPaths
          .map((path) => path.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
          .filter(Boolean),
      ),
    ].sort();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(["browser_capture", "rendered_artifacts", targets]))
      .digest("hex");
    this.occurrences = this.previousFingerprint === fingerprint ? this.occurrences + 1 : 1;
    this.previousFingerprint = fingerprint;
    if (this.occurrences < 2) return null;
    return {
      version: 1,
      capability: "browser_capture",
      fingerprint,
      occurrences: this.occurrences,
      requiredEvidence: ["rendered_artifacts"],
      disposition: "await_capability",
      classificationOwner: "worker_capability_circuit",
    };
  }
}

export function withCapabilityBlockedResult(
  result: JobResult,
  blocker: CapabilityRevisionBlocker,
  changedPaths: string[],
): JobResult {
  const summary =
    "Browser evidence capability unavailable; candidate held for a capable environment";
  return {
    ...result,
    ok: false,
    exitCode: 4,
    summary,
    // Do not set validationBlocked: no accepted command/artifact handoff exists.
    validationBlocked: undefined,
    publishBlocked: undefined,
    candidateState: {
      ...result.candidateState,
      status: "held",
      reason: "browser_capture_capability_unavailable",
      changedPaths,
    },
    diagnostics: {
      ...result.diagnostics,
      metadata: { ...result.diagnostics?.metadata, capabilityBlocker: blocker },
      terminal: {
        ...result.diagnostics?.terminal,
        failureClass: "environment.browser",
        terminalStage: "capability_blocked",
        summary,
        watchdogFired: false,
        metadata: {
          ...result.diagnostics?.terminal?.metadata,
          classificationOwner: "worker_capability_circuit",
          capabilityBlocker: blocker,
        },
      },
    },
  };
}
