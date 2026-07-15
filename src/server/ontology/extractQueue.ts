/**
 * Long-term ontology-extraction catch-up queue: tops up and drains articles
 * whose ontology is stale (never extracted, or extracted under a vocabulary
 * signature that has since changed — see `isArticleOntologyStale`). This is
 * separate from the synchronous extraction that already runs inline whenever
 * an article is generated or regenerated; it exists to backfill articles that
 * path never touched.
 *
 * The review queue (`./reviewQueue`) depends on this one: `enqueueReviewTasks`
 * only selects articles whose ontology signature is current, so an article
 * with an active or still-needed extraction job never reaches review with
 * stale suggestions.
 */
import type { DatabaseSync } from "node:sqlite";
import { prepared } from "../db";

export type ExtractQueueStatus = "pending" | "processing" | "done" | "error";

export interface ExtractQueueItem {
  id: number;
  articleSlug: string;
  articleTitle: string;
  status: ExtractQueueStatus;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  called: boolean | null;
  reason: string | null;
  error: string | null;
}

/** Rows currently pending or processing — used to skip re-enqueueing while
 *  there is still work in flight, and by the review queue to defer an
 *  article whose extraction hasn't finished yet. */
export function countActiveExtractions(db: DatabaseSync): number {
  const row = prepared(
    db,
    `SELECT COUNT(*) AS c FROM ontology_extract_queue WHERE status IN ('pending', 'processing')`,
  ).get() as { c: number };
  return row.c;
}

/**
 * Enqueue up to `batch` articles whose ontology signature doesn't match the
 * current vocabulary (never extracted, or stale) and aren't already queued.
 * Newest articles (by `generated_at`) get the highest rank, so the queue
 * drains latest-articles-first.
 */
export function enqueueExtractionTasks(db: DatabaseSync, vocabSignature: string, batch: number): number {
  if (batch <= 0) return 0;
  const rows = prepared(
    db,
    `SELECT a.slug AS slug, a.generated_at AS rank
       FROM articles a
       LEFT JOIN article_ontology_state s ON s.article_slug = a.slug
      WHERE (s.signature IS NULL OR s.signature != ?)
        AND NOT EXISTS (
          SELECT 1 FROM ontology_extract_queue q
           WHERE q.article_slug = a.slug AND q.status IN ('pending', 'processing')
        )
      ORDER BY a.generated_at DESC
      LIMIT ?`,
  ).all(vocabSignature, batch) as Array<{ slug: string; rank: number }>;

  const now = Date.now();
  for (const row of rows) {
    prepared(
      db,
      `INSERT INTO ontology_extract_queue (article_slug, article_rank, status, enqueued_at)
       VALUES (?, ?, 'pending', ?)`,
    ).run(row.slug, row.rank, now);
  }
  return rows.length;
}

/** Atomically claim the highest-ranked pending row (latest article first). */
export function claimNextExtraction(db: DatabaseSync): { id: number; articleSlug: string } | null {
  const row = prepared(
    db,
    `SELECT id, article_slug AS articleSlug FROM ontology_extract_queue
      WHERE status = 'pending'
      ORDER BY article_rank DESC, id ASC
      LIMIT 1`,
  ).get() as { id: number; articleSlug: string } | undefined;
  if (!row) return null;
  const res = prepared(
    db,
    `UPDATE ontology_extract_queue SET status = 'processing', started_at = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(Date.now(), row.id);
  if (Number(res.changes) === 0) return null;
  return row;
}

export function completeExtraction(db: DatabaseSync, id: number, result: { called: boolean; reason: string }): void {
  prepared(
    db,
    `UPDATE ontology_extract_queue
        SET status = 'done', finished_at = ?, called = ?, reason = ?
      WHERE id = ?`,
  ).run(Date.now(), result.called ? 1 : 0, result.reason, id);
}

export function failExtraction(db: DatabaseSync, id: number, error: string): void {
  prepared(
    db,
    `UPDATE ontology_extract_queue SET status = 'error', finished_at = ?, error = ? WHERE id = ?`,
  ).run(Date.now(), error, id);
}

/** Active rows (pending/processing) first in run order, then finished rows
 *  most-recently-finished first — mirrors `listReviewQueue`. */
export function listExtractQueue(db: DatabaseSync, limit = 50): ExtractQueueItem[] {
  const rows = prepared(
    db,
    `SELECT q.id, q.article_slug AS articleSlug,
            COALESCE(a.title, q.article_slug) AS articleTitle,
            q.status, q.enqueued_at AS enqueuedAt, q.started_at AS startedAt,
            q.finished_at AS finishedAt, q.called, q.reason, q.error
       FROM ontology_extract_queue q
       LEFT JOIN articles a ON a.slug = q.article_slug
      ORDER BY
        CASE WHEN q.status IN ('pending', 'processing') THEN 0 ELSE 1 END,
        CASE WHEN q.status IN ('pending', 'processing') THEN q.article_rank END DESC,
        CASE WHEN q.status IN ('pending', 'processing') THEN q.id END ASC,
        COALESCE(q.finished_at, q.started_at, q.enqueued_at) DESC
      LIMIT ?`,
  ).all(limit) as Array<Omit<ExtractQueueItem, "called"> & { called: number | null }>;
  return rows.map((row) => ({ ...row, called: row.called === null ? null : row.called === 1 }));
}
