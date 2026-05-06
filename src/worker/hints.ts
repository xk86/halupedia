import type { LinkHint } from "./sanitize";

/**
 * Persist all link-context hints emitted by `sourceSlug`. Each hint tells
 * future generations of `targetSlug` what the source article asserted about
 * that target. We dedupe on (target_slug, source_slug) so re-runs from the
 * same source overwrite rather than accumulate.
 */
export async function saveHints(
  db: D1Database,
  sourceSlug: string,
  hints: LinkHint[]
): Promise<void> {
  if (!hints.length) return;
  const now = Date.now();
  const stmts = hints
    // Don't store self-references (an article shouldn't pre-seed itself).
    .filter((h) => h.targetSlug !== sourceSlug)
    .map((h) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO link_hints
             (target_slug, source_slug, blurb, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .bind(h.targetSlug, sourceSlug, h.blurb, now)
    );
  if (stmts.length) await db.batch(stmts);
}

/**
 * Load up to `limit` prior hints for `targetSlug`, most recent first. Returned
 * as plain blurb strings ready to drop into the LLM prompt.
 */
export async function loadHints(
  db: D1Database,
  targetSlug: string,
  limit = 15
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT blurb FROM link_hints
        WHERE target_slug = ?
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .bind(targetSlug, limit)
    .all<{ blurb: string }>();
  return results.map((r) => r.blurb);
}
