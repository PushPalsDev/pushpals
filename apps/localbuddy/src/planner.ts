/**
 * Planner / Model interface - Agent 2
 *
 * Two adapters:
 *   1. LocalHeuristicPlanner - works offline for bootstrapping
 *   2. RemotePlanner - calls an LLM endpoint (local or hosted)
 */

// Interfaces

import { loadPromptTemplate } from "shared";

export interface PlannerInput {
  userText: string;
  history: unknown[];
  repoContext?: {
    gitStatus?: string;
    gitDiff?: string;
    files?: string[];
  };
}

export interface PlannerTask {
  title: string;
  description: string;
  toolsNeeded?: string[];
  confidence: number; // 0-1
}

export interface PlannerOutput {
  tasks: PlannerTask[];
}

export interface PlannerModel {
  plan(input: PlannerInput): Promise<PlannerOutput>;
}

const BASE_REMOTE_PLANNER_SYSTEM_PROMPT = loadPromptTemplate(
  "localbuddy/localbuddy_system_prompt.md",
);
const POST_SYSTEM_PROMPT = loadPromptTemplate("shared/post_system_prompt.md");
const REMOTE_PLANNER_SYSTEM_PROMPT =
  `${BASE_REMOTE_PLANNER_SYSTEM_PROMPT}

${POST_SYSTEM_PROMPT}

Planner-specific output contract:
- For this response, output STRICT JSON only.
- JSON shape: { "tasks": [{ "title": string, "description": string, "toolsNeeded": string[], "confidence": number }] }
- Do not include markdown, prose, or code fences.
- Keep tasks concrete and executable by available tools.
`.trim();

// LocalHeuristicPlanner

/**
 * Simple keyword-based planner that works offline.
 * Good enough for bootstrapping and dogfooding.
 */
export class LocalHeuristicPlanner implements PlannerModel {
  async plan(input: PlannerInput): Promise<PlannerOutput> {
    const text = input.userText.toLowerCase();
    const tasks: PlannerTask[] = [];

    // Heuristic rules
    if (text.includes("test") || text.includes("spec")) {
      tasks.push({
        title: "Run tests",
        description: "Execute the test suite to verify correctness",
        toolsNeeded: ["bun.test"],
        confidence: 0.8,
      });
    }

    if (text.includes("lint") || text.includes("format")) {
      tasks.push({
        title: "Run linter",
        description: "Check code quality and formatting",
        toolsNeeded: ["bun.lint"],
        confidence: 0.8,
      });
    }

    if (text.includes("diff") || text.includes("change") || text.includes("patch")) {
      tasks.push({
        title: "Review changes",
        description: "Inspect current git diff for recent modifications",
        toolsNeeded: ["git.diff", "git.status"],
        confidence: 0.7,
      });
    }

    if (text.includes("search") || text.includes("find") || text.includes("grep")) {
      tasks.push({
        title: "Search codebase",
        description: "Search for relevant code patterns",
        toolsNeeded: ["file.search"],
        confidence: 0.6,
      });
    }

    if (text.includes("read") || text.includes("show") || text.includes("cat")) {
      tasks.push({
        title: "Read file",
        description: "Read the contents of a specific file",
        toolsNeeded: ["file.read"],
        confidence: 0.6,
      });
    }

    if (text.includes("apply") || text.includes("commit") || text.includes("patch")) {
      tasks.push({
        title: "Apply changes",
        description: "Apply a code patch to the repository",
        toolsNeeded: ["git.applyPatch"],
        confidence: 0.5,
      });
    }

    // New repo-awareness heuristics

    if (text.includes("log") || text.includes("history") || text.includes("commit")) {
      tasks.push({
        title: "View commit history",
        description: "Show recent commit log",
        toolsNeeded: ["git.log"],
        confidence: 0.7,
      });
    }

    if (text.includes("branch") || text.includes("branches")) {
      tasks.push({
        title: "List branches",
        description: "Show all branches and current branch",
        toolsNeeded: ["git.branch"],
        confidence: 0.8,
      });
    }

    if (
      text.includes("list") ||
      text.includes("tree") ||
      text.includes("files") ||
      text.includes("structure") ||
      text.includes("directory")
    ) {
      tasks.push({
        title: "List files",
        description: "Show project file structure",
        toolsNeeded: ["file.list"],
        confidence: 0.6,
      });
    }

    if (
      text.includes("ci") ||
      text.includes("pipeline") ||
      text.includes("actions") ||
      text.includes("workflow") ||
      text.includes("build status") ||
      text.includes("checks")
    ) {
      tasks.push({
        title: "Check CI status",
        description: "Check CI/CD pipeline status (GitHub Actions)",
        toolsNeeded: ["ci.status"],
        confidence: 0.8,
      });
    }

    if (
      text.includes("summary") ||
      text.includes("overview") ||
      text.includes("status report") ||
      text.includes("project status") ||
      text.includes("standup")
    ) {
      tasks.push({
        title: "Project summary",
        description: "Generate a high-level project overview",
        toolsNeeded: ["project.summary"],
        confidence: 0.9,
      });
    }

    if (
      text.includes("write") ||
      text.includes("create file") ||
      text.includes("new file") ||
      text.includes("save file")
    ) {
      tasks.push({
        title: "Write file",
        description: "Create or overwrite a file",
        toolsNeeded: ["file.write"],
        confidence: 0.7,
      });
    }

    if (
      text.includes("edit") ||
      text.includes("modify") ||
      text.includes("update file") ||
      text.includes("replace") ||
      text.includes("patch")
    ) {
      tasks.push({
        title: "Edit file",
        description: "Apply a targeted text edit to a file",
        toolsNeeded: ["file.patch"],
        confidence: 0.7,
      });
    }

    if (
      text.includes("run") ||
      text.includes("exec") ||
      text.includes("shell") ||
      text.includes("command") ||
      text.includes("install") ||
      text.includes("npm") ||
      text.includes("pip") ||
      text.includes("apt")
    ) {
      tasks.push({
        title: "Run command",
        description: "Execute a shell command",
        toolsNeeded: ["shell.exec"],
        confidence: 0.6,
      });
    }

    if (
      text.includes("fetch") ||
      text.includes("url") ||
      text.includes("download") ||
      text.includes("http") ||
      text.includes("website") ||
      text.includes("api")
    ) {
      tasks.push({
        title: "Fetch URL",
        description: "Fetch content from a URL",
        toolsNeeded: ["web.fetch"],
        confidence: 0.7,
      });
    }

    if (
      text.includes("search the web") ||
      text.includes("look up") ||
      text.includes("google") ||
      text.includes("web search") ||
      text.includes("search online")
    ) {
      tasks.push({
        title: "Web search",
        description: "Search the web for information",
        toolsNeeded: ["web.search"],
        confidence: 0.8,
      });
    }

    if (text.includes("rename") || text.includes("move file") || text.includes("mv ")) {
      tasks.push({
        title: "Rename / move file",
        description: "Rename or move a file",
        toolsNeeded: ["file.rename"],
        confidence: 0.85,
      });
    }

    if (text.includes("delete") || text.includes("remove file") || text.includes("rm ")) {
      tasks.push({
        title: "Delete file",
        description: "Delete a file or directory",
        toolsNeeded: ["file.delete"],
        confidence: 0.85,
      });
    }

    if (text.includes("copy file") || text.includes("cp ") || text.includes("duplicate")) {
      tasks.push({
        title: "Copy file",
        description: "Copy a file",
        toolsNeeded: ["file.copy"],
        confidence: 0.85,
      });
    }

    if (text.includes("append")) {
      tasks.push({
        title: "Append to file",
        description: "Append text to a file",
        toolsNeeded: ["file.append"],
        confidence: 0.85,
      });
    }

    if (
      text.includes("mkdir") ||
      text.includes("create dir") ||
      text.includes("create folder") ||
      text.includes("new folder") ||
      text.includes("make dir")
    ) {
      tasks.push({
        title: "Create directory",
        description: "Create a new directory",
        toolsNeeded: ["file.mkdir"],
        confidence: 0.85,
      });
    }

    // Default: at least scan the repo
    if (tasks.length === 0) {
      tasks.push({
        title: "Analyze request",
        description: `Understand user request: "${input.userText}"`,
        toolsNeeded: ["git.status", "project.summary"],
        confidence: 0.4,
      });
    }

    return { tasks };
  }
}

// RemotePlanner

/**
 * Calls a remote LLM endpoint to generate tasks.
 * Can point to a local model server (LM Studio, Ollama) or a hosted API.
 */
export class RemotePlanner implements PlannerModel {
  private endpoint: string;
  private apiKey: string | null;
  private model: string;

  constructor(
    opts: {
      endpoint?: string;
      apiKey?: string;
      model?: string;
    } = {},
  ) {
    const backend = (
      process.env.LOCALBUDDY_LLM_BACKEND ??
      ""
    )
      .trim()
      .toLowerCase();
    const defaultEndpoint =
      backend === "ollama"
        ? "http://127.0.0.1:11434/api/chat"
        : "http://127.0.0.1:1234/v1/chat/completions";
    const configuredEndpoint =
      opts.endpoint ??
      process.env.LOCALBUDDY_LLM_ENDPOINT ??
      defaultEndpoint;
    this.endpoint =
      backend === "ollama" && !configuredEndpoint.includes("/api/chat")
        ? `${configuredEndpoint.replace(/\/+$/, "")}/api/chat`
        : configuredEndpoint;
    this.apiKey =
      opts.apiKey ??
      process.env.LOCALBUDDY_LLM_API_KEY ??
      null;
    this.model =
      opts.model ??
      process.env.LOCALBUDDY_LLM_MODEL ??
      "local-model";
  }

  async plan(input: PlannerInput): Promise<PlannerOutput> {
    const userPrompt = `User request: "${input.userText}"
${input.repoContext?.gitStatus ? `\nGit status:\n${input.repoContext.gitStatus}` : ""}
${input.repoContext?.gitDiff ? `\nGit diff (truncated):\n${input.repoContext.gitDiff.substring(0, 2000)}` : ""}`;

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
      const isOllamaChatApi = this.endpoint.includes("/api/chat");
      const body: Record<string, unknown> = {
        model: this.model,
        messages: [
          { role: "system", content: REMOTE_PLANNER_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        stream: false,
      };
      if (isOllamaChatApi) {
        body.format = "json";
      }

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        console.error(`[RemotePlanner] HTTP ${response.status}`);
        // Fallback to local
        return new LocalHeuristicPlanner().plan(input);
      }

      const data = (await response.json()) as any;
      const content = data.message?.content ?? data.choices?.[0]?.message?.content ?? "{}";

      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
        return parsed as PlannerOutput;
      }

      return new LocalHeuristicPlanner().plan(input);
    } catch (err) {
      console.error(`[RemotePlanner] Error:`, err);
      // Fallback to local heuristic
      return new LocalHeuristicPlanner().plan(input);
    }
  }
}
