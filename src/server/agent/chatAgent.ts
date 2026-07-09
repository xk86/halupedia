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
import { getArticleByEquivalentLookup } from "../db";
import type { LlmRouter } from "../llm";
import type { RagRuntime } from "../rag";
import type { TraceRecorder } from "../pipeline/runtime/trace";
import type { ReferenceList } from "../types";
import { resolveRefLinks, resolveBareBracketsToRefs } from "../referenceList";
import { stripSelfLinks, renderMarkdown } from "../markdown";
import { HalupediaChatModel, type ChatLlmRole } from "./HalupediaChatModel";
import { createReadArticleTool } from "./tools/readArticle";
import type { AgentToolConfig } from "./tools/context";
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
  toolConfig?: AgentToolConfig;
  recorder: TraceRecorder;
  requestId: string;
  slug?: string;
  onEvent?: (event: ChatStreamEvent) => void;
}

export interface ChatTurnResult {
  answer: string;
  /** Final answer with citations resolved to real /wiki/ links, pre-rendered
   *  to HTML server-side via the same pipeline article bodies use. */
  html: string;
  references: ResearchBriefReference[];
  runId: string;
}

const STREAM_SYSTEM_SUFFIX = `
You have just finished researching the user's question. Write your final
conversational answer to them now — a few sentences to a short paragraph,
grounded only in the research below and consistent with the rest of the
conversation. Cite articles only as real markdown links, [Title](ref:slug),
using the article's real title (never its slug) as the bracket text, and the
slug from the reference list verbatim as the target — never write a bracketed
citation marker that isn't a real link (no "[Summary]", "[Source]", footnote
numbers, or similar; if you're not making a link, don't use brackets).

Weave each citation into the sentence that actually discusses that article, at
the point where you first name it — never save citations up and tack them onto
the end of the answer, and never append a link to an unrelated word just to
fit it in somewhere. A citation should read as a normal part of the sentence
grammar, not a trailing appendage. If nothing relevant was found, say so
plainly in your own words.`;

/** Unwraps a citation whose closing paren the model never wrote — e.g.
 *  "[Text](ref:slug, more prose..." — which produces markdown no parser can
 *  match (the shared link parser, `text/markdownLinkParser.ts`, requires a
 *  balanced closing paren for both its strict and lenient scans, same as
 *  CommonMark). This is a genuine gap in that shared parser, not a citation
 *  shape it already handles — everything else (well-formed [Title](ref:slug)
 *  links, bare [Title] brackets, and bracket-less "Title (ref:slug)" markers)
 *  goes through the real parser via `resolveRefLinks` / `resolveBareBracketsToRefs`
 *  / `renderMarkdown` below, not a hand-rolled regex.
 *
 *  Detected by the telltale comma immediately after the ref/halu slug with no
 *  closing ")" first — a well-formed citation's parenthetical is never
 *  followed by a bare comma. Unwraps to the plain label so the sentence still
 *  reads, dropping only the broken markup; a properly closed link later in
 *  the same sentence is untouched. */
export function unwrapUnclosedCitations(text: string): string {
  return text.replace(/\[([^\]]+)\]\((?:ref|halu):[a-z0-9-]+,/gi, "$1,");
}

/** Builds the lightweight `ReferenceList` shape the shared link-resolution
 *  helpers (`resolveRefLinks`, `resolveBareBracketsToRefs`) expect, from the
 *  chat turn's deterministically-collected references. The extra fields they
 *  require beyond slug/title (content, kind, pinned, revisionId) are inert
 *  for chat's purposes — chat never assembles a persisted reference list,
 *  it just needs slug→title resolution. */
function toReferenceList(refs: ResearchBriefReference[]): ReferenceList {
  return refs.map((r) => ({
    slug: r.slug,
    title: r.title,
    content: "",
    kind: "summary",
    pinned: false,
    revisionId: "current",
  }));
}

/** Resolves a chat answer's citations into final HTML, reusing the exact
 *  same deterministic link-resolution pipeline article bodies go through
 *  (`resolveRefLinks` / `resolveBareBracketsToRefs` / `stripSelfLinks` /
 *  `renderMarkdown` — see `src/server/referenceList.ts` and
 *  `src/server/markdown.ts`) rather than reimplementing citation parsing —
 *  every malformed shape those functions already cover (raw-slug link text,
 *  bare brackets, bracket-less "Title (ref:slug)" markers) is handled there,
 *  not here. */
export function renderChatAnswer(
  rawAnswer: string,
  references: ResearchBriefReference[],
  selfSlug?: string,
): string {
  const refList = toReferenceList(references);
  let resolved = unwrapUnclosedCitations(rawAnswer);
  resolved = resolveRefLinks(resolved, refList);
  resolved = resolveBareBracketsToRefs(resolved, refList);
  if (selfSlug) resolved = stripSelfLinks(resolved, selfSlug);
  return renderMarkdown(resolved);
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
            toolConfig: deps.toolConfig,
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
    // Exclude the article the user is already reading from citable references —
    // linking it back to itself at the end of an answer about it reads as a
    // redundant non sequitur (the exact "tacked-on" citation bug this guards
    // against), and the model can just say "this article" instead.
    // deps.slug arrives in the client's URL/wiki-segment form (e.g.
    // "Advanced_testing_procedures"), not the DB's canonical lowercase-hyphen
    // slug — getArticleByEquivalentLookup normalizes case/separators/aliases
    // to find it regardless of which form was passed.
    const currentArticle = deps.slug ? getArticleByEquivalentLookup(deps.db, deps.slug) : null;
    const references = collector
      .references()
      .filter((r) => r.slug !== currentArticle?.slug);
    const streamSystem = `${deps.chatSystemPrompt}\n${STREAM_SYSTEM_SUFFIX}`;
    const conversationText = messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");
    const referenceListText = references.length
      ? references.map((r) => `- ${r.title} (ref:${r.slug})`).join("\n")
      : "(none)";
    const currentArticleLine = currentArticle
      ? `\n\nThe user is currently reading the article "${currentArticle.title}" — don't cite it back at itself, just refer to it as "this article" if relevant.`
      : "";
    const streamUser = `Conversation so far:\n${conversationText}\n\nResearch for the latest question:\n${transcript || "(no research was needed)"}\n\nReferences available to cite (only these, only as [Title](ref:slug)):\n${referenceListText}${currentArticleLine}${
      hitRecursionLimit
        ? "\n\n(Research was cut short before fully concluding — answer from what's above, and briefly note the answer may be incomplete rather than mentioning any error or limit.)"
        : ""
    }`;

    // Stream raw deltas as they arrive for live visual feedback — citation
    // syntax may look like a plain, non-navigating link for the ~1s the
    // answer is still in flight. Once the stream settles, the full answer is
    // resolved through the real link-resolution pipeline (see
    // `renderChatAnswer`) and sent as pre-rendered HTML in the "done" event,
    // which is what the client actually displays for a settled message.
    const startedAt = Date.now();
    const { content: rawAnswer } = await deps.llmRouter.streamChat(
      deps.chatRole,
      streamSystem,
      streamUser,
      (delta) => {
        if (delta) deps.onEvent?.({ type: "token", delta });
      },
    );
    const answer = unwrapUnclosedCitations(rawAnswer).trim();
    const html = renderChatAnswer(rawAnswer, references, currentArticle?.slug);
    chatHandle.onLlmCall({
      role: deps.chatRole,
      system: streamSystem,
      user: streamUser,
      response: answer,
      durationMs: Date.now() - startedAt,
    });

    chatHandle.finish("ok");
    deps.onEvent?.({ type: "done", references, html });
    return { answer, html, references, runId: chatHandle.runId };
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
    const fallbackHtml = renderChatAnswer(fallbackAnswer, []);
    deps.onEvent?.({ type: "token", delta: fallbackAnswer });
    deps.onEvent?.({ type: "done", references: [], html: fallbackHtml });
    return { answer: fallbackAnswer, html: fallbackHtml, references: [], runId: chatHandle.runId };
  }
}
