export type LogValue = string | number | boolean | null | undefined;

export interface LogFields {
  [key: string]: LogValue;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

const LEVEL_STYLES: Record<string, { tag: string; color: string }> = {
  debug: { tag: "DBG", color: "\x1b[90m" },
  info:  { tag: "INF", color: "\x1b[36m" },
  warn:  { tag: "WRN", color: "\x1b[33m" },
  error: { tag: "ERR", color: "\x1b[31m" },
};

const EVENT_COLORS: Record<string, string> = {
  "page.":       "\x1b[35m",
  "llm.":        "\x1b[34m",
  "rag.":        "\x1b[32m",
  "shutdown.":   "\x1b[33m",
  "startup":     "\x1b[36m",
  "server.":     "\x1b[36m",
};

function eventColor(event: string): string {
  for (const [prefix, color] of Object.entries(EVENT_COLORS)) {
    if (event.startsWith(prefix)) return color;
  }
  return DIM;
}

function timestamp(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export function formatLogLine(level: string, event: string, fields: LogFields = {}): string {
  const style = LEVEL_STYLES[level] ?? LEVEL_STYLES.info!;
  const ts = timestamp();
  const renderedFields = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${DIM}${key}=${RESET}${JSON.stringify(value)}`)
    .join(" ");
  const eventStr = `${eventColor(event)}${event}${RESET}`;
  const levelStr = `${style.color}${BOLD}${style.tag}${RESET}`;
  return renderedFields
    ? `${DIM}${ts}${RESET} ${levelStr} ${eventStr} ${renderedFields}`
    : `${DIM}${ts}${RESET} ${levelStr} ${eventStr}`;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createConsoleLogger(minLevel: LogLevel = "debug"): Logger {
  const enabled = (level: LogLevel) => LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
  return {
    debug(event, fields) {
      if (enabled("debug")) console.debug(formatLogLine("debug", event, fields));
    },
    info(event, fields) {
      if (enabled("info")) console.log(formatLogLine("info", event, fields));
    },
    warn(event, fields) {
      if (enabled("warn")) console.warn(formatLogLine("warn", event, fields));
    },
    error(event, fields) {
      if (enabled("error")) console.error(formatLogLine("error", event, fields));
    },
  };
}

/**
 * Wrap a logger, dropping any (level, event) the `keep` predicate rejects. Used
 * by the offline scripts to silence high-volume per-request `llm.*` chatter
 * while keeping their own progress logs and all warnings/errors.
 */
export function createFilteredLogger(
  base: Logger,
  keep: (level: LogLevel, event: string) => boolean,
): Logger {
  return {
    debug(event, fields) {
      if (keep("debug", event)) base.debug(event, fields);
    },
    info(event, fields) {
      if (keep("info", event)) base.info(event, fields);
    },
    warn(event, fields) {
      if (keep("warn", event)) base.warn(event, fields);
    },
    error(event, fields) {
      if (keep("error", event)) base.error(event, fields);
    },
  };
}

export function truncateForLog(value: string, limit = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}
