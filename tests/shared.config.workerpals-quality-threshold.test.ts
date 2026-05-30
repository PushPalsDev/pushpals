import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadPushPalsConfig } from "../packages/shared/src/config";

describe("shared config workerpals quality critic threshold parsing", () => {
  test("requires configs/default.toml", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    try {
      expect(() => loadPushPalsConfig({ projectRoot: root, reload: true })).toThrow(
        `Missing required runtime config file: ${join(configDir, "default.toml")}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaults workerpals.executor to openai_codex when unset", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(join(configDir, "default.toml"), 'profile = "dev"\n', "utf8");
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    const priorExecutor = process.env.WORKERPALS_EXECUTOR;
    delete process.env.WORKERPALS_EXECUTOR;

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.workerpals.executor).toBe("openai_codex");
    } finally {
      if (priorExecutor == null) delete process.env.WORKERPALS_EXECUTOR;
      else process.env.WORKERPALS_EXECUTOR = priorExecutor;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaults openai_codex LLM services to gpt-5.5 with extra-high reasoning", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[localbuddy.llm]",
        'backend = "openai_codex"',
        "",
        "[remotebuddy.llm]",
        'backend = "openai_codex"',
        "",
        "[workerpals.llm]",
        'backend = "openai_codex"',
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.localbuddy.llm.model).toBe("gpt-5.5");
      expect(cfg.remotebuddy.llm.model).toBe("gpt-5.5");
      expect(cfg.workerpals.llm.model).toBe("gpt-5.5");
      expect(cfg.localbuddy.llm.reasoningEffort).toBe("xhigh");
      expect(cfg.remotebuddy.llm.reasoningEffort).toBe("xhigh");
      expect(cfg.workerpals.llm.reasoningEffort).toBe("xhigh");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parses BOM-prefixed TOML config files", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(join(configDir, "default.toml"), '\uFEFFprofile = "dev"\n', "utf8");
    writeFileSync(
      join(configDir, "local.example.toml"),
      '\uFEFF[workerpals.llm]\nbackend = "openai_codex"\n',
      "utf8",
    );

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.profile).toBe("dev");
      expect(cfg.workerpals.llm.backend).toBe("openai_codex");
      expect(cfg.workerpals.llm.model).toBe("gpt-5.5");
      expect(cfg.workerpals.llm.reasoningEffort).toBe("xhigh");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaults workerpals.quality_max_auto_revisions to 3 when unset", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(join(configDir, "default.toml"), 'profile = "dev"\n', "utf8");
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.workerpals.qualityMaxAutoRevisions).toBe(3);
      expect(cfg.workerpals.qualityValidationMaxAutoRevisions).toBe(3);
      expect(cfg.workerpals.qualityScopeGateEnabled).toBe(true);
      expect(cfg.workerpals.qualityValidationGateEnabled).toBe(true);
      expect(cfg.workerpals.qualityCriticGateEnabled).toBe(true);
      expect(cfg.workerpals.qualityPublishGateEnabled).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads workerpals runtime policy values from local.example.toml", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
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
        "quality_validation_max_auto_revisions = 3",
        "quality_scope_gate_enabled = false",
        "quality_validation_gate_enabled = true",
        "quality_critic_gate_enabled = false",
        "quality_publish_gate_enabled = true",
        "quality_critic_timeout_ms = 55000",
        'quality_critic_timeout_behavior = "block"',
        "quality_critic_min_score = 8.7",
        'quality_critic_model = "gpt-5.5-mini"',
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
      "WORKERPALS_QUALITY_VALIDATION_MAX_AUTO_REVISIONS",
      "WORKERPALS_QUALITY_SCOPE_GATE_ENABLED",
      "WORKERPALS_QUALITY_VALIDATION_GATE_ENABLED",
      "WORKERPALS_QUALITY_CRITIC_GATE_ENABLED",
      "WORKERPALS_QUALITY_PUBLISH_GATE_ENABLED",
      "WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS",
      "WORKERPALS_QUALITY_CRITIC_TIMEOUT_BEHAVIOR",
      "WORKERPALS_QUALITY_CRITIC_MIN_SCORE",
      "WORKERPALS_QUALITY_CRITIC_MODEL",
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
      expect(cfg.workerpals.qualityValidationMaxAutoRevisions).toBe(3);
      expect(cfg.workerpals.qualityScopeGateEnabled).toBe(false);
      expect(cfg.workerpals.qualityValidationGateEnabled).toBe(true);
      expect(cfg.workerpals.qualityCriticGateEnabled).toBe(false);
      expect(cfg.workerpals.qualityPublishGateEnabled).toBe(true);
      expect(cfg.workerpals.qualityCriticTimeoutMs).toBe(55000);
      expect(cfg.workerpals.qualityCriticTimeoutBehavior).toBe("block");
      expect(cfg.workerpals.qualityCriticMinScore).toBe(8.7);
      expect(cfg.workerpals.qualityCriticModel).toBe("gpt-5.5-mini");
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
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      ['profile = "dev"', "", "[workerpals]", "quality_critic_min_score = 8.0"].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.example.toml"),
      ["[workerpals]", "quality_critic_min_score = 7.5"].join("\n"),
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
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      ['profile = "dev"', "", "[workerpals]", "quality_critic_min_score = 8.0"].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.example.toml"),
      ["[workerpals]", "quality_critic_min_score = 7.5"].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.toml"),
      ["[workerpals]", "quality_critic_min_score = 8.8"].join("\n"),
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
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      ['profile = "dev"', "", "[workerpals]", "quality_critic_min_score = 8.0"].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.example.toml"),
      ["[workerpals]", "quality_critic_min_score = 7.5"].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.toml"),
      ["[workerpals]", "quality_critic_min_score = 8.8"].join("\n"),
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
    const configDir = join(root, "configs");
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
        "quality_validation_max_auto_revisions = 3",
        "quality_scope_gate_enabled = true",
        "quality_validation_gate_enabled = true",
        "quality_critic_gate_enabled = true",
        "quality_publish_gate_enabled = true",
        "quality_critic_timeout_ms = 90000",
        'quality_critic_timeout_behavior = "retry_once"',
        "quality_critic_min_score = 8.0",
        'quality_critic_model = ""',
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
      WORKERPALS_QUALITY_VALIDATION_MAX_AUTO_REVISIONS: "2",
      WORKERPALS_QUALITY_SCOPE_GATE_ENABLED: "false",
      WORKERPALS_QUALITY_VALIDATION_GATE_ENABLED: "false",
      WORKERPALS_QUALITY_CRITIC_GATE_ENABLED: "false",
      WORKERPALS_QUALITY_PUBLISH_GATE_ENABLED: "false",
      WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS: "56000",
      WORKERPALS_QUALITY_CRITIC_TIMEOUT_BEHAVIOR: "skip",
      WORKERPALS_QUALITY_CRITIC_MIN_SCORE: "9.3",
      WORKERPALS_QUALITY_CRITIC_MODEL: "gpt-5.5-nano",
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
      expect(cfg.workerpals.qualityValidationMaxAutoRevisions).toBe(2);
      expect(cfg.workerpals.qualityScopeGateEnabled).toBe(false);
      expect(cfg.workerpals.qualityValidationGateEnabled).toBe(false);
      expect(cfg.workerpals.qualityCriticGateEnabled).toBe(false);
      expect(cfg.workerpals.qualityPublishGateEnabled).toBe(false);
      expect(cfg.workerpals.qualityCriticTimeoutMs).toBe(56000);
      expect(cfg.workerpals.qualityCriticTimeoutBehavior).toBe("skip");
      expect(cfg.workerpals.qualityCriticMinScore).toBe(9.3);
      expect(cfg.workerpals.qualityCriticModel).toBe("gpt-5.5-nano");
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
