export const MINIMUM_SUPPORTED_BUN_VERSION = "1.3.14";

export type RuntimeVersionTuple = readonly [number, number, number];

export function parseRuntimeVersion(value: string): RuntimeVersionTuple | null {
  const match = String(value ?? "")
    .trim()
    .match(/v?(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function runtimeVersionAtLeast(
  actual: RuntimeVersionTuple,
  minimum: RuntimeVersionTuple,
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

export function isSupportedBunVersion(
  value: string,
  minimumVersion = MINIMUM_SUPPORTED_BUN_VERSION,
): boolean {
  const actual = parseRuntimeVersion(value);
  const minimum = parseRuntimeVersion(minimumVersion);
  return Boolean(actual && minimum && runtimeVersionAtLeast(actual, minimum));
}
