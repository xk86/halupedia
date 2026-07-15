/**
 * Long-term ontology-review queue: separate from the live generation queue and
 * from the per-article suggestion UI. The scheduler (`../pipeline/scheduler`)
 * enqueues articles that have pending ontology suggestions and drains them at
 * its own pace, running each through `reviewArticleSuggestions`. Depends on
 * the extraction queue (`./extractQueue`) — see `enqueueReviewTasks` below.
 */
import type { DatabaseSync } from "node:sqlite";
import { prepared } from "../db";

export type ReviewQueueStatus = "pending" | "processing" | "done" | "error";

export interface ReviewQueueItem {
  id: number;
  articleSlug: string;
  articleTitle: string;
  status: ReviewQueueStatus;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  verdict: string | null;
  passed: number | null;
  failed: number | null;
  resultJson: string | null;
  error: string | null;
}

export interface ReviewResult {
  verdict: "pass" | "partial" | "fail";
  passed: number;
  failed: number;
  detail: unknown;
}

/** Rows currently pending or processing — used to skip re-enqueueing while
 *  there is still work in flight. */
export function countActiveReviews(db: DatabaseSync): number {
  const row = prepared(
    db,
    `SELECT COUNT(*) AS c FROM ontology_review_queue WHERE status IN ('pending', 'processing')`,
  ).get() as { c: number };
  return row.c;
}

/**
 * Enqueue up to `batch` articles that have a pending ontology suggestion (a
 * relation suggestion or a type suggestion) and aren't already queued. Newest
 * articles (by `generated_at`) get the highest rank, so the queue drains
 * latest-articles-first.
 *
 * Depends on extraction (`../ontology/extractQueue`): an article whose
 * ontology signature doesn't match the current vocabulary — never extracted,
 * or stale — is skipped, as is one with an extraction job still pending or
 * processing. Both mean its suggestions may not reflect the article's current
 * content/vocabulary, so review must wait for extraction to catch up first.
 */
export function enqueueReviewTasks(db: DatabaseSync, vocabSignature: string, batch: number): number {
  if (batch <= 0) return 0;
  const rows = prepared(
    db,
    `SELECT a.slug AS slug, a.generated_at AS rank
       FROM articles a
       LEFT JOIN article_ontology_state s ON s.article_slug = a.slug
      WHERE (
        EXISTS (SELECT 1 FROM ontology_suggestions sg WHERE sg.article_slug = a.slug)
        OR EXISTS (SELECT 1 FROM ontology_type_suggestions t WHERE t.article_slug = a.slug)
      )
      AND s.signature IS NOT NULL AND s.signature = ?
      AND NOT EXISTS (
        SELECT 1 FROM ontology_extract_queue eq
         WHERE eq.article_slug = a.slug AND eq.status IN ('pending', 'processing')
      )
      AND NOT EXISTS (
        SELECT 1 FROM ontology_review_queue q
         WHERE q.article_slug = a.slug AND q.status IN ('pending', 'processing')
      )
      ORDER BY a.generated_at DESC
      LIMIT ?`,
  ).all(vocabSignature, batch) as Array<{ slug: string; rank: number }>;

  const now = Date.now();
  for (const row of rows) {
    prepared(
      db,
      `INSERT INTO ontology_review_queue (article_slug, article_rank, status, enqueued_at)
       VALUES (?, ?, 'pending', ?)`,
    ).run(row.slug, row.rank, now);
  }
  return rows.length;
}

/** Atomically claim the highest-ranked pending row (latest article first). */
export function claimNextReview(
  db: DatabaseSync,
): { id: number; articleSlug: string } | null {
  const row = prepared(
    db,
    `SELECT id, article_slug AS articleSlug FROM ontology_review_queue
      WHERE status = 'pending'
      ORDER BY article_rank DESC, id ASC
      LIMIT 1`,
  ).get() as { id: number; articleSlug: string } | undefined;
  if (!row) return null;
  const res = prepared(
    db,
    `UPDATE ontology_review_queue SET status = 'processing', started_at = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(Date.now(), row.id);
  // Lost the race to another claimer (not expected with a single scheduler
  // timer, but cheap to guard).
  if (Number(res.changes) === 0) return null;
  return row;
}

export function completeReview(
  db: DatabaseSync,
  id: number,
  result: ReviewResult,
): void {
  prepared(
    db,
    `UPDATE ontology_review_queue
        SET status = 'done', finished_at = ?, verdict = ?, passed = ?, failed = ?, result_json = ?
      WHERE id = ?`,
  ).run(
    Date.now(),
    result.verdict,
    result.passed,
    result.failed,
    JSON.stringify(result.detail),
    id,
  );
}

export function failReview(db: DatabaseSync, id: number, error: string): void {
  prepared(
    db,
    `UPDATE ontology_review_queue SET status = 'error', finished_at = ?, error = ? WHERE id = ?`,
  ).run(Date.now(), error, id);
}

/**
 * Active rows (pending/processing) first, in their real run order — the same
 * `article_rank DESC, id ASC` `claimNextReview` uses, so a "processing" row
 * never jumps ahead of a not-yet-claimed pending row it wouldn't have beaten
 * anyway. Finished rows (done/error) follow, most recently finished first.
 * The two groups read as one continuous timeline: active rows carry a future
 * (estimated) run time, finished rows a past (actual) one.
 */
export function listReviewQueue(db: DatabaseSync, limit = 50): ReviewQueueItem[] {
  return prepared(
    db,
    `SELECT q.id, q.article_slug AS articleSlug,
            COALESCE(a.title, q.article_slug) AS articleTitle,
            q.status, q.enqueued_at AS enqueuedAt, q.started_at AS startedAt,
            q.finished_at AS finishedAt, q.verdict, q.passed, q.failed,
            q.result_json AS resultJson, q.error
       FROM ontology_review_queue q
       LEFT JOIN articles a ON a.slug = q.article_slug
      ORDER BY
        CASE WHEN q.status IN ('pending', 'processing') THEN 0 ELSE 1 END,
        CASE WHEN q.status IN ('pending', 'processing') THEN q.article_rank END DESC,
        CASE WHEN q.status IN ('pending', 'processing') THEN q.id END ASC,
        COALESCE(q.finished_at, q.started_at, q.enqueued_at) DESC
      LIMIT ?`,
  ).all(limit) as unknown as ReviewQueueItem[];
}
