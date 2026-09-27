import { describe, expect, test } from "bun:test";
import {
  containsPushPalsInternalUserRepoText,
  evaluateAutonomyInternalWork,
  type AutonomyInternalWorkCandidate,
  type AutonomyInternalWorkProvenance,
} from "../apps/remotebuddy/src/autonomy_candidate_admission";

const repository = { identity: "fixture-product", revision: "a".repeat(40), tree: "b".repeat(40) };
const sourcePath = "utils/appShellLabel.js";
const blobHash = "c".repeat(40);
const candidate = (): AutonomyInternalWorkCandidate => ({
  title: "Correct the app-shell landmark product name",
  problem_statement:
    "utils/appShellLabel.js:1 exports 'PushPals app shell', whereas vision.md identifies the product as Orchard. The supplied packet does not show its rendered consumers.",
  vision_alignment_reason: "Keep the product's shared label consistent with its documented name.",
  feature_hypotheses: ["A corrected shared constant prevents inconsistent product naming."],
  target_paths: [sourcePath],
  component_area: "utils",
});
const provenance = (): AutonomyInternalWorkProvenance => ({
  currentRepository: { ...repository },
  evidenceRepository: { ...repository },
  verifiedTargetPaths: [{ path: sourcePath, blobHash }],
  evidence: [
    {
      path: sourcePath,
      revision: repository.revision,
      blobHash,
      startLine: 1,
      endLine: 1,
      excerpt: "export const APP_SHELL_LABEL = 'PushPals app shell';",
    },
  ],
});

describe("autonomy structural internal-work admission", () => {
  test("allows correcting a host-verified source quotation in a generic product repository", () => {
    expect(evaluateAutonomyInternalWork(candidate(), provenance())).toEqual({
      ok: true,
      reason: null,
      groundedQuotedSource: true,
      repositoryNativeProblemStatement:
        "utils/appShellLabel.js:1 exports [existing source literal; see cited location], whereas vision.md identifies the product as Orchard. The supplied packet does not show its rendered consumers.",
    });
  });

  test("supports quoted source declarations, with a real line-range and backtick path citation", () => {
    const source = provenance();
    source.evidence = [{ ...source.evidence![0]!, startLine: 4, endLine: 6 }];
    expect(
      evaluateAutonomyInternalWork(
        {
          ...candidate(),
          problem_statement:
            '`utils/appShellLabel.js`:4-6 declares the literal "PushPals app shell".',
        },
        source,
      ).ok,
    ).toBe(true);
  });

  test("supports an observed user-visible string followed by a repo-native replacement action", () => {
    const input = {
      ...candidate(),
      problem_statement:
        'utils/appShellLabel.js:1 contains the user-visible string "PushPals app shell"; replace it with the documented product name and add a regression.',
    };
    const result = evaluateAutonomyInternalWork(input, provenance());
    expect(result.ok).toBe(true);
    expect(result.repositoryNativeProblemStatement).toContain(
      "; replace it with the documented product name and add a regression.",
    );
  });

  test.each(["identity", "revision", "tree"] as const)(
    "does not consume evidence from a different %s",
    (field) => {
      const source = provenance();
      source.evidenceRepository = { ...repository, [field]: "d".repeat(40) };
      expect(evaluateAutonomyInternalWork(candidate(), source).ok).toBe(false);
    },
  );

  test.each([
    ["no provenance", {}],
    ["no verified targets", { ...provenance(), verifiedTargetPaths: [] }],
    [
      "different target",
      { ...provenance(), verifiedTargetPaths: [{ path: "other.js", blobHash }] },
    ],
    [
      "different current blob",
      { ...provenance(), verifiedTargetPaths: [{ path: sourcePath, blobHash: "d".repeat(40) }] },
    ],
  ] as const)("keeps quoted internals rejected with %s", (_label, source) => {
    expect(evaluateAutonomyInternalWork(candidate(), source).ok).toBe(false);
  });

  test.each([
    ["different evidence path", { path: "other.js" }],
    ["different evidence revision", { revision: "d".repeat(40) }],
    ["different evidence blob", { blobHash: "d".repeat(40) }],
    ["missing blob", { blobHash: undefined }],
    ["invalid blob", { blobHash: "model-claimed-blob" }],
    ["different literal", { excerpt: "export const APP_SHELL_LABEL = 'Orchard app shell';" }],
    [
      "literal substring only",
      { excerpt: "export const APP_SHELL_LABEL = 'PushPals app shell settings';" },
    ],
    ["missing line provenance", { startLine: undefined }],
    ["different line range", { startLine: 2, endLine: 2 }],
    ["malformed line range", { startLine: 2, endLine: 1 }],
  ])("rejects %s", (_label, overrides) => {
    const source = provenance();
    source.evidence = [{ ...source.evidence![0]!, ...(overrides as object) }];
    expect(evaluateAutonomyInternalWork(candidate(), source).ok).toBe(false);
  });

  test("does not use non-target citations or model rationale as source provenance", () => {
    const source = provenance();
    source.evidence = [{ ...source.evidence![0]!, path: "README.md" }];
    source.verifiedTargetPaths = [{ path: "README.md", blobHash }];
    expect(evaluateAutonomyInternalWork(candidate(), source).ok).toBe(false);
    const rawEvidence = {
      ...provenance().evidence![0]!,
      excerpt: undefined,
      rationale: "'PushPals app shell'",
    };
    expect(
      evaluateAutonomyInternalWork(candidate(), { ...provenance(), evidence: [rawEvidence] }).ok,
    ).toBe(false);
  });

  test.each([
    "Replace the existing label with 'PushPals app shell'.",
    "Set utils/appShellLabel.js:1 to 'PushPals app shell'.",
    "utils/appShellLabel.js:1 should export 'PushPals app shell'.",
    "'PushPals app shell' is a useful new label to introduce.",
    "another/file.js:1 exports 'PushPals app shell'.",
    "utils/AppShellLabel.js:1 exports 'PushPals app shell'.",
  ])("does not treat quoted action or unrelated attribution as an observation: %s", (problem) => {
    expect(
      evaluateAutonomyInternalWork({ ...candidate(), problem_statement: problem }, provenance()).ok,
    ).toBe(false);
  });

  test("requires a naming-remediation title, not arbitrary internal work with a source quote", () => {
    expect(
      evaluateAutonomyInternalWork(
        {
          ...candidate(),
          title: "Add queue diagnostics to the application",
        },
        provenance(),
      ).ok,
    ).toBe(false);
  });

  test.each(["title", "vision_alignment_reason", "feature_hypotheses"] as const)(
    "keeps remaining %s strict even when the source quote is grounded",
    (field) => {
      const value = "Expose WorkerPal queue diagnostics in the product UI";
      expect(
        evaluateAutonomyInternalWork(
          {
            ...candidate(),
            [field]: field === "feature_hypotheses" ? [value] : value,
          },
          provenance(),
        ).ok,
      ).toBe(false);
    },
  );

  test("does not strip ungrounded work appended after a valid source quotation", () => {
    const input = {
      ...candidate(),
      problem_statement: `${candidate().problem_statement} Add WorkerPal queue health to the product.`,
    };
    const result = evaluateAutonomyInternalWork(input, provenance());
    expect(result.ok).toBe(false);
    expect(result.repositoryNativeProblemStatement).toBe(input.problem_statement);
    expect(result.groundedQuotedSource).toBe(false);
  });

  test("safe rendering preserves every non-quotation word and the original candidate", () => {
    const input = candidate();
    const original = JSON.stringify(input);
    const result = evaluateAutonomyInternalWork(input, provenance());
    expect(result.repositoryNativeProblemStatement).toBe(
      String(input.problem_statement).replace(
        "'PushPals app shell'",
        "[existing source literal; see cited location]",
      ),
    );
    expect(JSON.stringify(input)).toBe(original);
    expect(result.repositoryNativeProblemStatement).toContain("utils/appShellLabel.js:1 exports");
    expect(result.repositoryNativeProblemStatement).toContain(
      "does not show its rendered consumers",
    );
    expect(containsPushPalsInternalUserRepoText(result.repositoryNativeProblemStatement)).toBe(
      false,
    );
    expect(
      evaluateAutonomyInternalWork(
        {
          ...input,
          problem_statement: result.repositoryNativeProblemStatement,
        },
        provenance(),
      ).repositoryNativeProblemStatement,
    ).toBe(result.repositoryNativeProblemStatement);
  });

  test("only masks each separately attributed verified quotation in a mixed source statement", () => {
    const declarationPath = "utils/appShellLabel.d.ts";
    const declarationHash = "d".repeat(40);
    const source = provenance();
    source.verifiedTargetPaths = [
      ...source.verifiedTargetPaths!,
      { path: declarationPath, blobHash: declarationHash },
    ];
    source.evidence = [
      ...source.evidence!,
      {
        path: declarationPath,
        revision: repository.revision,
        blobHash: declarationHash,
        startLine: 1,
        endLine: 1,
        excerpt: "export declare const APP_SHELL_LABEL: 'PushPals app shell';",
      },
    ];
    const input = {
      ...candidate(),
      target_paths: [sourcePath, declarationPath],
      problem_statement:
        "utils/appShellLabel.js:1 exports 'PushPals app shell', and utils/appShellLabel.d.ts:1 declares 'PushPals app shell'. Both differ from the product name in vision.md.",
    };
    const result = evaluateAutonomyInternalWork(input, source);
    expect(result.ok).toBe(true);
    expect(result.repositoryNativeProblemStatement).toBe(
      input.problem_statement
        .split("'PushPals app shell'")
        .join("[existing source literal; see cited location]"),
    );
  });

  test("rejected title or unsupported provenance never sanitizes the problem statement", () => {
    const input = { ...candidate(), title: "Correct WorkerPal diagnostics labels" };
    for (const result of [
      evaluateAutonomyInternalWork(input, provenance()),
      evaluateAutonomyInternalWork(candidate()),
    ]) {
      expect(result.ok).toBe(false);
      expect(result.repositoryNativeProblemStatement).toBe(candidate().problem_statement);
    }
  });

  test("a model-supplied internal component path is not repository ownership", () => {
    expect(
      evaluateAutonomyInternalWork(
        {
          ...candidate(),
          component_area: "apps/workerpals",
          title: "Expose WorkerPal queue diagnostics in the product UI",
        },
        provenance(),
      ).ok,
    ).toBe(false);
  });

  test("genuine host-established PushPals ownership allows internal repository work", () => {
    expect(
      evaluateAutonomyInternalWork(
        {
          title: "Improve WorkerPal queue health",
          problem_statement: "Fix PushPals worker orchestration diagnostics.",
          target_paths: ["apps/workerpals/src/execute_job.ts"],
        },
        { allowInternalRepository: true },
      ),
    ).toEqual({
      ok: true,
      reason: null,
      groundedQuotedSource: false,
      repositoryNativeProblemStatement: "Fix PushPals worker orchestration diagnostics.",
    });
  });

  test("preserves ordinary product work and strict internal failure-label detection", () => {
    expect(
      evaluateAutonomyInternalWork({
        title: "Improve the product's durable queue health",
        target_paths: ["apps/server/src/queue.ts"],
      }).ok,
    ).toBe(true);
    expect(containsPushPalsInternalUserRepoText("artifact_only_no_publishable_patch")).toBe(true);
    expect(containsPushPalsInternalUserRepoText("no-reviewable-patch")).toBe(true);
    expect(containsPushPalsInternalUserRepoText("Improve the source control manager")).toBe(false);
  });
});
