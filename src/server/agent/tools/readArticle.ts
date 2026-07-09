import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getArticleByLookup } from "../../db";
import { listArticleSections, sectionSlice } from "../../markdown";
import type { AgentToolContext } from "./context";

/** A specific article's summary and heading outline (or one section's text),
 *  never the full body — keeps the research subagent's transcript small. */
export function createReadArticleTool(ctx: AgentToolContext) {
  return tool(
    ({ slug, section }: { slug: string; section?: string }) => {
      ctx.onToolCall?.("read_article", { slug, section });
      const article = getArticleByLookup(ctx.db, slug);
      if (!article) return `No article found for slug "${slug}".`;
      const sections = listArticleSections(article.markdown);
      if (section) {
        const match = sections.find(
          (s) => s.id === section || s.title.toLowerCase() === section.toLowerCase(),
        );
        if (!match) {
          return `Section "${section}" not found in "${article.title}". Available sections: ${sections.map((s) => s.title).join(", ") || "(none)"}`;
        }
        return `# ${article.title} — ${match.title}\n\n${sectionSlice(article.markdown, match.title)}`;
      }
      const summary =
        article.summaryMarkdown?.trim() || "(no summary available)";
      const outline = sections.map((s) => `## ${s.title}`).join("\n") || "(no sections)";
      return `# ${article.title}\n\nSummary: ${summary}\n\nOutline:\n${outline}`;
    },
    {
      name: "read_article",
      description:
        "Read a specific article's summary and heading outline by slug. Pass `section` to read one section's full text instead.",
      schema: z.object({
        slug: z.string().describe("The article's slug."),
        section: z
          .string()
          .optional()
          .describe("Optional section id or heading title to read in full."),
      }),
    },
  );
}
