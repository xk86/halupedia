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
import { ReferenceCollector } from "./references";
import { beginAgentRun } from "./trace";
import { runAgentLoop } from "./runAgentLoop";
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
grounded only in the research below and consistent with the rest of the
conversation. Cite articles only as real markdown links, [Title](ref:slug),
using a slug/title from the reference list verbatim — never write a bracketed
citation marker that isn't a real link (no "[Summary]", "[Source]", footnote
numbers, or similar; if you're not making a link, don't use brackets). If
nothing relevant was found, say so plainly in your own words.`;

/** Strips bracket-citation artifacts a model sometimes mimics from the
 *  research transcript's own field labels (e.g. writing "[Summary]" as if it
 *  were a footnote) — a safety net behind the prompt's explicit prohibition.
 *  Only removes brackets that aren't followed by "(" (i.e. not a real
 *  markdown link), so genuine [Title](ref:slug)/[Title](halu:slug) links are
 *  untouched. */
export function sanitizeCitations(text: string): string {
  return text
    .replace(/\s?\[(?:Summary|Sources?|References?|Citations?|Footnote|Note)\](?!\()/gi, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}

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

  // References are collected deterministically from every tool that touches an
  // article — across all research passes AND the orchestrator's own
  // read_article — so the "Sources" chips reflect exactly what the agent
  // pulled in, with real slugs/titles for correct linking.
  const collector = new ReferenceCollector();

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
            onArticleSeen: (article) => collector.add(article),
          },
          systemPrompt: deps.researchSystemPrompt,
          role: deps.researchRole,
          recursionLimit: deps.researchRecursionLimit,
          onLlmCall: (call) => childHandle.onLlmCall(call),
        });
        childHandle.finish("ok");
        deps.onEvent?.({ type: "research_trace", query, entries: brief.trace });
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

  const readArticleTool = createReadArticleTool({
    db: deps.db,
    rag: deps.rag,
    onArticleSeen: (article) => collector.add(article),
  });

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
    const { messages: finalMessages, hitRecursionLimit } = await runAgentLoop(
      agent,
      { messages: history },
      deps.chatRecursionLimit,
    );
    const transcript = finalMessages
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

    // Even when the loop was cut off before it reached its own stop condition
    // (GraphRecursionError inside runAgentLoop), we still always answer —
    // just from whatever research actually completed, rather than surfacing
    // the recursion-limit error to the user.
    //
    // The full conversation (not just the latest question) goes into this
    // prompt too — the tool loop above sees it already (for deciding whether
    // to research), but this separate synthesis call is what actually
    // produces the visible prose, and it needs the same context to stay
    // coherent across turns.
    const references = collector.references();
    const streamSystem = `${deps.chatSystemPrompt}\n${STREAM_SYSTEM_SUFFIX}`;
    const conversationText = messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");
    const referenceListText = references.length
      ? references.map((r) => `- ${r.title} (ref:${r.slug})`).join("\n")
      : "(none)";
    const streamUser = `Conversation so far:\n${conversationText}\n\nResearch for the latest question:\n${transcript || "(no research was needed)"}\n\nReferences available to cite (only these, only as [Title](ref:slug)):\n${referenceListText}${
      hitRecursionLimit
        ? "\n\n(Research was cut short before fully concluding — answer from what's above, and briefly note the answer may be incomplete rather than mentioning any error or limit.)"
        : ""
    }`;

    // Stream progressively-sanitized text: recompute the cleaned prefix on
    // every chunk and only emit the newly-revealed tail, so a bracket
    // artifact that gets stripped once its closing "]" arrives never reaches
    // the client even though the model emitted it token-by-token.
    let rawAnswer = "";
    let sentLength = 0;
    const startedAt = Date.now();
    await deps.llmRouter.streamChat(
      deps.chatRole,
      streamSystem,
      streamUser,
      (_delta, accumulated) => {
        rawAnswer = accumulated;
        const sanitized = sanitizeCitations(rawAnswer);
        if (sanitized.length > sentLength) {
          deps.onEvent?.({ type: "token", delta: sanitized.slice(sentLength) });
          sentLength = sanitized.length;
        }
      },
    );
    const answer = sanitizeCitations(rawAnswer);
    chatHandle.onLlmCall({
      role: deps.chatRole,
      system: streamSystem,
      user: streamUser,
      response: answer,
      durationMs: Date.now() - startedAt,
    });

    chatHandle.finish("ok");
    deps.onEvent?.({ type: "done", references });
    return { answer, references, runId: chatHandle.runId };
  } catch (err) {
    // Even a genuinely unexpected failure (not just a recursion-limit
    // cutoff, which runAgentLoop already handles) should still leave the
    // user with a real, in-character response rather than a bare error —
    // the trace row below still records the failure for observability.
    const wrapped = err instanceof Error ? err : new Error(String(err));
    chatHandle.finish("error", wrapped);
    const lastUserMessage = messages.at(-1)?.content ?? "";
    let fallbackAnswer: string;
    try {
      fallbackAnswer = await deps.llmRouter.chat(
        deps.chatRole,
        deps.chatSystemPrompt,
        `The user asked: "${lastUserMessage}"\n\nResearching this hit an unexpected problem, so you have no findings to draw on. Reply briefly, in character, that you can't answer that right now and suggest trying again or rephrasing — do not mention errors, tools, or anything technical.`,
      );
    } catch {
      fallbackAnswer = "I can't answer that right now — please try again.";
    }
    deps.onEvent?.({ type: "token", delta: fallbackAnswer });
    deps.onEvent?.({ type: "done", references: [] });
    return { answer: fallbackAnswer, references: [], runId: chatHandle.runId };
  }
}
