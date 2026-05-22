/**
 * Structural pipeline trace recorder.
 *
 * Every workflow run produces a `pipeline_runs` row plus N `pipeline_nodes`
 * rows, written to a dedicated SQLite database so churn never contends with
 * the main article store and so retention can be tuned independently.
 *
 * Tracing is opt-out per-config:
 *
 *   [pipeline.trace]
 *   enabled = true
 *   level = "normal"      # off | quiet | normal | debug | trace
 *
 * The recorder is allocation-light when disabled (`enabled=false` or
 * `level="off"` returns a no-op recorder that does no IO).
 *
 * Storage schema is deliberately denormalised — each node row carries its
 * own captured input/output/diff JSON. Read-time joins are not a concern;
 * traces are written once, displayed in admin UI, and pruned after N days.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import type {
  PipelineState,
  PipelineStatePatch,
} from "../state";
import type { PipelineTraceConfig, PipelineTraceLevel } from "../../types";

// ─── Public API ──────────────────────────────────────────────────────────────

export interface NodeTraceFields {
  workflow: string;
  runId: string;
  nodeName: string;
  nodeKind: string;
  startedAt: number;
  durationMs: number;
  status: "ok" | "error";
  reads: readonly string[];
  writes: readonly string[];
  inputs?: Record<string, unknown>;
  patch?: PipelineStatePatch;
  diff?: StateDiff;
  warnings?: string[];
  error?: { message: string; stack?: string };
}

export interface RunTraceFields {
  workflow: string;
  runId: string;
  requestId: string;
  slug?: string;
  startedAt: number;
  durationMs: number;
  status: "ok" | "error";
  nodesExecuted: number;
  error?: { message: string; stack?: string };
}

export interface TraceRecorder {
  level: PipelineTraceLevel;
  recordRun(fields: RunTraceFields): void;
  recordNode(fields: NodeTraceFields): void;
  /** Released back to the recorder pool — no-op for SQLite recorder today. */
  close(): void;
}

/**
 * Compute a structural diff between two state snapshots. Only emits the
 * keys that were added, removed, or changed; values are kept verbatim so
 * the trace viewer can render them. `kind` is exposed so the UI can render
 * adds/changes/removes differently.
 */
export type StateDiff = Record<
  string,
  { kind: "add" | "change" | "remove"; before?: unknown; after?: unknown }
>;

export function diffState(
  before: PipelineState,
  after: PipelineState,
): StateDiff {
  const diff: StateDiff = {};
  const keys = new Set<string>([
    ...Object.keys(before as Record<string, unknown>),
    ...Object.keys(after as Record<string, unknown>),
  ]);
  for (const key of keys) {
    const b = (before as Record<string, unknown>)[key];
    const a = (after as Record<string, unknown>)[key];
    const inBefore = key in (before as Record<string, unknown>);
    const inAfter = key in (after as Record<string, unknown>);
    if (!inBefore && inAfter) diff[key] = { kind: "add", after: a };
    else if (inBefore && !inAfter) diff[key] = { kind: "remove", before: b };
    else if (!shallowEqual(b, a)) diff[key] = { kind: "change", before: b, after: a };
  }
  return diff;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  // Defer to content-hash equality for deep objects. Cheap enough for trace.
  return hashValue(a) === hashValue(b);
}

export function hashValue(v: unknown): string {
  return createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v ?? null))
    .digest("hex")
    .slice(0, 16);
}

export function newRunId(): string {
  return randomUUID();
}

// ─── No-op recorder (used when tracing is disabled) ──────────────────────────

class NoopRecorder implements TraceRecorder {
  readonly level: PipelineTraceLevel = "off";
  recordRun(): void {}
  recordNode(): void {}
  close(): void {}
}

// ─── SQLite recorder ─────────────────────────────────────────────────────────

class SqliteTraceRecorder implements TraceRecorder {
  readonly level: PipelineTraceLevel;
  private readonly db: DatabaseSync;
  private readonly insertRun: ReturnType<DatabaseSync["prepare"]>;
  private readonly insertNode: ReturnType<DatabaseSync["prepare"]>;

  constructor(databasePath: string, level: PipelineTraceLevel) {
    this.level = level;
    const absPath = resolve(process.cwd(), databasePath);
    mkdirSync(dirname(absPath), { recursive: true });
    this.db = new DatabaseSync(absPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA_SQL);
    this.insertRun = this.db.prepare(
      `INSERT INTO pipeline_runs
         (run_id, request_id, workflow, slug, started_at, duration_ms,
          status, nodes_executed, error_message, error_stack)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    this.insertNode = this.db.prepare(
      `INSERT INTO pipeline_nodes
         (run_id, node_name, node_kind, started_at, duration_ms, status,
          reads, writes, inputs_json, patch_json, diff_json, warnings_json,
          error_message, error_stack)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
  }

  recordRun(fields: RunTraceFields): void {
    if (this.level === "off") return;
    try {
      this.insertRun.run(
        fields.runId,
        fields.requestId,
        fields.workflow,
        fields.slug ?? null,
        fields.startedAt,
        fields.durationMs,
        fields.status,
        fields.nodesExecuted,
        fields.error?.message ?? null,
        fields.error?.stack ?? null,
      );
    } catch {
      // Tracing failures must never break a workflow. Swallow.
    }
  }

  recordNode(fields: NodeTraceFields): void {
    if (this.level === "off" || this.level === "quiet") {
      // quiet: skip per-node rows beyond what `recordRun` captures? Keep
      // node rows because that's the minimum to render execution order.
      if (this.level === "off") return;
    }
    try {
      const includeInputs = this.level === "trace";
      const includePatch =
        this.level === "trace" || this.level === "debug";
      const includeDiff =
        this.level === "debug" ||
        this.level === "trace" ||
        this.level === "normal";
      this.insertNode.run(
        fields.runId,
        fields.nodeName,
        fields.nodeKind,
        fields.startedAt,
        fields.durationMs,
        fields.status,
        JSON.stringify(fields.reads),
        JSON.stringify(fields.writes),
        includeInputs ? safeJson(fields.inputs) : null,
        includePatch ? safeJson(fields.patch) : null,
        includeDiff ? safeJson(fields.diff) : null,
        fields.warnings && fields.warnings.length
          ? JSON.stringify(fields.warnings)
          : null,
        fields.error?.message ?? null,
        fields.error?.stack ?? null,
      );
    } catch {
      // ditto — swallow trace failures.
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignored
    }
  }
}

function safeJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === "string" && v.length > 16_000) {
        return `${v.slice(0, 16_000)}…[truncated ${v.length - 16_000} chars]`;
      }
      return v;
    });
  } catch {
    return JSON.stringify({ _unserializable: true });
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id          TEXT PRIMARY KEY,
  request_id      TEXT,
  workflow        TEXT NOT NULL,
  slug            TEXT,
  started_at      INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  status          TEXT NOT NULL,
  nodes_executed  INTEGER NOT NULL,
  error_message   TEXT,
  error_stack     TEXT
);
CREATE INDEX IF NOT EXISTS pipeline_runs_workflow_idx
  ON pipeline_runs (workflow, started_at);
CREATE INDEX IF NOT EXISTS pipeline_runs_slug_idx
  ON pipeline_runs (slug, started_at);

CREATE TABLE IF NOT EXISTS pipeline_nodes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  node_name       TEXT NOT NULL,
  node_kind       TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  status          TEXT NOT NULL,
  reads           TEXT NOT NULL,
  writes          TEXT NOT NULL,
  inputs_json     TEXT,
  patch_json      TEXT,
  diff_json       TEXT,
  warnings_json   TEXT,
  error_message   TEXT,
  error_stack     TEXT
);
CREATE INDEX IF NOT EXISTS pipeline_nodes_run_idx
  ON pipeline_nodes (run_id, started_at);
`;

// ─── Factory ─────────────────────────────────────────────────────────────────

let cachedRecorder: TraceRecorder | null = null;
let cachedKey: string | null = null;

/**
 * Returns a process-cached recorder keyed by (path, level). Re-loading config
 * with a different level swaps the recorder transparently.
 */
export function getTraceRecorder(config: PipelineTraceConfig): TraceRecorder {
  if (!config.enabled || config.level === "off") {
    return new NoopRecorder();
  }
  const key = `${config.database_path}|${config.level}`;
  if (cachedRecorder && cachedKey === key) return cachedRecorder;
  if (cachedRecorder) cachedRecorder.close();
  cachedRecorder = new SqliteTraceRecorder(
    config.database_path,
    config.level,
  );
  cachedKey = key;
  return cachedRecorder;
}

/** Force-close the cached recorder. Tests and shutdown call this. */
export function closeTraceRecorder(): void {
  if (cachedRecorder) {
    cachedRecorder.close();
    cachedRecorder = null;
    cachedKey = null;
  }
}
