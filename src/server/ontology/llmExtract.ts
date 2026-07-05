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
import type { ArticleRecord } from "../types";
import type { PromptConfig } from "../types";
import type { LlmRouter } from "../llm";
import type { Logger } from "../logger";
import { prepared } from "../db";
import { contentHash } from "../rag/documents";
import { getPrompt, parseJsonLoose, renderTemplate } from "../prompts";
import { validateLlmExtraction } from "./extract";
import { emptyExtraction, type ExtractionResult } from "./types";
import type { OntologyVocabulary } from "./vocabulary";

export interface OntologyLlmOptions {
  llm: LlmRouter;
  prompts: PromptConfig;
  logger?: Logger;
}

/** Human-readable "predicate: subject -> object" lines for binary predicates. */
function describePredicates(vocab: OntologyVocabulary): string {
  return [...vocab.predicates.values()]
    .filter((p) => p.arity === "binary")
    .map((p) => `- ${p.name}: ${p.subject} -> ${p.object}`)
    .join("\n");
}

interface CacheRow {
  content_hash: string;
  vocab_hash: string;
  extraction: string;
}

/**
 * Return a validated LLM extraction for the article, using the cache when the
 * content + vocabulary hash are unchanged. Returns an empty extraction (never
 * throws) on model or parse failure so deterministic indexing still proceeds.
 */
export async function deriveLlmExtraction(
  db: DatabaseSync,
  vocab: OntologyVocabulary,
  article: ArticleRecord,
  options: OntologyLlmOptions,
): Promise<ExtractionResult> {
  const body = article.markdown || article.plain_text || "";
  if (!body.trim()) return emptyExtraction();
  const hash = contentHash(body);
  const vocabHash = `${vocab.version}:${vocab.hash}`;

  const cached = prepared(
    db,
    `SELECT content_hash, vocab_hash, extraction FROM ontology_llm_cache WHERE article_slug = ?`,
  ).get(article.slug) as CacheRow | undefined;
  if (cached && cached.content_hash === hash && cached.vocab_hash === vocabHash) {
    try {
      return JSON.parse(cached.extraction) as ExtractionResult;
    } catch {
      // Corrupt cache row — fall through and re-derive.
    }
  }

  let extraction = emptyExtraction();
  try {
    const prompt = getPrompt(options.prompts, "ontology");
    const title = article.displayTitle || article.title;
    const raw = await options.llm.chat(
      prompt.model === "heavy" ? "heavy" : "light",
      prompt.system,
      renderTemplate(prompt.user, {
        requested_title: title,
        entity_types: [...vocab.entityTypes].join(", "),
        predicates: describePredicates(vocab),
        article_body: body.slice(0, 12000),
      }),
      { thinking: prompt.thinking, jsonMode: prompt.json },
    );
    const parsed = parseJsonLoose(raw);
    if (parsed === null) {
      // Unrecoverable even after repair (rare): log, keep the empty result, and
      // let deterministic extraction carry the article on its own.
      options.logger?.warn?.("ontology.llm_extraction_unparseable", { slug: article.slug });
    } else {
      // validateLlmExtraction tolerates malformed/partial input and never throws,
      // so a truncated-but-repaired array still yields its complete entries.
      extraction = validateLlmExtraction(parsed, vocab);
    }
  } catch (err) {
    options.logger?.warn?.("ontology.llm_extraction_failed", {
      slug: article.slug,
      error: err instanceof Error ? err.message : String(err),
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

  return extraction;
}
