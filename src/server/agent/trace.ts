/**
 * Tracing harness for the LangGraph agents.
 *
 * The agents don't run through the static-DAG pipeline runtime
 * (`src/server/pipeline/runtime/graph.ts`) — LangGraph owns the loop — but
 * they reuse the exact same `TraceRecorder` / `LiveRunRegistry` primitives
 * the pipeline uses, so every agent run shows up in the admin traces view
 * with full per-turn prompt/response visibility, and nested runs (the chat
 * orchestrator spawning the research subagent) get the same parent/child
 * linkage as `article.generate` spawning `article.post_process`.
 *
 * This mirrors the pattern already used for out-of-band traced work in
 * `src/server/index.ts`'s `onOntologyExtracted` callback: call
 * `recorder.recordRun`/`recordNode` directly rather than going through
 * `runWorkflow`, since there's no `PipelineState` here to declare
 * reads/writes against.
 */
import { randomUUID } from "node:crypto";
import { getLiveRunRegistry } from "../pipeline/runtime/liveRegistry";
import type { TraceRecorder } from "../pipeline/runtime/trace";
import type { AgentLlmCallTrace } from "./HalupediaChatModel";

export interface AgentRunOptions {
  recorder: TraceRecorder;
  /** e.g. "agent.chat" | "agent.research". */
  workflow: string;
  requestId: string;
  slug?: string;
  title?: string;
  parentRunId?: string;
  origin?: string;
}

export interface AgentRunHandle {
  runId: string;
  /** Call once per underlying LLM turn — records a `pipeline_nodes` row
   *  immediately so the run is inspectable mid-flight, and pushes a live
   *  update for the admin dashboard. */
  onLlmCall(call: AgentLlmCallTrace): void;
  /** Terminal transition — always call exactly once, even on error. */
  finish(status: "ok" | "error", error?: Error): void;
}

export function beginAgentRun(opts: AgentRunOptions): AgentRunHandle {
  const registry = getLiveRunRegistry();
  const runId = randomUUID();
  const queuedAt = Date.now();
  let turn = 0;

  registry.beginRun({
    runId,
    workflow: opts.workflow,
    slug: opts.slug,
    title: opts.title,
    parentRunId: opts.parentRunId,
    origin: opts.origin,
    queuedAt,
  });
  opts.recorder.recordRunPending({
    workflow: opts.workflow,
    runId,
    requestId: opts.requestId,
    slug: opts.slug,
    queuedAt,
    parentRunId: opts.parentRunId,
    origin: opts.origin,
  });
  registry.markStarted(runId);
  opts.recorder.recordRunStarted(runId, Date.now());

  return {
    runId,
    onLlmCall(call) {
      turn += 1;
      const nodeName = `${opts.workflow}.turn_${turn}`;
      const promptText = `### System\n${call.system}\n\n### User\n${call.user}`;
      registry.setPhase(runId, nodeName);
      registry.recordLlmUpdate(runId, { node: nodeName, response: call.response });
      opts.recorder.recordNode({
        workflow: opts.workflow,
        runId,
        nodeName,
        nodeKind: "llm",
        startedAt: Date.now() - call.durationMs,
        durationMs: call.durationMs,
        status: "ok",
        reads: [],
        writes: [],
        promptChars: promptText.length,
        promptText,
        responseText: call.response,
        llmRole: call.role,
        llmCalls: [
          {
            promptChars: promptText.length,
            prompt: promptText,
            cot: "",
            response: call.response,
            role: call.role,
          },
        ],
      });
    },
    finish(status, error) {
      opts.recorder.recordRun({
        workflow: opts.workflow,
        runId,
        requestId: opts.requestId,
        slug: opts.slug,
        startedAt: queuedAt,
        durationMs: Date.now() - queuedAt,
        status,
        nodesExecuted: turn,
        error: error ? { message: error.message, stack: error.stack } : undefined,
        queuedAt,
        parentRunId: opts.parentRunId,
        origin: opts.origin,
      });
      registry.done(runId);
    },
  };
}
