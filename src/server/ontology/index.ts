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
import { extractDeterministic, mergeExtractions, mergeOntologyExtractions } from "./extract";
import { inferRelations } from "./infer";
import { deriveLlmExtraction, type OntologyLlmOptions } from "./llmExtract";
import { getArticleEntityId, getArticleOntologySignature, reconcileArticleOntology, setArticleOntologySignature } from "./store";
import { emptyExtraction, type ExtractionResult } from "./types";
import type { OntologyVocabulary } from "./vocabulary";

export * from "./types";
export * from "./vocabulary";
export { extractDeterministic, validateLlmExtraction, mergeExtractions, mergeOntologyExtractions } from "./extract";
export { reconcileArticleOntology, listArticleEntityFacts, deleteArticleOntology, findEntityId, upsertEntity, resolveArticleSlugByName, getArticleOntologySignature, setArticleOntologySignature, getArticleEntityId, updateArticleEntityType, addCuratedFact, deleteCuratedFact, suppressFact, updateFact, relationKey, type ArticleOntologyFact, type CuratedFactInput, type FactUpdateInput } from "./store";
export { buildOntologyFactDocuments } from "./documents";
export { deriveLlmExtraction, type OntologyLlmOptions, type LlmExtractionOutcome, type LlmExtractionReason, type OntologyExtractionCallInfo } from "./llmExtract";
export { inferRelations } from "./infer";
export { getPredicateUsageStats, getUnmappedLabelStats, getVocabularyReviewStats, runOntologyVocabularyReview, sanitizePredicateAddition, sanitizePredicateRemoval, type PredicateUsage, type UnmappedLabelUsage, type VocabularyReviewStats, type PredicateAdditionProposal, type PredicateRemovalProposal, type VocabularyReviewProposals, type OntologyVocabularyReviewOptions } from "./vocabularyReview";
export { appendPredicates, removePredicates } from "./vocabularyToml";
export { applyOntologySuggestions, deleteOntologySuggestions, setOntologySuggestionsStatus, listOntologySuggestions, updateOntologySuggestionObject, listPendingOntologySuggestionsByArticle, replaceOntologyTypeSuggestion, getOntologyTypeSuggestion, deleteOntologyTypeSuggestion, setOntologyTypeSuggestionStatus, type ArticleOntologySuggestionGroup, type OntologySuggestion, type OntologySuggestionStatus, type OntologyTypeSuggestion } from "./suggestions";
export { buildOntologyGraphPayload, type EntityTypeSummary, type OntologyGraphCoverage, type OntologyGraphNode, type OntologyGraphPayload, type OntologyGraphRelation, type PredicateSummary } from "./graph";
export { countActiveReviews, enqueueReviewTasks, claimNextReview, completeReview, failReview, listReviewQueue, recoverStaleReviews, flushReviewQueue, type ReviewQueueItem, type ReviewQueueStatus, type ReviewResult } from "./reviewQueue";
export { countActiveExtractions, enqueueExtractionTasks, claimNextExtraction, completeExtraction, failExtraction, listExtractQueue, recoverStaleExtractions, flushExtractQueue, type ExtractQueueItem, type ExtractQueueStatus } from "./extractQueue";
export { reviewArticleSuggestions, type OntologyReviewOptions, type OntologyReviewResult, type OntologyReviewItemResult, type OntologyReviewTypeResult, type OntologyReviewCallInfo, type ReviewVerdict } from "./reviewer";

export interface IndexArticleOntologyArgs {
  slug: string;
  title: string;
  infobox: InfoboxData | null;
  vocab: OntologyVocabulary;
  revisionId?: number | null;
  /** Optional already-validated LLM extraction to merge with deterministic. */
  llmExtraction?: ExtractionResult;
  mergeMode?: "append" | "replace-covered";
}

export function indexArticleOntology(db: DatabaseSync, args: IndexArticleOntologyArgs): ExtractionResult {
  const deterministic = extractDeterministic({
    slug: args.slug,
    title: args.title,
    infobox: args.infobox,
    vocab: args.vocab,
  });
  const merged = args.llmExtraction ? (args.mergeMode === "replace-covered" ? mergeOntologyExtractions(deterministic, args.llmExtraction) : mergeExtractions(deterministic, args.llmExtraction)) : deterministic;
  // Derive provable inferred relations (symmetric/inverse/transitive) from the
  // asserted set and append them before persisting.
  merged.relations.push(...inferRelations(args.vocab, merged.relations));
  reconcileArticleOntology(db, args.slug, args.revisionId ?? null, merged);
  setArticleOntologySignature(db, args.slug, args.vocab.signature);
  return merged;
}

/** True when an article was never extracted, was extracted under a vocabulary
 *  whose extraction-shaping signature has since changed, or has lost the entity
 *  row its whole ontology hangs off.
 *
 *  That last case looks fresh by signature alone but is really empty: the
 *  article renders no ontology box, and any pending suggestion can never be
 *  merged (there is no subject entity to attach it to). Treating it as stale is
 *  what gets the entity rebuilt instead of leaving the article stuck. */
export function isArticleOntologyStale(db: DatabaseSync, slug: string, vocab: OntologyVocabulary): boolean {
  if (getArticleOntologySignature(db, slug) !== vocab.signature) return true;
  // Only meaningful for a slug that actually has an article — object slugs of
  // relations are checked through here too, and a redlink has no entity by
  // definition (and nothing to re-extract from).
  return getArticle(db, slug) !== null && getArticleEntityId(db, slug) === null;
}

/**
 * Bring an article's ontology up to the current vocabulary *deterministically*,
 * in-process, when it is stale. This runs only the infobox extractor — no model
 * call — so it is cheap and safe to await inside a request without coupling to
 * any LLM timeout. The heavier embedding + LLM-pass catch-up is left to a
 * background reindex job the caller should enqueue when this returns true.
 *
 * Returns whether a re-extraction actually happened.
 */
export function ensureArticleOntologyFresh(db: DatabaseSync, slug: string, vocab: OntologyVocabulary): boolean {
  if (!isArticleOntologyStale(db, slug, vocab)) return false;
  const article = getArticle(db, slug);
  if (!article) return false;
  const title = article.displayTitle || article.title;
  const infobox = getArticleInfobox(db, slug);
  indexArticleOntology(db, { slug, title, infobox, vocab });
  return true;
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
export function createOntologyDocumentProvider(db: DatabaseSync, vocab: OntologyVocabulary, llmOptions?: OntologyLlmOptions): (slug: string, updatedAt: number) => Promise<RagTextDocument[]> {
  return async (slug, updatedAt) => {
    const article = getArticle(db, slug);
    if (!article) return [];
    const title = article.displayTitle || article.title;
    const infobox = getArticleInfobox(db, slug);
    if (llmOptions) await deriveLlmExtraction(db, vocab, article, llmOptions);
    indexArticleOntology(db, { slug, title, infobox, vocab });
    return buildOntologyFactDocuments(db, slug, title, updatedAt, vocab);
  };
}
