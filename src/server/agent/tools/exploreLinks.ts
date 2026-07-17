import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getArticleByLookup, listOutboundLinks, listWrittenBacklinks } from "../../db";
import type { AgentToolContext } from "./context";

const DEFAULT_OUTBOUND_LIMIT = 15;
const DEFAULT_BACKLINK_LIMIT = 15;

/** Walks the wiki's link graph around one article — the "rabbithole" tool.
 *  Semantic search finds articles *about* a topic; this finds the ones the
 *  canon itself has explicitly wired together. Outbound links (including
 *  not-yet-written targets, the richest unexpanded threads, each with the
 *  hidden hint recorded at link time) plus the written articles that link back
 *  in. Read-only, and every written neighbour is recorded as a reference
 *  candidate so following a thread still credits its sources. */
export function createExploreLinksTool(ctx: AgentToolContext) {
  return tool(
    ({ slug }: { slug: string }) => {
      ctx.onToolCall?.("explore_links", { slug });
      const article = getArticleByLookup(ctx.db, slug);
      if (!article) return `No article found for slug "${slug}".`;

      const outbound = listOutboundLinks(ctx.db, article.slug, DEFAULT_OUTBOUND_LIMIT);
      const backlinks = listWrittenBacklinks(ctx.db, article.slug, DEFAULT_BACKLINK_LIMIT);

      // Written neighbours are real reference candidates — record them so a
      // thread the agent follows still shows up in the deterministic sources.
      for (const link of outbound) {
        if (link.exists) {
          ctx.onArticleSeen?.({ slug: link.targetSlug, title: link.targetTitle, via: "link" });
        }
      }
      for (const back of backlinks) {
        ctx.onArticleSeen?.({ slug: back.slug, title: back.title, via: "link" });
      }

      if (outbound.length === 0 && backlinks.length === 0) {
        return `"${article.title}" has no recorded links in either direction yet.`;
      }

      const lines = [`# ${article.title} — linked articles`];
      if (outbound.length) {
        lines.push("", "Links out to:");
        for (const link of outbound) {
          const status = link.exists ? "" : " [not yet written — an unexpanded canon thread]";
          const hint = link.hint ? ` — ${link.hint}` : "";
          lines.push(`- ${link.targetTitle} (slug: ${link.targetSlug})${status}${hint}`);
        }
      }
      if (backlinks.length) {
        lines.push("", "Linked to from:");
        for (const back of backlinks) {
          lines.push(`- ${back.title} (slug: ${back.slug})`);
        }
      }
      return lines.join("\n");
    },
    {
      name: "explore_links",
      description:
        "Walk the wiki's link graph around one article, by slug — the articles the " +
        "canon explicitly connects, which semantic search won't surface. Returns its " +
        "outbound links (including not-yet-written targets, the best unexpanded threads, " +
        "each with a hint) and the written articles that link back in. Use it to follow " +
        "related threads and rabbitholes out from a relevant hit.",
      schema: z.object({
        slug: z.string().describe("The slug of the article whose links to explore."),
      }),
    },
  );
}
