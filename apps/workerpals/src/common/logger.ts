export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(raw: string): LogLevel | null {
  const value = raw.trim().toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return null;
}

function resolveMinLevel(): LogLevel {
  const explicit = normalizeLevel(process.env.WORKERPALS_LOG_LEVEL ?? "");
  if (explicit) return explicit;
  const debugFlag = (process.env.WORKERPALS_DEBUG ?? "").trim().toLowerCase();
  return debugFlag === "1" || debugFlag === "true" || debugFlag === "yes" ? "debug" : "info";
}

export class Logger {
  private readonly minLevel: LogLevel;
  private readonly prefix: string;

  constructor(prefix: string, minLevel: LogLevel = resolveMinLevel()) {
    this.prefix = prefix.trim();
    this.minLevel = minLevel;
  }

  isDebugEnabled(): boolean {
    return this.canLog("debug");
  }

  debug(message: string): void {
    if (!this.canLog("debug")) return;
    console.log(this.format(message));
  }

  info(message: string): void {
    if (!this.canLog("info")) return;
    console.log(this.format(message));
  }

  warn(message: string): void {
    if (!this.canLog("warn")) return;
    console.warn(this.format(message));
  }

  error(message: string): void {
    if (!this.canLog("error")) return;
    console.error(this.format(message));
  }

  private canLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel];
  }

  private format(message: string): string {
    return this.prefix ? `[${this.prefix}] ${message}` : message;
  }
}
