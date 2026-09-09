import {
  MAX_TRUSTED_VALIDATION_COMMANDS,
  normalizeTrustedValidationCommands,
  tokenizeTrustedValidationCommand,
} from "./trusted_validation.js";

/** Server-derived, immutable validation authority for one worker completion.
 * A partial diagnostics upload is never evidence of the full original plan. */
export type ReviewPublicationValidationPlan = {
  version: 1;
  status: "ready" | "pending" | "invalid";
  commands: string[];
  reason?: string;
};

function rejected(status: "pending" | "invalid", reason: string): ReviewPublicationValidationPlan {
  return { version: 1, status, commands: [], reason };
}

function commandArray(value: unknown, label: string, optional = true): string[] {
  if (optional && (value === undefined || value === null)) return [];
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error(`${label} must be a command array, not unparsed text.`);
    }
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim()))
    throw new Error(`${label} must contain only nonempty strings.`);
  // Refuse pathological/partial evidence before parsing it; never truncate a
  // full plan into a smaller passing subset.
  if (value.length > 256) throw new Error(`${label} exceeds the evidence bound.`);
  return value;
}

function plannedCommands(steps: string[], required: boolean): string[] {
  const commands: string[] = [];
  for (const step of steps) {
    const trimmed = step.trim();
    const candidate = trimmed.replace(/^(?:run|execute)\s+/i, "");
    if (tokenizeTrustedValidationCommand(candidate)) {
      commands.push(candidate);
      continue;
    }
    // Handle explicit Markdown command instructions without evaluating prose,
    // shell expressions, or arbitrary embedded code. Preserve every command.
    if (/^(?:(?:run|execute)\s+)?`/i.test(trimmed)) {
      const matches = [...trimmed.matchAll(/`([^`\r\n]+)`/g)];
      if (matches.length && matches.every((match) => tokenizeTrustedValidationCommand(match[1]))) {
        commands.push(...matches.map((match) => match[1].trim()));
        continue;
      }
      throw new Error(`Unsafe or ambiguous planned validation command: ${trimmed}`);
    }
    // Optional narrative acceptance criteria are not executable gates. A
    // mandatory step or explicit command instruction cannot silently disappear.
    if (required || /^(?:run|execute)\s+/i.test(trimmed))
      throw new Error(`Cannot establish the required validation command: ${trimmed}`);
  }
  return commands;
}

function completeCommands(values: string[]): string[] {
  const commands: string[] = [];
  const seen = new Set<string>();
  for (const command of values) {
    const argv = tokenizeTrustedValidationCommand(command);
    if (!argv) throw new Error(`Unsafe or unsupported validation command: ${command}`);
    // Case and quoted argument whitespace are significant on Linux. Do not
    // erase distinct gates while combining passed and deferred command sets.
    const key = JSON.stringify(argv);
    if (seen.has(key)) continue;
    seen.add(key);
    commands.push(command.trim());
  }
  if (commands.length > MAX_TRUSTED_VALIDATION_COMMANDS)
    throw new Error(
      `The complete plan exceeds ${MAX_TRUSTED_VALIDATION_COMMANDS} commands; no gates were truncated.`,
    );
  const normalized = normalizeTrustedValidationCommands(commands);
  if (!normalized.ok) throw new Error(normalized.message);
  if (normalized.commands.length !== commands.length)
    throw new Error("Distinct validation gates collide under trusted-runner normalization.");
  return commands;
}

/** Retain the repository's original contract, including docs-only diff gates.
 * Do not substitute guessed tests for missing authoritative worker evidence. */
export function buildReviewPublicationValidationPlan(options: {
  complete: boolean;
  requiredValidationSteps: unknown;
  validationSteps: unknown;
  workerCommands: unknown;
  deferredCommands?: unknown;
}): ReviewPublicationValidationPlan {
  if (options.complete !== true)
    return rejected("pending", "The final worker validation snapshot is not complete.");
  try {
    const commands = completeCommands([
      ...plannedCommands(commandArray(options.requiredValidationSteps, "Required steps"), true),
      ...plannedCommands(commandArray(options.validationSteps, "Validation steps"), false),
      ...commandArray(options.workerCommands, "Worker validation evidence", false),
      ...commandArray(options.deferredCommands, "Deferred validation"),
    ]);
    return { version: 1, status: "ready", commands };
  } catch (error) {
    return rejected("invalid", error instanceof Error ? error.message : String(error));
  }
}

/** Host-side boundary: a changed/reconciled candidate must rerun the entire
 * server-resolved plan, not just commands deferred from its original tree. */
export function resolveReconciledReviewValidationPlan(
  value: unknown,
  deferredCommands?: unknown,
): ReviewPublicationValidationPlan {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return rejected("pending", "The completion has no authoritative full validation plan.");
  const plan = value as Record<string, unknown>;
  if (plan.version !== 1 || !["ready", "pending", "invalid"].includes(String(plan.status)))
    return rejected("invalid", "Unsupported full validation plan evidence.");
  if (plan.status !== "ready")
    return rejected(
      plan.status as "pending" | "invalid",
      typeof plan.reason === "string" ? plan.reason : "The full validation plan is not ready.",
    );
  try {
    return {
      version: 1,
      status: "ready",
      commands: completeCommands([
        ...commandArray(plan.commands, "Authoritative validation", false),
        ...commandArray(deferredCommands, "Deferred validation"),
      ]),
    };
  } catch (error) {
    return rejected("invalid", error instanceof Error ? error.message : String(error));
  }
}
