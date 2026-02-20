/** Job kinds that modify files and should trigger commits */
export const FILE_MODIFYING_JOBS = new Set(["task.execute"]);

export const MAX_OUTPUT = 192 * 1024;
export const MAX_OUTPUT_LINES = 600;
export const MAX_OUTPUT_HEAD_LINES = 120;
export const QUALITY_MAX_AUTO_REVISIONS = 4;
export const QUALITY_VALIDATION_STEP_TIMEOUT_MS = 180_000;
export const QUALITY_CRITIC_TIMEOUT_MS = 45_000;
export const QUALITY_CRITIC_MIN_SCORE = 8;
export const QUALITY_CRITIC_MAX_DIFF_CHARS = 16_000;
export const QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS = 8_000;
export const EXECUTOR_RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ ";
