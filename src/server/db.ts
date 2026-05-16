import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { ArticleRecord, ArticleRevision, BacklinkItem, DisambiguationEntry, ParsedInternalLink } from "./types";
import { summaryMarkdownFromArticle } from "./markdown";

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

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
      summary_markdown TEXT NOT NULL DEFAULT '',
      plain_text TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      is_disambiguation INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS article_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_slug TEXT NOT NULL,
      title TEXT NOT NULL,
      markdown TEXT NOT NULL,
      html TEXT NOT NULL,
      summary_markdown TEXT NOT NULL DEFAULT '',
      plain_text TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      operation TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      reverted_from_revision_id INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_article_revisions_slug ON article_revisions(article_slug, created_at DESC, id DESC);
  `);
  if (!hasColumn(db, "articles", "canonical_slug")) {
    db.exec(`ALTER TABLE articles ADD COLUMN canonical_slug TEXT`);
  }
  if (!hasColumn(db, "articles", "summary_markdown")) {
    db.exec(`ALTER TABLE articles ADD COLUMN summary_markdown TEXT NOT NULL DEFAULT ''`);
  }
  if (!hasColumn(db, "articles", "is_disambiguation")) {
    db.exec(`ALTER TABLE articles ADD COLUMN is_disambiguation INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn(db, "articles", "display_title")) {
    db.exec(`ALTER TABLE articles ADD COLUMN display_title TEXT NOT NULL DEFAULT ''`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_articles_canonical_slug ON articles(canonical_slug)`);
  return db;
}

export function getArticle(db: DatabaseSync, slug: string): ArticleRecord | null {
  const row = db
    .prepare(
      `SELECT slug,
              COALESCE(canonical_slug, slug) AS canonicalSlug,
              title,
              COALESCE(NULLIF(display_title, ''), title) AS displayTitle,
              markdown,
              html,
              summary_markdown AS summaryMarkdown,
              plain_text,
              generated_at,
              is_disambiguation AS isDisambiguationFlag
       FROM articles
       WHERE slug = ?`
    )
    .get(slug) as (ArticleRecord & { isDisambiguationFlag?: number }) | undefined;
  if (!row) return null;
  const { isDisambiguationFlag, ...rest } = row;
  return { ...rest, isDisambiguation: Boolean(isDisambiguationFlag) };
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
  aliases: string[],
  revision: {
    operation?: string;
    instructions?: string;
    revertedFromRevisionId?: number | null;
  } = {}
): void {
  const now = article.generated_at;
  const summaryMarkdown = article.summaryMarkdown?.trim() || summaryMarkdownFromArticle(article.markdown);
  const insertArticle = db.prepare(`
    INSERT INTO articles (slug, canonical_slug, title, display_title, markdown, html, summary_markdown, plain_text, generated_at, is_disambiguation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      canonical_slug = excluded.canonical_slug,
      title = excluded.title,
      display_title = excluded.display_title,
      markdown = excluded.markdown,
      html = excluded.html,
      summary_markdown = excluded.summary_markdown,
      plain_text = excluded.plain_text,
      generated_at = excluded.generated_at,
      is_disambiguation = excluded.is_disambiguation
  `);
  const insertRevision = db.prepare(`
    INSERT INTO article_revisions (
      article_slug,
      title,
      markdown,
      html,
      summary_markdown,
      plain_text,
      generated_at,
      created_at,
      operation,
      instructions,
      reverted_from_revision_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      article.displayTitle ?? "",
      article.markdown,
      article.html,
      summaryMarkdown,
      article.plain_text,
      now,
      article.isDisambiguation ? 1 : 0
    );
    insertRevision.run(
      article.slug,
      article.title,
      article.markdown,
      article.html,
      summaryMarkdown,
      article.plain_text,
      article.generated_at,
      Date.now(),
      revision.operation ?? "update",
      revision.instructions ?? "",
      revision.revertedFromRevisionId ?? null
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function updateArticleInPlace(
  db: DatabaseSync,
  slug: string,
  fields: { markdown: string; html: string; summaryMarkdown: string; plain_text: string },
  links: ParsedInternalLink[],
) {
  const now = Date.now();
  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE articles SET markdown = ?, html = ?, summary_markdown = ?, plain_text = ?, generated_at = ? WHERE slug = ?`,
    ).run(fields.markdown, fields.html, fields.summaryMarkdown, fields.plain_text, now, slug);
    db.prepare(`DELETE FROM article_links WHERE source_slug = ?`).run(slug);
    const insertLink = db.prepare(
      `INSERT INTO article_links (source_slug, target_slug, visible_label, hidden_hint, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const link of links) {
      if (link.targetSlug === slug) continue;
      insertLink.run(slug, link.targetSlug, link.visibleLabel, link.hiddenHint, now);
    }
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
              COALESCE(a.summary_markdown, '') AS summaryMarkdown,
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

export function getRandomArticles(db: DatabaseSync, count: number) {
  return db
    .prepare(
      `SELECT slug,
              COALESCE(canonical_slug, slug) AS canonicalSlug,
              title,
              summary_markdown AS summaryMarkdown,
              plain_text AS plainText
       FROM articles
       WHERE is_disambiguation = 0
       ORDER BY RANDOM()
       LIMIT ?`
    )
    .all(count) as Array<{
      slug: string;
      canonicalSlug: string;
      title: string;
      summaryMarkdown: string;
      plainText: string;
    }>;
}

export function countArticles(db: DatabaseSync): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM articles WHERE is_disambiguation = 0`).get() as { count: number }).count;
}

export function listArticles(db: DatabaseSync, offset: number, limit: number) {
  const items = db
    .prepare(
      `SELECT slug,
              COALESCE(canonical_slug, slug) AS canonicalSlug,
              title,
              summary_markdown AS summaryMarkdown,
              generated_at AS generatedAt
       FROM articles
       ORDER BY title COLLATE NOCASE ASC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Array<{ slug: string; canonicalSlug: string; title: string; summaryMarkdown: string; generatedAt: number }>;
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

export function wipeGeneratedCorpus(db: DatabaseSync) {
  db.exec("BEGIN");
  try {
    db.exec(`
      DELETE FROM article_chunks;
      DELETE FROM article_links;
      DELETE FROM article_aliases;
      DELETE FROM articles;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deleteArticleBySlug(db: DatabaseSync, lookupSlug: string) {
  const article = getArticleByLookup(db, lookupSlug);
  if (!article) return false;
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM article_chunks WHERE slug = ?`).run(article.slug);
    db.prepare(`DELETE FROM article_links WHERE source_slug = ? OR target_slug = ?`).run(article.slug, article.slug);
    db.prepare(`DELETE FROM article_aliases WHERE article_slug = ? OR alias_slug = ?`).run(article.slug, lookupSlug);
    db.prepare(`DELETE FROM articles WHERE slug = ?`).run(article.slug);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listArticleRevisions(db: DatabaseSync, lookupSlug: string): ArticleRevision[] {
  const article = getArticleByLookup(db, lookupSlug);
  if (!article) return [];
  const select = db
    .prepare(
      `SELECT id,
              article_slug AS articleSlug,
              title,
              markdown,
              html,
              summary_markdown AS summaryMarkdown,
              plain_text,
              generated_at AS generatedAt,
              created_at AS createdAt,
              operation,
              instructions,
              reverted_from_revision_id AS revertedFromRevisionId
       FROM article_revisions
       WHERE article_slug = ?
       ORDER BY created_at DESC, id DESC`
    );
  let revisions = select.all(article.slug) as unknown as ArticleRevision[];
  if (revisions.length === 0) {
    const summaryMarkdown = article.summaryMarkdown?.trim() || summaryMarkdownFromArticle(article.markdown);
    db.prepare(
      `INSERT INTO article_revisions (
        article_slug,
        title,
        markdown,
        html,
        summary_markdown,
        plain_text,
        generated_at,
        created_at,
        operation,
        instructions,
        reverted_from_revision_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      article.slug,
      article.title,
      article.markdown,
      article.html,
      summaryMarkdown,
      article.plain_text,
      article.generated_at,
      article.generated_at,
      "baseline",
      "Initial history snapshot.",
      null
    );
    revisions = select.all(article.slug) as unknown as ArticleRevision[];
  }
  return revisions;
}

export function getArticleRevision(db: DatabaseSync, id: number): ArticleRevision | null {
  return (
    db
      .prepare(
        `SELECT id,
                article_slug AS articleSlug,
                title,
                markdown,
                html,
                summary_markdown AS summaryMarkdown,
                plain_text,
                generated_at AS generatedAt,
                created_at AS createdAt,
                operation,
                instructions,
                reverted_from_revision_id AS revertedFromRevisionId
         FROM article_revisions
         WHERE id = ?`
      )
      .get(id) as ArticleRevision | undefined
  ) ?? null;
}
