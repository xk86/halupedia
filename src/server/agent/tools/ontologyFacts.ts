import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { listArticleEntityFacts } from "../../ontology/store";
import type { AgentToolContext } from "./context";

/** Structured fact triples for an article's entity — the symbolic-canon
 *  counterpart to prose search. Facts are dense and cheap relative to prose,
 *  so the cap here is a generous top-K (how many to return), never a top-P
 *  score cutoff — every fact already carries its own confidence in the
 *  output so the agent can weigh borderline ones itself. */
const DEFAULT_FACTS_MAX = 50;

export function createGetOntologyFactsTool(ctx: AgentToolContext) {
  const factsMax = ctx.toolConfig?.ontologyFactsMax ?? DEFAULT_FACTS_MAX;
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
        .slice(0, factsMax)
        .map((f) => `- [confidence ${f.confidence.toFixed(2)}] ${entity.canonicalName} ${f.predicate} ${f.object}`);
      return `${entity.canonicalName} (${entity.entityType}) — ${lines.length} fact(s):\n${lines.join("\n")}`;
    },
    {
      name: "get_ontology_facts",
      description:
        `Full structured fact triples (subject-predicate-object) recorded for an article's ` +
        `entity, by slug, up to ${factsMax} of them — each tagged with its own confidence score ` +
        `rather than pre-filtered by one, so weigh low-confidence facts yourself. search_articles ` +
        `already inlines a batch of facts per hit; call this when you need an entity's complete ` +
        `fact list beyond that.`,
      schema: z.object({
        slug: z.string().describe("The article's slug."),
      }),
    },
  );
}
