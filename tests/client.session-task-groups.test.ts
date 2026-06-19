import { describe, expect, test } from "bun:test";
import { buildTaskGroupsFromEvents } from "../apps/client/src/lib/taskGroups";

let eventSeq = 0;

function event(type: string, payload: Record<string, unknown>) {
  eventSeq += 1;
  return {
    id: `evt-${eventSeq}`,
    ts: `2026-06-19T12:00:${String(eventSeq).padStart(2, "0")}.000Z`,
    type,
    payload,
    sessionId: "dev",
    protocolVersion: "0.1",
  } as any;
}

describe("client session task groups", () => {
  test("completes a task when a mapped job completes without a taskId payload", () => {
    const tasks = buildTaskGroupsFromEvents([
      event("task_created", {
        taskId: "review-fix-pr114-1781871891987",
        title: "Address ReviewAgent feedback for PR #114",
      }),
      event("task_started", { taskId: "review-fix-pr114-1781871891987" }),
      event("job_enqueued", {
        jobId: "2b7f3a6f-0737-498c-8644-45f9944a9727",
        taskId: "review-fix-pr114-1781871891987",
        kind: "task.execute",
      }),
      event("job_claimed", {
        jobId: "2b7f3a6f-0737-498c-8644-45f9944a9727",
        workerId: "workerpal-mqktffm3qhkc",
      }),
      event("job_completed", {
        jobId: "2b7f3a6f-0737-498c-8644-45f9944a9727",
        summary: "openai_codex stopped after durable publishable progress (1 file(s))",
        origin: "autonomy",
      }),
    ]);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("completed");
    expect(tasks[0].events.map((item) => item.type)).toContain("job_completed");
  });

  test("does not mark a task complete while another mapped job remains active", () => {
    const startedWithOneActiveJob = [
      event("task_created", { taskId: "task-1", title: "Do the thing" }),
      event("task_started", { taskId: "task-1" }),
      event("job_enqueued", { jobId: "job-1", taskId: "task-1", kind: "task.execute" }),
      event("job_enqueued", { jobId: "job-2", taskId: "task-1", kind: "task.execute" }),
      event("job_claimed", { jobId: "job-1", workerId: "workerpal-1" }),
      event("job_claimed", { jobId: "job-2", workerId: "workerpal-2" }),
      event("job_completed", { jobId: "job-1", summary: "first done" }),
    ];

    expect(buildTaskGroupsFromEvents(startedWithOneActiveJob)[0].status).toBe("started");
    expect(
      buildTaskGroupsFromEvents([
        ...startedWithOneActiveJob,
        event("job_completed", { jobId: "job-2", summary: "second done" }),
      ])[0].status,
    ).toBe("completed");
  });
});
