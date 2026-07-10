import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { buildEvidenceContext } from "../../rag";
import type { AgentToolContext } from "./context";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const DEFAULT_FACTS_PER_RESULT = 3;

/** Semantic search + RRF ranking over the article corpus, with structured
 *  ontology facts pulled in automatically alongside each result — so the
 *  agent sees a hit's world/canon data on the first pass, without a separate
 *  `get_ontology_facts` call for every article it finds. Returns a condensed,
 *  ranked list — never raw retrieval evidence — so the agent's context stays
 *  small. Uses a synthetic target slug since research queries aren't scoped
 *  to one article (mirrors the admin RAG tester's `adminRoutes.ts` pattern). */
export function createSearchArticlesTool(ctx: AgentToolContext) {
  const defaultLimit = ctx.toolConfig?.searchDefaultLimit ?? DEFAULT_LIMIT;
  const maxLimit = ctx.toolConfig?.searchMaxLimit ?? MAX_LIMIT;
  const factsPerResult = ctx.toolConfig?.searchOntologyFactsPerResult ?? DEFAULT_FACTS_PER_RESULT;
  return tool(
    async ({
      query,
      limit,
      minScore,
    }: {
      query: string;
      limit?: number;
      minScore?: number;
    }) => {
      // Clamped in code rather than enforced purely via the zod schema: a
      // hallucinated out-of-range value (e.g. limit: 999) would otherwise
      // fail schema validation and waste the whole tool call instead of just
      // being capped.
      const topK = Math.min(Math.max(Math.trunc(limit ?? defaultLimit), 1), maxLimit);
      const clampedMinScore =
        minScore != null ? Math.min(Math.max(minScore, 0), 1) : undefined;
      ctx.onToolCall?.("search_articles", {
        query,
        limit: topK,
        ...(clampedMinScore != null ? { minScore: clampedMinScore } : {}),
      });
      const result = await ctx.rag.retrieve({
        targetSlug: "agent-research",
        queryText: query,
        profile: "reference_search",
        topK,
        ...(clampedMinScore != null ? { minScore: clampedMinScore } : {}),
      });
      const evidence = buildEvidenceContext(result);
      if (evidence.articles.length === 0) {
        return "No matching articles found in the corpus.";
      }

      for (const a of evidence.articles) {
        ctx.onArticleSeen?.({
          slug: a.slug,
          title: a.title,
          via: "search",
          score: a.score ?? undefined,
          relevance: a.summary,
        });
      }
      // Ontology facts are already grouped and ranked per article; take this
      // tool's own (typically tighter) display cap on top of the canonical
      // ontology_facts_per_retrieved_article cap already applied upstream.
      return evidence.articles
        .map((a) => {
          const facts = a.ontologyFacts.slice(0, factsPerResult).map((f) => f.content.trim());
          const factsLine = facts.length ? `\n  Facts: ${facts.join("; ")}` : "";
          return `- ${a.title} (slug: ${a.slug}, score: ${(a.score ?? 0).toFixed(2)}): ${a.summary}${factsLine}`;
        })
        .join("\n");
    },
    {
      name: "search_articles",
      description:
        `Ranked semantic search over the wiki corpus, with structured ontology facts ` +
        `auto-included per result when available — no separate ontology lookup needed ` +
        `for hits this already covers. Returns title, slug, relevance score, a one-line ` +
        `summary, and any known facts for each match. Defaults to ${defaultLimit} results; ` +
        `pass \`limit\` (up to ${maxLimit}) if you need a broader sweep, or \`minScore\` ` +
        `(0-1 cosine similarity) to filter out weak matches when the corpus is noisy.`,
      schema: z.object({
        query: z.string().describe("The research question or topic to search for."),
        // Bounds are enforced in code (clamped), not in the schema itself —
        // an out-of-range value from a hallucinating model gets capped
        // instead of failing the whole tool call on schema validation.
        limit: z
          .number()
          .int()
          .optional()
          .describe(`Max results to return (default ${defaultLimit}, max ${maxLimit}).`),
        minScore: z
          .number()
          .optional()
          .describe(
            "Minimum relevance score (0-1) to keep a result — raise this to cut out weak/noisy matches.",
          ),
      }),
    },
  );
}
