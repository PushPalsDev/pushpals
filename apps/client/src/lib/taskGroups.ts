import type { EventEnvelope } from "protocol/browser";

export interface TaskGroup {
  taskId: string;
  title: string;
  status: "created" | "started" | "in_progress" | "completed" | "failed";
  events: EventEnvelope[];
}

type DerivedJobStatus = "enqueued" | "claimed" | "completed" | "failed";

export function buildTaskGroupsFromEvents(events: EventEnvelope[]): TaskGroup[] {
  const map = new Map<string, TaskGroup>();
  const jobToTask = new Map<string, string>();
  const jobStatus = new Map<string, DerivedJobStatus>();
  const jobIdsByTask = new Map<string, Set<string>>();

  const linkJobToTask = (jobId: string, taskId: string) => {
    jobToTask.set(jobId, taskId);
    const jobIds = jobIdsByTask.get(taskId) ?? new Set<string>();
    jobIds.add(jobId);
    jobIdsByTask.set(taskId, jobIds);
  };

  const hasActiveJob = (taskId: string) => {
    const jobIds = jobIdsByTask.get(taskId);
    if (!jobIds) return false;
    for (const jobId of jobIds) {
      const status = jobStatus.get(jobId);
      if (status === "enqueued" || status === "claimed") return true;
    }
    return false;
  };

  const hasFailedJob = (taskId: string) => {
    const jobIds = jobIdsByTask.get(taskId);
    if (!jobIds) return false;
    for (const jobId of jobIds) {
      if (jobStatus.get(jobId) === "failed") return true;
    }
    return false;
  };

  for (const ev of events) {
    const p = ev.payload as any;
    const payloadTaskId: string | undefined =
      typeof p?.taskId === "string" ? p.taskId : undefined;
    const payloadJobId: string | undefined = typeof p?.jobId === "string" ? p.jobId : undefined;

    if (ev.type === "job_enqueued" && payloadTaskId && payloadJobId) {
      linkJobToTask(payloadJobId, payloadTaskId);
      jobStatus.set(payloadJobId, "enqueued");
    } else if (ev.type === "job_claimed" && payloadJobId && jobToTask.has(payloadJobId)) {
      jobStatus.set(payloadJobId, "claimed");
    } else if (ev.type === "job_completed" && payloadJobId && jobToTask.has(payloadJobId)) {
      jobStatus.set(payloadJobId, "completed");
    } else if (ev.type === "job_failed" && payloadJobId && jobToTask.has(payloadJobId)) {
      jobStatus.set(payloadJobId, "failed");
    }

    const taskId: string | undefined =
      payloadTaskId ?? (payloadJobId ? jobToTask.get(payloadJobId) : undefined);
    if (!taskId) continue;

    if (!map.has(taskId)) {
      map.set(taskId, {
        taskId,
        title: p.title ?? taskId,
        status: "created",
        events: [],
      });
    }
    const group = map.get(taskId)!;
    group.events.push(ev);
    if (
      (!group.title || group.title === taskId) &&
      typeof p?.title === "string" &&
      p.title.trim()
    ) {
      group.title = p.title;
    }

    if (ev.type === "task_started") group.status = "started";
    else if (ev.type === "task_progress") group.status = "in_progress";
    else if (ev.type === "task_completed") group.status = "completed";
    else if (ev.type === "task_failed") group.status = "failed";
    else if (ev.type === "job_completed" && group.status !== "failed") {
      if (!hasActiveJob(taskId) && !hasFailedJob(taskId)) {
        group.status = "completed";
      }
    } else if (ev.type === "job_failed" && group.status !== "completed") {
      if (!hasActiveJob(taskId)) {
        group.status = "failed";
      }
    }
  }

  return Array.from(map.values());
}
