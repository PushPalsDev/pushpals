export type ExecutorBackend = string;

export interface JobTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  estimated?: boolean;
  backend?: string;
  modelId?: string;
}

export interface JobPublishBlockedInfo {
  summary: string;
  detail: string;
  publicBranch: string;
  localRef: string;
  sha: string;
  stage: "sync" | "push";
}

export interface JobResult {
  ok: boolean;
  summary: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  usage?: JobTokenUsage;
  publishBlocked?: JobPublishBlockedInfo;
}
