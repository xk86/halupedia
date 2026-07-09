/**
 * Chat orchestrator agent: the article Q&A chatbot's entry point. It does
 * NOT call retrieval tools directly — its one substantive tool, `research`,
 * delegates to the research subagent (`researchSubagent.ts`) and gets back a
 * condensed brief. The orchestrator only ever sees that brief, so its own
 * context stays small regardless of how much the subagent had to retrieve.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type { DatabaseSync } from "node:sqlite";
import type { LlmRouter } from "../llm";
import type { RagRuntime } from "../rag";
import type { TraceRecorder } from "../pipeline/runtime/trace";
import { HalupediaChatModel, type ChatLlmRole } from "./HalupediaChatModel";
import { createReadArticleTool } from "./tools/readArticle";
import { runResearchSubagent, renderBriefForTranscript, type ResearchBriefReference } from "./researchSubagent";
import { beginAgentRun } from "./trace";
import type { ChatMessageInput, ChatStreamEvent } from "./types";

export interface ChatAgentDeps {
  llmRouter: LlmRouter;
  db: DatabaseSync;
  rag: RagRuntime;
  chatSystemPrompt: string;
  researchSystemPrompt: string;
  chatRole: ChatLlmRole;
  researchRole: ChatLlmRole;
  chatRecursionLimit: number;
  researchRecursionLimit: number;
  recorder: TraceRecorder;
  requestId: string;
  slug?: string;
  onEvent?: (event: ChatStreamEvent) => void;
}

export interface ChatTurnResult {
  answer: string;
  references: ResearchBriefReference[];
  runId: string;
}

const STREAM_SYSTEM_SUFFIX = `
You have just finished researching the user's question. Write your final
conversational answer to them now — a few sentences to a short paragraph,
grounded only in the research transcript below. Cite articles with
[Title](ref:slug) links from the transcript. If nothing relevant was found,
say so plainly.`;

export async function runChatTurn(
  messages: ChatMessageInput[],
  deps: ChatAgentDeps,
): Promise<ChatTurnResult> {
  const chatHandle = beginAgentRun({
    recorder: deps.recorder,
    workflow: "agent.chat",
    requestId: deps.requestId,
    slug: deps.slug,
    origin: "http",
  });

  let lastReferences: ResearchBriefReference[] = [];

  const researchTool = tool(
    async ({ query }: { query: string }) => {
      deps.onEvent?.({ type: "research", query });
      const childHandle = beginAgentRun({
        recorder: deps.recorder,
        workflow: "agent.research",
        requestId: deps.requestId,
        slug: deps.slug,
        parentRunId: chatHandle.runId,
        origin: "agent_tool",
      });
      try {
        const brief = await runResearchSubagent({
          query,
          llmRouter: deps.llmRouter,
          toolCtx: {
            db: deps.db,
            rag: deps.rag,
            onToolCall: (name, args) =>
              deps.onEvent?.({ type: "research_step", tool: name, args }),
          },
          systemPrompt: deps.researchSystemPrompt,
          role: deps.researchRole,
          recursionLimit: deps.researchRecursionLimit,
          onLlmCall: (call) => childHandle.onLlmCall(call),
        });
        childHandle.finish("ok");
        lastReferences = brief.references;
        return renderBriefForTranscript(brief);
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        childHandle.finish("error", wrapped);
        throw wrapped;
      }
    },
    {
      name: "research",
      description:
        "Run a focused research pass over the wiki corpus and return a brief (summary, key facts, ranked references). Call this for any question that needs wiki knowledge.",
      schema: z.object({
        query: z.string().describe("A focused research question or topic."),
      }),
    },
  );

  const readArticleTool = createReadArticleTool({ db: deps.db, rag: deps.rag });

  const model = new HalupediaChatModel({
    llmRouter: deps.llmRouter,
    role: deps.chatRole,
    systemPrompt: deps.chatSystemPrompt,
    onLlmCall: (call) => chatHandle.onLlmCall(call),
  });

  const history: BaseMessage[] = messages.map((m) =>
    m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content),
  );

  try {
    const agent = createReactAgent({
      llm: model,
      tools: [researchTool, readArticleTool],
    });
    const result = await agent.invoke(
      { messages: history },
      { recursionLimit: deps.chatRecursionLimit },
    );
    const transcript = result.messages
      .slice(history.length)
      .map((m) => {
        const kind = m.getType();
        const text = typeof m.content === "string" ? m.content : "";
        if (kind === "tool") return `Research result: ${text}`;
        if (kind === "ai") return text ? `Draft answer: ${text}` : "";
        return "";
      })
      .filter(Boolean)
      .join("\n\n");

    const streamSystem = `${deps.chatSystemPrompt}\n${STREAM_SYSTEM_SUFFIX}`;
    const lastUserMessage = messages.at(-1)?.content ?? "";
    const streamUser = `User's question: ${lastUserMessage}\n\nResearch transcript:\n${transcript || "(no research was needed)"}`;

    let answer = "";
    const startedAt = Date.now();
    await deps.llmRouter.streamChat(
      deps.chatRole,
      streamSystem,
      streamUser,
      (delta, accumulated) => {
        answer = accumulated;
        deps.onEvent?.({ type: "token", delta });
      },
    );
    chatHandle.onLlmCall({
      role: deps.chatRole,
      system: streamSystem,
      user: streamUser,
      response: answer,
      durationMs: Date.now() - startedAt,
    });

    chatHandle.finish("ok");
    deps.onEvent?.({ type: "done", references: lastReferences });
    return { answer, references: lastReferences, runId: chatHandle.runId };
  } catch (err) {
    // Reported to the caller via the "error" event (and the trace row) —
    // deliberately not rethrown, so the NDJSON route doesn't have to guard
    // against a double error report.
    const wrapped = err instanceof Error ? err : new Error(String(err));
    chatHandle.finish("error", wrapped);
    deps.onEvent?.({ type: "error", message: wrapped.message });
    return { answer: "", references: [], runId: chatHandle.runId };
  }
}
