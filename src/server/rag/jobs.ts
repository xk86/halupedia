/**
 * Durable indexing job processor.
 *
 * Drains the `rag_index_jobs` outbox: for each affected article it re-derives
 * the full set of text documents from canonical SQLite, embeds them, and
 * atomically replaces that article's rows in LanceDB. Articles are the unit of
 * replacement so retrieval never reads partially-updated documents.
 *
 * Per-article failures are isolated: the article's previous documents stay
 * active and its jobs remain durable with attempt/error data.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  deleteRagSourceStateForArticle,
  getArticle,
  getArticleInfobox,
  getArticleMediaRows,
  listOutboundLinkHints,
  listPendingRagJobs,
  markRagJobComplete,
  markRagJobFailed,
  upsertRagSourceState,
  type RagIndexJobRow,
} from "../db";
import type { Logger } from "../logger";
import { deleteArticleOntology } from "../ontology";
import {
  buildBodyDocuments,
  buildImageTextDocuments,
  buildInfoboxDigest,
  buildInfoboxFacts,
  buildLinkHintDocuments,
  buildSummaryDocument,
  type ImageTextInput,
} from "./documents";
import type { ChunkerOptions } from "./chunker";
import type { RagStore } from "./store";
import type { TextEmbedder } from "./embeddings";
import type { RagTextDocument } from "./types";

/**
 * Supplies documents that need data outside the primary DB or another
 * subsystem — image descriptions (media DB) and ontology facts (ontology store).
 * Returning [] keeps the core text path working before those land.
 */
export type ExtraDocumentProvider = (
  slug: string,
  updatedAt: number,
) => Promise<RagTextDocument[]> | RagTextDocument[];

export interface ProcessJobsDeps {
  db: DatabaseSync;
  store: RagStore;
  embedder: TextEmbedder;
  chunker?: ChunkerOptions;
  logger?: Logger;
  /** Optional providers merged into each article's document set. */
  extraDocuments?: ExtraDocumentProvider;
  /** Optional media-description lookup keyed by media id. */
  imageDescriptions?: (mediaIds: string[]) => Map<string, string>;
  /** Cap on articles processed per invocation. */
  maxArticles?: number;
}

export interface ProcessJobsResult {
  articlesProcessed: number;
  articlesDeleted: number;
  documentsUpserted: number;
  failures: number;
}

interface ArticleBatch {
  slug: string;
  jobs: RagIndexJobRow[];
  hasDelete: boolean;
}

function groupByArticle(jobs: RagIndexJobRow[], maxArticles: number): ArticleBatch[] {
  const map = new Map<string, ArticleBatch>();
  for (const job of jobs) {
    let batch = map.get(job.articleSlug);
    if (!batch) {
      if (map.size >= maxArticles) continue;
      batch = { slug: job.articleSlug, jobs: [], hasDelete: false };
      map.set(job.articleSlug, batch);
    }
    batch.jobs.push(job);
    if (job.operation === "delete") batch.hasDelete = true;
  }
  return [...map.values()];
}

/** Re-derive every text document for a live article from canonical SQLite. */
async function buildArticleDocuments(
  deps: ProcessJobsDeps,
  slug: string,
): Promise<RagTextDocument[] | null> {
  const article = getArticle(deps.db, slug);
  if (!article) return null; // treat as delete
  const updatedAt = article.generated_at ?? Date.now();
  const title = article.displayTitle || article.title;
  const docs: RagTextDocument[] = [];

  docs.push(...buildBodyDocuments({ slug, markdown: article.markdown, updatedAt, chunker: deps.chunker }));
  const summary = buildSummaryDocument(slug, article.summaryMarkdown ?? "", updatedAt);
  if (summary) docs.push(summary);

  const infobox = getArticleInfobox(deps.db, slug);
  if (infobox) {
    const digest = buildInfoboxDigest(slug, title, infobox, updatedAt);
    if (digest) docs.push(digest);
    docs.push(...buildInfoboxFacts(slug, title, infobox, updatedAt));
  }

  docs.push(...buildLinkHintDocuments(slug, listOutboundLinkHints(deps.db, slug), updatedAt));

  const media = getArticleMediaRows(deps.db, slug);
  if (media.length) {
    const descriptions = deps.imageDescriptions?.(media.map((m) => m.mediaId)) ?? new Map();
    const images: ImageTextInput[] = media.map((m) => ({
      mediaId: m.mediaId,
      caption: m.caption,
      description: descriptions.get(m.mediaId) ?? "",
      role: m.role,
      ordinal: m.ordinal,
    }));
    docs.push(...buildImageTextDocuments(slug, images, updatedAt));
  }

  if (deps.extraDocuments) docs.push(...(await deps.extraDocuments(slug, updatedAt)));
  return docs;
}

async function reindexArticle(deps: ProcessJobsDeps, slug: string): Promise<number> {
  const docs = await buildArticleDocuments(deps, slug);
  if (docs === null) {
    await deleteArticle(deps, slug);
    return 0;
  }
  if (docs.length === 0) {
    // Article exists but produced no documents (e.g. empty stub): clear its rows.
    await deps.store.deleteByArticle(slug);
    deleteRagSourceStateForArticle(deps.db, slug);
    return 0;
  }
  const { vectors, model } = await deps.embedder.embed(docs.map((d) => d.content));
  const embedded = docs.map((doc, i) => ({ ...doc, embeddingModel: model, vector: vectors[i] }));
  // Replace the whole article: delete then upsert so removed sources disappear.
  await deps.store.deleteByArticle(slug);
  await deps.store.upsertTextDocuments(embedded);
  for (const doc of docs) {
    upsertRagSourceState(deps.db, {
      sourceKind: doc.sourceKind,
      sourceId: doc.sourceId,
      articleSlug: slug,
      expectedHash: doc.contentHash,
      indexedHash: doc.contentHash,
      status: "current",
    });
  }
  return embedded.length;
}

async function deleteArticle(deps: ProcessJobsDeps, slug: string): Promise<void> {
  await deps.store.deleteByArticle(slug);
  deleteRagSourceStateForArticle(deps.db, slug);
  deleteArticleOntology(deps.db, slug);
}

export async function processJobs(deps: ProcessJobsDeps): Promise<ProcessJobsResult> {
  const maxArticles = deps.maxArticles ?? 200;
  const pending = listPendingRagJobs(deps.db);
  const batches = groupByArticle(pending, maxArticles);
  const result: ProcessJobsResult = {
    articlesProcessed: 0,
    articlesDeleted: 0,
    documentsUpserted: 0,
    failures: 0,
  };

  for (const batch of batches) {
    try {
      const article = getArticle(deps.db, batch.slug);
      if (batch.hasDelete && !article) {
        await deleteArticle(deps, batch.slug);
        result.articlesDeleted += 1;
      } else {
        const n = await reindexArticle(deps, batch.slug);
        result.documentsUpserted += n;
        if (article) result.articlesProcessed += 1;
        else result.articlesDeleted += 1;
      }
      for (const job of batch.jobs) markRagJobComplete(deps.db, job.id);
    } catch (err) {
      result.failures += 1;
      const message = err instanceof Error ? err.message : String(err);
      deps.logger?.warn("rag.job_failed", { slug: batch.slug, error: message });
      for (const job of batch.jobs) markRagJobFailed(deps.db, job.id, message);
    }
  }
  return result;
}
