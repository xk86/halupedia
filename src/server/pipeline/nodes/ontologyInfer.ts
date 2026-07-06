import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps } from "../deps";
import { getArticle } from "../../db";
import { slugify } from "../../slug";
import { prepared } from "../../db";
import {
  deriveLlmExtraction,
  ensureArticleOntologyFresh,
  listArticleEntityFacts,
} from "../../ontology";

export const ontologyInferLlmNode = defineNode({
  name: "ontology.llm.infer",
  kind: "llm",
  description:
    "Call the light LLM to extract entities and relations from the article, " +
    "busting the extraction cache so a fresh model call always happens.",
  reads: ["input"] as const,
  writes: ["ontologyExtraction"] as const,
  async run({ input }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    if (!slug) return {};
    const article = getArticle(deps.db, slug);
    if (!article) return {};

    const vocab = deps.rag?.vocab;
    if (!vocab) return {};

    ensureArticleOntologyFresh(deps.db, slug, vocab);

    prepared(deps.db, `DELETE FROM ontology_llm_cache WHERE article_slug = ?`).run(slug);

    const outcome = await deriveLlmExtraction(deps.db, vocab, article, {
      llm: deps.llm,
      prompts: deps.runtime.prompts,
      logger: deps.logger,
    });

    const { facts: existing } = listArticleEntityFacts(deps.db, slug);
    const existingKeys = new Set(existing.map((f) => `${f.predicate}\0${f.object}`));

    const proposed = outcome.extraction.relations
      .filter((r) => r.predicate !== "is_a")
      .map((r) => ({
        predicate: r.predicate,
        label: vocab.predicates.get(r.predicate)?.label ?? r.predicate.replace(/_/g, " "),
        object: r.object,
        source: r.source,
        isNew: !existingKeys.has(`${r.predicate}\0${r.object}`),
      }));

    let raw: Array<{ predicate: string; label: string; object: string; source: string; isNew: boolean }> = [];
    if (proposed.filter((p) => p.isNew).length === 0 && outcome.rawParsed) {
      const parsed = outcome.rawParsed as Record<string, unknown>;
      const rawRelations = Array.isArray(parsed.relations) ? parsed.relations : [];
      raw = rawRelations
        .filter((r: any) => r && typeof r === "object" && r.predicate !== "is_a")
        .map((r: any) => ({
          predicate: String(r.predicate ?? ""),
          label: String(r.predicate ?? "").replace(/_/g, " "),
          object: String(r.object ?? ""),
          source: "llm",
          isNew: !existingKeys.has(`${r.predicate}\0${r.object}`),
        }))
        .filter((r: any) => r.predicate && r.object && r.isNew);
    }

    return {
      ontologyExtraction: {
        entities: outcome.extraction.entities.length,
        relations: outcome.extraction.relations.length,
        categories: outcome.extraction.categories.length,
        llmEnabled: true,
        llmReason: outcome.reason,
        extraction: outcome.extraction,
        proposed,
        raw,
        called: outcome.called,
      },
    };
  },
});
