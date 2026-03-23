import { existsSync, readFileSync } from "fs";
import { relative, resolve } from "path";
import { loadPushPalsConfig, type PushPalsConfig } from "./config.js";
import { validateVisionDocStructure, type VisionDocValidation } from "./vision.js";

export type ClientPreflightCopyCommands = {
  windowsPowerShell: string;
  bash: string;
};

export type ClientPreflightIssue = {
  code:
    | "missing_env_file"
    | "missing_local_toml"
    | "missing_vision_doc"
    | "unreadable_vision_doc"
    | "empty_vision_doc"
    | "invalid_vision_doc";
  message: string;
  detail?: string;
  copyCommands?: ClientPreflightCopyCommands;
};

export type ClientRuntimePreflightResult = {
  ok: boolean;
  projectRoot: string;
  runtimeRoot: string;
  config: PushPalsConfig;
  issues: ClientPreflightIssue[];
  autonomyEnabled: boolean;
  visionSummary: null | {
    path: string;
    chars: number;
    sectionCount: number;
    validation: VisionDocValidation;
  };
};

type EvaluateClientRuntimePreflightOptions = {
  projectRoot: string;
  runtimeRoot?: string;
  configDir?: string;
  config?: PushPalsConfig;
  visionTemplateRoot?: string;
};

function runtimeHasConfigDir(runtimeRoot: string, dirName: string): boolean {
  const dirPath = resolve(runtimeRoot, dirName);
  return (
    existsSync(resolve(dirPath, "default.toml")) ||
    existsSync(resolve(dirPath, "local.example.toml")) ||
    existsSync(resolve(dirPath, "local.toml"))
  );
}

function resolveClientConfigDir(
  projectRoot: string,
  runtimeRoot: string,
  explicitConfigDir?: string,
): string | undefined {
  if (explicitConfigDir && explicitConfigDir.trim()) {
    return resolve(explicitConfigDir);
  }

  const runtimeCanonical = resolve(runtimeRoot, "configs");
  if (runtimeHasConfigDir(runtimeRoot, "configs")) {
    return runtimeCanonical;
  }

  const projectCanonical = resolve(projectRoot, "configs");
  if (runtimeHasConfigDir(projectRoot, "configs")) {
    return projectCanonical;
  }

  return runtimeCanonical;
}

function toDisplayPath(currentRoot: string, pathValue: string): string {
  const rel = relative(currentRoot, pathValue);
  if (!rel || rel === "") return ".";
  if (rel.startsWith("..")) return pathValue;
  return rel.replace(/\\/g, "/");
}

function quotePowerShell(pathValue: string): string {
  if (/^[A-Za-z0-9_./\\:-]+$/.test(pathValue)) return pathValue;
  return `'${pathValue.replace(/'/g, "''")}'`;
}

function quoteBash(pathValue: string): string {
  if (/^[A-Za-z0-9_./\\:-]+$/.test(pathValue)) return pathValue;
  return "'" + pathValue.replace(/'/g, "'\"'\"'") + "'";
}

function buildCopyCommands(
  workspaceRoot: string,
  sourcePath: string,
  destPath: string,
): ClientPreflightCopyCommands {
  const displaySource = toDisplayPath(workspaceRoot, sourcePath);
  const displayDest = toDisplayPath(workspaceRoot, destPath);
  return {
    windowsPowerShell: `Copy-Item ${quotePowerShell(displaySource)} ${quotePowerShell(displayDest)}`,
    bash: `cp ${quoteBash(displaySource)} ${quoteBash(displayDest)}`,
  };
}

export function evaluateClientRuntimePreflight(
  options: EvaluateClientRuntimePreflightOptions,
): ClientRuntimePreflightResult {
  const projectRoot = resolve(options.projectRoot);
  const runtimeRoot = resolve(options.runtimeRoot ?? projectRoot);
  const configDir = resolveClientConfigDir(projectRoot, runtimeRoot, options.configDir);
  const visionTemplateRoot = resolve(options.visionTemplateRoot ?? runtimeRoot);
  const config =
    options.config ??
    loadPushPalsConfig({
      projectRoot,
      configDir,
      reload: true,
    });

  const issues: ClientPreflightIssue[] = [];

  const envPath = resolve(runtimeRoot, ".env");
  if (!existsSync(envPath)) {
    const envExamplePath = resolve(runtimeRoot, ".env.example");
    issues.push({
      code: "missing_env_file",
      message: `Missing required local env file: ${toDisplayPath(projectRoot, envPath)}.`,
      copyCommands: existsSync(envExamplePath)
        ? buildCopyCommands(projectRoot, envExamplePath, envPath)
        : undefined,
    });
  }

  const localTomlPath = resolve(runtimeRoot, "configs", "local.toml");
  if (!existsSync(localTomlPath)) {
    const localExamplePath = resolve(runtimeRoot, "configs", "local.example.toml");
    issues.push({
      code: "missing_local_toml",
      message: `Missing required local config file: ${toDisplayPath(projectRoot, localTomlPath)}.`,
      copyCommands: existsSync(localExamplePath)
        ? buildCopyCommands(projectRoot, localExamplePath, localTomlPath)
        : undefined,
    });
  }

  const autonomyEnabled = Boolean(config.remotebuddy.autonomy.enabled);
  if (!autonomyEnabled) {
    return {
      ok: issues.length === 0,
      projectRoot,
      runtimeRoot,
      config,
      issues,
      autonomyEnabled,
      visionSummary: null,
    };
  }

  const visionPath = resolve(projectRoot, "vision.md");
  const visionTemplatePath = resolve(visionTemplateRoot, "vision.example.md");
  if (!existsSync(visionPath)) {
    issues.push({
      code: "missing_vision_doc",
      message:
        "Missing required autonomy vision file: vision.md " +
        "(required when remotebuddy.autonomy.enabled=true).",
      copyCommands: existsSync(visionTemplatePath)
        ? buildCopyCommands(projectRoot, visionTemplatePath, visionPath)
        : undefined,
    });
    return {
      ok: false,
      projectRoot,
      runtimeRoot,
      config,
      issues,
      autonomyEnabled,
      visionSummary: null,
    };
  }

  let rawVision = "";
  try {
    rawVision = readFileSync(visionPath, "utf8");
  } catch (err) {
    issues.push({
      code: "unreadable_vision_doc",
      message: `Autonomy vision preflight failed: could not read vision.md.`,
      detail: String(err),
    });
    return {
      ok: false,
      projectRoot,
      runtimeRoot,
      config,
      issues,
      autonomyEnabled,
      visionSummary: null,
    };
  }

  const visionText = rawVision.trim();
  if (!visionText) {
    issues.push({
      code: "empty_vision_doc",
      message: "Autonomy vision preflight failed: vision.md is empty.",
      detail: "Add repository vision/goals before startup.",
    });
    return {
      ok: false,
      projectRoot,
      runtimeRoot,
      config,
      issues,
      autonomyEnabled,
      visionSummary: null,
    };
  }

  const validation = validateVisionDocStructure(visionText);
  if (!validation.ok) {
    issues.push({
      code: "invalid_vision_doc",
      message: "Autonomy vision preflight failed: vision.md is invalid.",
      detail: validation.errors.join(" "),
    });
    return {
      ok: false,
      projectRoot,
      runtimeRoot,
      config,
      issues,
      autonomyEnabled,
      visionSummary: null,
    };
  }

  return {
    ok: issues.length === 0,
    projectRoot,
    runtimeRoot,
    config,
    issues,
    autonomyEnabled,
    visionSummary: {
      path: toDisplayPath(projectRoot, visionPath),
      chars: visionText.length,
      sectionCount: validation.sectionCount,
      validation,
    },
  };
}

export function formatClientRuntimePreflightLines(
  result: ClientRuntimePreflightResult,
  prefix: string,
): string[] {
  const normalizedPrefix = prefix.trim();
  const lines: string[] = [];
  if (result.ok) {
    if (result.visionSummary) {
      lines.push(
        `${normalizedPrefix} Autonomy preflight: loaded ${result.visionSummary.path} ` +
          `(${result.visionSummary.chars} chars, ${result.visionSummary.sectionCount} section(s)).`,
      );
    }
    return lines;
  }

  for (const issue of result.issues) {
    lines.push(`${normalizedPrefix} ${issue.message}`);
    if (issue.detail) {
      lines.push(`${normalizedPrefix}   ${issue.detail}`);
    }
    if (issue.copyCommands) {
      lines.push(
        `${normalizedPrefix}   Windows (PowerShell): ${issue.copyCommands.windowsPowerShell}`,
      );
      lines.push(`${normalizedPrefix}   Linux/macOS (bash): ${issue.copyCommands.bash}`);
    }
  }
  return lines;
}
