import { describe, expect, test } from "bun:test";
import {
  CompositeSessionMemory,
  createSessionMemoryBackend,
  InMemorySessionMemory,
  NoopSessionMemory,
  mergeMemoryLines,
  type SessionMemoryBackend,
  type SessionMemoryRecallOptions,
  type SessionMemoryWriteInput,
  type SessionMemoryWriteOptions,
} from "../apps/remotebuddy/src/memory";

class StubBackend implements SessionMemoryBackend {
  remembers: Array<{ input: SessionMemoryWriteInput; options: SessionMemoryWriteOptions }> = [];
  recalls: string[] = [];
  purged = 0;
  closed = false;

  remember(input: SessionMemoryWriteInput, options: SessionMemoryWriteOptions = {}): void {
    this.remembers.push({ input, options });
  }

  recallForPlanning(_options: SessionMemoryRecallOptions): string[] {
    return [...this.recalls];
  }

  purgeExpired(_retentionDays: number, _repoRoot?: string): number {
    this.purged += 1;
    return 1;
  }

  close(): void {
    this.closed = true;
  }
}

class ThrowingBackend implements SessionMemoryBackend {
  remember(_input: SessionMemoryWriteInput, _options: SessionMemoryWriteOptions = {}): void {
    throw new Error("remember boom");
  }
  recallForPlanning(_options: SessionMemoryRecallOptions): string[] {
    throw new Error("recall boom");
  }
  purgeExpired(_retentionDays: number, _repoRoot?: string): number {
    throw new Error("purge boom");
  }
  close(): void {
    throw new Error("close boom");
  }
}

describe("remotebuddy memory modular composition", () => {
  test("mergeMemoryLines dedupes and respects size limits", () => {
    const merged = mergeMemoryLines(
      [
        " [memory repo-history plan] alpha ",
        "[memory repo-history plan] alpha",
        "[memory this-session request] beta",
      ],
      { maxItems: 2, maxChars: 70 },
    );
    expect(merged.length).toBe(2);
    expect(merged[0]).toContain("alpha");
    expect(merged[1]).toContain("beta");
  });

  test("composite fans out remember and merges recall from all backends", () => {
    const a = new StubBackend();
    const b = new StubBackend();
    a.recalls = ["[memory repo-history note] alpha", "[memory repo-history note] beta"];
    b.recalls = ["[memory repo-history note] alpha", "[memory this-session note] gamma"];
    const composite = new CompositeSessionMemory([a, b]);
    const input: SessionMemoryWriteInput = {
      repoRoot: "C:/repo/pushpals",
      sessionId: "session-a",
      requestId: "req-1",
      kind: "plan",
      summary: "plan details",
    };

    composite.remember(input, { maxSummaryChars: 300, retentionDays: 14 });
    const recalled = composite.recallForPlanning({
      repoRoot: "C:/repo/pushpals",
      sessionId: "session-a",
      includeCurrentSession: true,
      includeCrossSession: true,
      maxItems: 3,
      maxChars: 500,
    });

    expect(a.remembers.length).toBe(1);
    expect(b.remembers.length).toBe(1);
    expect(recalled).toEqual([
      "[memory repo-history note] alpha",
      "[memory repo-history note] beta",
      "[memory this-session note] gamma",
    ]);
  });

  test("factory returns noop when disabled and composite when multiple enabled backends", () => {
    const a = new StubBackend();
    const b = new StubBackend();
    const disabled = createSessionMemoryBackend(false, [() => a, () => b]);
    const enabled = createSessionMemoryBackend(true, [() => a, () => b]);

    expect(disabled instanceof NoopSessionMemory).toBe(true);
    expect(enabled instanceof CompositeSessionMemory).toBe(true);
  });

  test("factory returns single backend directly for easy backend-specific extensions", () => {
    const single = new StubBackend();
    const resolved = createSessionMemoryBackend(true, [() => single]);
    expect(resolved).toBe(single);
  });

  test("factory is lazy when disabled (backend constructors are not invoked)", () => {
    let constructed = 0;
    const disabled = createSessionMemoryBackend(false, [
      () => {
        constructed += 1;
        return new StubBackend();
      },
    ]);
    expect(disabled instanceof NoopSessionMemory).toBe(true);
    expect(constructed).toBe(0);
  });

  test("composite tolerates failing backends", () => {
    const ok = new StubBackend();
    ok.recalls = ["[memory repo-history request] safe-path"];
    const composite = new CompositeSessionMemory([new ThrowingBackend(), ok]);

    composite.remember(
      {
        repoRoot: "C:/repo/pushpals",
        sessionId: "session-a",
        kind: "request",
        summary: "hello",
      },
      { retentionDays: 30, maxSummaryChars: 420 },
    );
    const recalled = composite.recallForPlanning({
      repoRoot: "C:/repo/pushpals",
      sessionId: "session-a",
      includeCurrentSession: true,
      includeCrossSession: true,
      maxItems: 5,
      maxChars: 500,
    });
    const purged = composite.purgeExpired(30, "C:/repo/pushpals");
    composite.close();

    expect(recalled).toEqual(["[memory repo-history request] safe-path"]);
    expect(purged).toBe(1);
    expect(ok.closed).toBe(true);
  });

  test("in-memory backend supports cross-session repo recall", () => {
    const memory = new InMemorySessionMemory();
    const repoRoot = "C:/repo/pushpals";

    memory.remember(
      {
        repoRoot,
        sessionId: "session-1",
        kind: "request",
        summary: "First session context",
      },
      { retentionDays: 30, maxSummaryChars: 420 },
    );
    memory.remember(
      {
        repoRoot,
        sessionId: "session-2",
        kind: "plan",
        summary: "Second session context",
      },
      { retentionDays: 30, maxSummaryChars: 420 },
    );

    const recalled = memory.recallForPlanning({
      repoRoot,
      sessionId: "session-3",
      includeCurrentSession: true,
      includeCrossSession: true,
      maxItems: 8,
      maxChars: 500,
    });

    expect(recalled.length).toBe(2);
    expect(recalled.join("\n")).toContain("repo-history");
    expect(recalled.join("\n")).toContain("First session context");
    expect(recalled.join("\n")).toContain("Second session context");
  });
});
