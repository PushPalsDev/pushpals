import type { CompletionSnapshotRow, JobSnapshotRow, RequestSnapshotRow } from "../lib/pushpalsApi";

export type ResolvedMode = "light" | "dark";
export type Tone = "accent" | "positive" | "warning" | "danger";

export interface DashboardTheme {
  mode: ResolvedMode;
  background: string;
  shell: string;
  panel: string;
  panelAlt: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  positive: string;
  warning: string;
  danger: string;
  bubbleUser: string;
  bubbleAgent: string;
  bubbleAgentBorder: string;
  inputBg: string;
  fontSans: string;
  fontMono: string;
}

export interface FlowStep {
  key: string;
  label: string;
  detail: string;
  tone: Tone;
}

export type CoordinationStage =
  | "awaiting_remote"
  | "planning"
  | "executing"
  | "ready_for_review"
  | "failed";

export interface CoordinationRow {
  request: RequestSnapshotRow;
  jobs: JobSnapshotRow[];
  completions: CompletionSnapshotRow[];
  stage: CoordinationStage;
  stageDetail: string;
}
