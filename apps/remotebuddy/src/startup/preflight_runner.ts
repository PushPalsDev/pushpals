import {
  runStartupPreflight,
  type StartupChecklistContext,
  type StartupChecklistOptions,
  type StartupChecklistResult,
} from "./checklist.js";
import {
  notifyDependencyPreflightBlock,
  runDependencyPreflight,
  type DependencyCheckOutcome,
} from "./dependency_check.js";
import {
  buildPreflightReport,
  convertStartupFailure,
  convertStartupRecord,
  withCheckStep,
  withFailureStep,
  type PreflightCheckResult,
  type PreflightFailure,
  type PreflightReport,
} from "./preflight_report.js";

export interface RemotebuddyPreflightOptions extends StartupChecklistOptions {
  repoRoot: string;
  skipDependencyCheck?: boolean;
  dependencyCheck?: (repoRoot: string) => Promise<DependencyCheckOutcome>;
  onDependencyBlock?: (outcome: DependencyCheckOutcome, repoRoot: string) => void;
}

export interface RemotebuddyPreflightRun {
  report: PreflightReport;
  dependencyOutcome?: DependencyCheckOutcome;
  checklistResult?: StartupChecklistResult;
}

export async function runRemotebuddyPreflight(
  ctx: StartupChecklistContext,
  options: RemotebuddyPreflightOptions,
): Promise<RemotebuddyPreflightRun> {
  const repoRoot = options.repoRoot;
  if (!repoRoot) {
    throw new Error("repoRoot is required to run RemoteBuddy preflight.");
  }
  const dependencyRunner = options.dependencyCheck ?? runDependencyPreflight;
  const dependencyNotifier = options.onDependencyBlock ?? notifyDependencyPreflightBlock;
  const checks: PreflightCheckResult[] = [];
  let failure: PreflightFailure | undefined;
  let dependencyOutcome: DependencyCheckOutcome | undefined;
  let checklistResult: StartupChecklistResult | undefined;

  if (!options.skipDependencyCheck) {
    dependencyOutcome = await dependencyRunner(repoRoot);
    const dependencyStep = checks.length + 1;
    checks.push(withCheckStep(dependencyOutcome.record, dependencyStep));
    if (!dependencyOutcome.ok) {
      if (dependencyOutcome.failure) {
        failure = withFailureStep(dependencyOutcome.failure, dependencyStep);
      } else {
        failure = {
          code: dependencyOutcome.record.code,
          detail: dependencyOutcome.record.detail,
          action:
            dependencyOutcome.record.action ??
            "Run `bun install` from the repo root to restore workspace dependencies.",
          category: dependencyOutcome.record.category,
          step: dependencyStep,
        };
      }
      dependencyNotifier(dependencyOutcome, repoRoot);
      return {
        dependencyOutcome,
        report: buildPreflightReport({ repoRoot, checks, failure }),
      };
    }
  }

  checklistResult = await runStartupPreflight(ctx, options);
  const stepOffset = checks.length;
  for (const record of checklistResult.history) {
    checks.push(convertStartupRecord(record, stepOffset));
  }
  if (!checklistResult.ok && checklistResult.failure) {
    failure = convertStartupFailure(checklistResult.failure, stepOffset);
  }

  return {
    dependencyOutcome,
    checklistResult,
    report: buildPreflightReport({ repoRoot, checks, failure }),
  };
}
