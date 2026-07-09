/**
 * POST /api/chat — the article Q&A chatbot's streaming entry point.
 *
 * Server is stateless (matches every other route): the client re-sends the
 * full message history each turn. Response is NDJSON — the same
 * `ReadableStream` + `x-accel-buffering: no` convention used by the article
 * live-sidecar stream (`src/server/index.ts`'s `/api/article/:slug/live`).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Hono } from "hono";
import { buildPromptRegistry } from "../pipeline/prompts/registry";
import type { TraceRecorder } from "../pipeline/runtime/trace";
import type { LlmRouter } from "../llm";
import type { RagRuntime } from "../rag";
import type { AgentConfig, PromptConfig } from "../types";
import { runChatTurn } from "./chatAgent";
import type { ChatMessageInput, ChatStreamEvent } from "./types";

export interface AgentRouteDeps {
  db: DatabaseSync;
  rag: RagRuntime;
  llm: LlmRouter;
  promptConfig: PromptConfig;
  recorder: TraceRecorder;
  agentConfig: AgentConfig;
}

export function registerAgentRoutes(
  app: Hono,
  getDeps: () => AgentRouteDeps,
): void {
  app.post("/api/chat", async (c) => {
    const deps = getDeps();
    if (!deps.agentConfig.enabled) {
      return c.json({ error: "chat agent is disabled" }, 503);
    }

    let body: { messages?: unknown; slug?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const messages = parseMessages(body.messages);
    if (messages.length === 0 || messages.at(-1)?.role !== "user") {
      return c.json(
        { error: "messages must be non-empty and end with a user turn" },
        400,
      );
    }

    const prompts = buildPromptRegistry(deps.promptConfig);
    const chatSystemPrompt = prompts.get("agent_chat").resolved.system;
    const researchSystemPrompt = prompts.get("agent_research").resolved.system;

    const enc = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: ChatStreamEvent) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`${JSON.stringify(event)}\n`));
          } catch {
            closed = true;
          }
        };
        try {
          await runChatTurn(messages, {
            llmRouter: deps.llm,
            db: deps.db,
            rag: deps.rag,
            chatSystemPrompt,
            researchSystemPrompt,
            chatRole: deps.agentConfig.chat_role,
            researchRole: deps.agentConfig.research_role,
            chatRecursionLimit: deps.agentConfig.chat_recursion_limit,
            researchRecursionLimit: deps.agentConfig.research_recursion_limit,
            toolConfig: {
              searchDefaultLimit: deps.agentConfig.search_default_limit,
              searchMaxLimit: deps.agentConfig.search_max_limit,
              searchOntologyFactsPerResult: deps.agentConfig.search_ontology_facts_per_result,
              ontologyFactsMax: deps.agentConfig.ontology_facts_max,
            },
            recorder: deps.recorder,
            requestId: randomUUID(),
            slug: typeof body.slug === "string" ? body.slug : undefined,
            onEvent: send,
          });
        } catch (err) {
          send({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed by a failed enqueue above
          }
        }
      },
      cancel() {
        closed = true;
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  });
}

function parseMessages(raw: unknown): ChatMessageInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is ChatMessageInput =>
      !!m &&
      typeof m === "object" &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string",
  );
}

