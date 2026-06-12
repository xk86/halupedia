import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { OpenAICompatClient } from "./llm";
import { getPrompt, renderTemplate } from "./prompts";
import type { PromptConfig } from "./types";

const COOKIE_NAME = "hu_uid";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

interface CommentRow {
  id: string;
  slug: string;
  parent_id: string | null;
  user_id: string;
  body: string;
  created_at: number;
  score: number;
}

interface UserRow {
  id: string;
  name: string;
  username: string;
  created_at: number;
}

function setIdentityCookie(c: Context, userId: string) {
  setCookie(c, COOKIE_NAME, userId, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

function sanitizeUsername(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^[0-9_]+/g, "")
    .slice(0, 24);
}

function sanitizeName(input: string): string {
  return input.replace(/[<>"]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

async function generateIdentity(llm: OpenAICompatClient, prompts: PromptConfig) {
  const prompt = getPrompt(prompts, "identity");
  const raw = await llm.chat(
    prompt.system,
    renderTemplate(prompt.user, {
      slug: "",
      link_hints: "",
      rag_context: "",
      article_excerpt: "",
      parent_comment: "",
    }),
    { thinking: prompt.thinking },
  );
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("identity generation returned invalid JSON");
  const parsed = JSON.parse(match[0]) as { name?: string; username?: string };
  const name = sanitizeName(parsed.name ?? "");
  const username = sanitizeUsername(parsed.username ?? "");
  if (!name || username.length < 3) {
    throw new Error("identity generation returned empty fields");
  }
  return { name, username };
}

function fallbackIdentity(id: string) {
  const suffix = id.replace(/[^a-z0-9]/gi, "").slice(-4).toLowerCase() || "anon";
  return {
    name: `Reader ${suffix.toUpperCase()}`,
    username: `reader_${suffix}`,
  };
}

async function ensureUser(c: Context, db: DatabaseSync, llm: OpenAICompatClient, prompts: PromptConfig) {
  const existingId = getCookie(c, COOKIE_NAME);
  if (existingId) {
    const existing = db.prepare(`SELECT id, name, username, created_at FROM users WHERE id = ?`).get(existingId) as UserRow | undefined;
    if (existing) {
      setIdentityCookie(c, existing.id);
      return existing;
    }
  }

  const id = crypto.randomUUID();
  let identity = fallbackIdentity(id);
  try {
    identity = await generateIdentity(llm, prompts);
  } catch {
    // Keep local fallback if the model is unavailable or misbehaves.
  }

  const insert = db.prepare(`
    INSERT INTO users (id, name, username, created_at)
    VALUES (?, ?, ?, ?)
  `);

  let username = identity.username;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      insert.run(id, identity.name, username, Date.now());
      setIdentityCookie(c, id);
      return {
        id,
        name: identity.name,
        username,
        created_at: Date.now(),
      };
    } catch {
      username = `${identity.username.slice(0, 18)}_${Math.floor(Math.random() * 9999)}`;
    }
  }

  throw new Error("could not allocate commenter identity");
}

function buildTree(rows: Array<CommentRow & { name: string; username: string; voted: number }>) {
  const items = rows.map((row) => ({
    id: row.id,
    parent_id: row.parent_id,
    user: {
      id: row.user_id,
      name: row.name,
      username: row.username,
    },
    body: row.body,
    created_at: row.created_at,
    score: row.score,
    voted: Boolean(row.voted),
    children: [] as Array<any>,
  }));

  const byId = new Map(items.map((item) => [item.id, item]));
  const roots: typeof items = [];
  for (const item of items) {
    if (item.parent_id && byId.has(item.parent_id)) {
      byId.get(item.parent_id)?.children.push(item);
    } else {
      roots.push(item);
    }
  }
  return roots;
}

export function registerCommentRoutes(
  app: Hono,
  db: DatabaseSync,
  llm: OpenAICompatClient,
  prompts: PromptConfig
) {
  app.get("/api/comments/:slug", async (c) => {
    const slug = c.req.param("slug");
    const userId = getCookie(c, COOKIE_NAME) ?? "";
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 100);

    const rows = db
      .prepare(
        `SELECT c.id,
                c.slug,
                c.parent_id,
                c.user_id,
                c.body,
                c.created_at,
                CAST((SELECT COUNT(*) FROM votes v WHERE v.comment_id = c.id) AS INTEGER) AS score,
                u.name,
                u.username,
                CASE WHEN EXISTS (
                  SELECT 1 FROM votes v2 WHERE v2.comment_id = c.id AND v2.user_id = ?
                ) THEN 1 ELSE 0 END AS voted
         FROM comments c
         JOIN users u ON u.id = c.user_id
         WHERE c.slug = ?
         ORDER BY c.created_at ASC`
      )
      .all(userId, slug) as unknown as Array<CommentRow & { name: string; username: string; voted: number }>;

    const roots = buildTree(rows);
    const pagedRoots = roots.slice(offset, offset + limit);
    const user = userId
      ? ((db.prepare(`SELECT id, name, username, created_at FROM users WHERE id = ?`).get(userId) as UserRow | undefined) ?? null)
      : null;

    return c.json({
      slug,
      total: rows.length,
      roots_total: roots.length,
      offset,
      limit,
      has_more: offset + limit < roots.length,
      comments: pagedRoots,
      user,
    });
  });

  app.post("/api/comments/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = (await c.req.json().catch(() => ({}))) as { body?: string; parent_id?: string | null };
    const text = (body.body ?? "").trim().slice(0, 2000);
    if (!text) return c.json({ error: "comment body is required" }, 400);

    const user = await ensureUser(c, db, llm, prompts);
    const parentId = body.parent_id ?? null;
    if (parentId) {
      const parent = db.prepare(`SELECT id FROM comments WHERE id = ? AND slug = ?`).get(parentId, slug) as { id: string } | undefined;
      if (!parent) return c.json({ error: "parent comment not found" }, 404);
    }

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    db.prepare(
      `INSERT INTO comments (id, slug, parent_id, user_id, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, slug, parentId, user.id, text, createdAt);
    db.prepare(
      `INSERT OR IGNORE INTO votes (user_id, comment_id, created_at)
       VALUES (?, ?, ?)`
    ).run(user.id, id, createdAt);

    return c.json({
      user,
      comment: {
        id,
        parent_id: parentId,
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
        },
        body: text,
        created_at: createdAt,
        score: 1,
        voted: true,
        children: [],
      },
    });
  });

  app.post("/api/comments/:id/vote", async (c) => {
    const id = c.req.param("id");
    const user = await ensureUser(c, db, llm, prompts);
    const existing = db.prepare(`SELECT 1 FROM votes WHERE user_id = ? AND comment_id = ?`).get(user.id, id);
    if (existing) {
      db.prepare(`DELETE FROM votes WHERE user_id = ? AND comment_id = ?`).run(user.id, id);
    } else {
      db.prepare(`INSERT INTO votes (user_id, comment_id, created_at) VALUES (?, ?, ?)`).run(user.id, id, Date.now());
    }
    const scoreRow = db.prepare(`SELECT COUNT(*) AS count FROM votes WHERE comment_id = ?`).get(id) as { count: number };
    return c.json({
      user,
      voted: !existing,
      score: scoreRow.count,
    });
  });
}
