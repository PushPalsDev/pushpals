import type { DashboardTheme } from "./dashboardTypes";

export interface ChatSpeakerPresentation {
  label: string;
  bubbleBg: string;
  bubbleBorder: string;
  labelColor: string;
}

function parseWorkerSuffix(raw: string): string | null {
  const match = raw.match(/workerpal-([a-z0-9]+)/i);
  return match?.[1] ? match[1].slice(0, 8) : null;
}

export function resolveChatSpeaker(
  from: string | undefined,
  theme: DashboardTheme,
): ChatSpeakerPresentation {
  const raw = (from ?? "").trim();
  const normalized = raw.toLowerCase();

  const palette =
    theme.mode === "dark"
      ? {
          local: { bg: "#1A3342", border: "#2B6984", label: "#93D5FF" },
          remote: { bg: "#222C48", border: "#4F66D9", label: "#B6C5FF" },
          worker: { bg: "#213628", border: "#4D9F67", label: "#A4E2BA" },
          scm: { bg: "#352919", border: "#B88949", label: "#FFD4A2" },
          server: { bg: "#2A2638", border: "#7D6BB3", label: "#D4C5FF" },
          agent: { bg: theme.bubbleAgent, border: theme.bubbleAgentBorder, label: theme.accent },
        }
      : {
          local: { bg: "#E9F6FF", border: "#9CCBF0", label: "#165B86" },
          remote: { bg: "#EEF0FF", border: "#AAB8F8", label: "#35449A" },
          worker: { bg: "#EAF8EC", border: "#9CD2AE", label: "#1E6C40" },
          scm: { bg: "#FFF4E7", border: "#E1B67A", label: "#8A5D1D" },
          server: { bg: "#F0EDFA", border: "#B8AFE5", label: "#5C4DA5" },
          agent: {
            bg: theme.bubbleAgent,
            border: theme.bubbleAgentBorder,
            label: theme.accentText,
          },
        };

  if (normalized.includes("localbuddy")) {
    return {
      label: "Local Buddy",
      bubbleBg: palette.local.bg,
      bubbleBorder: palette.local.border,
      labelColor: palette.local.label,
    };
  }
  if (normalized.includes("remotebuddy")) {
    return {
      label: "Remote Buddy",
      bubbleBg: palette.remote.bg,
      bubbleBorder: palette.remote.border,
      labelColor: palette.remote.label,
    };
  }
  if (normalized.includes("workerpal") || normalized.includes("workerpals")) {
    const suffix = parseWorkerSuffix(normalized);
    return {
      label: suffix ? `WorkerPal ${suffix}` : "WorkerPal",
      bubbleBg: palette.worker.bg,
      bubbleBorder: palette.worker.border,
      labelColor: palette.worker.label,
    };
  }
  if (
    normalized.includes("source_control_manager") ||
    normalized.includes("sourcecontrolmanager") ||
    normalized.includes("scm")
  ) {
    return {
      label: "Source Control Manager",
      bubbleBg: palette.scm.bg,
      bubbleBorder: palette.scm.border,
      labelColor: palette.scm.label,
    };
  }
  if (normalized.includes("server")) {
    return {
      label: "Server",
      bubbleBg: palette.server.bg,
      bubbleBorder: palette.server.border,
      labelColor: palette.server.label,
    };
  }

  if (!raw) {
    return {
      label: "Agent",
      bubbleBg: palette.agent.bg,
      bubbleBorder: palette.agent.border,
      labelColor: palette.agent.label,
    };
  }

  const simple = raw
    .replace(/^agent:/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  const pretty = simple.replace(/\b\w/g, (ch) => ch.toUpperCase());
  return {
    label: pretty || "Agent",
    bubbleBg: palette.agent.bg,
    bubbleBorder: palette.agent.border,
    labelColor: palette.agent.label,
  };
}
