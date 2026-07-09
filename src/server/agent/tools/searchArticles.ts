import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { toLegacyView } from "../../rag";
import type { AgentToolContext } from "./context";

/** Semantic search + RRF ranking over the article corpus. Returns a condensed,
 *  ranked list — never raw retrieval evidence — so the agent's context stays
 *  small. Uses a synthetic target slug since research queries aren't scoped
 *  to one article (mirrors the admin RAG tester's `adminRoutes.ts` pattern). */
export function createSearchArticlesTool(ctx: AgentToolContext) {
  return tool(
    async ({ query }: { query: string }) => {
      ctx.onToolCall?.("search_articles", { query });
      const result = await ctx.rag.retrieve({
        targetSlug: "agent-research",
        queryText: query,
        profile: "reference_search",
      });
      const view = toLegacyView(result);
      if (view.sourceArticles.length === 0) {
        return "No matching articles found in the corpus.";
      }
      return view.sourceArticles
        .slice(0, 10)
        .map(
          (a) =>
            `- ${a.title} (slug: ${a.slug}, score: ${(a.score ?? 0).toFixed(2)}): ${a.summary}`,
        )
        .join("\n");
    },
    {
      name: "search_articles",
      description:
        "Ranked semantic search over the wiki corpus. Returns matching articles with title, slug, relevance score, and a one-line summary.",
      schema: z.object({
        query: z.string().describe("The research question or topic to search for."),
      }),
    },
  );
}
