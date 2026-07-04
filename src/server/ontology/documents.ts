/**
 * Build compact `ontology_fact` RAG documents from stored typed relations.
 *
 * These are high-precision, deterministic, provenance-backed facts — far smaller
 * than prose chunks. One consolidated doc summarizes the article's entity; one
 * doc per relation supports precise fact retrieval and citation. When an object
 * links to another article it is emitted as a proper `[Title](ref:slug)` link.
 */
import type { DatabaseSync } from "node:sqlite";
import { contentHash } from "../rag/documents";
import type { RagTextDocument } from "../rag/types";
import { buildRefLink } from "../text/links/haluLinks";
import { listArticleEntityFacts, type ArticleOntologyFact } from "./store";
import type { OntologyVocabulary } from "./vocabulary";

const MAX_RELATION_DOCS = 60;

/** Human phrase for a predicate ("was founded by"), from the vocabulary. */
function predicateLabel(vocab: OntologyVocabulary, predicate: string): string {
  return vocab.predicates.get(predicate)?.label ?? predicate.replace(/_/g, " ");
}

/** Render a fact's object, wrapping it as a ref-link when it owns an article. */
function renderObject(fact: ArticleOntologyFact): string {
  return fact.objectSlug ? buildRefLink(fact.object, fact.objectSlug) : fact.object;
}

export function buildOntologyFactDocuments(
  db: DatabaseSync,
  slug: string,
  title: string,
  updatedAt: number,
  vocab: OntologyVocabulary,
): RagTextDocument[] {
  const { entity, facts, identifiers, categories } = listArticleEntityFacts(db, slug);
  if (!entity) return [];

  const docs: RagTextDocument[] = [];
  const parts = [`type: ${entity.entityType}`];
  for (const id of identifiers) parts.push(`${id.scheme}: ${id.value}`);
  for (const fact of facts) {
    // `type:` above already conveys the is_a class; don't repeat it here.
    if (fact.predicate === "is_a") continue;
    parts.push(`${predicateLabel(vocab, fact.predicate)}: ${renderObject(fact)}`);
  }
  if (categories.length) parts.push(`categories: ${categories.join(", ")}`);

  const consolidated = `${title} — ${parts.join("; ")}`;
  docs.push({
    documentId: `ontology_fact:${slug}:entity`,
    articleSlug: slug,
    sourceKind: "ontology_fact",
    sourceId: `${slug}:entity`,
    content: consolidated,
    contentHash: contentHash(consolidated),
    sourceUpdatedAt: updatedAt,
    metadata: { entityType: entity.entityType, identifiers, categories },
  });

  for (const fact of facts.slice(0, MAX_RELATION_DOCS)) {
    const content = `${title} ${predicateLabel(vocab, fact.predicate)} ${renderObject(fact)}`;
    docs.push({
      documentId: `ontology_fact:${slug}:rel:${fact.relationId}`,
      articleSlug: slug,
      sourceKind: "ontology_fact",
      sourceId: `${slug}:rel:${fact.relationId}`,
      content,
      contentHash: contentHash(content),
      sourceUpdatedAt: updatedAt,
      metadata: {
        predicate: fact.predicate,
        object: fact.object,
        objectSlug: fact.objectSlug ?? undefined,
        source: fact.source,
        confidence: fact.confidence,
        inferredFrom: fact.inferredFrom ?? undefined,
      },
    });
  }
  return docs;
}
