type Level = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL: Level = (process.env.LOG_LEVEL as Level) || "info";

function log(level: Level, component: string, message: string, data?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[MIN_LEVEL]) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${component}]`;
  const suffix = data ? " " + JSON.stringify(data) : "";
  const out = level === "error" || level === "warn" ? console.error : console.log;
  out(`${prefix} ${message}${suffix}`);
}

export const logger = {
  debug: (component: string, msg: string, data?: Record<string, unknown>) => log("debug", component, msg, data),
  info: (component: string, msg: string, data?: Record<string, unknown>) => log("info", component, msg, data),
  warn: (component: string, msg: string, data?: Record<string, unknown>) => log("warn", component, msg, data),
  error: (component: string, msg: string, data?: Record<string, unknown>) => log("error", component, msg, data),
};
