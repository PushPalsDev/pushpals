import { describe, expect, test } from "bun:test";
import {
  dependencySnapshotHasIssues,
  mergeRebaseRemediationMessage,
  notifyDependencyPreflightBlock,
  summarizePreflightFailure,
  toDependencySnapshot,
  type PreflightReport,
} from "./preflight.js";

describe("RemoteBuddy preflight helpers", () => {
  test("summarizePreflightFailure surfaces detail and remediation", () => {
    const report: PreflightReport = {
      repoRoot: "/repo",
      generatedAt: new Date().toISOString(),
      checks: [
        {
          code: "repo.merge_in_progress",
          label: "Merge in progress",
          category: "repo",
          ok: false,
          detail: "MERGE_HEAD present",
          remediation: mergeRebaseRemediationMessage(),
        },
        {
          code: "repo.worktree_clean",
          label: "Worktree",
          category: "repo",
          ok: true,
          detail: "clean",
        },
      ],
    };
    const summary = summarizePreflightFailure(report);
    expect(summary).toContain("MERGE_HEAD");
    expect(summary).toContain("Resolve or abort");
  });

  test("toDependencySnapshot normalizes workspace link issues", () => {
    const snapshot = toDependencySnapshot({
      repoRoot: "/repo",
      rootWorkspaceLinkIssues: [
        {
          label: "node_modules/shared workspace link",
          path: "/repo/node_modules/shared",
          probeError: "ENOENT",
          expectedTarget: "/repo/packages/shared",
          actualTarget: "/repo/packages/shared.bak",
        },
      ],
    });
    expect(dependencySnapshotHasIssues(snapshot)).toBe(true);
    expect(snapshot.missingWorkspaceLinks[0]?.path).toBe("node_modules/shared");
    expect(snapshot.missingWorkspaceLinks[0]?.expectedTarget).toBe("packages/shared");
    expect(snapshot.missingWorkspaceLinks[0]?.actualTarget).toBe("packages/shared.bak");
    expect(snapshot.missingArtifacts).toHaveLength(0);
  });

  test("summarizePreflightFailure includes workspace link target hints", () => {
    const snapshot = toDependencySnapshot({
      repoRoot: "/repo",
      rootWorkspaceLinkIssues: [
        {
          label: "node_modules/shared workspace link",
          path: "/repo/node_modules/shared",
          probeError: "SYMLINK_TARGET_MISMATCH",
          expectedTarget: "/repo/packages/shared",
          actualTarget: "/repo/packages/shared.bak",
        },
      ],
    });
    const summary = summarizePreflightFailure({
      repoRoot: "/repo",
      generatedAt: new Date().toISOString(),
      checks: [],
      dependencySnapshot: snapshot,
    });
    expect(summary).toContain("expected=packages/shared");
    expect(summary).toContain("actual=packages/shared.bak");
  });

  test("notifyDependencyPreflightBlock emits assistant message summary", async () => {
    const snapshot = toDependencySnapshot({
      repoRoot: "/repo",
      rootWorkspaceLinkIssues: [
        {
          label: "node_modules/shared workspace link",
          path: "/repo/node_modules/shared",
          probeError: "ENOENT",
        },
      ],
    });
    const messages: string[] = [];
    const messenger = {
      async assistantMessage(text: string, _meta?: Record<string, unknown>) {
        messages.push(text);
        return true;
      },
    };
    await notifyDependencyPreflightBlock(messenger, snapshot, {
      detail: "Workspace dependencies missing.",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Workspace dependencies missing.");
    expect(messages[0]).toContain("node_modules/shared");
  });
});
