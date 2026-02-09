import type { MergeQueueDB, MergeJobStatus } from "./db";

/**
 * Small HTTP status server for the serial pusher.
 * Provides read-only access to job status for monitoring and dashboards.
 */
export function createStatusServer(
  db: MergeQueueDB,
  port: number,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      // ── Response headers (no CORS — localhost-only server) ─────────
      const headers = {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };

      // ── GET /health ───────────────────────────────────────────────────
      if (req.method === "GET" && pathname === "/health") {
        return Response.json({ status: "ok", pid: process.pid }, { headers });
      }

      // ── GET /jobs ─────────────────────────────────────────────────────
      if (req.method === "GET" && pathname === "/jobs") {
        const statusFilter = url.searchParams.get("status");
        const limitParam = url.searchParams.get("limit");
        const rawLimit = limitParam ? parseInt(limitParam, 10) : 50;
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50;

        // Validate status filter if provided
        const validStatuses = new Set(["queued", "running", "success", "failed", "skipped"]);
        if (statusFilter && !validStatuses.has(statusFilter)) {
          return Response.json(
            { error: `Invalid status: ${statusFilter}. Valid values: ${[...validStatuses].join(", ")}` },
            { status: 400, headers },
          );
        }

        const jobs = statusFilter
          ? db.getJobsByStatus(statusFilter as MergeJobStatus, limit)
          : db.getRecentJobs(limit);

        return Response.json({ jobs, count: jobs.length }, { headers });
      }

      // ── GET /jobs/:id ─────────────────────────────────────────────────
      const jobMatch = pathname.match(/^\/jobs\/(\d+)$/);
      if (req.method === "GET" && jobMatch) {
        const jobId = parseInt(jobMatch[1], 10);
        const job = db.getJob(jobId);

        if (!job) {
          return Response.json(
            { error: "Job not found" },
            { status: 404, headers },
          );
        }

        const logs = db.getJobLogs(jobId);
        return Response.json({ job, logs }, { headers });
      }

      // ── GET /stats ────────────────────────────────────────────────────
      if (req.method === "GET" && pathname === "/stats") {
        const counts = db.getStatusCounts();

        return Response.json(
          {
            queued: counts.queued ?? 0,
            running: counts.running ?? 0,
            success: counts.success ?? 0,
            failed: counts.failed ?? 0,
            skipped: counts.skipped ?? 0,
          },
          { headers },
        );
      }

      // ── 404 ───────────────────────────────────────────────────────────
      return Response.json(
        { error: "Not found" },
        { status: 404, headers },
      );
    },
  });
}
