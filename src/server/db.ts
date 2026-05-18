import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { ArticleRecord, ArticleRevision, BacklinkItem, DisambiguationEntry, HomepagePayload, ParsedInternalLink } from "./types";
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

    CREATE TABLE IF NOT EXISTS homepage_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      generated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );

    -- Each row is one historical homepage snapshot, newest-first via DESC index.
    CREATE TABLE IF NOT EXISTS homepage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_homepage_history_generated
      ON homepage_history(generated_at DESC);

    -- Articles used as references during a save/edit/refresh, grouped by saved_at.
    -- saved_at matches the article's generated_at for that event, making it a
    -- foreign-key-free join: SELECT ... WHERE article_slug = ? ORDER BY saved_at DESC.
    --
    -- A reference is pure metadata about an article. The rendered References
    -- section in the article body is generated algorithmically from these rows
    -- (no LLM involvement). The kind column records whether the source was a
    -- chunk or a whole-article summary; pinned survives ranking/pruning;
    -- revision_id holds the positive revision id this reference was attached
    -- on. In-memory sentinel ids (initial, current, pinned-by-user) are NEVER
    -- written.
    CREATE TABLE IF NOT EXISTS article_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_slug TEXT NOT NULL,
      saved_at INTEGER NOT NULL,
      referenced_slug TEXT NOT NULL,
      referenced_title TEXT NOT NULL,
      referenced_summary_markdown TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'summary',
      pinned INTEGER NOT NULL DEFAULT 0,
      revision_id INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_article_references_slug
      ON article_references(article_slug, saved_at DESC);

    -- See-also entries are sidecar metadata, similar in shape to references
    -- but semantically distinct: the target article does not necessarily
    -- exist yet (it is created lazily when the user clicks the link).
    -- Grouped by saved_at the same way references are.
    CREATE TABLE IF NOT EXISTS article_see_also (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_slug TEXT NOT NULL,
      saved_at INTEGER NOT NULL,
      target_slug TEXT NOT NULL,
      target_title TEXT NOT NULL,
      hint TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_article_see_also_slug
      ON article_see_also(article_slug, saved_at DESC);
  `);
  // Migrate existing article_references rows to include the new reference-list fields.
  if (!hasColumn(db, "article_references", "kind")) {
    db.exec(`ALTER TABLE article_references ADD COLUMN kind TEXT NOT NULL DEFAULT 'summary'`);
  }
  if (!hasColumn(db, "article_references", "pinned")) {
    db.exec(`ALTER TABLE article_references ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn(db, "article_references", "revision_id")) {
    db.exec(`ALTER TABLE article_references ADD COLUMN revision_id INTEGER`);
  }
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

export function getArticleByTitle(db: DatabaseSync, title: string): ArticleRecord | null {
  const row = db
    .prepare(
      `SELECT slug
       FROM articles
       WHERE title = ?
       LIMIT 1`
    )
    .get(title) as { slug: string } | undefined;
  if (!row) return null;
  return getArticle(db, row.slug);
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

export function updateArticleSummary(
  db: DatabaseSync,
  slug: string,
  summaryMarkdown: string,
  revision: {
    operation?: string;
    instructions?: string;
  } = {},
) {
  const article = getArticle(db, slug);
  if (!article) return null;
  const now = Date.now();
  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE articles SET summary_markdown = ?, generated_at = ? WHERE slug = ?`,
    ).run(summaryMarkdown, now, slug);
    db.prepare(`
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
    `).run(
      article.slug,
      article.title,
      article.markdown,
      article.html,
      summaryMarkdown,
      article.plain_text,
      now,
      now,
      revision.operation ?? "summary-regenerate",
      revision.instructions ?? "",
      null,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getArticle(db, slug);
}

export function renameArticleSlug(db: DatabaseSync, currentSlug: string, nextSlug: string) {
  if (!currentSlug || !nextSlug || currentSlug === nextSlug) return false;
  const existing = db.prepare(`SELECT slug FROM articles WHERE slug = ?`).get(nextSlug) as { slug: string } | undefined;
  if (existing) return false;

  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE articles SET slug = ?, canonical_slug = ? WHERE slug = ?`).run(nextSlug, nextSlug, currentSlug);
    db.prepare(`UPDATE article_links SET source_slug = ? WHERE source_slug = ?`).run(nextSlug, currentSlug);
    db.prepare(`UPDATE article_links SET target_slug = ? WHERE target_slug = ?`).run(nextSlug, currentSlug);
    db.prepare(`UPDATE article_chunks SET slug = ? WHERE slug = ?`).run(nextSlug, currentSlug);
    db.prepare(`UPDATE article_revisions SET article_slug = ? WHERE article_slug = ?`).run(nextSlug, currentSlug);
    db.prepare(`UPDATE article_aliases SET article_slug = ? WHERE article_slug = ?`).run(nextSlug, currentSlug);
    db.prepare(`DELETE FROM article_aliases WHERE alias_slug = ?`).run(nextSlug);
    db.prepare(`INSERT OR REPLACE INTO article_aliases (alias_slug, article_slug) VALUES (?, ?)`).run(currentSlug, nextSlug);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface IncomingHint {
  sourceSlug: string;
  sourceTitle: string;
  visibleLabel: string;
  hiddenHint: string;
}

export function listIncomingHints(db: DatabaseSync, slug: string): IncomingHint[] {
  return db
    .prepare(
      `SELECT l.source_slug AS sourceSlug,
              COALESCE(a.title, l.source_slug) AS sourceTitle,
              l.visible_label AS visibleLabel,
              l.hidden_hint AS hiddenHint
       FROM article_links l
       LEFT JOIN articles a ON a.slug = l.source_slug
       WHERE l.target_slug = ?
       ORDER BY l.created_at DESC`
    )
    .all(slug) as unknown as IncomingHint[];
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

  const existing: BacklinkItem[] = rows.filter((row) => row.existsFlag === 1);
  const unwritten: BacklinkItem[] = rows.filter((row) => row.existsFlag === 0);

  // Live scan: find articles that reference this slug via ref: or halu: links but
  // whose entry in article_links is stale (saved before backlink tracking was fixed,
  // or not yet re-saved after a link change). The patterns match the closing syntax
  // so they don't false-positive on slug prefixes.
  const knownSlugs = new Set(rows.map((r) => r.slug));
  const liveRows = db
    .prepare(
      `SELECT slug, title, COALESCE(summary_markdown, '') AS summaryMarkdown, generated_at AS createdAt
       FROM articles
       WHERE slug != ?
         AND is_disambiguation = 0
         AND (
           markdown LIKE ? OR markdown LIKE ? OR markdown LIKE ?
         )`,
    )
    .all(
      slug,
      `%ref:${slug})%`,
      `%halu:${slug} %`,
      `%halu:${slug})%`,
    ) as unknown as Array<{ slug: string; title: string; summaryMarkdown: string; createdAt: number }>;

  for (const row of liveRows) {
    if (knownSlugs.has(row.slug)) continue;
    knownSlugs.add(row.slug);
    existing.push({
      slug: row.slug,
      title: row.title,
      visibleLabel: row.title,
      hiddenHint: "",
      summaryMarkdown: row.summaryMarkdown,
      createdAt: row.createdAt,
    });
  }

  return { existing, unwritten };
}

export function getRandomArticles(db: DatabaseSync, count: number) {
  const rows = db
    .prepare(
      `SELECT slug,
              COALESCE(canonical_slug, slug) AS canonicalSlug,
              title,
              summary_markdown AS summaryMarkdown,
              markdown,
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
      markdown: string;
      plainText: string;
    }>;
  return rows.map((row) => ({
    ...row,
    summaryMarkdown: row.summaryMarkdown?.trim() || summaryMarkdownFromArticle(row.markdown),
  }));
}

export function getRandomSuggestions(db: DatabaseSync, count: number, excludeSlugs: string[] = []) {
  const placeholders = excludeSlugs.map(() => "?").join(",");
  const whereClause = excludeSlugs.length
    ? `WHERE is_disambiguation = 0 AND slug NOT IN (${placeholders})`
    : "WHERE is_disambiguation = 0";
  return db
    .prepare(
      `SELECT slug,
              title,
              summary_markdown AS summaryMarkdown,
              markdown
       FROM articles
       ${whereClause}
       ORDER BY RANDOM()
       LIMIT ?`
    )
    .all(...excludeSlugs, count) as Array<{
      slug: string;
      title: string;
      summaryMarkdown: string;
      markdown: string;
    }>;
}

export function getHomepageCache(db: DatabaseSync): HomepagePayload | null {
  const row = db
    .prepare(
      `SELECT generated_at AS generatedAt,
              payload_json AS payloadJson
       FROM homepage_cache
       WHERE id = 1`
    )
    .get() as { generatedAt: number; payloadJson: string } | undefined;
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payloadJson) as HomepagePayload;
    return {
      ...payload,
      generatedAt: row.generatedAt,
    };
  } catch {
    return null;
  }
}

export function saveHomepageCache(db: DatabaseSync, payload: HomepagePayload): void {
  const json = JSON.stringify(payload);
  db.exec("BEGIN");
  try {
    // Update the single current-cache row
    db.prepare(
      `INSERT INTO homepage_cache (id, generated_at, payload_json)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         generated_at = excluded.generated_at,
         payload_json = excluded.payload_json`,
    ).run(payload.generatedAt, json);

    // Append to history so users can browse prior sets
    db.prepare(
      `INSERT INTO homepage_history (generated_at, payload_json) VALUES (?, ?)`,
    ).run(payload.generatedAt, json);

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Return the most-recent `limit` historical homepage snapshots, newest first.
 * Does not include the `expiresAt` field (it is no longer meaningful for history).
 */
export function listHomepageHistory(
  db: DatabaseSync,
  limit: number,
): HomepagePayload[] {
  const rows = db
    .prepare(
      `SELECT generated_at AS generatedAt, payload_json AS payloadJson
       FROM homepage_history
       ORDER BY generated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(Math.max(1, limit)) as Array<{
    generatedAt: number;
    payloadJson: string;
  }>;

  return rows.flatMap((row) => {
    try {
      const parsed = JSON.parse(row.payloadJson) as HomepagePayload;
      return [{ ...parsed, generatedAt: row.generatedAt }];
    } catch {
      return [];
    }
  });
}

import type {
  ReferenceList,
  ReferenceListEntry,
  ReferenceKind,
  ReferenceRevisionId,
} from "./types";

/**
 * @deprecated Use ReferenceListEntry from types.ts. Retained as a transitional
 * alias so older call sites continue to compile while the migration to the
 * unified reference path completes.
 */
export interface ArticleReference {
  slug: string;
  title: string;
  summaryMarkdown: string;
}

/**
 * Resolve a possibly-sentinel revisionId down to the integer value (or null)
 * that the database is allowed to store. Sentinels are in-memory bookkeeping
 * only and must never round-trip through SQLite.
 */
function revisionIdForStorage(id: ReferenceRevisionId): number | null {
  return typeof id === "number" ? id : null;
}

/**
 * Hydrate a stored row back into a ReferenceListEntry. Rows pre-dating the
 * pinned/kind/revision columns will report defaults; older callers using the
 * legacy ArticleReference shape can ignore the extra fields.
 */
function rowToReferenceEntry(row: {
  slug: string;
  title: string;
  summaryMarkdown: string;
  kind?: string;
  pinned?: number;
  revision_id?: number | null;
}): ReferenceListEntry {
  const kind: ReferenceKind = row.kind === "chunk" ? "chunk" : "summary";
  const revisionId: ReferenceRevisionId =
    typeof row.revision_id === "number" && row.revision_id >= 0
      ? row.revision_id
      : "initial";
  // `summaryMarkdown` is retained as a legacy alias for `content` so older
  // callers (including tests) that haven't migrated to the new field name
  // continue to work. Once those callers are updated this duplication can
  // be removed.
  const content = row.summaryMarkdown ?? "";
  return {
    slug: row.slug,
    title: row.title,
    content,
    summaryMarkdown: content,
    kind,
    pinned: Boolean(row.pinned),
    revisionId,
  } as ReferenceListEntry;
}

/**
 * Persist the reference list for an article at a given save event.
 *
 * `savedAt` should equal the article's `generated_at` so this set can be
 * retrieved without a foreign-key join. Sentinel revisionIds are coerced to
 * NULL; only positive integers reach the database.
 *
 * Accepts the new `ReferenceList` shape or the legacy `ArticleReference[]`
 * shape during migration. New call sites should pass `ReferenceList`.
 */
export function saveArticleReferences(
  db: DatabaseSync,
  articleSlug: string,
  savedAt: number,
  references: ReferenceList | ArticleReference[],
): void {
  if (references.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO article_references
       (article_slug, saved_at, referenced_slug, referenced_title,
        referenced_summary_markdown, kind, pinned, revision_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  try {
    for (const ref of references) {
      const entry = ref as Partial<ReferenceListEntry> & ArticleReference;
      const content = entry.content ?? entry.summaryMarkdown ?? "";
      const kind: ReferenceKind = entry.kind === "chunk" ? "chunk" : "summary";
      const pinned = entry.pinned ? 1 : 0;
      const revisionId = revisionIdForStorage(entry.revisionId ?? "initial");
      insert.run(
        articleSlug,
        savedAt,
        ref.slug,
        ref.title,
        content,
        kind,
        pinned,
        revisionId,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Return the most-recent persisted reference list for an article.
 *
 * Returns an empty list when no references have been saved yet. The returned
 * entries are fully-typed `ReferenceListEntry` objects; legacy fields are
 * still populated for transitional consumers.
 */
export function getLatestArticleReferences(
  db: DatabaseSync,
  articleSlug: string,
): ReferenceList {
  const latest = db
    .prepare(
      `SELECT saved_at FROM article_references
       WHERE article_slug = ?
       ORDER BY saved_at DESC
       LIMIT 1`,
    )
    .get(articleSlug) as { saved_at: number } | undefined;
  if (!latest) return [];

  const rows = db
    .prepare(
      `SELECT referenced_slug AS slug,
              referenced_title AS title,
              referenced_summary_markdown AS summaryMarkdown,
              kind,
              pinned,
              revision_id
       FROM article_references
       WHERE article_slug = ? AND saved_at = ?`,
    )
    .all(articleSlug, latest.saved_at) as Array<{
      slug: string;
      title: string;
      summaryMarkdown: string;
      kind?: string;
      pinned?: number;
      revision_id?: number | null;
    }>;
  return rows.map(rowToReferenceEntry);
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
       WHERE is_disambiguation = 0
       ORDER BY title COLLATE NOCASE ASC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Array<{ slug: string; canonicalSlug: string; title: string; summaryMarkdown: string; generatedAt: number }>;
  const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM articles WHERE is_disambiguation = 0`).get() as { count: number };
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
              summary_markdown AS summaryMarkdown,
              markdown,
              1 AS existsFlag
       FROM articles
       WHERE lower(title) LIKE ? OR lower(slug) LIKE ?
       ORDER BY title COLLATE NOCASE ASC
       LIMIT ?`
    )
    .all(like, like, limit) as Array<{ slug: string; canonicalSlug: string; title: string; summaryMarkdown: string; markdown: string; existsFlag: number }>;

  const existingWithSummary = existing.map((row) => ({
    slug: row.slug,
    canonicalSlug: row.canonicalSlug,
    title: row.title,
    summary: row.summaryMarkdown?.trim() || summaryMarkdownFromArticle(row.markdown),
    existsFlag: row.existsFlag,
  }));

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

  const unwrittenWithSummary = unwritten.map((row) => ({
    ...row,
    summary: "",
  }));

  return [...existingWithSummary, ...unwrittenWithSummary];
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

// ---------------------------------------------------------------------------
// See-also storage
// ---------------------------------------------------------------------------
//
// See-also is sidecar metadata. The current `articles.markdown` column still
// contains a baked-in "See also" section for transitional purposes, but the
// authoritative location is `article_see_also`. New code paths should read
// and write here; the body markdown will eventually omit the section
// entirely (see `article.ts` for the typed Article contract).

/** Persistence shape for a see-also entry; matches `SeeAlsoEntry` in article.ts. */
export interface StoredSeeAlsoEntry {
  slug: string;
  title: string;
  hint: string;
}

/**
 * Persist the see-also list for an article at a given save event.
 * Matches the saved_at convention used by article_references.
 */
export function saveArticleSeeAlso(
  db: DatabaseSync,
  articleSlug: string,
  savedAt: number,
  entries: StoredSeeAlsoEntry[],
): void {
  if (entries.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO article_see_also (article_slug, saved_at, target_slug, target_title, hint)
     VALUES (?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  try {
    for (const entry of entries) {
      insert.run(articleSlug, savedAt, entry.slug, entry.title, entry.hint ?? "");
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Return the most-recent see-also list for an article. Empty when none saved.
 */
export function getLatestArticleSeeAlso(
  db: DatabaseSync,
  articleSlug: string,
): StoredSeeAlsoEntry[] {
  const latest = db
    .prepare(
      `SELECT saved_at FROM article_see_also
       WHERE article_slug = ?
       ORDER BY saved_at DESC
       LIMIT 1`,
    )
    .get(articleSlug) as { saved_at: number } | undefined;
  if (!latest) return [];

  return db
    .prepare(
      `SELECT target_slug AS slug, target_title AS title, hint
       FROM article_see_also
       WHERE article_slug = ? AND saved_at = ?`,
    )
    .all(articleSlug, latest.saved_at) as unknown as StoredSeeAlsoEntry[];
}
