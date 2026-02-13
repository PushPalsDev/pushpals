import type { EventEnvelope } from "protocol/browser";

export type UserIntent = {
  summary: string;
  tasks: { title: string; description: string; confidence: number }[];
  constraints?: string[];
  riskLevel?: "low" | "medium" | "high";
};

export interface CompanionModel {
  summarizeAndPlan(input: {
    userText: string;
    history: EventEnvelope[];
  }): Promise<UserIntent>;
}

/**
 * Remote companion model - stub that calls a remote service (not implemented).
 * For now it returns a simple heuristic-based intent.
 */
export class RemoteCompanionModel implements CompanionModel {
  async summarizeAndPlan(input: {
    userText: string;
    history: EventEnvelope[];
  }): Promise<UserIntent> {
    // Simple heuristic stub: echo the user text as summary and create one task
    return {
      summary: input.userText.slice(0, 140),
      tasks: [
        {
          title: `Follow up: ${input.userText.slice(0, 40)}`,
          description: input.userText,
          confidence: 0.6,
        },
      ],
      riskLevel: "low",
    };
  }
}
