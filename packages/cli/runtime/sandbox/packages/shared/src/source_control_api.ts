export type SourceControlProvider = "git" | "sapling" | "mercurial";

export type SourceControlCommitIdentitySource = "env" | "source-control-config";

export interface SourceControlCommitIdentity {
  name: string;
  email: string;
  source: SourceControlCommitIdentitySource;
}

export function normalizeSourceControlProvider(value: unknown): SourceControlProvider | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");

  if (!normalized) return null;
  if (normalized === "auto") return "git";
  if (normalized === "git") return "git";
  if (normalized === "sapling" || normalized === "sl") return "sapling";
  if (normalized === "mercurial" || normalized === "mercury" || normalized === "hg") {
    return "mercurial";
  }
  return null;
}

function hasSourceControlProviderValue(value: unknown): boolean {
  return String(value ?? "").trim().length > 0;
}

function formatUnknownSourceControlProvider(value: unknown): string {
  return String(value ?? "").trim() || "(empty)";
}

export function resolveSourceControlProvider(
  value?: unknown,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): SourceControlProvider {
  if (hasSourceControlProviderValue(value)) {
    const explicit = normalizeSourceControlProvider(value);
    if (explicit) return explicit;
    throw new Error(`Unknown source control provider '${formatUnknownSourceControlProvider(value)}'.`);
  }

  const envValue = env.PUSHPALS_SOURCE_CONTROL_PROVIDER ?? env.SOURCE_CONTROL_PROVIDER;
  if (hasSourceControlProviderValue(envValue)) {
    const fromEnv = normalizeSourceControlProvider(envValue);
    if (fromEnv) return fromEnv;
    throw new Error(
      `Unknown source control provider '${formatUnknownSourceControlProvider(envValue)}'.`,
    );
  }

  return "git";
}

export function assertSupportedSourceControlProvider(provider: SourceControlProvider): "git" {
  if (provider === "git") return "git";
  throw new Error(
    `Source control provider '${provider}' is recognized but not supported yet. PushPals currently supports git only.`,
  );
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function sanitizeSourceControlIdentityField(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function explicitSourceControlCommitIdentityFromEnv(
  env: Record<string, string | undefined>,
  fallbackEmail = "",
): SourceControlCommitIdentity | null {
  const name = sanitizeSourceControlIdentityField(
    firstNonEmptyString(
      env.WORKERPALS_GIT_AUTHOR_NAME,
      env.PUSHPALS_GIT_AUTHOR_NAME,
      env.GIT_AUTHOR_NAME,
    ),
  );
  const email = sanitizeSourceControlIdentityField(
    firstNonEmptyString(
      env.WORKERPALS_GIT_AUTHOR_EMAIL,
      env.PUSHPALS_GIT_AUTHOR_EMAIL,
      env.GIT_AUTHOR_EMAIL,
      fallbackEmail,
    ),
  );
  if (!name || !email) return null;
  return { name, email, source: "env" };
}

export function buildGitCommitArgs(
  commitMsg: string,
  identity: SourceControlCommitIdentity | null,
): string[] {
  const args: string[] = [];
  if (identity?.name && identity.email) {
    args.push("-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`);
  }
  args.push("commit");
  if (identity?.name && identity.email) {
    args.push("--author", `${identity.name} <${identity.email}>`);
  }
  args.push("-m", commitMsg);
  return args;
}
