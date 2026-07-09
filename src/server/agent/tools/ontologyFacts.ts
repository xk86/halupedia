import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { listArticleEntityFacts } from "../../ontology/store";
import type { AgentToolContext } from "./context";

/** Structured fact triples for an article's entity — the symbolic-canon
 *  counterpart to prose search. */
export function createGetOntologyFactsTool(ctx: AgentToolContext) {
  return tool(
    ({ slug }: { slug: string }) => {
      ctx.onToolCall?.("get_ontology_facts", { slug });
      const { entity, facts } = listArticleEntityFacts(ctx.db, slug);
      if (!entity) return `No structured facts recorded for slug "${slug}".`;
      ctx.onArticleSeen?.({ slug, title: entity.canonicalName, via: "facts" });
      if (facts.length === 0) {
        return `${entity.canonicalName} (${entity.entityType}): no relations recorded.`;
      }
      const lines = facts
        .slice(0, 25)
        .map((f) => `- ${entity.canonicalName} ${f.predicate} ${f.object}`);
      return `${entity.canonicalName} (${entity.entityType}):\n${lines.join("\n")}`;
    },
    {
      name: "get_ontology_facts",
      description:
        "Structured fact triples (subject-predicate-object) recorded for an article's entity, by slug.",
      schema: z.object({
        slug: z.string().describe("The article's slug."),
      }),
    },
  );
}
