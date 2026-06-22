/**
 * Build compact `ontology_fact` RAG documents from stored typed relations.
 *
 * These are high-precision, deterministic, provenance-backed facts — far smaller
 * than prose chunks. One consolidated doc summarizes the article's entity; one
 * doc per relation supports precise fact retrieval and citation.
 */
import type { DatabaseSync } from "node:sqlite";
import { contentHash } from "../rag/documents";
import type { RagTextDocument } from "../rag/types";
import { listArticleEntityFacts } from "./store";

const MAX_RELATION_DOCS = 60;

function humanizePredicate(predicate: string): string {
  return predicate.replace(/_/g, " ");
}

export function buildOntologyFactDocuments(
  db: DatabaseSync,
  slug: string,
  title: string,
  updatedAt: number,
): RagTextDocument[] {
  const { entity, facts, identifiers, categories } = listArticleEntityFacts(db, slug);
  if (!entity) return [];

  const docs: RagTextDocument[] = [];
  const parts = [`type: ${entity.entityType}`];
  for (const id of identifiers) parts.push(`${id.scheme}: ${id.value}`);
  for (const fact of facts) parts.push(`${humanizePredicate(fact.predicate)}: ${fact.object}`);
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
    const content = `${title} ${humanizePredicate(fact.predicate)} ${fact.object}`;
    docs.push({
      documentId: `ontology_fact:${slug}:rel:${fact.relationId}`,
      articleSlug: slug,
      sourceKind: "ontology_fact",
      sourceId: `${slug}:rel:${fact.relationId}`,
      content,
      contentHash: contentHash(content),
      sourceUpdatedAt: updatedAt,
      metadata: { predicate: fact.predicate, object: fact.object },
    });
  }
  return docs;
}
