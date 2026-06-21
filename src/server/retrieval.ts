import type { DatabaseSync } from "node:sqlite";
import type { LlmRouter } from "./llm";
import type { Logger } from "./logger";
import { listArticleBlacklistSlugs, prepared } from "./db";
import { slugify } from "./slug";

/**
 * A single chunk surfaced by the RAG pipeline.
 *
 * `score` is the relevancy score the chunk earned during ranking
 * (cosine similarity for embeddings, lexical match ratio for fallback).
 * Higher is better. Carried through so the reference-list builder can
 * re-rank chunks against summaries without re-running retrieval.
 */
export interface RetrievedSourceArticle {
  slug: string;
  title: string;
  content: string;
  score?: number;
}

/**
 * Diagnostic metadata about how a retrieval pass ranked chunks — surfaced in the
 * admin RAG trace so it's clear whether embeddings actually ran and which host
 * served them, versus a lexical fallback.
 */
export interface RetrievalEmbeddingMeta {
  /** embeddings | embeddings_mixed | lexical | lexical_fallback | lexical_no_embeddings */
  strategy: string;
  /** Configured embeddings model id (present whenever embeddings were attempted). */
  model?: string;
  /** Host id that served the query embedding. */
  host?: string;
  /** Base URL of the host that served the query embedding. */
  baseUrl?: string;
  /** Query embedding vector length. */
  dimensions?: number;
  /** Chunks in the corpus considered for ranking. */
  corpusChunks?: number;
  /** Corpus chunks that carried a stored embedding. */
  embeddedChunks?: number;
}

export interface RetrievedContextPacket {
  context: string;
  relatedTitles: string[];
  sourceArticles: RetrievedSourceArticle[];
  embedding?: RetrievalEmbeddingMeta;
}

export interface IndexArticleChunksResult {
  textChunks: number;
  imageChunks: number;
  infoboxChunks: number;
  embeddingsEnabled: boolean;
  embeddedChunks: number;
  embeddingError?: string;
}

// Promises for RAG indexing runs that have been kicked off but not yet
// finished. Retrieval waits on these (bounded by a timeout) so that an article
// persisted moments ago is visible to the next generation's RAG pass instead
// of racing the async post-process pipeline.
const pendingRagIndexes = new Map<string, Promise<unknown>>();

const PENDING_INDEX_MAX_AGE_MS = 30_000;

export function registerPendingRagIndex(slug: string, promise: Promise<unknown>): void {
  pendingRagIndexes.set(slug, promise);
  const evict = () => {
    if (pendingRagIndexes.get(slug) === promise) pendingRagIndexes.delete(slug);
  };
  // Evict on settle, but also after a max age so a wedged indexing run can't
  // tax every future retrieval with the wait timeout.
  const timer = setTimeout(evict, PENDING_INDEX_MAX_AGE_MS);
  timer.unref?.();
  void promise.catch(() => {}).finally(() => {
    clearTimeout(timer);
    evict();
  });
}

export async function awaitPendingRagIndexing(timeoutMs = 5000): Promise<void> {
  if (pendingRagIndexes.size === 0) return;
  const pending = [...pendingRagIndexes.values()];
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

function chunkText(text: string, chunkSize: number): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }
    if (`${current}\n\n${paragraph}`.length > chunkSize) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = `${current}\n\n${paragraph}`;
    }
  }

  if (current) chunks.push(current);
  return chunks.slice(0, 32);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const size = Math.min(a.length, b.length);
  for (let i = 0; i < size; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function lexicalScore(queryWords: string[], content: string): number {
  const lower = content.toLowerCase();
  if (queryWords.length === 0) return 0;
  const hits = queryWords.reduce((score, word) => (lower.includes(word) ? score + 1 : score), 0);
  return hits / queryWords.length;
}

/** Flatten an infobox JSON object into a single plain-text chunk for RAG indexing. */
export function flattenInfoboxForRag(
  slug: string,
  infobox: { title?: string; subtitle?: string; groups?: Array<{ label: string; rows: Array<{ label: string; value: string }> }> },
): string {
  const lines: string[] = [`[infobox:${slug}]`];
  if (infobox.title) lines.push(infobox.title);
  if (infobox.subtitle) {
    // Strip markdown link syntax so only the visible text is embedded/matched.
    lines.push(infobox.subtitle.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"));
  }
  for (const group of infobox.groups ?? []) {
    for (const row of group.rows) {
      const value = row.value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
      lines.push(`${row.label}: ${value}`);
    }
  }
  return lines.join("\n");
}

export async function indexArticleChunks(
  db: DatabaseSync,
  llm: LlmRouter,
  slug: string,
  markdown: string,
  useEmbeddings: boolean,
  chunkSize: number,
  logger?: Logger,
  /** Image descriptions are accepted for legacy callers but not indexed into article RAG. */
  imageDescriptions: Array<{ id: string; description: string }> = [],
  /** Flattened infobox text (from flattenInfoboxForRag). One chunk, relevance-gated. */
  infoboxText?: string,
): Promise<IndexArticleChunksResult> {
  const textChunks = chunkText(markdown, chunkSize);
  void imageDescriptions;
  const imgChunks: string[] = [];
  // Infobox chunks are temporarily excluded from RAG indexing — sidebar data
  // was polluting retrieval with title-only / key-value noise. flattenInfoboxForRag
  // still runs upstream; to re-enable, restore `...infoboxChunks` in `chunks` below.
  const infoboxChunks: string[] = []; // was: infoboxText?.trim() ? [infoboxText.trim()] : []
  const chunks = [...textChunks, ...imgChunks];

  let embeddings: number[][] = [];
  let embeddingError: string | undefined;
  if (useEmbeddings && chunks.length) {
    try {
      embeddings = await llm.embed(chunks);
    } catch (err) {
      embeddingError = err instanceof Error ? err.message : String(err);
      logger?.warn("rag.index_embed_failed", {
        slug,
        chunks: chunks.length,
        error: embeddingError,
      });
    }
  }
  const deleteStmt = db.prepare(`DELETE FROM article_chunks WHERE slug = ?`);
  const insertStmt = db.prepare(`
    INSERT INTO article_chunks (slug, chunk_index, content, embedding_json)
    VALUES (?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    deleteStmt.run(slug);
    chunks.forEach((content, index) => {
      insertStmt.run(slug, index, content, embeddings[index] ? JSON.stringify(embeddings[index]) : null);
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  logger?.info("rag.index_complete", {
    slug,
    text_chunks: textChunks.length,
    image_chunks: imgChunks.length,
    infobox_chunk: infoboxChunks.length,
    embeddings_enabled: useEmbeddings,
    embedded_chunks: embeddings.length,
    ...(embeddingError ? { embedding_error: embeddingError } : {}),
  });
  return {
    textChunks: textChunks.length,
    imageChunks: imgChunks.length,
    infoboxChunks: infoboxChunks.length,
    embeddingsEnabled: useEmbeddings,
    embeddedChunks: embeddings.length,
    ...(embeddingError ? { embeddingError } : {}),
  };
}

export type RagMode = "summary" | "full";

/**
 * Controls how summary-mode RAG truncates a source's content.
 * - `enabled: false` → never truncate (summary mode keeps the whole chunk).
 * - `enabled: true`  → clip to `chars`, appending an ellipsis.
 * Backed by the `rag.summary_cap_enabled` / `rag.summary_cap_chars` config.
 */
export interface SummaryCap {
  enabled: boolean;
  chars: number;
}

/** Fallback used when no config-derived cap is threaded through (tests, callers
 *  predating the config item). Matches the historical hard-coded ceiling. */
const DEFAULT_SUMMARY_CAP: SummaryCap = { enabled: true, chars: 3600 };

function summaryContent(text: string, cap: SummaryCap = DEFAULT_SUMMARY_CAP) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!cap.enabled || normalized.length <= cap.chars) return normalized;
  return `${normalized.slice(0, cap.chars).trim()}...`;
}

function contextContent(text: string, mode: RagMode, cap: SummaryCap = DEFAULT_SUMMARY_CAP) {
  return mode === "summary"
    ? summaryContent(text, cap)
    : text.replace(/\s+/g, " ").trim();
}

/** Lowercase alphanumeric-only key for comparing content against a title/slug. */
function alnumKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * A retrieved chunk is only worth feeding the model when it carries text
 * beyond the article's own title/slug. Indexing keeps the H1 in the first
 * chunk, and stub/short articles produce chunks that normalize to just their
 * title — those add duplicate headings and noise without information. Leading
 * Markdown heading markers are stripped before the comparison.
 */
function chunkHasUsefulContent(content: string, title: string, slug: string): boolean {
  const normalized = (content ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const body = normalized.replace(/^#{1,6}\s+/, "").trim();
  const key = alnumKey(body);
  if (!key) return false;
  return key !== alnumKey(title) && key !== alnumKey(slug);
}

function formatContextLine(
  row: { title: string; slug: string; content: string },
  mode: RagMode,
  cap: SummaryCap = DEFAULT_SUMMARY_CAP,
) {
  return `- ${row.title} (slug: ${row.slug}): ${contextContent(row.content, mode, cap)}`;
}

export function mergeRetrievedContextPackets(
  primary: RetrievedContextPacket,
  secondary: RetrievedContextPacket,
): RetrievedContextPacket {
  const seen = new Set<string>();
  const sourceArticles = [...primary.sourceArticles, ...secondary.sourceArticles].filter((article) => {
    if (seen.has(article.slug)) return false;
    seen.add(article.slug);
    return true;
  });
  const relatedTitles = sourceArticles.map((article) => article.title);
  return {
    context: [primary.context, secondary.context].filter(Boolean).join("\n"),
    relatedTitles,
    sourceArticles,
    // The primary packet is the one that ran semantic retrieval; keep its
    // embedding diagnostics (the secondary is a direct/backlink lookup).
    embedding: primary.embedding ?? secondary.embedding,
  };
}

/**
 * Strip user-blacklisted articles out of a retrieved-context block before it
 * reaches any prompt. Merges the slugs sent with the current request with the
 * article's persisted blacklist, so blocks made in earlier sessions hold for
 * every retrieval (generation, refresh, rewrite) — not just reference-list
 * builds.
 */
export function excludeBlacklistedSources<
  T extends { sourceArticles: RetrievedSourceArticle[]; ragTitles: string[] },
>(db: DatabaseSync, articleSlug: string, retrieved: T, requestBlacklistSlugs: string[] = []): T {
  const blocked = new Set<string>([
    ...requestBlacklistSlugs.map((s) => slugify(s)).filter(Boolean),
    ...listArticleBlacklistSlugs(db, slugify(articleSlug)),
  ]);
  if (blocked.size === 0) return retrieved;
  const blockedTitles = new Set(
    retrieved.sourceArticles.filter((a) => blocked.has(a.slug)).map((a) => a.title),
  );
  return {
    ...retrieved,
    sourceArticles: retrieved.sourceArticles.filter((a) => !blocked.has(a.slug)),
    ragTitles: retrieved.ragTitles.filter(
      (t) => !blockedTitles.has(t) && !blocked.has(slugify(t)),
    ),
  };
}

/**
 * Strip a leading echo of the article title from chunk content. Indexing keeps
 * the H1 in the first chunk, so retrieved content usually opens by restating
 * the title verbatim (optionally as a `# Heading`). Left in place, the prompt
 * block would render the title twice — once as our heading, once in the body.
 *
 * Only strips when the title is followed by a word boundary, so a single-letter
 * title like "A" is never clipped off content that merely starts with "a".
 */
export function stripLeadingTitleEcho(content: string, title: string): string {
  const body = content.replace(/^\s+/, "").replace(/^#{1,6}\s+/, "");
  const t = title.trim();
  if (!t) return body.trim();
  if (body.slice(0, t.length).toLowerCase() === t.toLowerCase()) {
    const after = body[t.length] ?? "";
    // Require a boundary after the echoed title (end-of-string or non-alphanumeric)
    // so we don't bite into a longer word that happens to share the prefix.
    if (after === "" || !/[\p{L}\p{N}]/u.test(after)) {
      return body.slice(t.length).replace(/^[\s:.–—-]+/, "").trim();
    }
  }
  return body.trim();
}

/**
 * Assemble retrieved source articles into the `rag_context` prompt block.
 *
 * Each source becomes its own `## Title` heading followed by its content, with
 * a leading title-echo stripped so the heading isn't immediately repeated.
 * Entries are added whole while they fit a hard character budget; any source
 * whose content can't fit is NOT dropped silently — its title is collected into
 * a compact "additional related topics" list appended below, so the model still
 * knows the topic exists. Each title appears at most once across both sections.
 */
export function formatRagContextForPrompt(
  sourceArticles: Array<{ title: string; content: string; slug?: string }>,
  maxChars: number,
  /**
   * Hard cap on how many sources get a full `## heading + body`. Sources past
   * the cap (or past the char budget) collapse into the title-only overflow
   * list. Refresh/rewrite pass a small cap so a wall of low-relevance context
   * can't drown the article being edited. 0 / omitted = unlimited.
   */
  maxArticles = 0,
): string {
  // Render the title as a ref link when we know the slug, so the linkable form
  // is repeated through the context and the model is nudged to cite it.
  const titleLabel = (s: { title: string; slug?: string }) =>
    s.slug ? `[${s.title}](ref:${s.slug})` : s.title;

  const parts: string[] = [];
  const overflow: string[] = []; // refs whose content didn't fit the budget
  const seenTitles = new Set<string>();
  let used = 0;
  for (const s of sourceArticles) {
    // Defense in depth: never emit an empty or title-only heading, and never
    // repeat the same article's heading (upstream should already dedupe, but
    // the prompt block must be clean regardless of caller).
    if (!chunkHasUsefulContent(s.content, s.title, s.slug ?? "")) continue;
    const titleKey = alnumKey(s.title);
    if (titleKey && seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);
    const entry = `## ${titleLabel(s)}\n${stripLeadingTitleEcho(s.content, s.title)}`;
    // Article-count cap reached, too big to ever fit, or no room left: list the
    // title below instead of giving it a full content block.
    if (
      (maxArticles > 0 && parts.length >= maxArticles) ||
      entry.length > maxChars ||
      (used + entry.length + 2 > maxChars && parts.length > 0)
    ) {
      overflow.push(titleLabel(s));
      continue;
    }
    parts.push(entry);
    used += entry.length + 2; // "\n\n" separator joined below
  }
  let out = parts.join("\n\n");
  if (overflow.length > 0) {
    const list = overflow.map((t) => `- ${t}`).join("\n");
    out += `${out ? "\n\n" : ""}Additional related topics (content omitted for length):\n${list}`;
  }
  return out;
}

/**
 * Format the "suggested related topics" bullet list for prompts. When a title
 * matches a known retrieved source we render it as a `[Title](ref:slug)` link
 * so the linkable form is repeated in context; titles without a resolvable
 * slug stay plain bullets (there is nothing safe to link them to). Duplicate
 * titles are collapsed.
 */
export function formatRelatedTitlesForPrompt(
  ragTitles: string[],
  sourceArticles: Array<{ title: string; slug?: string }> = [],
  /** Cap the number of suggestions (0 / omitted = unlimited). Refresh passes a
   *  small cap so a long noisy title list can't dominate the prompt. */
  limit = 0,
): string {
  const slugByTitle = new Map<string, string>();
  for (const s of sourceArticles) {
    const key = alnumKey(s.title);
    if (key && s.slug && !slugByTitle.has(key)) slugByTitle.set(key, s.slug);
  }
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const t of ragTitles) {
    if (limit > 0 && lines.length >= limit) break;
    const key = alnumKey(t);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const slug = slugByTitle.get(key);
    lines.push(slug ? `- [${t}](ref:${slug})` : `- ${t}`);
  }
  return lines.join("\n");
}

export function retrieveDirectArticleContext(
  db: DatabaseSync,
  currentSlug: string,
  referencedSlugs: string[],
  mode: RagMode,
  maxResults: number,
  logger?: Logger,
  opts: { maxChunksPerArticle?: number; summaryCap?: SummaryCap } = {},
): RetrievedContextPacket {
  const cap = opts.summaryCap ?? DEFAULT_SUMMARY_CAP;
  // Per-article chunk cap — without it the first referenced article fills the
  // entire max_results budget with chunks of itself and the remaining
  // references contribute nothing (and prompts balloon with one article's
  // full text).
  const perArticle = Math.max(1, opts.maxChunksPerArticle ?? 3);
  const seen = new Set<string>([currentSlug]);
  // One entry per article: the per-article chunks are merged under a single
  // title so the prompt never repeats a heading. `maxResults` caps articles.
  const rows: Array<{ slug: string; title: string; content: string }> = [];

  for (const slug of referencedSlugs) {
    if (seen.has(slug) || rows.length >= maxResults) continue;
    seen.add(slug);
    const chunks = db
      .prepare(
        `SELECT c.slug,
                COALESCE(a.title, c.slug) AS title,
                c.content
         FROM article_chunks c
         LEFT JOIN articles a ON a.slug = c.slug
         WHERE c.slug = ?
         ORDER BY c.chunk_index ASC
         LIMIT ?`,
      )
      .all(slug, perArticle) as Array<{ slug: string; title: string; content: string }>;

    const usefulChunks = chunks.filter((row) => chunkHasUsefulContent(row.content, row.title, row.slug));
    if (usefulChunks.length > 0) {
      rows.push({
        slug,
        title: usefulChunks[0].title,
        content: usefulChunks.map((row) => row.content.trim()).join("\n\n"),
      });
      continue;
    }

    const article = db
      .prepare(
        `SELECT slug, title, markdown AS content
         FROM articles
         WHERE slug = ?
         LIMIT 1`,
      )
      .get(slug) as { slug: string; title: string; content: string } | undefined;
    // Unindexed article fallback: never inject whole markdown bodies — keep
    // them chunk-sized so one big unindexed article can't dominate the prompt.
    if (article && chunkHasUsefulContent(article.content, article.title, article.slug)) {
      rows.push({ ...article, content: article.content });
    }
  }

  const picked = rows.slice(0, maxResults);
  logger?.info("rag.direct_references", {
    slug: currentSlug,
    requested: referencedSlugs.length,
    picked: picked.length,
    sources: picked.map((row) => `${row.slug}[chunk]`).join(", ") || "(none)",
  });

  return {
    context: picked.map((row) => formatContextLine(row, mode, cap)).join("\n"),
    relatedTitles: [...new Set(picked.map((row) => row.title))],
    sourceArticles: picked.map((row) => ({
      slug: row.slug,
      title: row.title,
      content: contextContent(row.content, mode, cap),
    })),
  };
}

// TODO: Document this function, then later replace it with better RAG pipeline instead of baking everything ourselves
export async function retrieveContext(
  db: DatabaseSync,
  llm: LlmRouter,
  slug: string,
  hints: string[],
  enabled: boolean,
  mode: RagMode,
  maxResults: number,
  minScore: number,
  useEmbeddings: boolean,
  logger?: Logger,
  queryOverride?: string,
  summaryCap: SummaryCap = DEFAULT_SUMMARY_CAP,
): Promise<RetrievedContextPacket> {
  if (!enabled) {
    logger?.info("rag.retrieve_skipped", {
      slug,
      hints: hints.length,
      enabled,
    });
    return { context: "", relatedTitles: [], sourceArticles: [] };
  }

  await awaitPendingRagIndexing();

  const rows = prepared(
    db,
      `SELECT c.slug,
              COALESCE(a.title, c.slug) AS title,
              c.content,
              c.embedding_json
       FROM article_chunks c
       LEFT JOIN articles a ON a.slug = c.slug
       WHERE c.slug != ?`
    )
    .all(slug) as Array<{ slug: string; title: string; content: string; embedding_json: string | null }>;

  if (rows.length === 0) {
    logger?.info("rag.retrieve_empty", {
      slug,
      hints: hints.length,
      corpus_chunks: 0,
    });
    return { context: "", relatedTitles: [], sourceArticles: [] };
  }

  const explicitQuery = queryOverride?.replace(/\s+/g, " ").trim();
  const query = explicitQuery || [slug, ...hints.slice(0, 8)].join("\n");
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4)
    .slice(0, 16);

  const rankLexically = () => {
    return rows
      .map((row) => ({
        slug: row.slug,
        title: row.title,
        content: row.content,
        score: lexicalScore(words, row.content),
      }))
      .filter((row) => row.score >= minScore)
      .sort((a, b) => b.score - a.score);
  };

  const embedInfo = llm.embeddingInfo?.();
  const embedding: RetrievalEmbeddingMeta = {
    strategy: useEmbeddings ? "embeddings" : "lexical",
    corpusChunks: rows.length,
    ...(useEmbeddings && embedInfo?.model ? { model: embedInfo.model } : {}),
  };

  let ranked: Array<{ slug: string; title: string; content: string; score: number }> = [];
  let strategy = useEmbeddings ? "embeddings" : "lexical";
  if (useEmbeddings) {
    const rowsWithEmbeddings = rows.filter((row) => row.embedding_json);
    embedding.embeddedChunks = rowsWithEmbeddings.length;
    if (rowsWithEmbeddings.length === 0) {
      strategy = "lexical_no_embeddings";
      ranked = rankLexically();
    } else {
      if (rowsWithEmbeddings.length < rows.length) strategy = "embeddings_mixed";
      try {
        const [queryEmbedding] = await llm.embed([query], (endpoint) => {
          embedding.host = endpoint.hostId;
          embedding.baseUrl = endpoint.baseUrl;
        });
        embedding.dimensions = queryEmbedding?.length;
        ranked = rows
          .map((row) => ({
            slug: row.slug,
            title: row.title,
            content: row.content,
            score: row.embedding_json
              ? cosineSimilarity(queryEmbedding, JSON.parse(row.embedding_json) as number[])
              : lexicalScore(words, row.content),
          }))
          .filter((row) => row.score >= minScore)
          .sort((a, b) => b.score - a.score);
      } catch (err) {
        // Embeddings down/timed out: degrade to lexical retrieval rather than
        // failing the whole generation. RAG is best-effort context, not a gate.
        logger?.warn("rag.embed_failed_fallback_lexical", {
          slug,
          error: err instanceof Error ? err.message : String(err),
        });
        strategy = "lexical_fallback";
        ranked = rankLexically();
      }
    }
  } else {
    ranked = rankLexically();
  }

  // `ranked` is one entry PER CHUNK, sorted by score. Collapse it to one entry
  // per article — keeping the best-scoring chunk — and drop chunks that carry
  // no content beyond the title. Without this the prompt repeats the same
  // heading once per chunk and includes title-only filler. `maxResults` then
  // caps distinct source articles, not raw chunks.
  const seenSlugs = new Set<string>();
  const picked: typeof ranked = [];
  let droppedEmpty = 0;
  for (const row of ranked) {
    if (!chunkHasUsefulContent(row.content, row.title, row.slug)) {
      droppedEmpty += 1;
      continue;
    }
    if (seenSlugs.has(row.slug)) continue;
    seenSlugs.add(row.slug);
    picked.push(row);
    if (picked.length >= maxResults) break;
  }
  logger?.info("rag.retrieve_complete", {
    slug,
    hints: hints.length,
    strategy,
    corpus_chunks: rows.length,
    ranked_chunks: ranked.length,
    dropped_empty: droppedEmpty,
    picked: picked.length,
    // Each entry shows slug, data type, and score so it's clear what fed the LLM context
    sources: picked.map((row) => `${row.slug}[chunk:${row.score.toFixed(3)}]`).join(", ") || "(none)",
    min_score: minScore,
    top_score: ranked[0]?.score ?? 0,
  });
  embedding.strategy = strategy;
  return {
    context: picked
      .map((row) => formatContextLine(row, mode, summaryCap))
      .join("\n"),
    relatedTitles: [...new Set(picked.map((row) => row.title))],
    sourceArticles: picked.map((row) => ({
      slug: row.slug,
      title: row.title,
      content: contextContent(row.content, mode, summaryCap),
      score: row.score,
    })),
    embedding,
  };
}
