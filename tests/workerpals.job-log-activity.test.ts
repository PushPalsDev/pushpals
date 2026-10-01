import { expect, test } from "bun:test";
import { createJobLogActivity } from "../apps/workerpals/src/job_log_activity";

test("periodic status heartbeats do not reset actual execution-output quiet age", () => {
  const activity = createJobLogActivity(1_000);
  activity.note("status", 61_000);
  activity.note("status", 121_000);
  expect(activity.quietForMs(181_000)).toBe(180_000);
  activity.note("execution", 182_000);
  activity.note("status", 242_000);
  expect(activity.quietForMs(302_000)).toBe(120_000);
  activity.note("execution", 10);
  activity.note("execution", Number.NaN);
  expect(activity.quietForMs(302_000)).toBe(120_000);
  expect(activity.quietForMs(1)).toBe(0);
});
