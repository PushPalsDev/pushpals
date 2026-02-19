import type { QueueCounts } from "../lib/pushpalsApi";
import type { DashboardTheme, Tone } from "./dashboardTypes";

export function queueValue(counts: QueueCounts | undefined, key: string): number {
  return Number(counts?.[key] ?? 0);
}

export function clip(value: string | undefined | null, limit = 180): string {
  if (!value) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}...`;
}

export function prettyTs(iso?: string): string {
  if (!iso) return "--";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "--";
  return new Date(ts).toLocaleTimeString();
}

export function relativeMs(iso?: string): string {
  if (!iso) return "unknown";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "unknown";
  const delta = Date.now() - ts;
  if (delta < 10_000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

export function statusColor(theme: DashboardTheme, status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("complete") || normalized.includes("processed")) return theme.positive;
  if (
    normalized.includes("fail") ||
    normalized.includes("error") ||
    normalized.includes("offline")
  ) {
    return theme.danger;
  }
  if (normalized.includes("initializing")) return theme.warning;
  if (normalized.includes("busy") || normalized.includes("claim")) return theme.warning;
  if (normalized.includes("progress") || normalized.includes("start")) return theme.warning;
  return theme.accent;
}

export function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${Math.round(value * 100)}%`;
}

export function formatDuration(valueMs: number | null | undefined): string {
  if (typeof valueMs !== "number" || !Number.isFinite(valueMs) || valueMs < 0) return "--";
  if (valueMs < 1000) return `${Math.round(valueMs)}ms`;
  if (valueMs < 60_000) return `${(valueMs / 1000).toFixed(1)}s`;
  return `${Math.round(valueMs / 1000)}s`;
}

export function formatEtaMs(valueMs: number | null | undefined): string {
  if (typeof valueMs !== "number" || !Number.isFinite(valueMs) || valueMs <= 0) return "now";
  if (valueMs < 1_000) return `${Math.round(valueMs)}ms`;
  const seconds = Math.ceil(valueMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
}

export function parseJsonText(value: string | null): string {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "string") return parsed;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

export function toneColor(theme: DashboardTheme, tone: Tone): string {
  if (tone === "positive") return theme.positive;
  if (tone === "warning") return theme.warning;
  if (tone === "danger") return theme.danger;
  return theme.accent;
}
