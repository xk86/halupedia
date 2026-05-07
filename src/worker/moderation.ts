/**
 * Content moderation. Two trigger paths:
 *
 *   1. /api/moderate sweep — drains every pending article + comment in
 *      batches until the per-invocation budget is spent. Idempotent (already
 *      checked items are skipped), so re-hitting the URL is safe.
 *   2. waitUntil hook on every fresh write — accepts the user's submission
 *      immediately and judges it asynchronously, deleting it if banned.
 *
 * Articles are judged by their TITLE only (per product decision: titles are
 * what the spam botnet weaponizes). Comments are judged by full body.
 *
 * Policy is intentionally permissive: only Nazi/fascist promotion, slurs
 * targeting protected groups, incitement to violence, and obvious keyword-
 * mashing spam get removed. Absurdity, vulgarity, mockery — all kept.
 */

export interface ModerationEnv {
  DB: D1Database;
  ARTICLES: KVNamespace;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_MODERATION_MODEL?: string;
}

const BATCH_SIZE = 30;
// Safety budget per /api/moderate invocation — workers have CPU/time limits
// and a single hammer-the-API endpoint shouldn't stall forever. Re-hits drain
// the rest, so this is just a per-call cap.
const MAX_BATCHES_PER_SWEEP = 10;
// How many KV keys to scan per sweep when backfilling moderation rows for
// articles created before this system existed (or via direct KV writes).
const KV_BACKFILL_LIMIT = 500;

const MODERATION_SYSTEM_PROMPT = `You are a content moderator for Hallucinopedia, a satirical AI-generated encyclopedia of fictional, absurd entries with a public comments section.

Be MAXIMALLY LIBERAL. The site is intentionally weird, silly, vulgar, and irreverent. ALLOW:
- Absurd, silly, fictional subjects (the entire encyclopedia is fake)
- Vulgarity, profanity, dark humor, mockery, sarcasm
- Criticism of governments, religions, ideologies, public figures
- Edgy or offensive jokes that punch in any direction
- Anything weird, surreal, or in poor taste

ONLY flag items that clearly fall into these narrow categories:
1. Promotion or glorification of Nazism, fascism, or genocide
2. Slurs or dehumanizing attacks targeting a protected group (race, religion, ethnicity, sexuality, gender identity, disability) — note: mocking an ideology or institution is NOT a slur against its adherents
3. Direct incitement of real-world violence against identifiable people
4. Sexual content involving minors
5. Obvious keyword-mashing spam (long repetitive concatenations of the same word/phrase, gibberish strings of digits, copy-paste flooding)

When in doubt, ALLOW. False positives ruin the site. A weird fictional title is not spam.

You will be given a numbered list of items. Respond with ONLY a JSON array of the 1-based indices to remove, like [1,4,7] or [] if nothing should be removed. No prose, no explanation, no code fences. Just the JSON array.`;

interface JudgeItem {
  index: number; // 1-based
  text: string;
}

/**
 * Send a batch of items to the moderator LLM. Returns the set of 1-based
 * indices the model wants removed. On any error we fail OPEN (return empty
 * set) — better to leave borderline content up than to mass-delete because
 * of a transient API hiccup.
 */
async function judgeBatch(
  items: JudgeItem[],
  kind: "article title" | "comment",
  env: ModerationEnv
): Promise<Set<number>> {
  if (items.length === 0) return new Set();

  const numbered = items
    .map((it) => `${it.index}. ${it.text.replace(/\s+/g, " ").slice(0, 500)}`)
    .join("\n");

  const userMsg = `Review the following ${items.length} ${kind}${items.length === 1 ? "" : "s"} and return the JSON array of 1-based indices to remove (or [] if all are acceptable):\n\n${numbered}`;

  const model =
    env.OPENROUTER_MODERATION_MODEL ||
    env.OPENROUTER_MODEL ||
    "google/gemini-2.5-flash-lite";

  let raw = "";
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://hallupedia.com",
        "X-Title": "Hallucinopedia Moderation",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: MODERATION_SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
      }),
    });
    if (!res.ok) {
      console.error("moderation: openrouter error", res.status);
      return new Set();
    }
    const json: any = await res.json();
    raw = json?.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    console.error("moderation: fetch failed", e);
    return new Set();
  }

  // Robust parse: find first [...] in the response.
  const m = raw.match(/\[[^\]]*\]/);
  if (!m) return new Set();
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return new Set();
  }
  if (!Array.isArray(arr)) return new Set();

  const valid = new Set(items.map((it) => it.index));
  const out = new Set<number>();
  for (const v of arr) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && valid.has(n)) out.add(n);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Per-write enqueue helpers                                                  */
/* -------------------------------------------------------------------------- */

/** Insert (or upsert to pending) a moderation row for a freshly-stored slug. */
export async function enqueueArticleForModeration(
  db: D1Database,
  slug: string
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO article_moderation (slug, status, enqueued_at)
         VALUES (?, 'pending', ?)
         ON CONFLICT(slug) DO UPDATE SET status='pending', enqueued_at=excluded.enqueued_at, checked_at=NULL, reason=NULL`
      )
      .bind(slug, Date.now())
      .run();
  } catch (e) {
    console.error("enqueueArticleForModeration failed", e);
  }
}

/** Comments default to status='pending' via the column default; this is a no-op stub kept for symmetry / future hooks. */
export function enqueueCommentForModeration(): void {
  /* column default handles it */
}

/** True if the slug has been moderated and banned. */
export async function isSlugBanned(
  db: D1Database,
  slug: string
): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT 1 AS x FROM article_moderation WHERE slug = ? AND status = 'banned'")
      .bind(slug)
      .first<{ x: number }>();
    return !!row;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Single-item background check (waitUntil after a write)                     */
/* -------------------------------------------------------------------------- */

/** Judge a single freshly-written article title. If banned, delete from KV
 *  and mark banned. Otherwise mark ok. */
export async function moderateArticleNow(
  slug: string,
  title: string,
  env: ModerationEnv
): Promise<void> {
  const banned = await judgeBatch(
    [{ index: 1, text: title }],
    "article title",
    env
  );
  if (banned.has(1)) {
    await banArticle(slug, "auto-flagged on creation", env);
  } else {
    await markArticleOk(slug, env.DB);
  }
}

/** Judge a single freshly-posted comment. If banned, delete it. */
export async function moderateCommentNow(
  commentId: string,
  body: string,
  env: ModerationEnv
): Promise<void> {
  const banned = await judgeBatch(
    [{ index: 1, text: body }],
    "comment",
    env
  );
  if (banned.has(1)) {
    await deleteComment(commentId, env.DB, "auto-flagged on creation");
  } else {
    await markCommentOk(commentId, env.DB);
  }
}

/* -------------------------------------------------------------------------- */
/*  Sweep (drains pending in batches)                                          */
/* -------------------------------------------------------------------------- */

interface SweepResult {
  articles: { checked: number; banned: number; remaining: number };
  comments: { checked: number; banned: number; remaining: number };
  backfilled: number;
}

export async function runSweep(env: ModerationEnv): Promise<SweepResult> {
  const backfilled = await backfillArticleModerationRows(env);

  // Drain articles and comments in interleaved batches so neither starves.
  let articlesChecked = 0;
  let articlesBanned = 0;
  let commentsChecked = 0;
  let commentsBanned = 0;

  for (let i = 0; i < MAX_BATCHES_PER_SWEEP; i++) {
    const did = await Promise.all([
      sweepOneArticleBatch(env),
      sweepOneCommentBatch(env),
    ]);
    const [a, cm] = did;
    articlesChecked += a.checked;
    articlesBanned += a.banned;
    commentsChecked += cm.checked;
    commentsBanned += cm.banned;
    if (a.checked === 0 && cm.checked === 0) break;
  }

  const aRem = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM article_moderation WHERE status='pending'")
    .first<{ n: number }>();
  const cRem = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM comments WHERE moderation_status='pending'")
    .first<{ n: number }>();

  return {
    articles: {
      checked: articlesChecked,
      banned: articlesBanned,
      remaining: aRem?.n ?? 0,
    },
    comments: {
      checked: commentsChecked,
      banned: commentsBanned,
      remaining: cRem?.n ?? 0,
    },
    backfilled,
  };
}

/**
 * Find KV article slugs that have no row in article_moderation and seed them
 * as 'pending'. Bounded per invocation so a giant cold-start doesn't blow
 * past the worker time budget — repeated /api/moderate hits will finish.
 */
async function backfillArticleModerationRows(
  env: ModerationEnv
): Promise<number> {
  let cursor: string | undefined;
  let scanned = 0;
  let inserted = 0;
  while (scanned < KV_BACKFILL_LIMIT) {
    const page = await env.ARTICLES.list({ cursor, limit: 200 });
    const slugs = page.keys
      .map((k) => k.name)
      .filter((n) => !n.startsWith("__"));
    scanned += slugs.length;
    if (slugs.length > 0) {
      // Bulk INSERT OR IGNORE so existing rows are untouched.
      const stmts = slugs.map((s) =>
        env.DB
          .prepare(
            `INSERT OR IGNORE INTO article_moderation (slug, status, enqueued_at) VALUES (?, 'pending', ?)`
          )
          .bind(s, Date.now())
      );
      try {
        const results = await env.DB.batch(stmts);
        for (const r of results) {
          // D1 result has `meta.changes` (1 if inserted, 0 if ignored).
          inserted += (r as any)?.meta?.changes ?? 0;
        }
      } catch (e) {
        console.error("backfill batch failed", e);
      }
    }
    if (page.list_complete) break;
    cursor = (page as any).cursor;
    if (!cursor) break;
  }
  return inserted;
}

interface BatchOutcome { checked: number; banned: number }

async function sweepOneArticleBatch(env: ModerationEnv): Promise<BatchOutcome> {
  const { results } = await env.DB
    .prepare(
      `SELECT slug FROM article_moderation WHERE status='pending' LIMIT ?`
    )
    .bind(BATCH_SIZE)
    .all<{ slug: string }>();
  if (!results || results.length === 0) return { checked: 0, banned: 0 };

  // Resolve titles. Cheap path: KV metadata. Fallback: deslugify.
  const items: JudgeItem[] = [];
  const slugs: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const slug = results[i].slug;
    slugs.push(slug);
    const title = await readTitle(env.ARTICLES, slug);
    items.push({ index: i + 1, text: title });
  }

  const banned = await judgeBatch(items, "article title", env);

  let bannedCount = 0;
  // Apply verdicts. Bans first (so a partial failure leaves marks consistent).
  for (let i = 0; i < slugs.length; i++) {
    const idx = i + 1;
    if (banned.has(idx)) {
      await banArticle(slugs[i], "auto-flagged in sweep", env);
      bannedCount++;
    } else {
      await markArticleOk(slugs[i], env.DB);
    }
  }
  return { checked: slugs.length, banned: bannedCount };
}

async function sweepOneCommentBatch(env: ModerationEnv): Promise<BatchOutcome> {
  const { results } = await env.DB
    .prepare(
      `SELECT id, body FROM comments WHERE moderation_status='pending' LIMIT ?`
    )
    .bind(BATCH_SIZE)
    .all<{ id: string; body: string }>();
  if (!results || results.length === 0) return { checked: 0, banned: 0 };

  const items: JudgeItem[] = results.map((r, i) => ({
    index: i + 1,
    text: r.body,
  }));

  const banned = await judgeBatch(items, "comment", env);

  let bannedCount = 0;
  for (let i = 0; i < results.length; i++) {
    const idx = i + 1;
    if (banned.has(idx)) {
      await deleteComment(results[i].id, env.DB, "auto-flagged in sweep");
      bannedCount++;
    } else {
      await markCommentOk(results[i].id, env.DB);
    }
  }
  return { checked: results.length, banned: bannedCount };
}

/* -------------------------------------------------------------------------- */
/*  Mutators                                                                   */
/* -------------------------------------------------------------------------- */

async function readTitle(kv: KVNamespace, slug: string): Promise<string> {
  // Metadata is the cheapest path; falls back to slug if missing.
  try {
    const list = await kv.list({ prefix: slug, limit: 1 });
    const k = list.keys.find((x) => x.name === slug);
    const t = (k?.metadata as any)?.title;
    if (typeof t === "string" && t.length > 0) return t;
  } catch {}
  // Fallback: read the JSON.
  try {
    const v = await kv.get(slug, "json") as { title?: string } | null;
    if (v?.title) return v.title;
  } catch {}
  return slug.replace(/-/g, " ");
}

async function banArticle(
  slug: string,
  reason: string,
  env: ModerationEnv
): Promise<void> {
  const now = Date.now();
  try {
    await env.ARTICLES.delete(slug);
  } catch (e) {
    console.error("ban: KV delete failed", slug, e);
  }
  try {
    await env.DB
      .prepare(
        `INSERT INTO article_moderation (slug, status, reason, enqueued_at, checked_at)
         VALUES (?, 'banned', ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET status='banned', reason=excluded.reason, checked_at=excluded.checked_at`
      )
      .bind(slug, reason, now, now)
      .run();
  } catch (e) {
    console.error("ban: DB write failed", slug, e);
  }
  // Also decrement the cached __total counter if present, so the index
  // doesn't lie about how many entries exist.
  try {
    const cur = await env.ARTICLES.get("__total");
    if (cur !== null) {
      const n = parseInt(cur, 10);
      if (Number.isFinite(n) && n > 0) {
        await env.ARTICLES.put("__total", String(n - 1));
      }
    }
  } catch {}
}

async function markArticleOk(slug: string, db: D1Database): Promise<void> {
  const now = Date.now();
  try {
    await db
      .prepare(
        `UPDATE article_moderation SET status='ok', checked_at=?, reason=NULL WHERE slug=?`
      )
      .bind(now, slug)
      .run();
  } catch (e) {
    console.error("markArticleOk failed", e);
  }
}

async function deleteComment(
  id: string,
  db: D1Database,
  _reason: string
): Promise<void> {
  try {
    // Cascade: votes referencing this comment must go too. We don't have ON
    // DELETE CASCADE on the existing schema, so do it manually.
    await db.batch([
      db.prepare("DELETE FROM votes WHERE comment_id = ?").bind(id),
      db.prepare("DELETE FROM comments WHERE id = ?").bind(id),
    ]);
  } catch (e) {
    console.error("deleteComment failed", id, e);
  }
}

async function markCommentOk(id: string, db: D1Database): Promise<void> {
  try {
    await db
      .prepare(`UPDATE comments SET moderation_status='ok' WHERE id=?`)
      .bind(id)
      .run();
  } catch (e) {
    console.error("markCommentOk failed", e);
  }
}
