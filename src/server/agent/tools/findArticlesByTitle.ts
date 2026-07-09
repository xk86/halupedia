import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { searchCorpus } from "../../db";
import type { AgentToolContext } from "./context";

/** Lexical title/slug lookup — for disambiguating which article a name
 *  refers to before pulling in semantic search results. */
export function createFindArticlesByTitleTool(ctx: AgentToolContext) {
  return tool(
    ({ query }: { query: string }) => {
      ctx.onToolCall?.("find_articles_by_title", { query });
      const { results } = searchCorpus(ctx.db, query, 10);
      const existing = results.filter((r) => r.existsFlag);
      if (existing.length === 0) {
        return `No articles found matching "${query}".`;
      }
      return existing
        .map((r) => `- ${r.title} (slug: ${r.slug})`)
        .join("\n");
    },
    {
      name: "find_articles_by_title",
      description:
        "Lexical title/slug search — use to disambiguate which article a name refers to.",
      schema: z.object({
        query: z.string().describe("A title or partial title to look up."),
      }),
    },
  );
}
