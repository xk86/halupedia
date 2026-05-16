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

export function createConsoleLogger(): Logger {
  return {
    debug(event, fields) {
      console.debug(formatLogLine("debug", event, fields));
    },
    info(event, fields) {
      console.log(formatLogLine("info", event, fields));
    },
    warn(event, fields) {
      console.warn(formatLogLine("warn", event, fields));
    },
    error(event, fields) {
      console.error(formatLogLine("error", event, fields));
    },
  };
}

export function truncateForLog(value: string, limit = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}
