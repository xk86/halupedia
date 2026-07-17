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
  /** Total chars in system+user prompt for LLM nodes; undefined for non-LLM nodes. */
  promptChars?: number;
  /** Formatted system+user prompt sent to the model (LLM nodes only). */
  promptText?: string;
  /** Model chain-of-thought / reasoning, when the backend separates it. */
  cotText?: string;
  /** Final model response text (LLM nodes only). */
  responseText?: string;
  /** Exact RAG values placed into the prompt (render nodes only); JSON-encoded. */
  ragTrace?: unknown;
  /** Exact rule set assembled into the prompt (render nodes only); JSON-encoded. */
  rulesTrace?: unknown;
  /** LLM invocation metadata and generation options (LLM nodes only). */
  llmRole?: string;
  llmResolvedRole?: string;
  llmConfigKey?: string;
  llmModel?: string;
  llmBaseUrl?: string;
  llmHost?: string;
  llmTemperature?: number;
  llmMaxTokens?: number;
  llmTopK?: number;
  llmTopP?: number;
  llmMinP?: number;
  llmThinking?: boolean;
  llmJsonMode?: boolean;
  llmImageCount?: number;
  llmTtftMs?: number;
  /** Every LLM invocation made by this node, in completion order. */
  llmCalls?: readonly LlmCallTrace[];
}

export interface LlmCallTrace {
  promptChars: number;
  prompt: string;
  cot: string;
  response: string;
  role: string;
  resolvedRole?: string;
  configKey?: string;
  model?: string;
  baseUrl?: string;
  host?: string;
  temperature?: number;
  maxTokens?: number;
  topK?: number;
  topP?: number;
  minP?: number;
  thinking?: boolean;
  jsonMode?: boolean;
  imageCount?: number;
  ttftMs?: number;
}

/** Full lifecycle of a `pipeline_runs` row. `pending`/`running` exist so a
 *  workflow that has been queued (or gated behind a concurrency limiter) is
 *  visible in the traces view *before* it produces any node output. */
export type PipelineRunStatus = "pending" | "running" | "ok" | "error";

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
  /** When the run was first known-about (queued), if different from startedAt. */
  queuedAt?: number;
  /** The run that caused this one to be scheduled, e.g. post-process spawned
   *  after article.generate — lets the traces view show "spawned by <parent>". */
  parentRunId?: string;
  /** Free-text label for what decided to run this workflow, e.g. "http",
   *  "post_process_auto", "image_auto", "maintenance". */
  origin?: string;
}

/** Fields known the moment a workflow is declared/queued, before it starts
 *  executing (i.e. before any node has run, possibly before a concurrency
 *  gate has even been acquired). */
export interface PendingRunFields {
  workflow: string;
  runId: string;
  requestId: string;
  slug?: string;
  queuedAt: number;
  parentRunId?: string;
  origin?: string;
}

export interface TraceRecorder {
  level: PipelineTraceLevel;
  /** Insert a `pending` row the instant a workflow is queued — before any
   *  gate/concurrency wait and before execution starts. */
  recordRunPending(fields: PendingRunFields): void;
  /** Transition a pending row to `running` once its gate clears and node
   *  execution actually begins. */
  recordRunStarted(runId: string, startedAt: number): void;
  /** Terminal transition to `ok`/`error` (UPSERT — also usable standalone by
   *  callers that never called recordRunPending). */
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
  recordRunPending(): void {}
  recordRunStarted(): void {}
  recordRun(): void {}
  recordNode(): void {}
  close(): void {}
}

// ─── SQLite recorder ─────────────────────────────────────────────────────────

class SqliteTraceRecorder implements TraceRecorder {
  readonly level: PipelineTraceLevel;
  private readonly db: DatabaseSync;
  private readonly insertRunPending: ReturnType<DatabaseSync["prepare"]>;
  private readonly updateRunStarted: ReturnType<DatabaseSync["prepare"]>;
  private readonly insertRun: ReturnType<DatabaseSync["prepare"]>;
  private readonly insertNode: ReturnType<DatabaseSync["prepare"]>;

  constructor(databasePath: string, level: PipelineTraceLevel) {
    this.level = level;
    const absPath = resolve(process.cwd(), databasePath);
    mkdirSync(dirname(absPath), { recursive: true });
    this.db = new DatabaseSync(absPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA_SQL);
    // Migrate existing DBs that predate the queue-aware columns.
    for (const col of [`queued_at INTEGER`, `parent_run_id TEXT`, `origin TEXT`]) {
      try {
        this.db.exec(`ALTER TABLE pipeline_runs ADD COLUMN ${col}`);
      } catch { /* column already exists */ }
    }
    // Only safe to create *after* the ALTER above — on a pre-existing DB the
    // column doesn't exist until this point, and CREATE INDEX on a missing
    // column is a hard SQL error (unlike ADD COLUMN, which errors are caught).
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS pipeline_runs_parent_idx ON pipeline_runs (parent_run_id)`,
    );
    this.insertRunPending = this.db.prepare(
      `INSERT INTO pipeline_runs
         (run_id, request_id, workflow, slug, started_at, duration_ms,
          status, nodes_executed, queued_at, parent_run_id, origin)
       VALUES (?,?,?,?,?,0,'pending',0,?,?,?)
       ON CONFLICT(run_id) DO NOTHING`,
    );
    this.updateRunStarted = this.db.prepare(
      `UPDATE pipeline_runs SET status = 'running', started_at = ?
       WHERE run_id = ? AND status = 'pending'`,
    );
    this.insertRun = this.db.prepare(
      `INSERT INTO pipeline_runs
         (run_id, request_id, workflow, slug, started_at, duration_ms,
          status, nodes_executed, error_message, error_stack,
          queued_at, parent_run_id, origin)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(run_id) DO UPDATE SET
         request_id = excluded.request_id,
         workflow = excluded.workflow,
         slug = excluded.slug,
         started_at = excluded.started_at,
         duration_ms = excluded.duration_ms,
         status = excluded.status,
         nodes_executed = excluded.nodes_executed,
         error_message = excluded.error_message,
         error_stack = excluded.error_stack`,
    );
    // Migrate existing DBs that predate later columns. Each ALTER is wrapped
    // independently so a DB missing only some of them still gets the rest.
    for (const col of [
      `prompt_chars INTEGER`,
      `prompt_text TEXT`,
      `cot_text TEXT`,
      `response_text TEXT`,
      `llm_role TEXT`,
      `llm_resolved_role TEXT`,
      `llm_config_key TEXT`,
      `llm_model TEXT`,
      `llm_base_url TEXT`,
      `llm_host TEXT`,
      `llm_temperature REAL`,
      `llm_max_tokens INTEGER`,
      `llm_top_k REAL`,
      `llm_top_p REAL`,
      `llm_min_p REAL`,
      `llm_thinking INTEGER`,
      `llm_json_mode INTEGER`,
      `llm_image_count INTEGER`,
      `llm_ttft_ms INTEGER`,
      `llm_calls_json TEXT`,
      `rag_json TEXT`,
      `rules_json TEXT`,
    ]) {
      try {
        this.db.exec(`ALTER TABLE pipeline_nodes ADD COLUMN ${col}`);
      } catch { /* column already exists */ }
    }
    this.insertNode = this.db.prepare(
      `INSERT INTO pipeline_nodes
         (run_id, node_name, node_kind, started_at, duration_ms, status,
          reads, writes, inputs_json, patch_json, diff_json, warnings_json,
          error_message, error_stack, prompt_chars, prompt_text, cot_text, response_text,
          llm_role, llm_resolved_role, llm_config_key, llm_model, llm_base_url,
          llm_host, llm_temperature, llm_max_tokens, llm_top_k, llm_top_p, llm_min_p,
          llm_thinking, llm_json_mode,
          llm_image_count, llm_ttft_ms, llm_calls_json, rag_json, rules_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    // Boot-time cleanup: any row still `pending`/`running` from a previous
    // process cannot possibly still be executing (the in-memory
    // LiveRunRegistry that would track it doesn't survive a restart) —
    // leaving it stuck would make the traces view show a phantom "running"
    // workflow forever.
    try {
      this.db.exec(
        `UPDATE pipeline_runs SET status = 'error', error_message = 'process restart'
         WHERE status IN ('pending', 'running')`,
      );
    } catch {
      // Tracing failures must never break startup. Swallow.
    }
  }

  recordRunPending(fields: PendingRunFields): void {
    if (this.level === "off") return;
    try {
      this.insertRunPending.run(
        fields.runId,
        fields.requestId,
        fields.workflow,
        fields.slug ?? null,
        fields.queuedAt,
        fields.queuedAt,
        fields.parentRunId ?? null,
        fields.origin ?? null,
      );
    } catch {
      // Tracing failures must never break a workflow. Swallow.
    }
  }

  recordRunStarted(runId: string, startedAt: number): void {
    if (this.level === "off") return;
    try {
      this.updateRunStarted.run(startedAt, runId);
    } catch {
      // Tracing failures must never break a workflow. Swallow.
    }
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
        fields.queuedAt ?? fields.startedAt,
        fields.parentRunId ?? null,
        fields.origin ?? null,
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
        fields.promptChars ?? null,
        capText(fields.promptText),
        capText(fields.cotText),
        capText(fields.responseText),
        fields.llmRole ?? null,
        fields.llmResolvedRole ?? null,
        fields.llmConfigKey ?? null,
        fields.llmModel ?? null,
        fields.llmBaseUrl ?? null,
        fields.llmHost ?? null,
        fields.llmTemperature ?? null,
        fields.llmMaxTokens ?? null,
        fields.llmTopK ?? null,
        fields.llmTopP ?? null,
        fields.llmMinP ?? null,
        fields.llmThinking === undefined ? null : fields.llmThinking ? 1 : 0,
        fields.llmJsonMode === undefined ? null : fields.llmJsonMode ? 1 : 0,
        fields.llmImageCount ?? null,
        fields.llmTtftMs ?? null,
        serializeLlmCalls(fields.llmCalls),
        fields.ragTrace ? capText(JSON.stringify(fields.ragTrace)) : null,
        fields.rulesTrace ? capText(JSON.stringify(fields.rulesTrace)) : null,
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

/** Cap a captured prompt/CoT/response blob so a runaway prompt can't bloat
 *  the trace DB. 80k chars is well past any real prompt yet bounded. */
function capText(value: string | undefined): string | null {
  if (!value) return null;
  const LIMIT = 80_000;
  return value.length > LIMIT
    ? `${value.slice(0, LIMIT)}…[truncated ${value.length - LIMIT} chars]`
    : value;
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

function serializeLlmCalls(calls: readonly LlmCallTrace[] | undefined): string | null {
  if (!calls?.length) return null;
  return JSON.stringify(
    calls.map((call) => ({
      ...call,
      prompt: capText(call.prompt),
      cot: capText(call.cot),
      response: capText(call.response),
    })),
  );
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
  error_stack     TEXT,
  queued_at       INTEGER,
  parent_run_id   TEXT,
  origin          TEXT
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
  error_stack     TEXT,
  prompt_chars    INTEGER,
  prompt_text     TEXT,
  cot_text        TEXT,
  response_text   TEXT,
  llm_role        TEXT,
  llm_resolved_role TEXT,
  llm_config_key  TEXT,
  llm_model       TEXT,
  llm_base_url    TEXT,
  llm_host        TEXT,
  llm_temperature REAL,
  llm_max_tokens  INTEGER,
  llm_top_k       REAL,
  llm_top_p       REAL,
  llm_min_p       REAL,
  llm_thinking    INTEGER,
  llm_json_mode   INTEGER,
  llm_image_count INTEGER,
  llm_ttft_ms     INTEGER,
  llm_calls_json  TEXT,
  rag_json        TEXT,
  rules_json      TEXT
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
 *
 * If the SQLite DB cannot be opened (e.g. locked by a concurrent test process),
 * silently returns a NoopRecorder rather than crashing. Tracing is observability
 * infrastructure and must never take down the application.
 */
export function getTraceRecorder(config: PipelineTraceConfig): TraceRecorder {
  if (!config.enabled || config.level === "off") {
    return new NoopRecorder();
  }
  const key = `${config.database_path}|${config.level}`;
  if (cachedRecorder && cachedKey === key) return cachedRecorder;
  if (cachedRecorder) cachedRecorder.close();
  try {
    cachedRecorder = new SqliteTraceRecorder(config.database_path, config.level);
    cachedKey = key;
  } catch {
    // DB open failed (e.g. locked by concurrent process). Degrade to noop.
    cachedRecorder = new NoopRecorder();
    cachedKey = key;
  }
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
