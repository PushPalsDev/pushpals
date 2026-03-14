import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadPushPalsConfig } from "../packages/shared/src/config";

describe("shared config workerpals quality critic threshold parsing", () => {
  test("defaults workerpals.quality_max_auto_revisions to 1 when unset", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(join(configDir, "default.toml"), 'profile = "dev"\n', "utf8");
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.workerpals.qualityMaxAutoRevisions).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads workerpals runtime policy values from local.example.toml", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      ['profile = "dev"', "", "[workerpals]", "quality_critic_min_score = 8.0"].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.example.toml"),
      [
        "[workerpals]",
        'file_modifying_jobs = ["task.execute", "warmup.execute", "task.execute"]',
        "output_max_chars = 65536",
        "output_max_lines = 900",
        "output_max_head_lines = 90",
        "quality_validation_step_timeout_ms = 210000",
        "quality_critic_timeout_ms = 55000",
        "quality_critic_min_score = 8.7",
        "quality_critic_max_diff_chars = 32000",
        "quality_critic_max_validation_output_chars = 12000",
        'executor_result_prefix = "__CUSTOM_RESULT__ "',
      ].join("\n"),
      "utf8",
    );

    const envKeys = [
      "WORKERPALS_FILE_MODIFYING_JOBS",
      "WORKERPALS_OUTPUT_MAX_CHARS",
      "WORKERPALS_OUTPUT_MAX_LINES",
      "WORKERPALS_OUTPUT_MAX_HEAD_LINES",
      "WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS",
      "WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS",
      "WORKERPALS_QUALITY_CRITIC_MIN_SCORE",
      "WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS",
      "WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS",
      "WORKERPALS_EXECUTOR_RESULT_PREFIX",
    ] as const;
    const priorEnv = new Map<string, string | undefined>();
    for (const key of envKeys) {
      priorEnv.set(key, process.env[key]);
      delete process.env[key];
    }

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.workerpals.fileModifyingJobs).toEqual(["task.execute", "warmup.execute"]);
      expect(cfg.workerpals.outputMaxChars).toBe(65536);
      expect(cfg.workerpals.outputMaxLines).toBe(900);
      expect(cfg.workerpals.outputMaxHeadLines).toBe(90);
      expect(cfg.workerpals.qualityValidationStepTimeoutMs).toBe(210000);
      expect(cfg.workerpals.qualityCriticTimeoutMs).toBe(55000);
      expect(cfg.workerpals.qualityCriticMinScore).toBe(8.7);
      expect(cfg.workerpals.qualityCriticMaxDiffChars).toBe(32000);
      expect(cfg.workerpals.qualityCriticMaxValidationOutputChars).toBe(12000);
      expect(cfg.workerpals.executorResultPrefix).toBe("__CUSTOM_RESULT__ ");
    } finally {
      for (const key of envKeys) {
        const value = priorEnv.get(key);
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses workerpals.quality_critic_min_score from local.example.toml when local.toml is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[workerpals]",
        "quality_critic_min_score = 8.0",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.example.toml"),
      [
        "[workerpals]",
        "quality_critic_min_score = 7.5",
      ].join("\n"),
      "utf8",
    );

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.workerpals.qualityCriticMinScore).toBe(7.5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses numeric workerpals.quality_critic_min_score from local.toml", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[workerpals]",
        "quality_critic_min_score = 8.0",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.example.toml"),
      [
        "[workerpals]",
        "quality_critic_min_score = 7.5",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.toml"),
      [
        "[workerpals]",
        "quality_critic_min_score = 8.8",
      ].join("\n"),
      "utf8",
    );

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.workerpals.qualityCriticMinScore).toBe(8.8);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("WORKERPALS_QUALITY_CRITIC_MIN_SCORE overrides TOML values", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[workerpals]",
        "quality_critic_min_score = 8.0",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.example.toml"),
      [
        "[workerpals]",
        "quality_critic_min_score = 7.5",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.toml"),
      [
        "[workerpals]",
        "quality_critic_min_score = 8.8",
      ].join("\n"),
      "utf8",
    );

    const prior = process.env.WORKERPALS_QUALITY_CRITIC_MIN_SCORE;
    process.env.WORKERPALS_QUALITY_CRITIC_MIN_SCORE = "9.1";

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.workerpals.qualityCriticMinScore).toBe(9.1);
    } finally {
      if (prior == null) delete process.env.WORKERPALS_QUALITY_CRITIC_MIN_SCORE;
      else process.env.WORKERPALS_QUALITY_CRITIC_MIN_SCORE = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("WORKERPALS_* env overrides take precedence for workerpals runtime policy values", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[workerpals]",
        'file_modifying_jobs = ["task.execute"]',
        "output_max_chars = 196608",
        "output_max_lines = 600",
        "output_max_head_lines = 120",
        "quality_validation_step_timeout_ms = 180000",
        "quality_critic_timeout_ms = 45000",
        "quality_critic_min_score = 8.0",
        "quality_critic_max_diff_chars = 16000",
        "quality_critic_max_validation_output_chars = 8000",
        'executor_result_prefix = "__PUSHPALS_OH_RESULT__ "',
      ].join("\n"),
      "utf8",
    );

    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    const envChanges: Record<string, string> = {
      WORKERPALS_FILE_MODIFYING_JOBS: "warmup.execute, task.execute",
      WORKERPALS_OUTPUT_MAX_CHARS: "131072",
      WORKERPALS_OUTPUT_MAX_LINES: "700",
      WORKERPALS_OUTPUT_MAX_HEAD_LINES: "70",
      WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS: "222000",
      WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS: "56000",
      WORKERPALS_QUALITY_CRITIC_MIN_SCORE: "9.3",
      WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS: "24000",
      WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS: "11000",
      WORKERPALS_EXECUTOR_RESULT_PREFIX: "__ENV_RESULT__ ",
    };
    const prior = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(envChanges)) {
      prior.set(key, process.env[key]);
      process.env[key] = value;
    }

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.workerpals.fileModifyingJobs).toEqual(["warmup.execute", "task.execute"]);
      expect(cfg.workerpals.outputMaxChars).toBe(131072);
      expect(cfg.workerpals.outputMaxLines).toBe(700);
      expect(cfg.workerpals.outputMaxHeadLines).toBe(70);
      expect(cfg.workerpals.qualityValidationStepTimeoutMs).toBe(222000);
      expect(cfg.workerpals.qualityCriticTimeoutMs).toBe(56000);
      expect(cfg.workerpals.qualityCriticMinScore).toBe(9.3);
      expect(cfg.workerpals.qualityCriticMaxDiffChars).toBe(24000);
      expect(cfg.workerpals.qualityCriticMaxValidationOutputChars).toBe(11000);
      expect(cfg.workerpals.executorResultPrefix).toBe("__ENV_RESULT__ ");
    } finally {
      for (const key of Object.keys(envChanges)) {
        const prev = prior.get(key);
        if (prev == null) delete process.env[key];
        else process.env[key] = prev;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
