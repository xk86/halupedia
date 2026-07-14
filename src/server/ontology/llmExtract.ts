/**
 * LLM-assisted ontology extraction with content-hash caching.
 *
 * On each reindex the deterministic infobox extractor already runs; this adds a
 * light-model pass over the article prose to propose additional on-vocabulary
 * entities and typed relations. Everything the model returns is validated
 * against the controlled vocabulary before it is trusted (`validateLlmExtraction`).
 *
 * The model call is cached in `ontology_llm_cache` keyed by the article's
 * content hash + the vocabulary hash, so the drainer only pays for the model
 * when the article body or the vocabulary actually changes.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ArticleRecord, LlmInvocationMetadata } from "../types";
import type { PromptConfig } from "../types";
import type { LlmRouter } from "../llm";
import type { Logger } from "../logger";
import { prepared } from "../db";
import { contentHash } from "../rag/documents";
import { getPrompt, parseJsonLoose, renderTemplate } from "../prompts";
import { validateLlmExtraction } from "./extract";
import { listArticleEntityFacts } from "./store";
import { emptyExtraction, type ExtractionResult } from "./types";
import type { OntologyVocabulary } from "./vocabulary";
import { replaceOntologySuggestions, replaceOntologyTypeSuggestion } from "./suggestions";

export interface OntologyLlmOptions {
  llm: LlmRouter;
  prompts: PromptConfig;
  logger?: Logger;
  /**
   * Fired after a fresh extraction (cache miss) writes new suggestions for a
   * slug. This path runs on the background reindex drainer, not through an
   * HTTP request, so there is no requester to hand the result back to —
   * any article page open for this slug needs to be told to refetch its
   * ontology data (otherwise new suggestions only appear after a manual
   * reload), and this run needs to be recorded somewhere or it's invisible
   * to the admin pipeline/traces view even though it made a real model call.
   */
  onExtracted?: (slug: string, info: OntologyExtractionCallInfo) => void;
}

/** Everything the admin trace view needs to render this call the same way it
 *  renders any other traced LLM node (prompt/response text, token counts
 *  derived from these at read time, and the resolved model/host). */
export interface OntologyExtractionCallInfo {
  reason: LlmExtractionReason;
  durationMs: number;
  error?: Error;
  /** Absent when the call threw before a prompt was built. */
  promptText?: string;
  responseText?: string;
  promptChars?: number;
  metadata?: LlmInvocationMetadata;
  thinking?: boolean;
  jsonMode?: boolean;
}

/** Human-readable "predicate: subject -> object" lines for binary predicates. */
function describePredicates(vocab: OntologyVocabulary): string {
  return [...vocab.predicates.values()]
    .filter((p) => p.arity === "binary")
    .map((p) => `- ${p.name}: ${p.subject} -> ${p.object}`)
    .join("\n");
}

/**
 * The article's currently-recorded facts as "predicate object" lines, for the
 * model to reevaluate against — so it confirms/extends/prunes an existing set
 * rather than re-deriving from scratch. Excludes the redundant `is_a` tag and
 * caps the list to bound the prompt.
 */
function describeExistingFacts(db: DatabaseSync, slug: string): string {
  const { facts } = listArticleEntityFacts(db, slug);
  const lines = facts
    .filter((f) => f.predicate !== "is_a")
    .slice(0, 40)
    .map((f) => `- ${f.predicate} ${f.object}`);
  return lines.length ? lines.join("\n") : "(none yet)";
}

interface CacheRow {
  content_hash: string;
  vocab_hash: string;
  extraction: string;
}

/** Why (or whether) the light model was actually called for this article. */
export type LlmExtractionReason = "cache_hit" | "first_extraction" | "content_changed" | "vocabulary_changed";

export interface LlmExtractionOutcome {
  extraction: ExtractionResult;
  /** True only when a model call was actually attempted (cache misses aside
   *  from a corrupt row never skip the attempt). */
  called: boolean;
  reason: LlmExtractionReason;
  /** The raw parsed JSON from the LLM before vocabulary validation. Only
   *  populated on a fresh call (not from cache). */
  rawParsed?: unknown;
}

/**
 * Return a validated LLM extraction for the article, using the cache when the
 * content + vocabulary hash are unchanged. Returns an empty extraction (never
 * throws) on model or parse failure so deterministic indexing still proceeds.
 */
export async function deriveLlmExtraction(db: DatabaseSync, vocab: OntologyVocabulary, article: ArticleRecord, options: OntologyLlmOptions): Promise<LlmExtractionOutcome> {
  const body = article.markdown || article.plain_text || "";
  if (!body.trim())
    return {
      extraction: emptyExtraction(),
      called: false,
      reason: "cache_hit",
    };
  const hash = contentHash(body);
  const vocabHash = vocab.signature;

  const cached = prepared(db, `SELECT content_hash, vocab_hash, extraction FROM ontology_llm_cache WHERE article_slug = ?`).get(article.slug) as CacheRow | undefined;
  if (cached && cached.content_hash === hash && cached.vocab_hash === vocabHash) {
    try {
      const hit = JSON.parse(cached.extraction) as ExtractionResult;
      options.logger?.debug?.("ontology.llm_cache_hit", { slug: article.slug });
      return { extraction: hit, called: false, reason: "cache_hit" };
    } catch {
      // Corrupt cache row — fall through and re-derive.
    }
  }

  // Explain why the (paid) model call is happening — this is the only path that
  // hits the LLM, and only on a genuine content/vocabulary change.
  const reason = !cached ? "first_extraction" : cached.content_hash !== hash ? "content_changed" : "vocabulary_changed";
  const startedAt = Date.now();

  let extraction = emptyExtraction();
  let rawParsed: unknown;
  let extractError: Error | undefined;
  let promptText: string | undefined;
  let responseText: string | undefined;
  let promptChars: number | undefined;
  let metadata: LlmInvocationMetadata | undefined;
  let resolvedRole: "heavy" | "light" | undefined;
  let thinking: boolean | undefined;
  let jsonMode: boolean | undefined;
  try {
    const prompt = getPrompt(options.prompts, "ontology");
    const title = article.displayTitle || article.title;
    resolvedRole = prompt.model === "heavy" ? "heavy" : "light";
    thinking = prompt.thinking;
    jsonMode = prompt.json;
    const templateVars = {
      requested_title: title,
      entity_types: [...vocab.entityTypes].join(", "),
      predicates: describePredicates(vocab),
      existing_facts: describeExistingFacts(db, article.slug),
      article_body: body.slice(0, 12000),
    };
    const systemPrompt = renderTemplate(prompt.system, templateVars);
    const userPrompt = renderTemplate(prompt.user, templateVars);
    promptText = `### System\n${systemPrompt}\n\n### User\n${userPrompt}`;
    promptChars = systemPrompt.length + userPrompt.length;
    metadata = options.llm.metadataFor?.(resolvedRole);
    options.logger?.info?.("ontology.llm_extract", {
      slug: article.slug,
      model: resolvedRole,
      reason,
    });
    const raw = await options.llm.chat(resolvedRole, systemPrompt, userPrompt, {
      thinking,
      jsonMode,
    });
    responseText = raw;
    // Fact objects carry TeX (e.g. "\text{SiO}_2"); preserve single-backslash
    // LaTeX so JSON.parse doesn't eat "\t"/"\n"/etc. as control chars.
    const parsed = parseJsonLoose(raw, { preserveLatex: true });
    if (parsed === null) {
      options.logger?.warn?.("ontology.llm_extraction_unparseable", {
        slug: article.slug,
      });
    } else {
      rawParsed = parsed;
      extraction = validateLlmExtraction(parsed, vocab);
    }
  } catch (err) {
    extractError = err instanceof Error ? err : new Error(String(err));
    responseText = (err as { partialContent?: string }).partialContent ?? responseText;
    options.logger?.warn?.("ontology.llm_extraction_failed", {
      slug: article.slug,
      error: extractError.message,
    });
    // Cache the (empty) result too, so a persistently failing/uncovered article
    // doesn't re-hit the model on every drain until its content changes.
  }

  prepared(
    db,
    `INSERT INTO ontology_llm_cache (article_slug, content_hash, vocab_hash, extraction, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(article_slug) DO UPDATE SET
       content_hash = excluded.content_hash,
       vocab_hash = excluded.vocab_hash,
       extraction = excluded.extraction,
       updated_at = excluded.updated_at`,
  ).run(article.slug, hash, vocabHash, JSON.stringify(extraction), Date.now());
  replaceOntologySuggestions(db, article.slug, rawParsed, extraction);
  const currentType = listArticleEntityFacts(db, article.slug).entity?.entityType ?? null;
  replaceOntologyTypeSuggestion(db, article.slug, article.displayTitle || article.title, currentType, extraction);
  options.onExtracted?.(article.slug, {
    reason,
    durationMs: Date.now() - startedAt,
    error: extractError,
    promptText,
    responseText,
    promptChars,
    metadata,
    thinking,
    jsonMode,
  });

  return { extraction, called: true, reason, rawParsed };
}
