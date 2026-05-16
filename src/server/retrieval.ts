import type { DatabaseSync } from "node:sqlite";
import type { LlmClient } from "./llm";
import type { Logger } from "./logger";

export interface RetrievedContextPacket {
  context: string;
  relatedTitles: string[];
  sourceArticles: Array<{
    slug: string;
    title: string;
    content: string;
  }>;
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

export async function indexArticleChunks(
  db: DatabaseSync,
  llm: LlmClient,
  slug: string,
  markdown: string,
  useEmbeddings: boolean,
  chunkSize: number,
  logger?: Logger
) {
  const chunks = chunkText(markdown, chunkSize);
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
    chunks: chunks.length,
    embeddings_enabled: useEmbeddings,
    embedded_chunks: embeddings.length,
  });
}

export async function retrieveContext(
  db: DatabaseSync,
  llm: LlmClient,
  slug: string,
  hints: string[],
  enabled: boolean,
  maxResults: number,
  minScore: number,
  useEmbeddings: boolean,
  logger?: Logger
): Promise<RetrievedContextPacket> {
  if (!enabled) {
    logger?.info("rag.retrieve_skipped", {
      slug,
      hints: hints.length,
      enabled,
    });
    return { context: "", relatedTitles: [], sourceArticles: [] };
  }

  const rows = db
    .prepare(
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

  const query = [slug, ...hints.slice(0, 8)].join("\n");

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
    matched_slugs: picked.map((row) => row.slug),
    min_score: minScore,
    top_score: ranked[0]?.score ?? 0,
  });
  return {
    context: picked
      .map((row) => `- ${row.title} (slug: ${row.slug}): ${row.content.replace(/\s+/g, " ").trim()}`)
      .join("\n"),
    relatedTitles: picked.map((row) => row.title),
    sourceArticles: picked.map((row) => ({
      slug: row.slug,
      title: row.title,
      content: row.content,
    })),
  };
}
