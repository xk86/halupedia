/**
 * Graph runtime — wraps LangGraph's `StateGraph` so that every node
 * declared via `defineNode` automatically produces a trace span.
 *
 * Why a thin wrapper instead of using StateGraph directly:
 *
 *   - LangGraph's tracing hooks are pluggable, but we want structural
 *     trace data (state diffs, declared reads/writes, hashes) keyed to
 *     the node definition — not LangChain's runtime callback shape.
 *   - We control the merge between a node's returned patch and the
 *     shared state, so we can compute exact before/after diffs.
 *   - We can expose a stable JSON representation of the compiled graph
 *     (see `introspect.ts`) without going through LC internals.
 *
 * Each workflow describes its graph as a `WorkflowDefinition` — a list
 * of nodes plus edges. The runtime compiles it linearly today (one node
 * after the next, in declaration order, with optional skip predicates).
 * Branching/parallelism arrives in a later iteration; the shape of this
 * file is the seam where StateGraph would slot in.
 *
 * Nothing in here is workflow-specific. Workflows live under
 * `src/server/pipeline/workflows/`.
 */

import type { CompiledNode } from "./nodeFactory";
import type { Logger } from "../../logger";
import type {
  PipelineState,
  PipelineStatePatch,
  WorkflowInput,
} from "../state";
import { initialPipelineState } from "../state";
import {
  diffState,
  hashValue,
  newRunId,
  type TraceRecorder,
} from "./trace";

/** Optional skip predicate — if it returns false, the node is skipped. */
export type SkipPredicate = (state: PipelineState) => boolean;

export interface WorkflowEdge<Deps> {
  node: CompiledNode<Deps>;
  /** Node is skipped when this returns false. */
  when?: SkipPredicate;
}

export interface WorkflowDefinition<Deps> {
  /** Stable workflow name, e.g. `article.generate`. */
  name: string;
  description?: string;
  /** Linear list of nodes executed in order. */
  edges: WorkflowEdge<Deps>[];
}

export interface WorkflowRunOptions<Deps> {
  input: WorkflowInput;
  deps: Deps;
  recorder: TraceRecorder;
  logger?: Logger;
  /** Called at the start of each node with the node name and kind. */
  onNode?: (nodeName: string, nodeKind: string) => void;
}

export interface WorkflowRunResult {
  state: PipelineState;
  runId: string;
  durationMs: number;
  nodesExecuted: number;
  status: "ok" | "error";
  error?: Error;
}

/**
 * Execute a workflow end-to-end. Returns the final state plus run metadata.
 *
 * On failure: trace is still recorded with `status:"error"` and the partial
 * state is returned to the caller so the route handler can format a useful
 * error response.
 */
export async function runWorkflow<Deps>(
  workflow: WorkflowDefinition<Deps>,
  options: WorkflowRunOptions<Deps>,
): Promise<WorkflowRunResult> {
  const runId = newRunId();
  const startedAt = Date.now();
  const requestId = options.input.requestId;
  const slug = options.input.slug;
  let state: PipelineState = initialPipelineState(options.input);
  let nodesExecuted = 0;
  let error: Error | undefined;
  let status: "ok" | "error" = "ok";

  options.logger?.info("pipeline.run.start", {
    workflow: workflow.name,
    run_id: runId,
    request_id: requestId,
    slug,
  });

  try {
    for (const edge of workflow.edges) {
      if (edge.when && !edge.when(state)) {
        options.logger?.debug("pipeline.node.skip", {
          workflow: workflow.name,
          run_id: runId,
          node: edge.node.name,
        });
        continue;
      }
      const nodeStart = Date.now();
      options.onNode?.(edge.node.name, edge.node.kind);
      const before = state;
      // Wrap deps.llm (if present) to capture prompt size for this node.
      let nodePromptChars: number | undefined;
      const deps = options.deps as Record<string, unknown>;
      const nodeDeps =
        deps && typeof deps === "object" && typeof deps.llm === "object" && deps.llm
          ? (() => {
              const origLlm = deps.llm as {
                chat(...args: unknown[]): Promise<string>;
                streamChat(...args: unknown[]): Promise<unknown>;
                embed: unknown;
                probeConnections: unknown;
              };
              const capture = (system: unknown, user: unknown) => {
                nodePromptChars =
                  (typeof system === "string" ? system.length : 0) +
                  (typeof user === "string" ? user.length : 0);
              };
              return {
                ...deps,
                llm: {
                  chat(role: unknown, system: unknown, user: unknown, ...rest: unknown[]) {
                    capture(system, user);
                    return origLlm.chat(role, system, user, ...rest);
                  },
                  streamChat(role: unknown, system: unknown, user: unknown, ...rest: unknown[]) {
                    capture(system, user);
                    return origLlm.streamChat(role, system, user, ...rest);
                  },
                  embed: (...args: unknown[]) => (origLlm as Record<string, unknown> & { embed(...a: unknown[]): unknown }).embed(...args),
                  probeConnections: (...args: unknown[]) => (origLlm as Record<string, unknown> & { probeConnections(...a: unknown[]): unknown }).probeConnections(...args),
                },
              };
            })()
          : options.deps;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const patch = await edge.node.run(before, nodeDeps as any);
        const after = mergePatch(before, patch);
        const diff = diffState(before, after);
        state = after;
        nodesExecuted += 1;
        options.recorder.recordNode({
          workflow: workflow.name,
          runId,
          nodeName: edge.node.name,
          nodeKind: edge.node.kind,
          startedAt: nodeStart,
          durationMs: Date.now() - nodeStart,
          status: "ok",
          reads: edge.node.reads,
          writes: edge.node.writes,
          inputs: pickKeys(before, edge.node.reads),
          patch,
          diff,
          promptChars: nodePromptChars,
        });
        options.logger?.info("pipeline.node.ok", {
          workflow: workflow.name,
          run_id: runId,
          slug,
          node: edge.node.name,
          kind: edge.node.kind,
          duration_ms: Date.now() - nodeStart,
          writes: edge.node.writes.join(",") || "(none)",
          state_hash: hashValue(after),
        });
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        options.recorder.recordNode({
          workflow: workflow.name,
          runId,
          nodeName: edge.node.name,
          nodeKind: edge.node.kind,
          startedAt: nodeStart,
          durationMs: Date.now() - nodeStart,
          status: "error",
          reads: edge.node.reads,
          writes: edge.node.writes,
          inputs: pickKeys(before, edge.node.reads),
          error: { message: wrapped.message, stack: wrapped.stack },
          promptChars: nodePromptChars,
        });
        options.logger?.error("pipeline.node.error", {
          workflow: workflow.name,
          run_id: runId,
          slug,
          node: edge.node.name,
          error: wrapped.message,
        });
        error = wrapped;
        status = "error";
        break;
      }
    }
  } finally {
    const durationMs = Date.now() - startedAt;
    options.recorder.recordRun({
      workflow: workflow.name,
      runId,
      requestId,
      slug,
      startedAt,
      durationMs,
      status,
      nodesExecuted,
      error: error
        ? { message: error.message, stack: error.stack }
        : undefined,
    });
    options.logger?.info("pipeline.run.done", {
      workflow: workflow.name,
      run_id: runId,
      status,
      nodes: nodesExecuted,
      duration_ms: durationMs,
    });
  }

  return {
    state,
    runId,
    durationMs: Date.now() - startedAt,
    nodesExecuted,
    status,
    error,
  };
}

function mergePatch(
  state: PipelineState,
  patch: PipelineStatePatch,
): PipelineState {
  return { ...state, ...patch };
}

function pickKeys(
  state: PipelineState,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = (state as Record<string, unknown>)[key];
  }
  return out;
}
