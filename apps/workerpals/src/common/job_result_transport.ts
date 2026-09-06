// Control frames have their own bound: ordinary process-log retention must not
// truncate a result's prefix or evict it after noisy shutdown output.
export const JOB_RESULT_PREFIX = "___RESULT___";
export const JOB_RESULT_MAX_CHARS = 2 * 1024 * 1024;
export const JOB_RESULT_OUTPUT_MAX_CHARS = 32 * 1024;

export function isJobResultFrame(line: string): boolean {
  return /^___RESULT___(?:\s|$)/.test(line.trimStart());
}

export function oversizedJobResultFrame(): string {
  const summary = `Worker structured result exceeded the ${JOB_RESULT_MAX_CHARS}-character transport limit`;
  return `${JOB_RESULT_PREFIX} ${JSON.stringify({
    ok: false,
    summary,
    exitCode: 1,
    diagnostics: {
      terminal: {
        failureClass: "structured_result_too_large",
        terminalStage: "docker_result_transport",
        summary,
        watchdogFired: false,
      },
    },
  })}`;
}

export function compactJobResultOutput(output: string | undefined): string | undefined {
  if (!output || output.length <= JOB_RESULT_OUTPUT_MAX_CHARS) return output;
  const marker = "\n[PushPals] Result output truncated; head and tail retained.\n";
  const headChars = Math.floor((JOB_RESULT_OUTPUT_MAX_CHARS - marker.length) / 2);
  const tailChars = JOB_RESULT_OUTPUT_MAX_CHARS - marker.length - headChars;
  return output.slice(0, headChars) + marker + output.slice(-tailChars);
}
