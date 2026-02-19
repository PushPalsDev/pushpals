import type {
  CompletionSnapshotRow,
  JobSnapshotRow,
  RequestSnapshotRow,
} from "../lib/pushpalsApi";
import type { CoordinationRow, CoordinationStage } from "./dashboardTypes";

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function requestIdForJob(job: JobSnapshotRow): string | null {
  const params = parseJsonRecord(job.params);
  const value = params?.requestId;
  return typeof value === "string" && value.trim() ? value : null;
}

export function deriveCoordinationRows(
  requests: RequestSnapshotRow[],
  jobs: JobSnapshotRow[],
  completions: CompletionSnapshotRow[],
): CoordinationRow[] {
  const jobsByRequest = new Map<string, JobSnapshotRow[]>();
  for (const job of jobs) {
    const requestId = requestIdForJob(job);
    if (!requestId) continue;
    const list = jobsByRequest.get(requestId) ?? [];
    list.push(job);
    jobsByRequest.set(requestId, list);
  }

  const completionsByJob = new Map<string, CompletionSnapshotRow[]>();
  for (const completion of completions) {
    const list = completionsByJob.get(completion.jobId) ?? [];
    list.push(completion);
    completionsByJob.set(completion.jobId, list);
  }

  return requests.map((request) => {
    const linkedJobs = [...(jobsByRequest.get(request.id) ?? [])].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    const linkedCompletions = linkedJobs.flatMap((job) => completionsByJob.get(job.id) ?? []);
    const anyFailed =
      request.status === "failed" ||
      linkedJobs.some((job) => job.status === "failed") ||
      linkedCompletions.some((completion) => completion.status === "failed");
    const processedCompletion = linkedCompletions.find(
      (completion) => completion.status === "processed",
    );
    const anyRunning = linkedJobs.some((job) => job.status === "claimed");
    const anyPlanned =
      linkedJobs.length > 0 || request.status === "claimed" || request.status === "completed";

    let stage: CoordinationStage = "awaiting_remote";
    let stageDetail = "LocalBuddy has not delegated this to execution yet.";

    if (anyFailed) {
      stage = "failed";
      stageDetail = "A planning/execution/finalization step failed and needs intervention.";
    } else if (processedCompletion) {
      const branch = processedCompletion.branch ?? "integration branch";
      const commit = processedCompletion.commitSha?.slice(0, 8) ?? "new commit";
      stage = "ready_for_review";
      stageDetail = `Ready to review on ${branch} (${commit}).`;
    } else if (anyRunning || request.status === "claimed") {
      stage = "executing";
      stageDetail = "WorkerPal execution is active or waiting on downstream completion.";
    } else if (anyPlanned) {
      stage = "planning";
      stageDetail = "RemoteBuddy has routed work and prepared execution artifacts.";
    }

    return {
      request,
      jobs: linkedJobs,
      completions: linkedCompletions,
      stage,
      stageDetail,
    };
  });
}
