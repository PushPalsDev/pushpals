/**
 * Planner / Model interface — Agent 2
 *
 * Two adapters:
 *   1. LocalHeuristicPlanner  – works offline for bootstrapping
 *   2. RemotePlanner          – calls an LLM endpoint (local or hosted)
 */

// ─── Interfaces ─────────────────────────────────────────────────────────────

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

// ─── LocalHeuristicPlanner ──────────────────────────────────────────────────

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

    // Default: at least scan the repo
    if (tasks.length === 0) {
      tasks.push({
        title: "Analyze request",
        description: `Understand user request: "${input.userText}"`,
        toolsNeeded: ["git.status", "git.diff"],
        confidence: 0.4,
      });
    }

    return { tasks };
  }
}

// ─── RemotePlanner ──────────────────────────────────────────────────────────

/**
 * Calls a remote LLM endpoint to generate tasks.
 * Can point to a local model (e.g. Ollama) or a hosted API.
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
    this.endpoint =
      opts.endpoint ?? process.env.PLANNER_ENDPOINT ?? "http://localhost:11434/api/chat";
    this.apiKey = opts.apiKey ?? process.env.PLANNER_API_KEY ?? null;
    this.model = opts.model ?? process.env.PLANNER_MODEL ?? "llama3";
  }

  async plan(input: PlannerInput): Promise<PlannerOutput> {
    const systemPrompt = `You are a task planner for a coding agent. Given the user's request, break it down into concrete tasks that a tool-using agent can execute.

Available tools: git.status, git.diff, git.applyPatch (needs approval), bun.test, bun.lint, file.read, file.search

Respond with a JSON object: { "tasks": [{ "title": string, "description": string, "toolsNeeded": string[], "confidence": number }] }`;

    const userPrompt = `User request: "${input.userText}"
${input.repoContext?.gitStatus ? `\nGit status:\n${input.repoContext.gitStatus}` : ""}
${input.repoContext?.gitDiff ? `\nGit diff (truncated):\n${input.repoContext.gitDiff.substring(0, 2000)}` : ""}`;

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          stream: false,
          format: "json",
        }),
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
