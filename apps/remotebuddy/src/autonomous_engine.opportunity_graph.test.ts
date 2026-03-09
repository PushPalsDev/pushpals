import { describe, expect, test } from "bun:test";
import {
  extractQueueHealthMetrics,
  parseJobFailureRateFromEvidence,
  parseLatencyEvidenceInMs,
  type QueueHealthMetric,
} from "./autonomous_engine";

describe("parseLatencyEvidenceInMs", () => {
  test("parses queue latency expressed in milliseconds", () => {
    expect(parseLatencyEvidenceInMs("queue_p95=250ms job_failure_rate=0.01")).toBe(250);
  });

  test("parses queue latency expressed in seconds", () => {
    expect(parseLatencyEvidenceInMs("queue_p95=1.2s pending=4")).toBeCloseTo(1200);
  });

  test("parses queue latency expressed in microseconds (us)", () => {
    const parsed = parseLatencyEvidenceInMs("queue_p95=500us");
    expect(parsed).not.toBeNull();
    expect(parsed).toBeCloseTo(0.5);
  });

  test("parses queue latency expressed in microseconds using µ", () => {
    const parsed = parseLatencyEvidenceInMs("queue_p95=750µs job_failure_rate=0");
    expect(parsed).not.toBeNull();
    expect(parsed).toBeCloseTo(0.75);
  });

  test("parses queue latency expressed in microseconds using μ", () => {
    const parsed = parseLatencyEvidenceInMs("queue_p95=100μs");
    expect(parsed).not.toBeNull();
    expect(parsed).toBeCloseTo(0.1);
  });
});

describe("parseJobFailureRateFromEvidence", () => {
  test("parses decimal ratios directly", () => {
    expect(parseJobFailureRateFromEvidence("job_failure_rate=0.07")).toBeCloseTo(0.07);
  });

  test("normalizes percentages to ratios", () => {
    expect(parseJobFailureRateFromEvidence("job_failure_rate=7%")).toBeCloseTo(0.07);
  });

  test("treats bare integers above one as percentages", () => {
    expect(parseJobFailureRateFromEvidence("job_failure_rate=7")).toBeCloseTo(0.07);
  });
});

describe("extractQueueHealthMetrics", () => {
  test("returns no metrics when neither signals nor traits have queue evidence", () => {
    expect(extractQueueHealthMetrics({ topSignals: [], stateTraits: [] })).toEqual([]);
  });

  test("prefers queue_health signals over supporting traits", () => {
    const metrics = extractQueueHealthMetrics({
      topSignals: [
        {
          signal_id: "sig_queue_high",
          type: "queue_health",
          value: 0.88,
          evidence: "queue_p95=1500ms job_failure_rate=0.45",
        },
      ],
      stateTraits: [
        {
          trait_id: "trait_queue_latency",
          category: "weakness",
          focus: "queue_latency",
          score: 0.7,
          evidence: "request queue p95=900ms job failure rate=0.12",
        },
      ],
    });

    expect(metrics).toHaveLength(2);
    const latency = metrics.find((entry) => entry.metric === "queue_latency_ms") as QueueHealthMetric;
    expect(latency.value).toBe(1500);
    expect(latency.sourceType).toBe("signal");

    const failure = metrics.find((entry) => entry.metric === "job_failure_rate") as QueueHealthMetric;
    expect(failure.value).toBeCloseTo(0.45);
    expect(failure.sourceType).toBe("signal");
  });

  test("selects the highest-severity metric when conflicting queue signals exist", () => {
    const metrics = extractQueueHealthMetrics({
      topSignals: [
        {
          signal_id: "sig_moderate",
          type: "queue_health",
          value: 0.4,
          evidence: "queue_p95=800ms job_failure_rate=0.1",
        },
        {
          signal_id: "sig_severe",
          type: "queue_health",
          value: 0.92,
          evidence: "queue_p95=2200ms job_failure_rate=0.4",
        },
      ],
      stateTraits: [],
    });

    const latency = metrics.find((entry) => entry.metric === "queue_latency_ms") as QueueHealthMetric;
    expect(latency.value).toBe(2200);
    expect(latency.sourceId).toBe("sig_severe");

    const failure = metrics.find((entry) => entry.metric === "job_failure_rate") as QueueHealthMetric;
    expect(failure.value).toBeCloseTo(0.4);
    expect(failure.sourceId).toBe("sig_severe");
  });

  test("selection is deterministic regardless of signal ordering", () => {
    const scenario = [
      {
        signal_id: "sig_b",
        type: "queue_health",
        value: 0.5,
        evidence: "queue_p95=900ms job_failure_rate=0.2",
      },
      {
        signal_id: "sig_a",
        type: "queue_health",
        value: 0.5,
        evidence: "queue_p95=900ms job_failure_rate=0.2",
      },
    ];

    const metricsA = extractQueueHealthMetrics({ topSignals: scenario, stateTraits: [] });
    const metricsB = extractQueueHealthMetrics({ topSignals: [...scenario].reverse(), stateTraits: [] });

    expect(metricsA).toEqual(metricsB);
    const latency = metricsA.find((entry) => entry.metric === "queue_latency_ms") as QueueHealthMetric;
    expect(latency.sourceId).toBe("sig_a");
  });

  test("ignores traits without queue context even if they contain latency strings", () => {
    const metrics = extractQueueHealthMetrics({
      topSignals: [],
      stateTraits: [
        {
          trait_id: "trait_general_latency",
          category: "weakness",
          focus: "latency",
          score: 0.4,
          evidence: "latency=2000ms job_failure_rate=0.35",
        },
        {
          trait_id: "trait_queue_latency",
          category: "weakness",
          focus: "queue_latency",
          score: 0.7,
          evidence: "queue_p95=900ms job_failure_rate=0.12",
        },
      ],
    });

    expect(metrics).toHaveLength(2);
    expect(metrics.every((metric) => metric.sourceId === "trait_queue_latency")).toBe(true);
  });

  test("uses trait evidence that explicitly references queue semantics", () => {
    const metrics = extractQueueHealthMetrics({
      topSignals: [],
      stateTraits: [
        {
          trait_id: "trait_alert_latency",
          category: "weakness",
          focus: "alert_latency",
          score: 0.55,
          evidence: "Queue p95=1800ms job_failure_rate=0.25",
        },
      ],
    });

    const latency = metrics.find((entry) => entry.metric === "queue_latency_ms") as QueueHealthMetric;
    expect(latency.value).toBe(1800);
    expect(latency.sourceType).toBe("trait");

    const failure = metrics.find((entry) => entry.metric === "job_failure_rate") as QueueHealthMetric;
    expect(failure.value).toBeCloseTo(0.25);
    expect(failure.sourceType).toBe("trait");
  });
});
