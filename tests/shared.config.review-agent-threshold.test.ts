import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadPushPalsConfig } from "../packages/shared/src/config";

describe("shared config review_agent threshold parsing", () => {
  test("uses source_control_manager.review_agent.pass_threshold from local.example.toml when local.toml is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[source_control_manager.review_agent]",
        "pass_threshold = 9.5",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.example.toml"),
      [
        "[source_control_manager.review_agent]",
        "pass_threshold = 8.5",
      ].join("\n"),
      "utf8",
    );

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.sourceControlManager.reviewAgent.passThreshold).toBe(8.5);
      expect(cfg.sourceControlManager.reviewAgent.maxPrCommentsBeforeGiveUp).toBe(10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses numeric source_control_manager.review_agent.pass_threshold from local.toml", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[source_control_manager.review_agent]",
        "pass_threshold = 9.5",
        "max_pr_comments_before_give_up = 10",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.example.toml"),
      [
        "[source_control_manager.review_agent]",
        "pass_threshold = 8.5",
        "max_pr_comments_before_give_up = 8",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.toml"),
      [
        "[source_control_manager.review_agent]",
        "pass_threshold = 8.2",
        "max_pr_comments_before_give_up = 12",
      ].join("\n"),
      "utf8",
    );

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.sourceControlManager.reviewAgent.passThreshold).toBe(8.2);
      expect(cfg.sourceControlManager.reviewAgent.maxPrCommentsBeforeGiveUp).toBe(12);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_PASS_THRESHOLD overrides TOML values", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[source_control_manager.review_agent]",
        "pass_threshold = 9.5",
        "max_pr_comments_before_give_up = 10",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.example.toml"),
      [
        "[source_control_manager.review_agent]",
        "pass_threshold = 8.5",
        "max_pr_comments_before_give_up = 9",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.toml"),
      [
        "[source_control_manager.review_agent]",
        "pass_threshold = 8.2",
        "max_pr_comments_before_give_up = 11",
      ].join("\n"),
      "utf8",
    );

    const prior = process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_PASS_THRESHOLD;
    process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_PASS_THRESHOLD = "8.9";

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.sourceControlManager.reviewAgent.passThreshold).toBe(8.9);
    } finally {
      if (prior == null) delete process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_PASS_THRESHOLD;
      else process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_PASS_THRESHOLD = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_MAX_PR_COMMENTS_BEFORE_GIVE_UP overrides TOML values", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[source_control_manager.review_agent]",
        "pass_threshold = 9.5",
        "max_pr_comments_before_give_up = 10",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.example.toml"),
      [
        "[source_control_manager.review_agent]",
        "max_pr_comments_before_give_up = 8",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.toml"),
      [
        "[source_control_manager.review_agent]",
        "max_pr_comments_before_give_up = 7",
      ].join("\n"),
      "utf8",
    );

    const key = "SOURCE_CONTROL_MANAGER_REVIEW_AGENT_MAX_PR_COMMENTS_BEFORE_GIVE_UP";
    const prior = process.env[key];
    process.env[key] = "13";

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.sourceControlManager.reviewAgent.maxPrCommentsBeforeGiveUp).toBe(13);
    } finally {
      if (prior == null) delete process.env[key];
      else process.env[key] = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
