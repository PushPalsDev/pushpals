import type { DispatcherTelemetrySnapshot } from "../dispatcher_telemetry.js";

declare module "protocol" {
  interface EventTypePayloadMap {
    dispatcher_telemetry: {
      ts: string;
      reason: string;
      event: "activated" | "cleared" | "steady";
      code: string | null;
      queueWaitMs: DispatcherTelemetrySnapshot["queueWaitMs"];
      dispatchLatencyMs: DispatcherTelemetrySnapshot["dispatchLatencyMs"];
      concurrency: DispatcherTelemetrySnapshot["concurrency"];
      backpressure: DispatcherTelemetrySnapshot["backpressure"];
      ingestion: {
        throttleActive: boolean;
        holdRemainingMs: number;
        reasonCode: string | null;
        phase: DispatcherTelemetrySnapshot["backpressure"]["phase"];
      };
    };
  }
}
