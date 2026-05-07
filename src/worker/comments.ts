import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  hallucinateIdentity,
  fallbackIdentity,
  type Identity,
} from "./identity";
import { slugify } from "./slug";
import { rateLimit, clientIp } from "./ratelimit";
import { moderateCommentNow } from "./moderation";

export interface CommentsEnv {
  DB: D1Database;
  ARTICLES: KVNamespace;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_MODERATION_MODEL?: string;
  IDENT_PER_IP_PER_HOUR?: string;
}

const COOKIE_NAME = "hu_uid";
// Browsers (and Hono) cap cookie Max-Age at 400 days per RFC 6265bis. We
// refresh the cookie on every authenticated request so active users never
// actually expire.
const COOKIE_MAX_AGE = 60 * 60 * 24 * 400;
const MAX_BODY_LEN = 2000;
const MAX_COMMENTS_PER_SLUG = 500;

export interface UserRow {
  id: string;
  name: string;
  username: string;
  created_at: number;
}

export interface CommentRow {
  id: string;
  slug: string;
  parent_id: string | null;
  user_id: string;
  body: string;
  created_at: number;
  score: number;
}

export interface CommentDTO {
  id: string;
  parent_id: string | null;
  user: { id: string; name: string; username: string };
  body: string;
  created_at: number;
  score: number;
  voted: boolean;
  children: CommentDTO[];
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function setIdentityCookie(c: any, userId: string, secure: boolean): void {
  setCookie(c, COOKIE_NAME, userId, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure,
    maxAge: COOKIE_MAX_AGE,
  });
}

async function lookupUser(
  db: D1Database,
  id: string | undefined
): Promise<UserRow | null> {
  if (!id) return null;
  const row = await db
    .prepare("SELECT id, name, username, created_at FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
  return row ?? null;
}

/**
 * Ensure the request has an associated user row. If the cookie points at an
 * unknown id (or there's no cookie at all) we hallucinate a fresh identity,
 * persist it, and stamp the cookie. Returns the user.
 *
 * Username collisions are extremely unlikely but cheap to retry: we attempt
 * insertion up to 4 times with progressively varied usernames.
 */
async function ensureUser(
  c: any,
  env: CommentsEnv
): Promise<UserRow> {
  const secure = new URL(c.req.url).protocol === "https:";
  const existingId = getCookie(c, COOKIE_NAME);
  const existing = await lookupUser(env.DB, existingId);
  if (existing) {
    // Refresh the cookie so its 400-day window slides forward on every visit.
    setIdentityCookie(c, existing.id, secure);
    return existing;
  }

  const id = crypto.randomUUID();

  // Per-IP guard on identity creation — stops UA-forging botnets from
  // burning tokens by repeatedly minting fresh users.
  const ip = clientIp(c);
  const perHour = parseInt(env.IDENT_PER_IP_PER_HOUR || "10", 10);
  const rl = await rateLimit({
    kv: env.ARTICLES,
    bucket: "ident",
    ip,
    limit: perHour,
    windowSec: 3600,
  });
  if (!rl.ok) {
    const err: any = new Error(
      `slow down — at most ${rl.limit} new identities per hour from one address`
    );
    err.status = 429;
    err.retryAfter = rl.retryAfter;
    throw err;
  }

  // Try AI first; fall back to local generator on error.
  let identity: Identity;
  try {
    identity = await hallucinateIdentity(
      env.OPENROUTER_API_KEY,
      env.OPENROUTER_MODEL || "google/gemini-2.5-flash-lite"
    );
  } catch {
    identity = fallbackIdentity(id);
  }

  const created_at = Date.now();
  let attempt = 0;
  let usernameToTry = identity.username;
  while (attempt < 5) {
    try {
      await env.DB
        .prepare(
          "INSERT INTO users (id, name, username, created_at) VALUES (?, ?, ?, ?)"
        )
        .bind(id, identity.name, usernameToTry, created_at)
        .run();
      setIdentityCookie(c, id, secure);
      return {
        id,
        name: identity.name,
        username: usernameToTry,
        created_at,
      };
    } catch (err: any) {
      // UNIQUE constraint on username — retry with a numeric suffix.
      const msg = String(err?.message ?? err);
      if (!/UNIQUE|constraint/i.test(msg)) throw err;
      attempt++;
      const suffix = Math.floor(Math.random() * 9999);
      usernameToTry = `${identity.username.slice(0, 18)}_${suffix}`;
    }
  }
  throw new Error("could not allocate username after retries");
}

function rowToDTO(
  row: CommentRow,
  user: { id: string; name: string; username: string },
  voted: boolean
): CommentDTO {
  return {
    id: row.id,
    parent_id: row.parent_id,
    user,
    body: row.body,
    created_at: row.created_at,
    score: row.score,
    voted,
    children: [],
  };
}

function buildTree(flat: CommentDTO[]): CommentDTO[] {
  const byId = new Map<string, CommentDTO>();
  for (const c of flat) byId.set(c.id, c);
  const roots: CommentDTO[] = [];
  for (const c of flat) {
    if (c.parent_id && byId.has(c.parent_id)) {
      byId.get(c.parent_id)!.children.push(c);
    } else {
      roots.push(c);
    }
  }
  // HN-style: sort by score desc, then created_at asc.
  const sortRec = (list: CommentDTO[]) => {
    list.sort((a, b) => b.score - a.score || a.created_at - b.created_at);
    list.forEach((c) => sortRec(c.children));
  };
  sortRec(roots);
  return roots;
}

/* -------------------------------------------------------------------------- */
/*  Routes                                                                     */
/* -------------------------------------------------------------------------- */

export function createCommentsApp() {
  const app = new Hono<{ Bindings: CommentsEnv }>();

  /** Current viewer; null until they comment for the first time. */
  app.get("/api/me", async (c) => {
    const id = getCookie(c, COOKIE_NAME);
    const user = await lookupUser(c.env.DB, id);
    if (!user) return c.json({ user: null });
    return c.json({
      user: { id: user.id, name: user.name, username: user.username },
    });
  });

  /** Threaded comments for an article slug. */
  app.get("/api/comments/:slug", async (c) => {
    const slug = slugify(c.req.param("slug"));
    if (!slug) return c.json({ error: "invalid slug" }, 400);

    const viewerId = getCookie(c, COOKIE_NAME);
    const viewer = await lookupUser(c.env.DB, viewerId);

    // Pull comments + author info in a single join.
    const { results } = await c.env.DB
      .prepare(
        `SELECT c.id, c.slug, c.parent_id, c.user_id, c.body, c.created_at, c.score,
                u.name AS u_name, u.username AS u_username
           FROM comments c
           JOIN users u ON u.id = c.user_id
          WHERE c.slug = ?
          ORDER BY c.created_at ASC
          LIMIT ?`
      )
      .bind(slug, MAX_COMMENTS_PER_SLUG)
      .all<
        CommentRow & { u_name: string; u_username: string }
      >();

    let votedSet = new Set<string>();
    if (viewer && results.length > 0) {
      const ids = results.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      const v = await c.env.DB
        .prepare(
          `SELECT comment_id FROM votes WHERE user_id = ? AND comment_id IN (${placeholders})`
        )
        .bind(viewer.id, ...ids)
        .all<{ comment_id: string }>();
      votedSet = new Set(v.results.map((r) => r.comment_id));
    }

    const flat = results.map((r) =>
      rowToDTO(
        r,
        { id: r.user_id, name: r.u_name, username: r.u_username },
        votedSet.has(r.id)
      )
    );
    const tree = buildTree(flat);

    return c.json({
      slug,
      total: flat.length,
      comments: tree,
      user: viewer
        ? { id: viewer.id, name: viewer.name, username: viewer.username }
        : null,
    });
  });

  /** Post a comment (creates a user on first contact). */
  app.post("/api/comments/:slug", async (c) => {
    const slug = slugify(c.req.param("slug"));
    if (!slug) return c.json({ error: "invalid slug" }, 400);

    let payload: any;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const body = typeof payload?.body === "string" ? payload.body.trim() : "";
    const parent_id =
      typeof payload?.parent_id === "string" && payload.parent_id
        ? payload.parent_id
        : null;

    if (!body) return c.json({ error: "comment is empty" }, 400);
    if (body.length > MAX_BODY_LEN) {
      return c.json({ error: `comment exceeds ${MAX_BODY_LEN} chars` }, 400);
    }

    if (parent_id) {
      const parent = await c.env.DB
        .prepare("SELECT id, slug FROM comments WHERE id = ?")
        .bind(parent_id)
        .first<{ id: string; slug: string }>();
      if (!parent || parent.slug !== slug) {
        return c.json({ error: "parent not found" }, 400);
      }
    }

    let user: UserRow;
    try {
      user = await ensureUser(c, c.env);
    } catch (e: any) {
      if (e?.status === 429) {
        return c.json({ error: e.message }, 429, {
          "retry-after": String(e.retryAfter ?? 60),
        });
      }
      throw e;
    }

    const id = crypto.randomUUID();
    const created_at = Date.now();

    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO comments (id, slug, parent_id, user_id, body, created_at, score)
           VALUES (?, ?, ?, ?, ?, ?, 1)`
        )
        .bind(id, slug, parent_id, user.id, body, created_at),
      // Author auto-upvotes their own post (matches HN behavior).
      c.env.DB
        .prepare(
          `INSERT INTO votes (user_id, comment_id, created_at) VALUES (?, ?, ?)`
        )
        .bind(user.id, id, created_at),
    ]);

    const dto: CommentDTO = {
      id,
      parent_id,
      user: { id: user.id, name: user.name, username: user.username },
      body,
      created_at,
      score: 1,
      voted: true,
      children: [],
    };

    // Background moderation: accept the comment immediately, then judge it
    // out-of-band. If banned, moderateCommentNow deletes it (and its votes).
    c.executionCtx.waitUntil(
      moderateCommentNow(id, body, c.env).catch((e) =>
        console.error("comment moderation failed", e)
      )
    );

    return c.json({
      comment: dto,
      user: { id: user.id, name: user.name, username: user.username },
    });
  });

  /** Toggle upvote on a comment. */
  app.post("/api/comments/:id/vote", async (c) => {
    const commentId = c.req.param("id");
    const target = await c.env.DB
      .prepare("SELECT id, score FROM comments WHERE id = ?")
      .bind(commentId)
      .first<{ id: string; score: number }>();
    if (!target) return c.json({ error: "comment not found" }, 404);

    let user: UserRow;
    try {
      user = await ensureUser(c, c.env);
    } catch (e: any) {
      if (e?.status === 429) {
        return c.json({ error: e.message }, 429, {
          "retry-after": String(e.retryAfter ?? 60),
        });
      }
      throw e;
    }

    const existing = await c.env.DB
      .prepare(
        "SELECT user_id FROM votes WHERE user_id = ? AND comment_id = ?"
      )
      .bind(user.id, commentId)
      .first();

    if (existing) {
      await c.env.DB.batch([
        c.env.DB
          .prepare(
            "DELETE FROM votes WHERE user_id = ? AND comment_id = ?"
          )
          .bind(user.id, commentId),
        c.env.DB
          .prepare(
            "UPDATE comments SET score = MAX(score - 1, 0) WHERE id = ?"
          )
          .bind(commentId),
      ]);
      return c.json({
        voted: false,
        score: Math.max(target.score - 1, 0),
        user: { id: user.id, name: user.name, username: user.username },
      });
    } else {
      await c.env.DB.batch([
        c.env.DB
          .prepare(
            "INSERT INTO votes (user_id, comment_id, created_at) VALUES (?, ?, ?)"
          )
          .bind(user.id, commentId, Date.now()),
        c.env.DB
          .prepare("UPDATE comments SET score = score + 1 WHERE id = ?")
          .bind(commentId),
      ]);
      return c.json({
        voted: true,
        score: target.score + 1,
        user: { id: user.id, name: user.name, username: user.username },
      });
    }
  });

  return app;
}
