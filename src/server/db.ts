import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { ArticleRecord, BacklinkItem, ParsedInternalLink } from "./types";

export function openDatabase(databasePath: string): DatabaseSync {
  const absolutePath = resolve(process.cwd(), databasePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const db = new DatabaseSync(absolutePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      slug TEXT PRIMARY KEY,
      canonical_slug TEXT,
      title TEXT NOT NULL,
      markdown TEXT NOT NULL,
      html TEXT NOT NULL,
      plain_text TEXT NOT NULL,
      generated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS article_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_slug TEXT NOT NULL,
      target_slug TEXT NOT NULL,
      visible_label TEXT NOT NULL,
      hidden_hint TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_article_links_source ON article_links(source_slug);
    CREATE INDEX IF NOT EXISTS idx_article_links_target ON article_links(target_slug, created_at DESC);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      parent_id TEXT,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (parent_id) REFERENCES comments(id)
    );

    CREATE TABLE IF NOT EXISTS votes (
      user_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, comment_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (comment_id) REFERENCES comments(id)
    );

    CREATE INDEX IF NOT EXISTS idx_comments_slug ON comments(slug, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);

    CREATE TABLE IF NOT EXISTS article_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding_json TEXT,
      UNIQUE(slug, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS article_aliases (
      alias_slug TEXT PRIMARY KEY,
      article_slug TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_articles_canonical_slug ON articles(canonical_slug);
  `);
  try {
    db.exec(`ALTER TABLE articles ADD COLUMN canonical_slug TEXT`);
  } catch {}
  return db;
}

export function getArticle(db: DatabaseSync, slug: string): ArticleRecord | null {
  return (
    db
      .prepare(
        `SELECT slug,
                COALESCE(canonical_slug, slug) AS canonicalSlug,
                title,
                markdown,
                html,
                plain_text,
                generated_at
         FROM articles
         WHERE slug = ?`
      )
      .get(slug) as ArticleRecord | undefined
  ) ?? null;
}

export function getArticleByLookup(db: DatabaseSync, lookupSlug: string): ArticleRecord | null {
  const direct = getArticle(db, lookupSlug);
  if (direct) return direct;

  const alias = db
    .prepare(
      `SELECT article_slug
       FROM article_aliases
       WHERE alias_slug = ?`
    )
    .get(lookupSlug) as { article_slug: string } | undefined;
  if (!alias) return null;
  return getArticle(db, alias.article_slug);
}

export function getCanonicalSlugForTarget(db: DatabaseSync, targetSlug: string): string {
  const row = db
    .prepare(
      `SELECT COALESCE(canonical_slug, slug) AS canonicalSlug
       FROM articles
       WHERE slug = ?`
    )
    .get(targetSlug) as { canonicalSlug: string } | undefined;
  return row?.canonicalSlug ?? targetSlug;
}

export function saveArticle(
  db: DatabaseSync,
  article: ArticleRecord,
  links: ParsedInternalLink[],
  aliases: string[]
): void {
  const now = article.generated_at;
  const insertArticle = db.prepare(`
    INSERT INTO articles (slug, canonical_slug, title, markdown, html, plain_text, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      canonical_slug = excluded.canonical_slug,
      title = excluded.title,
      markdown = excluded.markdown,
      html = excluded.html,
      plain_text = excluded.plain_text,
      generated_at = excluded.generated_at
  `);
  const deleteLinks = db.prepare(`DELETE FROM article_links WHERE source_slug = ?`);
  const deleteAliases = db.prepare(`DELETE FROM article_aliases WHERE article_slug = ?`);
  const insertAlias = db.prepare(`
    INSERT OR REPLACE INTO article_aliases (alias_slug, article_slug)
    VALUES (?, ?)
  `);
  const insertLink = db.prepare(`
    INSERT INTO article_links (source_slug, target_slug, visible_label, hidden_hint, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    deleteLinks.run(article.slug);
    deleteAliases.run(article.slug);
    for (const link of links) {
      if (link.targetSlug === article.slug) continue;
      insertLink.run(article.slug, link.targetSlug, link.visibleLabel, link.hiddenHint, now);
    }
    for (const alias of aliases) {
      insertAlias.run(alias, article.slug);
    }
    insertArticle.run(
      article.slug,
      article.canonicalSlug,
      article.title,
      article.markdown,
      article.html,
      article.plain_text,
      now
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listIncomingHints(db: DatabaseSync, slug: string): string[] {
  const rows = db
    .prepare(
      `SELECT hidden_hint
       FROM article_links
       WHERE target_slug = ?
       ORDER BY created_at DESC`
    )
    .all(slug) as Array<{ hidden_hint: string }>;
  return rows.map((row) => row.hidden_hint);
}

export function listBacklinks(db: DatabaseSync, slug: string) {
  const rows = db
    .prepare(
      `SELECT l.source_slug AS slug,
              COALESCE(a.title, l.source_slug) AS title,
              l.visible_label AS visibleLabel,
              l.hidden_hint AS hiddenHint,
              l.created_at AS createdAt,
              CASE WHEN a.slug IS NULL THEN 0 ELSE 1 END AS existsFlag
       FROM article_links l
       LEFT JOIN articles a ON a.slug = l.source_slug
       WHERE l.target_slug = ?
       ORDER BY l.created_at DESC, l.source_slug ASC`
    )
    .all(slug) as unknown as Array<BacklinkItem & { existsFlag: number }>;

  return {
    existing: rows.filter((row) => row.existsFlag === 1),
    unwritten: rows.filter((row) => row.existsFlag === 0),
  };
}

export function listArticles(db: DatabaseSync, offset: number, limit: number) {
  const items = db
    .prepare(
      `SELECT slug,
              COALESCE(canonical_slug, slug) AS canonicalSlug,
              title,
              generated_at AS generatedAt
       FROM articles
       ORDER BY title COLLATE NOCASE ASC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Array<{ slug: string; canonicalSlug: string; title: string; generatedAt: number }>;
  const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM articles`).get() as { count: number };
  return {
    items,
    total: totalRow.count,
    nextOffset: offset + items.length < totalRow.count ? offset + items.length : null,
  };
}

export function searchCorpus(db: DatabaseSync, query: string, limit: number) {
  const like = `%${query.toLowerCase()}%`;
  const existing = db
    .prepare(
      `SELECT slug,
              COALESCE(canonical_slug, slug) AS canonicalSlug,
              title,
              1 AS existsFlag
       FROM articles
       WHERE lower(title) LIKE ? OR lower(slug) LIKE ?
       ORDER BY title COLLATE NOCASE ASC
       LIMIT ?`
    )
    .all(like, like, limit) as Array<{ slug: string; canonicalSlug: string; title: string; existsFlag: number }>;

  const remaining = Math.max(0, limit - existing.length);
  const unwritten = remaining
    ? (db
        .prepare(
          `SELECT DISTINCT l.target_slug AS slug,
                  l.target_slug AS canonicalSlug,
                  l.target_slug AS title,
                  0 AS existsFlag
           FROM article_links l
           LEFT JOIN articles a ON a.slug = l.target_slug
           WHERE a.slug IS NULL
             AND (lower(l.target_slug) LIKE ? OR lower(l.hidden_hint) LIKE ? OR lower(l.visible_label) LIKE ?)
           ORDER BY l.created_at DESC
           LIMIT ?`
        )
        .all(like, like, like, remaining) as Array<{ slug: string; canonicalSlug: string; title: string; existsFlag: number }>)
    : [];

  return [...existing, ...unwritten];
}

export function getAdminOverview(db: DatabaseSync) {
  const articleCount = (db.prepare(`SELECT COUNT(*) AS count FROM articles`).get() as { count: number }).count;
  const linkCount = (db.prepare(`SELECT COUNT(*) AS count FROM article_links`).get() as { count: number }).count;
  const aliasCount = (db.prepare(`SELECT COUNT(*) AS count FROM article_aliases`).get() as { count: number }).count;
  const latestArticles = db
    .prepare(
      `SELECT slug,
              COALESCE(canonical_slug, slug) AS canonicalSlug,
              title,
              generated_at AS generatedAt
       FROM articles
       ORDER BY generated_at DESC
       LIMIT 10`
    )
    .all() as Array<{ slug: string; canonicalSlug: string; title: string; generatedAt: number }>;
  return { articleCount, linkCount, aliasCount, latestArticles };
}
