// Surgical, comment-preserving TOML edits. smol-toml only parses, and we don't
// want to regenerate llm.toml from scratch on every admin save — that would wipe
// the hand-written comments and commented-out alternates the operator keeps. So
// these helpers patch the raw text line-by-line, touching only the line that
// changes and leaving everything else (comments, ordering, spacing) verbatim.
//
// Scope is deliberately small: top-level dotted tables (`[llm.chat]`,
// `[llm.host.cat-desktop]`) and scalar / string-array values. Not a general TOML
// writer.

export type TomlValue = string | number | boolean | string[];

/** Render a value as a TOML literal. Strings use basic (double-quoted) form;
 *  arrays render inline. */
export function tomlRender(value: TomlValue): string {
  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isHeaderLine(line: string): boolean {
  return /^\s*\[[^[]/.test(line) && !/^\s*#/.test(line);
}

/** Index of the `[tablePath]` header line, or -1 if the table isn't present. */
function findTableHeader(lines: string[], tablePath: string): number {
  const header = new RegExp(`^\\s*\\[\\s*${escapeRegExp(tablePath)}\\s*\\]\\s*(#.*)?$`);
  return lines.findIndex((line) => header.test(line));
}

/** End (exclusive) of a table's block — the next header line at or after `start`,
 *  or the end of the file. */
function tableBlockEnd(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    if (isHeaderLine(lines[i])) return i;
  }
  return lines.length;
}

/**
 * Set `key = value` inside `[tablePath]`, preserving all surrounding lines.
 * Replaces an existing non-comment `key = …` line in the table (keeping its
 * indentation), inserts one right after the header if the key is absent, or
 * appends a new table block if the table itself is missing.
 */
export function setTomlTableValue(
  source: string,
  tablePath: string,
  key: string,
  value: TomlValue,
): string {
  const rendered = `${key} = ${tomlRender(value)}`;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);

  const headerIdx = findTableHeader(lines, tablePath);
  if (headerIdx === -1) {
    const block = [`[${tablePath}]`, rendered];
    const sep = source.length > 0 && !source.endsWith("\n") ? eol + eol : eol;
    return `${source}${sep}${block.join(eol)}${eol}`;
  }

  const blockEnd = tableBlockEnd(lines, headerIdx + 1);
  const keyPattern = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=`);
  for (let i = headerIdx + 1; i < blockEnd; i++) {
    if (/^\s*#/.test(lines[i])) continue;
    const m = lines[i].match(keyPattern);
    if (m) {
      lines[i] = `${m[1]}${rendered}`;
      return lines.join(eol);
    }
  }
  // Key absent — insert directly after the header.
  lines.splice(headerIdx + 1, 0, rendered);
  return lines.join(eol);
}

/** Remove an active key from a table while preserving comments and formatting. */
export function removeTomlTableKey(source: string, tablePath: string, key: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const headerIdx = findTableHeader(lines, tablePath);
  if (headerIdx === -1) return source;
  const blockEnd = tableBlockEnd(lines, headerIdx + 1);
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let i = headerIdx + 1; i < blockEnd; i++) {
    if (/^\s*#/.test(lines[i])) continue;
    if (keyPattern.test(lines[i])) {
      lines.splice(i, 1);
      return lines.join(eol);
    }
  }
  return source;
}

/**
 * Append a new `[tablePath]` block with the given entries. No-op-safe: if the
 * table already exists this still appends a duplicate header, so callers should
 * only use it for genuinely new tables (use {@link setTomlTableValue} to edit).
 */
export function addTomlTable(
  source: string,
  tablePath: string,
  entries: Record<string, TomlValue>,
): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const block = [
    `[${tablePath}]`,
    ...Object.entries(entries).map(([k, v]) => `${k} = ${tomlRender(v)}`),
  ];
  const sep = source.length > 0 && !source.endsWith("\n") ? eol + eol : eol;
  return `${source}${sep}${block.join(eol)}${eol}`;
}
