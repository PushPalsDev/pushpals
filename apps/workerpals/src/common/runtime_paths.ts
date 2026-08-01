import { resolve } from "path";

export function resolveWorkerpalsSourcePath(...segments: string[]): string {
  const configuredRoot = String(process.env.PUSHPALS_WORKERPALS_SOURCE_ROOT ?? "").trim();
  const sourceRoot = configuredRoot || resolve(import.meta.dir, "..");
  return resolve(sourceRoot, ...segments);
}
