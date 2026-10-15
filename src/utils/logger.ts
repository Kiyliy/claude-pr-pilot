export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getConfiguredLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_PRIORITY) return env as LogLevel;
  return "info";
}

function isJsonFormat(): boolean {
  return process.env.LOG_FORMAT?.toLowerCase() === "json";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getConfiguredLevel()];
}

function formatText(level: LogLevel, msg: string): string {
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  return `[${ts}] ${tag} ${msg}`;
}

function formatJson(level: LogLevel, msg: string, context?: LogContext): string {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    msg,
  };
  if (context && Object.keys(context).length > 0) {
    Object.assign(entry, context);
  }
  return JSON.stringify(entry);
}

function emit(level: LogLevel, msg: string, context?: LogContext): void {
  if (!shouldLog(level)) return;

  const output = isJsonFormat()
    ? formatJson(level, msg, context)
    : formatText(level, msg);

  switch (level) {
    case "error":
      console.error(output);
      break;
    case "warn":
      console.warn(output);
      break;
    default:
      console.log(output);
      break;
  }
}

export const logger = {
  debug: (msg: string, context?: LogContext) => emit("debug", msg, context),
  info: (msg: string, context?: LogContext) => emit("info", msg, context),
  warn: (msg: string, context?: LogContext) => emit("warn", msg, context),
  error: (msg: string, context?: LogContext) => emit("error", msg, context),
};

/** @deprecated Use logger.info / logger.warn / logger.error instead */
export function log(msg: string): void {
  emit("info", msg);
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs}s`;
}
