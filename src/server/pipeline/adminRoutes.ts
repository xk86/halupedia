/**
 * Admin endpoints for the LangGraph pipeline.
 *
 *   GET /api/admin/pipeline/workflows
 *     → list of described workflows (nodes, edges, kinds, reads, writes).
 *       Drives the admin graph visualization directly — there is no
 *       manually-maintained diagram.
 *
 *   GET /api/admin/pipeline/workflows/:name
 *     → one described workflow.
 *
 *   GET /api/admin/pipeline/workflows/:name.dot
 *     → same workflow rendered as Graphviz DOT (for CLI debugging).
 *
 *   GET /api/admin/pipeline/runs?workflow=&slug=&limit=
 *     → recent run rows from the trace DB. Empty array when tracing
 *       is disabled or the DB does not exist.
 *
 *   GET /api/admin/pipeline/runs/:runId
 *     → one run plus all its node spans.
 *
 *   POST /api/admin/pipeline/run
 *     Body: { workflow: string, input: WorkflowInput }
 *     Executes the named workflow and returns the full trace + final state.
 *     Use this to validate end-to-end before wiring production routes.
 *
 * These endpoints intentionally do NOT execute workflows or mutate state.
 * The plan is to add a `/run` endpoint later, behind an admin-only flag.
 */

import type { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { encoding_for_model } from "tiktoken";
import type { PipelineTraceConfig } from "../types";
import type { PipelineDeps } from "./deps";
import { ALL_WORKFLOWS, findWorkflow } from "./registry";
import {
  describeWorkflow,
  describeWorkflowAsDot,
  workflowSummary,
} from "./runtime/introspect";
import { runWorkflow } from "./runtime/graph";
import { getTraceRecorder } from "./runtime/trace";
import type { WorkflowInput } from "./state";

export function registerPipelineAdminRoutes(
  app: Hono,
  getTraceConfig: () => PipelineTraceConfig,
  getDeps?: () => PipelineDeps,
): void {
  app.get("/api/admin/pipeline/workflows", (c) => {
    return c.json({
      workflows: ALL_WORKFLOWS.map((w) => ({
        ...describeWorkflow(w),
        summary: workflowSummary(w),
      })),
    });
  });

  // More-specific `.dot` route must be registered before the generic `:name`
  // route, otherwise Hono's router binds the whole segment (including ".dot")
  // into `:name` and the literal-suffix route never fires.
  app.get("/api/admin/pipeline/workflows/:name.dot", (c) => {
    const name = (c.req.param("name") ?? "").replace(/\.dot$/, "");
    const wf = findWorkflow(name);
    if (!wf) return c.text("unknown workflow", 404);
    return c.text(describeWorkflowAsDot(wf), 200, {
      "content-type": "text/vnd.graphviz; charset=utf-8",
    });
  });

  app.get("/api/admin/pipeline/workflows/:name", (c) => {
    const name = c.req.param("name");
    const wf = findWorkflow(name);
    if (!wf) return c.json({ error: "unknown workflow" }, 404);
    return c.json({ ...describeWorkflow(wf), summary: workflowSummary(wf) });
  });

  app.get("/api/admin/pipeline/runs", (c) => {
    const cfg = getTraceConfig();
    const conn = openTraceDbReadOnly(cfg);
    if (!conn) return c.json({ runs: [], traceEnabled: false });

    const workflowFilter = c.req.query("workflow") ?? null;
    const slugFilter = c.req.query("slug") ?? null;
    const limit = clampInt(c.req.query("limit"), 50, 1, 500);

    const where: string[] = [];
    const params: Array<string | number> = [];
    if (workflowFilter) {
      where.push("workflow = ?");
      params.push(workflowFilter);
    }
    if (slugFilter) {
      where.push("slug = ?");
      params.push(slugFilter);
    }
    const sql =
      `SELECT run_id, request_id, workflow, slug, started_at, duration_ms,
              status, nodes_executed, error_message
         FROM pipeline_runs ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY started_at DESC LIMIT ?`;
    params.push(limit);
    const rows = conn.prepare(sql).all(...params) as Array<{
      run_id: string;
      request_id: string;
      workflow: string;
      slug: string | null;
      started_at: number;
      duration_ms: number;
      status: string;
      nodes_executed: number;
      error_message: string | null;
    }>;
    const warningsByRun = listRunWarnings(
      conn,
      rows.map((row) => row.run_id),
    );
    conn.close();
    return c.json({
      traceEnabled: true,
      runs: rows.map((row) => {
        const warnings = warningsByRun.get(row.run_id) ?? [];
        return {
          ...row,
          warning_count: warnings.length,
          warning_messages: warnings.slice(0, 3),
        };
      }),
    });
  });

  app.get("/api/admin/pipeline/runs/:runId", (c) => {
    const cfg = getTraceConfig();
    const conn = openTraceDbReadOnly(cfg);
    if (!conn) return c.json({ error: "tracing disabled" }, 404);
    const runId = c.req.param("runId");
    const run = conn
      .prepare(`SELECT * FROM pipeline_runs WHERE run_id = ?`)
      .get(runId) as Record<string, unknown> | undefined;
    if (!run) {
      conn.close();
      return c.json({ error: "unknown run" }, 404);
    }
    const nodes = conn
      .prepare(
        `SELECT * FROM pipeline_nodes WHERE run_id = ? ORDER BY started_at ASC, id ASC`,
      )
      .all(runId) as Array<Record<string, unknown>>;
    conn.close();
    return c.json({
      run,
      nodes: nodes.map(serializeTraceNode),
    });
  });

  app.post("/api/admin/pipeline/run", async (c) => {
    if (!getDeps) {
      return c.json({ error: "pipeline deps not wired" }, 503);
    }
    let body: { workflow?: string; input?: Partial<WorkflowInput> };
    try {
      body = await c.req.json() as typeof body;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const workflowName = body.workflow;
    if (!workflowName) {
      return c.json({ error: "missing field: workflow" }, 400);
    }
    const wf = findWorkflow(workflowName);
    if (!wf) {
      return c.json(
        { error: `unknown workflow '${workflowName}'`, available: ALL_WORKFLOWS.map((w) => w.name) },
        404,
      );
    }
    const input: WorkflowInput = {
      requestId: randomUUID(),
      workflow: workflowName,
      slug: body.input?.slug,
      requestedTitle: body.input?.requestedTitle,
      instructions: body.input?.instructions,
      pinnedSlugs: body.input?.pinnedSlugs ?? [],
      blacklistSlugs: body.input?.blacklistSlugs ?? [],
      selectedReferenceSlugs: body.input?.selectedReferenceSlugs ?? null,
      imageId: body.input?.imageId,
      imageReplace: body.input?.imageReplace,
      imagePromptKey: body.input?.imagePromptKey,
      imageAspectRatioKey: body.input?.imageAspectRatioKey,
    };
    const cfg = getTraceConfig();
    const recorder = getTraceRecorder(cfg);
    const deps = getDeps();
    const result = await runWorkflow(wf, {
      input,
      deps,
      recorder,
      logger: deps.logger,
    });
    const conn = openTraceDbReadOnly(cfg);
    const traceRun = conn
      ?.prepare(`SELECT * FROM pipeline_runs WHERE run_id = ?`)
      .get(result.runId) ?? null;
    const traceNodes = conn
      ?.prepare(
        `SELECT * FROM pipeline_nodes WHERE run_id = ? ORDER BY started_at ASC, id ASC`,
      )
      .all(result.runId) ?? [];
    conn?.close();
    return c.json({
      runId: result.runId,
      status: result.status,
      durationMs: result.durationMs,
      nodesExecuted: result.nodesExecuted,
      error: result.error ? result.error.message : null,
      trace: {
        run: traceRun,
        nodes: (traceNodes as Array<Record<string, unknown>>).map(serializeTraceNode),
      },
    });
  });
}

function serializeTraceNode(n: Record<string, unknown>): Record<string, unknown> {
  const promptText = n.prompt_text as string | null;
  const promptTokens = splitPromptTokens(promptText);
  return {
    ...n,
    reads: safeParse(n.reads),
    writes: safeParse(n.writes),
    inputs: safeParse(n.inputs_json),
    patch: safeParse(n.patch_json),
    diff: safeParse(n.diff_json),
    warnings: safeParse(n.warnings_json),
    prompt_tokens: countTokens(promptText),
    system_prompt_tokens: promptTokens.system,
    user_prompt_tokens: promptTokens.user,
    cot_tokens: countTokens(n.cot_text as string | null),
    response_tokens: countTokens(n.response_text as string | null),
    llm_calls: parseLlmCalls(n.llm_calls_json),
    rag: parseRagTrace(n.rag_json),
  };
}

function parseLlmCalls(raw: unknown): Array<Record<string, unknown>> {
  const parsed = safeParse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((call): call is Record<string, unknown> =>
      Boolean(call && typeof call === "object" && !Array.isArray(call)),
    )
    .map((call) => {
      const prompt = typeof call.prompt === "string" ? call.prompt : "";
      const cot = typeof call.cot === "string" ? call.cot : "";
      const response = typeof call.response === "string" ? call.response : "";
      const promptTokens = splitPromptTokens(prompt);
      return {
        ...call,
        promptTokens: countTokens(prompt),
        systemPromptTokens: promptTokens.system,
        userPromptTokens: promptTokens.user,
        cotTokens: countTokens(cot),
        responseTokens: countTokens(response),
      };
    });
}

function openTraceDbReadOnly(
  cfg: PipelineTraceConfig,
): DatabaseSync | null {
  if (!cfg.enabled || cfg.level === "off") return null;
  const path = resolve(process.cwd(), cfg.database_path);
  if (!existsSync(path)) return null;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    // Reader may race with the writer's WAL initialisation on first start.
    return null;
  }
}

function safeParse(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeWarningList(value: unknown): string[] {
  const parsed = safeParse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((warning) => typeof warning === "string" ? warning.trim() : "")
    .filter(Boolean);
}

function listRunWarnings(
  conn: DatabaseSync,
  runIds: string[],
): Map<string, string[]> {
  const warningsByRun = new Map<string, string[]>();
  if (runIds.length === 0) return warningsByRun;
  const placeholders = runIds.map(() => "?").join(",");
  const rows = conn
    .prepare(
      `SELECT run_id, warnings_json
         FROM pipeline_nodes
        WHERE run_id IN (${placeholders})
          AND warnings_json IS NOT NULL
          AND warnings_json <> ''`,
    )
    .all(...runIds) as Array<{ run_id: string; warnings_json: string | null }>;
  for (const row of rows) {
    const warnings = normalizeWarningList(row.warnings_json);
    if (warnings.length === 0) continue;
    const existing = warningsByRun.get(row.run_id) ?? [];
    existing.push(...warnings);
    warningsByRun.set(row.run_id, existing);
  }
  return warningsByRun;
}

function clampInt(
  raw: string | undefined,
  def: number,
  min: number,
  max: number,
): number {
  const n = raw ? Number.parseInt(raw, 10) : def;
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function countTokens(text: string | null | undefined): number {
  if (!text) return 0;
  try {
    const enc = encoding_for_model("gpt-3.5-turbo");
    const tokens = enc.encode(text);
    enc.free();
    return tokens.length;
  } catch {
    return 0;
  }
}

/**
 * Parse a node's `rag_json` capture and attach tiktoken counts per section, so
 * the admin RAG view can show — byte-exact and with token sizes — the evidence
 * and link allowlist the model actually received. Returns null for non-render
 * nodes (no capture).
 */
function parseRagTrace(raw: unknown): Record<string, unknown> | null {
  const parsed = safeParse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    ...r,
    tokens: {
      evidence: countTokens(str(r.evidenceContext)),
      links: countTokens(str(r.linkAllowlist)),
      relatedTitles: countTokens(str(r.relatedTitles)),
      linkHints: countTokens(str(r.linkHints)),
      vibe: countTokens(str(r.articleVibe)),
    },
  };
}

/**
 * Token counts for the `### System` / `### User` halves of a captured prompt,
 * so the admin trace can label each section instead of lumping the total onto
 * the user prompt. Mirrors the client-side `splitPromptTrace` regex.
 */
function splitPromptTokens(
  text: string | null | undefined,
): { system: number | null; user: number | null } {
  if (!text) return { system: null, user: null };
  const match = text.match(/^### System\n([\s\S]*?)\n\n### User\n([\s\S]*)$/);
  if (!match) return { system: null, user: countTokens(text) };
  return { system: countTokens(match[1].trim()), user: countTokens(match[2].trim()) };
}
