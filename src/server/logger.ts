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

function formatLogLine(level: string, event: string, fields: LogFields = {}): string {
  const renderedFields = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  return renderedFields
    ? `[halupedia] level=${level} event=${event} ${renderedFields}`
    : `[halupedia] level=${level} event=${event}`;
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
