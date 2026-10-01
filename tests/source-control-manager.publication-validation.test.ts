import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PublicationValidationUnavailableError,
  resolveOrdinaryPublicationValidation,
} from "../apps/source_control_manager/src/publication_validation";
import { buildReviewPublicationValidationPlan } from "../packages/shared/src/review_publication_validation";
import { MAX_TRUSTED_VALIDATION_COMMANDS } from "../packages/shared/src/trusted_validation";
import {
  resolveTrustedValidationOutcome,
  runTrustedValidationCommands,
} from "../apps/source_control_manager/src/trusted_validation";
import {
  loadLatestValidationCheckpoint,
  persistValidationCheckpoint,
} from "../apps/source_control_manager/src/validation_repair_publication";

const sha = (value: string) => value.repeat(40);
const readyPlan = (commands = ["bun run aggregate.cjs", "bun run standalone.cjs"]) =>
  buildReviewPublicationValidationPlan({
    complete: true,
    requiredValidationSteps: [],
    validationSteps: [],
    workerCommands: commands,
  });

describe("ordinary publication validation is bound to immutable trees", () => {
  test("identical trees preserve deferred gates without rerunning worker checks even after commit identity changes", async () => {
    for (const deferredCommandsJson of [null, '["bun run aggregate.cjs"]']) {
      const result = await resolveOrdinaryPublicationValidation({
        originalCandidateSha: sha("a"),
        candidateSha: sha("b"),
        claimGeneration: 5,
        deferredCommandsJson,
        fullPlan: undefined,
        git: async () => ({ ok: true, stdout: sha("c"), stderr: "", exitCode: 0 }),
      });
      expect(result.commandsJson).toBe(deferredCommandsJson);
      expect(result.binding).toEqual({
        workerTreeSha: sha("c"),
        candidateTreeSha: sha("c"),
        planSource: "identical_worker_tree",
      });
    }
  });

  test("changed or unreadable trees require all authoritative gates even without deferred commands", async () => {
    for (const mode of ["different", "unreadable", "throws", "malformed"]) {
      const fullPlan = readyPlan();
      const result = await resolveOrdinaryPublicationValidation({
        originalCandidateSha: sha("a"),
        candidateSha: sha("b"),
        claimGeneration: 4,
        deferredCommandsJson: null,
        fullPlan,
        git: async (args) => {
          if (mode === "throws") throw new Error("object unavailable");
          return {
            ok: mode !== "unreadable",
            stdout: mode === "malformed" ? "not-a-tree" : args.at(-1)!.slice(0, 40),
            stderr: "",
            exitCode: 0,
          };
        },
      });
      expect(JSON.parse(result.commandsJson!)).toEqual(fullPlan.commands);
      expect(result.binding.planSource).toBe("full_worker_plan");
    }
  });

  test("missing final diagnostics have a finite retry budget; invalid or oversized authority never silently shrinks", async () => {
    for (const claimGeneration of [1, 2, 3, 10]) {
      for (const fullPlan of [
        undefined,
        readyPlan(
          Array.from(
            { length: MAX_TRUSTED_VALIDATION_COMMANDS + 1 },
            (_, i) => `bun test gate-${i}.ts`,
          ),
        ),
      ]) {
        try {
          await resolveOrdinaryPublicationValidation({
            originalCandidateSha: sha("a"),
            candidateSha: sha("b"),
            claimGeneration,
            deferredCommandsJson: null,
            fullPlan,
            git: async (args) => ({
              ok: true,
              stdout: args.at(-1)!.slice(0, 40),
              stderr: "",
              exitCode: 0,
            }),
          });
          throw new Error("Unexpected validation bypass");
        } catch (error) {
          expect(error).toBeInstanceOf(PublicationValidationUnavailableError);
          expect((error as PublicationValidationUnavailableError).pending).toBe(
            !fullPlan && claimGeneration < 3,
          );
        }
      }
    }
  });

  test("a changed integration base reruns a standalone gate absent from a passing aggregate, including retained checkpoint recovery", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-publication-tree-"));
    const git = async (args: string[]) => {
      const result = spawnSync("git", ["-c", "core.autocrlf=false", "-C", repo, ...args], {
        encoding: "utf8",
      });
      return {
        ok: result.status === 0,
        stdout: String(result.stdout ?? "").trim(),
        stderr: String(result.stderr ?? ""),
        exitCode: result.status ?? -1,
      };
    };
    const requireGit = async (args: string[]) => {
      const result = await git(args);
      if (!result.ok) throw new Error(result.stderr);
      return result.stdout;
    };
    try {
      await requireGit(["init", "--initial-branch=main"]);
      await requireGit(["config", "user.name", "Fixture"]);
      await requireGit(["config", "user.email", "fixture@example.invalid"]);
      writeFileSync(join(repo, "contract.txt"), "supported");
      writeFileSync(join(repo, "aggregate.cjs"), "console.log('aggregate passes');\n");
      writeFileSync(
        join(repo, "standalone.cjs"),
        "if (require('fs').readFileSync('contract.txt', 'utf8') !== 'supported') { console.error('error: independent contract failed'); process.exit(1); }\n",
      );
      await requireGit(["add", "."]);
      await requireGit(["commit", "-m", "base contracts"]);
      const base = await requireGit(["rev-parse", "HEAD"]);
      await requireGit(["checkout", "-b", "worker"]);
      writeFileSync(join(repo, "feature.txt"), "feature");
      await requireGit(["add", "."]);
      await requireGit(["commit", "-m", "worker candidate"]);
      const worker = await requireGit(["rev-parse", "HEAD"]);
      const runner = async (argv: string[], options: { cwd: string }) => {
        const result = spawnSync(process.execPath, argv.slice(1), {
          cwd: options.cwd,
          encoding: "utf8",
          timeout: 10_000,
        });
        return {
          ok: result.status === 0,
          output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
          exitCode: result.status ?? -1,
        };
      };
      const fullPlan = readyPlan();
      expect(
        resolveTrustedValidationOutcome(
          await runTrustedValidationCommands({
            repoPath: repo,
            commandsJson: JSON.stringify(fullPlan.commands),
            runner,
          }),
        ).terminalFailure,
      ).toBeNull();
      await requireGit(["checkout", "main"]);
      writeFileSync(join(repo, "contract.txt"), "incompatible");
      await requireGit(["add", "."]);
      await requireGit(["commit", "-m", "advance base without touching worker file"]);
      const advancedBase = await requireGit(["rev-parse", "HEAD"]);
      await requireGit(["cherry-pick", worker]);
      const candidate = await requireGit(["rev-parse", "HEAD"]);
      expect(candidate).not.toBe(worker);
      expect(advancedBase).not.toBe(base);
      await persistValidationCheckpoint({
        completionId: "ordinary-fixture",
        claimGeneration: 1,
        baselineSha: advancedBase,
        candidateSha: candidate,
        git,
      });
      const checkpoint = await loadLatestValidationCheckpoint({
        completionId: "ordinary-fixture",
        beforeClaimGeneration: 2,
        git,
      });
      expect(checkpoint?.candidateSha).toBe(candidate);
      for (const deferredCommandsJson of [null, '["bun run aggregate.cjs"]']) {
        const resolved = await resolveOrdinaryPublicationValidation({
          originalCandidateSha: worker,
          candidateSha: checkpoint!.candidateSha,
          claimGeneration: 2,
          deferredCommandsJson,
          fullPlan,
          git,
        });
        expect(JSON.parse(resolved.commandsJson!)).toEqual(fullPlan.commands);
        const results = await runTrustedValidationCommands({
          repoPath: repo,
          commandsJson: resolved.commandsJson!,
          runner,
        });
        expect(results.find((result) => result.command === "bun run aggregate.cjs")?.ok).toBe(true);
        expect(resolveTrustedValidationOutcome(results).terminalFailure?.command).toBe(
          "bun run standalone.cjs",
        );
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});
