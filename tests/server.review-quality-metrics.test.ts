import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AutonomyStore } from "../apps/server/src/autonomy";

describe("review quality metrics use observed PR outcomes", () => {
  test("successful publication is not a review revision or a review-quality sample", () => {
    withStore((store, seed) => {
      const db = (store as unknown as { db: Database }).db;
      db.prepare(
        `INSERT INTO autonomy_outcomes
        (objective_id, pattern_key, success, terminal, user_action, created_at)
        VALUES ('published', 'published', 1, 0, 'published', ?)`,
      ).run(new Date().toISOString());
      expect(store.getReliabilityMetrics()).toMatchObject({
        nonTerminalRevisionCount: 0,
        objectiveRevisionRate: null,
        objectiveFirstPassRate: null,
      });
      seed("published", { reviewed: true, success: true });
      expect(store.getReliabilityMetrics()).toMatchObject({
        nonTerminalRevisionCount: 0,
        objectiveRevisionRate: 0,
        objectiveFirstPassRate: 1,
      });
    });
  });

  test("revisions aging out of the reporting window cannot turn a revised merge into first-pass", () => {
    withStore((store, seed) => {
      seed("aged-revision", { reviewed: true, success: true, revision: true });
      const db = (store as unknown as { db: Database }).db;
      db.prepare(`UPDATE autonomy_outcomes SET created_at = ? WHERE terminal = 0`).run(
        new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
      );
      expect(store.getReliabilityMetrics()).toMatchObject({
        nonTerminalRevisionCount: 0,
        objectiveFirstPassRate: 0,
        objectiveRevisionRate: 1,
      });
    });
  });

  const withStore = (
    run: (
      store: AutonomyStore,
      seed: (
        id: string,
        options?: {
          reviewed?: boolean;
          success?: boolean;
          revision?: boolean;
          terminal?: boolean;
        },
      ) => void,
    ) => void,
  ) => {
    const store = new AutonomyStore(":memory:");
    const db = (store as unknown as { db: Database }).db;
    const seed = (
      id: string,
      options: {
        reviewed?: boolean;
        success?: boolean;
        revision?: boolean;
        terminal?: boolean;
      } = {},
    ) => {
      const ts = new Date().toISOString();
      if (options.reviewed)
        db.prepare(
          `INSERT INTO autonomy_pr_feedback
        (objective_id, pattern_key, verdict, created_at) VALUES (?, ?, ?, ?)`,
        ).run(id, id, options.success ? "approved_merged" : "closed_unmerged", ts);
      if (options.revision)
        db.prepare(
          `INSERT INTO autonomy_outcomes
        (objective_id, pattern_key, success, terminal, created_at) VALUES (?, ?, 0, 0, ?)`,
        ).run(id, id, ts);
      if (options.terminal !== false)
        db.prepare(
          `INSERT INTO autonomy_outcomes
        (objective_id, pattern_key, success, terminal, created_at) VALUES (?, ?, ?, 1, ?)`,
        ).run(id, id, options.success ? 1 : 0, ts);
    };
    try {
      run(store, seed);
    } finally {
      store.close();
    }
  };

  test("four pre-review failures report zero execution success and unavailable review quality", () => {
    withStore((store, seed) => {
      for (let index = 0; index < 4; index++) seed(`failed-${index}`);
      expect(store.getReliabilityMetrics()).toMatchObject({
        objectiveTerminalCount: 4,
        objectiveSuccessRate: 0,
        objectiveRevisionRate: null,
        objectiveFirstPassRate: null,
      });
    });
  });

  test("a closed-unmerged PR without revisions is not a first-pass success", () => {
    withStore((store, seed) => {
      seed("closed", { reviewed: true });
      expect(store.getReliabilityMetrics()).toMatchObject({
        objectiveFirstPassRate: 0,
        objectiveRevisionRate: 0,
      });
    });
  });

  test("reviewed cohorts exclude infrastructure failures and require successful delivery", () => {
    withStore((store, seed) => {
      seed("first-pass", { reviewed: true, success: true });
      seed("revised-merge", { reviewed: true, success: true, revision: true });
      seed("closed", { reviewed: true });
      seed("pending-revision", { revision: true, terminal: false });
      for (let index = 0; index < 4; index++) seed(`infra-${index}`);
      expect(store.getReliabilityMetrics()).toMatchObject({
        objectiveTerminalCount: 7,
        objectiveFirstPassRate: 0.25,
        objectiveRevisionRate: 0.5,
      });
    });
  });

  test("unresolved review and duplicate feedback cannot inflate first-pass success", () => {
    withStore((store, seed) => {
      seed("first-pass", { reviewed: true, success: true });
      seed("first-pass", { reviewed: true, success: true });
      seed("unresolved", { reviewed: true, terminal: false });
      expect(store.getReliabilityMetrics().objectiveFirstPassRate).toBe(0.5);
    });
  });
});
