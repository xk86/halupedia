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

export interface RetrievedContextPacket {
  context: string;
  relatedTitles: string[];
  sourceArticles: RetrievedSourceArticle[];
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
  /** Image descriptions to index alongside the text chunks. */
  imageDescriptions: Array<{ id: string; description: string }> = [],
  /** Flattened infobox text (from flattenInfoboxForRag). One chunk, relevance-gated. */
  infoboxText?: string,
) {
  const textChunks = chunkText(markdown, chunkSize);
  // Append one chunk per attached image that has a description.
  const imgChunks = imageDescriptions
    .filter((img) => img.description.trim())
    .map((img) => `[img:${img.id}]\n${img.description.trim()}`);
  // Append one infobox chunk when available so sidebar data is discoverable via RAG.
  const infoboxChunks = infoboxText?.trim() ? [infoboxText.trim()] : [];
  const chunks = [...textChunks, ...imgChunks, ...infoboxChunks];

  const embeddings = useEmbeddings && chunks.length ? await llm.embed(chunks) : [];
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
  });
}

export type RagMode = "summary" | "full";

function summaryContent(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 360
    ? normalized
    : `${normalized.slice(0, 360).trim()}...`;
}

function contextContent(text: string, mode: RagMode) {
  return mode === "summary"
    ? summaryContent(text)
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

function formatContextLine(row: { title: string; slug: string; content: string }, mode: RagMode) {
  return `- ${row.title} (slug: ${row.slug}): ${contextContent(row.content, mode)}`;
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
 * Assemble retrieved source articles into the `rag_context` prompt block,
 * respecting a hard character budget. Entries are dropped whole once the
 * budget is exhausted — never truncated mid-entry.
 */
export function formatRagContextForPrompt(
  sourceArticles: Array<{ title: string; content: string; slug?: string }>,
  maxChars: number,
): string {
  const parts: string[] = [];
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
    const entry = `## ${s.title}\n${s.content}`;
    if (used + entry.length > maxChars && parts.length > 0) break;
    if (entry.length > maxChars) continue;
    parts.push(entry);
    used += entry.length + 2;
  }
  return parts.join("\n\n");
}

export function retrieveDirectArticleContext(
  db: DatabaseSync,
  currentSlug: string,
  referencedSlugs: string[],
  mode: RagMode,
  maxResults: number,
  logger?: Logger,
  opts: { maxChunksPerArticle?: number } = {},
): RetrievedContextPacket {
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
      rows.push({ ...article, content: article.content.slice(0, 2_000) });
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
    context: picked.map((row) => formatContextLine(row, mode)).join("\n"),
    relatedTitles: [...new Set(picked.map((row) => row.title))],
    sourceArticles: picked.map((row) => ({
      slug: row.slug,
      title: row.title,
      content: row.content,
    })),
  };
}

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

  let ranked: Array<{ slug: string; title: string; content: string; score: number }> = [];
  if (useEmbeddings) {
    const [queryEmbedding] = await llm.embed([query]);
    ranked = rows
      .map((row) => ({
        slug: row.slug,
        title: row.title,
        content: row.content,
        score: row.embedding_json ? cosineSimilarity(queryEmbedding, JSON.parse(row.embedding_json) as number[]) : 0,
      }))
      .filter((row) => row.score >= minScore)
      .sort((a, b) => b.score - a.score);
  } else {
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4)
      .slice(0, 16);
    ranked = rows
      .map((row) => ({
        slug: row.slug,
        title: row.title,
        content: row.content,
        score: lexicalScore(words, row.content),
      }))
      .filter((row) => row.score >= minScore)
      .sort((a, b) => b.score - a.score);
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
    strategy: useEmbeddings ? "embeddings" : "lexical",
    corpus_chunks: rows.length,
    ranked_chunks: ranked.length,
    dropped_empty: droppedEmpty,
    picked: picked.length,
    // Each entry shows slug, data type, and score so it's clear what fed the LLM context
    sources: picked.map((row) => `${row.slug}[chunk:${row.score.toFixed(3)}]`).join(", ") || "(none)",
    min_score: minScore,
    top_score: ranked[0]?.score ?? 0,
  });
  return {
    context: picked
      .map((row) => formatContextLine(row, mode))
      .join("\n"),
    relatedTitles: [...new Set(picked.map((row) => row.title))],
    sourceArticles: picked.map((row) => ({
      slug: row.slug,
      title: row.title,
      content: row.content,
      score: row.score,
    })),
  };
}
