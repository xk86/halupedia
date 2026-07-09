/**
 * Research subagent: given a focused question, loops search → rank → read →
 * refine over the read-only retrieval tools and returns a condensed,
 * structured brief. This is the reusable research primitive — the chat
 * orchestrator's `research` tool spawns it, and it's the same primitive the
 * (future, feature-flagged) agentic article-generation work will reuse to
 * produce a canon/history-informed outline brief.
 */
import { HumanMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type { LlmRouter } from "../llm";
import { HalupediaChatModel, type AgentLlmCallTrace, type ChatLlmRole } from "./HalupediaChatModel";
import { createResearchTools, type AgentToolContext } from "./tools";
import { renderTranscript } from "./protocol";
import { runAgentLoop } from "./runAgentLoop";

export interface ResearchBriefReference {
  slug: string;
  title: string;
  relevance?: string;
}

export interface ResearchBrief {
  summary: string;
  references: ResearchBriefReference[];
  keyFacts?: string[];
}

export interface RunResearchSubagentArgs {
  query: string;
  llmRouter: LlmRouter;
  toolCtx: AgentToolContext;
  /** Resolved (shared-tone-expanded) system prompt from agent_research.toml. */
  systemPrompt: string;
  role: ChatLlmRole;
  recursionLimit: number;
  onLlmCall?: (call: AgentLlmCallTrace) => void;
}

const CONDENSE_SYSTEM_PROMPT = `You convert a research subagent's tool-call transcript into a strict JSON
brief. Ground every field only in what the transcript actually retrieved —
never add references or facts that weren't found. If the transcript found
nothing relevant, return an empty references array and say so in the summary.`;

const RESEARCH_BRIEF_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    references: {
      type: "array",
      items: {
        type: "object",
        properties: {
          slug: { type: "string" },
          title: { type: "string" },
          relevance: { type: "string" },
        },
        required: ["slug", "title"],
      },
    },
    keyFacts: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "references"],
};

export async function runResearchSubagent(
  args: RunResearchSubagentArgs,
): Promise<ResearchBrief> {
  const tools = createResearchTools(args.toolCtx);
  const model = new HalupediaChatModel({
    llmRouter: args.llmRouter,
    role: args.role,
    systemPrompt: args.systemPrompt,
    onLlmCall: args.onLlmCall,
  });
  const agent = createReactAgent({ llm: model, tools });
  const { messages, hitRecursionLimit } = await runAgentLoop(
    agent,
    { messages: [new HumanMessage(args.query)] },
    args.recursionLimit,
  );
  const transcript = renderTranscript(messages);

  const condenseUser = `Research question: ${args.query}\n\nSubagent transcript:\n${transcript}${
    hitRecursionLimit
      ? "\n\n(The subagent ran out of turns before concluding on its own — condense whatever was actually retrieved above; do not treat the cutoff itself as a finding.)"
      : ""
  }`;
  const startedAt = Date.now();
  const raw = await args.llmRouter.chat(
    args.role,
    CONDENSE_SYSTEM_PROMPT,
    condenseUser,
    { jsonSchema: RESEARCH_BRIEF_JSON_SCHEMA },
  );
  args.onLlmCall?.({
    role: args.role,
    system: CONDENSE_SYSTEM_PROMPT,
    user: condenseUser,
    response: raw,
    durationMs: Date.now() - startedAt,
  });

  return parseBrief(raw);
}

/** Strips a stray leading markdown heading marker (e.g. "# Bingus" -> "Bingus")
 *  — the condensing model sometimes copies the "# Title" line verbatim out of
 *  `read_article`'s rendered output into a reference's title field. */
function stripHeadingMarker(text: string): string {
  return text.replace(/^#+\s*/, "").trim();
}

export function parseBrief(raw: string): ResearchBrief {
  try {
    const parsed = JSON.parse(raw) as Partial<ResearchBrief>;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      references: Array.isArray(parsed.references)
        ? parsed.references
            .filter(
              (r): r is ResearchBriefReference =>
                !!r && typeof r.slug === "string" && typeof r.title === "string",
            )
            .map((r) => ({ ...r, title: stripHeadingMarker(r.title) }))
        : [],
      keyFacts: Array.isArray(parsed.keyFacts)
        ? parsed.keyFacts.filter((f): f is string => typeof f === "string")
        : undefined,
    };
  } catch {
    return { summary: raw.trim(), references: [] };
  }
}

/** Render a brief as tool-call content for the chat orchestrator's
 *  transcript — condensed, never the raw retrieval evidence. */
export function renderBriefForTranscript(brief: ResearchBrief): string {
  // Field labels deliberately avoid words like "Summary"/"Source" that a model
  // pattern-matching this transcript could mistake for a citation marker and
  // echo verbatim as a bogus "[Summary]"-style bracket in its own answer.
  const lines = [brief.summary];
  if (brief.keyFacts?.length) {
    lines.push("Additional details found:", ...brief.keyFacts.map((f) => `- ${f}`));
  }
  if (brief.references.length) {
    lines.push(
      "References:",
      ...brief.references.map(
        (r) => `- ${r.title} (ref:${r.slug})${r.relevance ? `: ${r.relevance}` : ""}`,
      ),
    );
  } else {
    lines.push("References: (none found)");
  }
  return lines.join("\n");
}
