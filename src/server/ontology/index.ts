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
import { inferRelations } from "./infer";
import { deriveLlmExtraction, type OntologyLlmOptions } from "./llmExtract";
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
export {
  deriveLlmExtraction,
  type OntologyLlmOptions,
  type LlmExtractionOutcome,
  type LlmExtractionReason,
} from "./llmExtract";
export { inferRelations } from "./infer";

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
  // Derive provable inferred relations (symmetric/inverse/transitive) from the
  // asserted set and append them before persisting.
  merged.relations.push(...inferRelations(args.vocab, merged.relations));
  reconcileArticleOntology(db, args.slug, args.revisionId ?? null, merged);
  return merged;
}

export { emptyExtraction };

/**
 * Build the job processor's `extraDocuments` provider: on each article reindex,
 * (re)run deterministic ontology extraction from the current infobox and emit
 * `ontology_fact` documents for embedding.
 *
 * When `llmOptions` is supplied, a cached light-model pass over the article
 * prose is merged in as well (see `deriveLlmExtraction`); without it the
 * provider is deterministic-only (the shape used by tests and offline rebuilds).
 */
export function createOntologyDocumentProvider(
  db: DatabaseSync,
  vocab: OntologyVocabulary,
  llmOptions?: OntologyLlmOptions,
): (slug: string, updatedAt: number) => Promise<RagTextDocument[]> {
  return async (slug, updatedAt) => {
    const article = getArticle(db, slug);
    if (!article) return [];
    const title = article.displayTitle || article.title;
    const infobox = getArticleInfobox(db, slug);
    const llmExtraction = llmOptions
      ? (await deriveLlmExtraction(db, vocab, article, llmOptions)).extraction
      : undefined;
    indexArticleOntology(db, { slug, title, infobox, vocab, llmExtraction });
    return buildOntologyFactDocuments(db, slug, title, updatedAt, vocab);
  };
}
