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
import type { LlmInvocationMetadata } from "../../types";
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

// Wall-clock time (Date.now) can jump backward under NTP/clock corrections,
// which produced negative node and run durations in pipeline traces. Measure
// every *elapsed* duration with a monotonic clock instead; Date.now() is kept
// only for the displayed start timestamps (which must stay wall-clock).
const monoNow = (): number => performance.now();
const elapsedMs = (startMono: number): number =>
  Math.max(0, Math.round(monoNow() - startMono));

/** Optional skip predicate — if it returns false, the node is skipped. */
export type SkipPredicate<Deps> = (state: PipelineState, deps: Deps) => boolean;

export interface WorkflowEdge<Deps> {
  node: CompiledNode<Deps>;
  /** Node is skipped when this returns false. */
  when?: SkipPredicate<Deps>;
  /**
   * Nodes to run concurrently with `node`. All nodes in this group (including
   * `node` itself) start with the same input state and their patches are merged
   * once all complete. Use only when the nodes write disjoint state keys and
   * use different model tiers so they don't contend on the same LLM pool.
   */
  parallel?: CompiledNode<Deps>[];
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
  const startedAtMono = monoNow();
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
      if (edge.when && !edge.when(state, options.deps)) {
        options.logger?.debug("pipeline.node.skip", {
          workflow: workflow.name,
          run_id: runId,
          node: edge.node.name,
        });
        continue;
      }

      const parallelNodes = edge.parallel ? [edge.node, ...edge.parallel] : null;

      if (parallelNodes) {
        // Run all nodes in the parallel group concurrently against the same
        // input state; merge their patches once all complete.
        const groupStartMono = monoNow();
        const before = state;
        const results = await Promise.all(
          parallelNodes.map(async (node) => {
            options.onNode?.(node.name, node.kind);
            const nodeStart = Date.now();
            const nodeStartMono = monoNow();
            let llmCapture: LlmCapture | undefined;
            const nodeDeps = wrapLlmDeps(options.deps, (cap) => { llmCapture = cap; }, {
              workflow: workflow.name,
              slug: before.input.slug,
              title: before.input.requestedTitle,
              node: node.name,
            });
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const patch = await node.run(before, nodeDeps as any);
              const diff = diffState(before, mergePatch(before, patch));
              options.recorder.recordNode({
                workflow: workflow.name,
                runId,
                nodeName: node.name,
                nodeKind: node.kind,
                startedAt: nodeStart,
                durationMs: elapsedMs(nodeStartMono),
                status: "ok",
                reads: node.reads,
                writes: node.writes,
                inputs: pickKeys(before, node.reads),
                patch,
                diff,
                promptChars: llmCapture?.promptChars,
                promptText: llmCapture?.prompt,
                cotText: llmCapture?.cot,
                responseText: llmCapture?.response,
                llmRole: llmCapture?.role,
                llmResolvedRole: llmCapture?.resolvedRole,
                llmConfigKey: llmCapture?.configKey,
                llmModel: llmCapture?.model,
                llmBaseUrl: llmCapture?.baseUrl,
                llmHost: llmCapture?.host,
                llmTemperature: llmCapture?.temperature,
                llmMaxTokens: llmCapture?.maxTokens,
                llmTopK: llmCapture?.topK,
                llmTopP: llmCapture?.topP,
                llmMinP: llmCapture?.minP,
                llmThinking: llmCapture?.thinking,
                llmJsonMode: llmCapture?.jsonMode,
                llmImageCount: llmCapture?.imageCount,
                llmTtftMs: llmCapture?.ttftMs,
              });
              options.logger?.info("pipeline.node.ok", {
                workflow: workflow.name,
                run_id: runId,
                slug,
                node: node.name,
                kind: node.kind,
                duration_ms: elapsedMs(nodeStartMono),
                writes: node.writes.join(",") || "(none)",
              });
              return { patch, error: undefined };
            } catch (err) {
              const wrapped = err instanceof Error ? err : new Error(String(err));
              options.recorder.recordNode({
                workflow: workflow.name,
                runId,
                nodeName: node.name,
                nodeKind: node.kind,
                startedAt: nodeStart,
                durationMs: elapsedMs(nodeStartMono),
                status: "error",
                reads: node.reads,
                writes: node.writes,
                inputs: pickKeys(before, node.reads),
                error: { message: wrapped.message, stack: wrapped.stack },
                promptChars: llmCapture?.promptChars,
                promptText: llmCapture?.prompt,
                cotText: llmCapture?.cot,
                responseText: llmCapture?.response,
                llmRole: llmCapture?.role,
                llmResolvedRole: llmCapture?.resolvedRole,
                llmConfigKey: llmCapture?.configKey,
                llmModel: llmCapture?.model,
                llmBaseUrl: llmCapture?.baseUrl,
                llmHost: llmCapture?.host,
                llmTemperature: llmCapture?.temperature,
                llmMaxTokens: llmCapture?.maxTokens,
                llmTopK: llmCapture?.topK,
                llmTopP: llmCapture?.topP,
                llmMinP: llmCapture?.minP,
                llmThinking: llmCapture?.thinking,
                llmJsonMode: llmCapture?.jsonMode,
                llmImageCount: llmCapture?.imageCount,
                llmTtftMs: llmCapture?.ttftMs,
              });
              options.logger?.error("pipeline.node.error", {
                workflow: workflow.name,
                run_id: runId,
                slug,
                node: node.name,
                error: wrapped.message,
              });
              return { patch: {} as PipelineStatePatch, error: wrapped };
            }
          }),
        );

        // Merge patches in declaration order; first error wins.
        let combined = before;
        for (const r of results) {
          combined = mergePatch(combined, r.patch);
          if (r.error && !error) { error = r.error; status = "error"; }
        }
        state = combined;
        nodesExecuted += parallelNodes.length;
        options.logger?.info("pipeline.parallel.ok", {
          workflow: workflow.name,
          run_id: runId,
          slug,
          nodes: parallelNodes.map((n) => n.name).join(","),
          duration_ms: elapsedMs(groupStartMono),
        });
        if (error) break;
        continue;
      }

      // ── serial node ──────────────────────────────────────────────────────────
      const nodeStart = Date.now();
      const nodeStartMono = monoNow();
      options.onNode?.(edge.node.name, edge.node.kind);
      const before = state;
      let llmCapture: LlmCapture | undefined;
      const nodeDeps = wrapLlmDeps(options.deps, (cap) => { llmCapture = cap; }, {
        workflow: workflow.name,
        slug: before.input.slug,
        title: before.input.requestedTitle,
        node: edge.node.name,
      });
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
          durationMs: elapsedMs(nodeStartMono),
          status: "ok",
          reads: edge.node.reads,
          writes: edge.node.writes,
          inputs: pickKeys(before, edge.node.reads),
          patch,
          diff,
          promptChars: llmCapture?.promptChars,
          promptText: llmCapture?.prompt,
          cotText: llmCapture?.cot,
          responseText: llmCapture?.response,
          llmRole: llmCapture?.role,
          llmResolvedRole: llmCapture?.resolvedRole,
          llmConfigKey: llmCapture?.configKey,
          llmModel: llmCapture?.model,
          llmBaseUrl: llmCapture?.baseUrl,
          llmHost: llmCapture?.host,
          llmTemperature: llmCapture?.temperature,
          llmMaxTokens: llmCapture?.maxTokens,
          llmTopK: llmCapture?.topK,
          llmTopP: llmCapture?.topP,
          llmMinP: llmCapture?.minP,
          llmThinking: llmCapture?.thinking,
          llmJsonMode: llmCapture?.jsonMode,
          llmImageCount: llmCapture?.imageCount,
          llmTtftMs: llmCapture?.ttftMs,
        });
        options.logger?.info("pipeline.node.ok", {
          workflow: workflow.name,
          run_id: runId,
          slug,
          node: edge.node.name,
          kind: edge.node.kind,
          duration_ms: elapsedMs(nodeStartMono),
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
          durationMs: elapsedMs(nodeStartMono),
          status: "error",
          reads: edge.node.reads,
          writes: edge.node.writes,
          inputs: pickKeys(before, edge.node.reads),
          error: { message: wrapped.message, stack: wrapped.stack },
          promptChars: llmCapture?.promptChars,
          promptText: llmCapture?.prompt,
          cotText: llmCapture?.cot,
          responseText: llmCapture?.response,
          llmRole: llmCapture?.role,
          llmResolvedRole: llmCapture?.resolvedRole,
          llmConfigKey: llmCapture?.configKey,
          llmModel: llmCapture?.model,
          llmBaseUrl: llmCapture?.baseUrl,
          llmHost: llmCapture?.host,
          llmTemperature: llmCapture?.temperature,
          llmMaxTokens: llmCapture?.maxTokens,
          llmTopK: llmCapture?.topK,
          llmTopP: llmCapture?.topP,
          llmMinP: llmCapture?.minP,
          llmThinking: llmCapture?.thinking,
          llmJsonMode: llmCapture?.jsonMode,
          llmImageCount: llmCapture?.imageCount,
          llmTtftMs: llmCapture?.ttftMs,
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
    const durationMs = elapsedMs(startedAtMono);
    // Prefer the input slug, but for slug-less workflows (e.g. random.page)
    // fall back to a slug the run produced so the trace row names its target.
    const recordedSlug =
      slug ||
      (state as { randomPageChoice?: { slug?: string } }).randomPageChoice?.slug ||
      state.canonicalSlug ||
      slug;
    options.recorder.recordRun({
      workflow: workflow.name,
      runId,
      requestId,
      slug: recordedSlug,
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
    durationMs: elapsedMs(startedAtMono),
    nodesExecuted,
    status,
    error,
  };
}

/** What the tracer captures from an LLM node's call: the formatted prompt,
 *  the model's chain-of-thought (when the backend separates it), and the
 *  response text. Only the LAST call in a node is kept (covers retries). */
export interface LlmCapture {
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

function formatPromptForTrace(system: unknown, user: unknown): string {
  const sys = typeof system === "string" ? system : "";
  const usr = typeof user === "string" ? user : "";
  return `### System\n${sys}\n\n### User\n${usr}`;
}

function extractEmbeddedReasoning(text: string): string {
  const blocks: string[] = [];
  const pattern = /<(think|thinking|reasoning)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of text.matchAll(pattern)) {
    const body = match[2]?.trim();
    if (body) blocks.push(body);
  }
  return blocks.join("\n\n");
}

function combineReasoning(separated: string, response: string): string {
  const embedded = extractEmbeddedReasoning(response);
  return [separated.trim(), embedded].filter(Boolean).join("\n\n");
}

function fallbackConfigKey(role: unknown): string | undefined {
  if (role === "heavy") return "llm.chat";
  if (role === "light") return "llm.light";
  if (role === "images") return "llm.images";
  return undefined;
}

function wrapLlmDeps<Deps>(
  deps: Deps,
  onCapture: (cap: LlmCapture) => void,
  dispatchContext?: { workflow?: string; slug?: string; title?: string; node?: string },
): Deps {
  const d = deps as Record<string, unknown>;
  if (!d || typeof d !== "object" || typeof d.llm !== "object" || !d.llm) return deps;
  const origLlm = d.llm as Record<string, (...a: unknown[]) => unknown>;
  const onLlmUpdate = typeof d.onLlmUpdate === "function"
    ? d.onLlmUpdate as (update: { workflow?: string; slug?: string; node: string; reasoning?: string; response?: string }) => void
    : undefined;
  const emitLive = (update: { reasoning?: string; response?: string }) => {
    if (!onLlmUpdate || !dispatchContext?.node) return;
    onLlmUpdate({
      workflow: dispatchContext.workflow,
      slug: dispatchContext.slug,
      node: dispatchContext.node,
      ...update,
    });
  };
  // Augment the caller's options at `optsIndex` with an onReasoning hook so the
  // client can hand back chain-of-thought without changing its return contract.
  // chat(role, system, user, options) → options at index 0 of `rest`;
  // streamChat(role, system, user, onChunk, options) → options at index 1.
  const withReasoning = (rest: unknown[], optsIndex: number, onReasoning: (r: string) => void): unknown[] => {
    const args = [...rest];
    const opts = (args[optsIndex] ?? {}) as Record<string, unknown>;
    const previousReasoning = opts.onReasoning;
    const previousReasoningDelta = opts.onReasoningDelta;
    args[optsIndex] = {
      ...opts,
      onReasoning: (reasoning: string) => {
        onReasoning(reasoning);
        if (typeof previousReasoning === "function") previousReasoning(reasoning);
        emitLive({ reasoning });
      },
      onReasoningDelta: (delta: string, accumulated: string) => {
        onReasoning(accumulated);
        if (typeof previousReasoningDelta === "function") previousReasoningDelta(delta, accumulated);
        emitLive({ reasoning: accumulated });
      },
      dispatchContext,
    };
    return args;
  };
  const charsOf = (system: unknown, user: unknown) =>
    (typeof system === "string" ? system.length : 0) + (typeof user === "string" ? user.length : 0);
  // Proxy: forwards every call, intercepting chat/streamChat to capture the
  // prompt, reasoning, and response for the trace.
  const wrappedLlm = new Proxy(origLlm, {
    get(target, prop) {
      // Build the metadata-bearing capture once; reused on both the success
      // path and the error path (so a failed/interrupted call still records the
      // prompt + whatever partial output the model produced before dying).
      const captureWith = (
        role: unknown,
        system: unknown,
        user: unknown,
        options: { thinking?: boolean; jsonMode?: boolean; images?: unknown[] },
        cot: string,
        response: string,
        ttftMs?: number,
      ) => {
        const metadata: LlmInvocationMetadata | undefined =
          typeof target.metadataFor === "function" &&
          (role === "heavy" || role === "light" || role === "images")
            ? target.metadataFor(role) as LlmInvocationMetadata
            : undefined;
        onCapture({
          promptChars: charsOf(system, user),
          prompt: formatPromptForTrace(system, user),
          cot: combineReasoning(cot, response),
          response,
          role: String(role),
          resolvedRole: metadata?.resolvedRole,
          configKey: metadata?.configKey ?? fallbackConfigKey(role),
          model: metadata?.model,
          baseUrl: metadata?.baseUrl,
          host: metadata?.host,
          temperature: metadata?.temperature,
          maxTokens: metadata?.maxTokens,
          topK: metadata?.topK,
          topP: metadata?.topP,
          minP: metadata?.minP,
          thinking: options.thinking === true,
          jsonMode: options.jsonMode === true,
          imageCount: Array.isArray(options.images) ? options.images.length : 0,
          ttftMs,
        });
      };
      if (prop === "chat") {
        return async (role: unknown, system: unknown, user: unknown, ...rest: unknown[]) => {
          let cot = "";
          const args = withReasoning(rest, 0, (r) => { cot = r; });
          const options = (args[0] ?? {}) as { thinking?: boolean; jsonMode?: boolean; images?: unknown[] };
          try {
            const response = (await target.chat(role, system, user, ...args)) as string;
            if (typeof response === "string") emitLive({ response });
            captureWith(role, system, user, options, cot, typeof response === "string" ? response : "");
            return response;
          } catch (err) {
            const partial = (err as { partialContent?: string }).partialContent ?? "";
            const partialCot = (err as { partialReasoning?: string }).partialReasoning ?? "";
            if (partial) emitLive({ response: partial });
            captureWith(role, system, user, options, cot || partialCot, partial);
            throw err;
          }
        };
      }
      if (prop === "streamChat") {
        return async (role: unknown, system: unknown, user: unknown, ...rest: unknown[]) => {
          let cot = "";
          const streamStartedMono = monoNow();
          let ttftMs: number | undefined;
          const args = withReasoning(rest, 1, (r) => { cot = r; });
          const onChunk = args[0];
          if (typeof onChunk === "function") {
            args[0] = (delta: unknown, accumulated: unknown) => {
              if (ttftMs === undefined) ttftMs = elapsedMs(streamStartedMono);
              if (typeof accumulated === "string") emitLive({ response: accumulated });
              return onChunk(delta, accumulated);
            };
          }
          const options = (args[1] ?? {}) as { thinking?: boolean; jsonMode?: boolean; images?: unknown[] };
          try {
            const result = (await target.streamChat(role, system, user, ...args)) as { content?: string; ttftMs?: number };
            captureWith(
              role,
              system,
              user,
              options,
              cot,
              typeof result?.content === "string" ? result.content : "",
              result?.ttftMs ?? ttftMs,
            );
            return result;
          } catch (err) {
            // Interrupted stream: llm.streamChat attaches what it received.
            const partial = (err as { partialContent?: string }).partialContent ?? "";
            const partialCot = (err as { partialReasoning?: string }).partialReasoning ?? "";
            if (partial) emitLive({ response: partial });
            captureWith(role, system, user, options, cot || partialCot, partial, ttftMs);
            throw err;
          }
        };
      }
      const val = Reflect.get(target, prop, target);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
  return { ...d, llm: wrappedLlm } as Deps;
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
