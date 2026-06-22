/**
 * Ontology subsystem public surface + orchestration.
 *
 * `indexArticleOntology` is the single entry point used by the indexing job /
 * lifecycle hooks: it runs deterministic infobox extraction, optionally merges a
 * pre-validated LLM extraction, and persists with the curation pin policy.
 */
import type { DatabaseSync } from "node:sqlite";
import { getArticle, getArticleInfobox, type InfoboxData } from "../db";
import type { RagTextDocument } from "../rag/types";
import { buildOntologyFactDocuments } from "./documents";
import { extractDeterministic, mergeExtractions } from "./extract";
import { reconcileArticleOntology } from "./store";
import { emptyExtraction, type ExtractionResult } from "./types";
import type { OntologyVocabulary } from "./vocabulary";

export * from "./types";
export * from "./vocabulary";
export {
  extractDeterministic,
  validateLlmExtraction,
  mergeExtractions,
} from "./extract";
export {
  reconcileArticleOntology,
  listArticleEntityFacts,
  deleteArticleOntology,
  findEntityId,
  upsertEntity,
} from "./store";
export { buildOntologyFactDocuments } from "./documents";

export interface IndexArticleOntologyArgs {
  slug: string;
  title: string;
  infobox: InfoboxData | null;
  vocab: OntologyVocabulary;
  revisionId?: number | null;
  /** Optional already-validated LLM extraction to merge with deterministic. */
  llmExtraction?: ExtractionResult;
}

export function indexArticleOntology(db: DatabaseSync, args: IndexArticleOntologyArgs): ExtractionResult {
  const deterministic = extractDeterministic({
    slug: args.slug,
    title: args.title,
    infobox: args.infobox,
    vocab: args.vocab,
  });
  const merged = args.llmExtraction
    ? mergeExtractions(deterministic, args.llmExtraction)
    : deterministic;
  reconcileArticleOntology(db, args.slug, args.revisionId ?? null, merged);
  return merged;
}

export { emptyExtraction };

/**
 * Build the job processor's `extraDocuments` provider: on each article reindex,
 * (re)run deterministic ontology extraction from the current infobox and emit
 * `ontology_fact` documents for embedding. LLM extraction is layered in by the
 * hook caller via `indexArticleOntology({ llmExtraction })` ahead of time.
 */
export function createOntologyDocumentProvider(
  db: DatabaseSync,
  vocab: OntologyVocabulary,
): (slug: string, updatedAt: number) => RagTextDocument[] {
  return (slug, updatedAt) => {
    const article = getArticle(db, slug);
    if (!article) return [];
    const title = article.displayTitle || article.title;
    const infobox = getArticleInfobox(db, slug);
    indexArticleOntology(db, { slug, title, infobox, vocab });
    return buildOntologyFactDocuments(db, slug, title, updatedAt);
  };
}
