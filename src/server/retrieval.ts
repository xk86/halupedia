import type { DatabaseSync } from "node:sqlite";
import type { LlmRouter } from "./llm";
import type { Logger } from "./logger";
import { prepared } from "./db";

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

export function retrieveDirectArticleContext(
  db: DatabaseSync,
  currentSlug: string,
  referencedSlugs: string[],
  mode: RagMode,
  maxResults: number,
  logger?: Logger,
): RetrievedContextPacket {
  const seen = new Set<string>([currentSlug]);
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
      .all(slug, Math.max(1, maxResults - rows.length)) as Array<{ slug: string; title: string; content: string }>;

    if (chunks.length > 0) {
      rows.push(...chunks);
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
    if (article) rows.push(article);
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

  const picked = ranked.slice(0, maxResults);
  logger?.info("rag.retrieve_complete", {
    slug,
    hints: hints.length,
    strategy: useEmbeddings ? "embeddings" : "lexical",
    corpus_chunks: rows.length,
    ranked_chunks: ranked.length,
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
    relatedTitles: picked.map((row) => row.title),
    sourceArticles: picked.map((row) => ({
      slug: row.slug,
      title: row.title,
      content: row.content,
      score: row.score,
    })),
  };
}
