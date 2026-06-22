import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { ArticleRecord, ArticleRevision, BacklinkItem, DisambiguationEntry, HomepagePayload, ParsedInternalLink } from "./types";
import { summaryMarkdownFromArticle } from "./markdown";
import { slugify, legacySlugify } from "./slug";
import { makeReversePatch, applyPatch } from "./promptDiff";

// node:sqlite re-parses SQL on every prepare(); memoize statements per
// connection for the hot read paths. Statements are tied to their connection,
// hence the WeakMap keyed by handle (entries die with the connection).
const statementCaches = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

export function prepared(db: DatabaseSync, sql: string): StatementSync {
  let cache = statementCaches.get(db);
  if (!cache) {
    cache = new Map();
    statementCaches.set(db, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function openDatabase(databasePath: string): DatabaseSync {
  const absolutePath = resolve(process.cwd(), databasePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const db = new DatabaseSync(absolutePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
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
      headline_media_id TEXT,
      headline_media_caption TEXT,
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

    -- Slugs the user has blocked from ever being auto-added as references to
    -- an article. Persisted so post-process / refresh / future edits respect
    -- the block until the user re-adds the reference (which unblocks it).
    CREATE TABLE IF NOT EXISTS article_blacklist (
      article_slug TEXT NOT NULL,
      blocked_slug TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (article_slug, blocked_slug)
    );

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

    -- Tombstone table for deleted articles. The slug is preserved here so
    -- deleted content can never be surfaced via lookup or reference lists,
    -- even if the row is gone from the articles table.
    CREATE TABLE IF NOT EXISTS deleted_articles (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      deleted_at INTEGER NOT NULL
    );

    -- Protection: sections the user has locked against automatic rewrites.
    CREATE TABLE IF NOT EXISTS protected_sections (
      article_slug TEXT NOT NULL,
      section_id TEXT NOT NULL,
      heading TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (article_slug, section_id)
    );

    -- Articles displaced by a canonical slug redirect. Full article data
    -- is stored here so admins can restore them if needed.
    CREATE TABLE IF NOT EXISTS archived_articles (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      archived_at INTEGER NOT NULL,
      markdown TEXT NOT NULL,
      html TEXT NOT NULL,
      summary_markdown TEXT NOT NULL DEFAULT '',
      plain_text TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS prompt_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      system_reverse_patch TEXT NOT NULL,
      user_reverse_patch TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'save',
      source_revision_id INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_revisions_key
      ON prompt_revisions(scope, key, created_at DESC, id DESC);

    -- Authoritative current content for each prompt. TOML files are derived
    -- from this table; edits made directly to TOML are ingested into this
    -- table on startup so the DB always reflects the latest state.
    CREATE TABLE IF NOT EXISTS prompt_current (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      system TEXT NOT NULL DEFAULT '',
      user TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    );

    -- Per-article "vibe": a human-authored, canonical statement of the rules,
    -- constraints, and facts for one article. Injected into generation and
    -- rewrite prompts as ground truth, never RAG'd. Versioned the same way as
    -- prompt revisions (reverse patches), but kept in its own tables so the
    -- TOML startup-sync for prompts never touches per-article content.
    CREATE TABLE IF NOT EXISTS article_vibe (
      slug TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS article_vibe_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      reverse_patch TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'save'
    );

    CREATE INDEX IF NOT EXISTS idx_article_vibe_revisions_slug
      ON article_vibe_revisions(slug, created_at DESC, id DESC);

    -- Per-article media attachments. The media_id references the media DB
    -- (cross-database, no FK enforced). caption is the per-usage visible text
    -- shown in the article (defaults to the media description when empty).
    CREATE TABLE IF NOT EXISTS article_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_slug TEXT NOT NULL,
      media_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'headline',
      ordinal INTEGER NOT NULL DEFAULT 1,
      caption TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(article_slug, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_article_media_slug ON article_media(article_slug);

    -- LLM-generated infobox rows (JSON). Separate from article body so
    -- regeneration does not lose the structured metadata.
    CREATE TABLE IF NOT EXISTS article_infobox (
      article_slug TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Audit trail for sidebar changes (infobox + caption).
    -- operation: 'generated' | 'user-edit' | 'ai-edit' | 'restore'
    CREATE TABLE IF NOT EXISTS sidebar_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_slug TEXT NOT NULL,
      infobox_json TEXT NOT NULL DEFAULT '',
      caption TEXT NOT NULL DEFAULT '',
      operation TEXT NOT NULL DEFAULT 'generated',
      changed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sidebar_revisions_slug
      ON sidebar_revisions(article_slug, changed_at DESC, id DESC);

    -- ===== RAG indexing coordination (LanceDB is the vector store) =====
    -- Transactional outbox: content saves enqueue durable indexing work in the
    -- same transaction; a processor drains jobs into LanceDB. Coalesced by source.
    -- operation: 'upsert' | 'delete' | 'rebuild'
    CREATE TABLE IF NOT EXISTS rag_index_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_slug TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      operation TEXT NOT NULL DEFAULT 'upsert',
      expected_hash TEXT,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      completed_at INTEGER,
      UNIQUE(article_slug, source_kind, source_id, operation)
    );
    CREATE INDEX IF NOT EXISTS idx_rag_index_jobs_pending
      ON rag_index_jobs(completed_at, created_at);

    -- Expected vs indexed state per source row (drives reconciliation/coverage).
    -- status: 'pending' | 'current' | 'failed' | 'deleted'
    CREATE TABLE IF NOT EXISTS rag_source_state (
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      article_slug TEXT NOT NULL,
      expected_hash TEXT,
      indexed_hash TEXT,
      indexed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (source_kind, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rag_source_state_article
      ON rag_source_state(article_slug);

    -- ===== Ontology / typed-entity layer (foundational) =====
    -- Canonical entities; an entity may or may not have its own article.
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      article_slug TEXT,
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(canonical_name, entity_type)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_article ON entities(article_slug);

    CREATE TABLE IF NOT EXISTS entity_aliases (
      entity_id INTEGER NOT NULL,
      alias TEXT NOT NULL,
      PRIMARY KEY (entity_id, alias),
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias ON entity_aliases(alias);

    -- scheme: 'ticker' | 'iso_date' | 'coordinate' | 'isin' | ...
    CREATE TABLE IF NOT EXISTS entity_identifiers (
      entity_id INTEGER NOT NULL,
      scheme TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (entity_id, scheme, value),
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );

    -- Category taxonomy: is_core marks controlled-vocabulary categories.
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      parent_id INTEGER,
      is_core INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    -- source: 'extracted' | 'curated'
    CREATE TABLE IF NOT EXISTS article_categories (
      article_slug TEXT NOT NULL,
      category_id INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'extracted',
      confidence REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (article_slug, category_id),
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_article_categories_cat ON article_categories(category_id);

    -- Typed relations. object_entity_id XOR object_literal carries the object.
    -- source: 'extracted' | 'curated' | 'infobox'
    CREATE TABLE IF NOT EXISTS entity_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_entity_id INTEGER NOT NULL,
      predicate TEXT NOT NULL,
      object_entity_id INTEGER,
      object_literal TEXT,
      provenance_slug TEXT,
      provenance_revision_id INTEGER,
      source TEXT NOT NULL DEFAULT 'extracted',
      confidence REAL NOT NULL DEFAULT 1,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (subject_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (object_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      UNIQUE(subject_entity_id, predicate, object_entity_id, object_literal, source)
    );
    CREATE INDEX IF NOT EXISTS idx_entity_relations_subject ON entity_relations(subject_entity_id);
    CREATE INDEX IF NOT EXISTS idx_entity_relations_object ON entity_relations(object_entity_id);
    CREATE INDEX IF NOT EXISTS idx_entity_relations_provenance ON entity_relations(provenance_slug);
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
  if (!hasColumn(db, "articles", "is_protected")) {
    db.exec(`ALTER TABLE articles ADD COLUMN is_protected INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn(db, "article_revisions", "headline_media_id")) {
    db.exec(`ALTER TABLE article_revisions ADD COLUMN headline_media_id TEXT`);
  }
  if (!hasColumn(db, "article_revisions", "headline_media_caption")) {
    db.exec(`ALTER TABLE article_revisions ADD COLUMN headline_media_caption TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_articles_canonical_slug ON articles(canonical_slug)`);
  // Serves the All Pages listing (WHERE is_disambiguation = 0 ORDER BY title
  // COLLATE NOCASE) without a full scan + sort per request.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_articles_title_nocase ON articles(is_disambiguation, title COLLATE NOCASE)`);
  backfillRobustSlugAliases(db);
  return db;
}

/**
 * Articles stored before the robust slugifier are keyed by legacy slugs
 * (punctuation collapsed). Alias each title's robust slug to the stored row so
 * fresh slugify(title) computations — page lookups, body-ref matching, link
 * resolution — keep finding them. Idempotent; never shadows a real article or
 * steals an existing alias.
 */
function backfillRobustSlugAliases(db: DatabaseSync): void {
  const rows = db
    .prepare(`SELECT slug, title FROM articles`)
    .all() as Array<{ slug: string; title: string }>;
  if (rows.length === 0) return;
  const articleSlugs = new Set(rows.map((row) => row.slug));
  const insert = db.prepare(
    `INSERT OR IGNORE INTO article_aliases (alias_slug, article_slug) VALUES (?, ?)`,
  );
  for (const row of rows) {
    const robust = slugify(row.title);
    if (!robust || robust === row.slug || articleSlugs.has(robust)) continue;
    insert.run(robust, row.slug);
  }
}

export function getArticle(db: DatabaseSync, slug: string): ArticleRecord | null {
  const row = prepared(
    db,
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

  const alias = prepared(
    db,
      `SELECT article_slug
       FROM article_aliases
       WHERE alias_slug = ?`
    )
    .get(lookupSlug) as { article_slug: string } | undefined;
  if (!alias) return null;
  return getArticle(db, alias.article_slug);
}

function compactLookupKey(value: string): string {
  return slugify(value).replace(/-/g, "");
}

export function getArticleByEquivalentLookup(db: DatabaseSync, lookupSlug: string): ArticleRecord | null {
  const requestedKey = compactLookupKey(lookupSlug);
  if (!requestedKey) return null;

  const rows = db
    .prepare(
      `SELECT slug, title
       FROM articles
       UNION
       SELECT alias_slug AS slug, '' AS title
       FROM article_aliases`
    )
    .all() as Array<{ slug: string; title: string }>;

  const matchedSlugs = new Set<string>();
  for (const row of rows) {
    if (compactLookupKey(row.slug) === requestedKey) {
      const article = getArticleByLookup(db, row.slug);
      if (article) matchedSlugs.add(article.slug);
      continue;
    }
    if (row.title && compactLookupKey(row.title) === requestedKey) {
      const article = getArticleByLookup(db, row.slug);
      if (article) matchedSlugs.add(article.slug);
    }
  }

  if (matchedSlugs.size !== 1) return null;
  return getArticle(db, Array.from(matchedSlugs)[0]) ?? null;
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
    /** Skip inserting a revision row — use for automatic pipeline repairs that
     *  are not user-visible edits (title normalisation, link cleanup, etc.). */
    skipRevision?: boolean;
  } = {}
): void {
  const now = article.generated_at;
  const summaryMarkdown = article.summaryMarkdown?.trim() || summaryMarkdownFromArticle(article.markdown);
  // Always alias the title's legacy (punctuation-collapsing) slug so links and
  // model-emitted slugs in the old style keep resolving to this article — but
  // never at another article's expense: if the legacy form is already a real
  // article's slug (e.g. "Foo-bar" collapsing onto the existing "Foo bar"
  // article at "foo-bar") or already someone else's alias, leave it alone.
  // Articles win over aliases at lookup time anyway; this guard is what keeps
  // a production DB with historically-colliding titles from being shadowed.
  const aliasSet = new Set(aliases.filter((alias) => alias && alias !== article.slug));
  const legacyAlias = legacySlugify(article.title);
  if (legacyAlias && legacyAlias !== article.slug && !aliasSet.has(legacyAlias)) {
    const occupiedByArticle = db
      .prepare(`SELECT slug FROM articles WHERE slug = ?`)
      .get(legacyAlias) as { slug: string } | undefined;
    const occupiedByAlias = db
      .prepare(`SELECT article_slug FROM article_aliases WHERE alias_slug = ?`)
      .get(legacyAlias) as { article_slug: string } | undefined;
    const occupied =
      !!occupiedByArticle || (!!occupiedByAlias && occupiedByAlias.article_slug !== article.slug);
    if (!occupied) aliasSet.add(legacyAlias);
  }
  aliases = Array.from(aliasSet);
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
      headline_media_id,
      headline_media_caption,
      generated_at,
      created_at,
      operation,
      instructions,
      reverted_from_revision_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    if (!revision.skipRevision) {
      const headlineMedia = getArticleHeadlineMedia(db, article.slug);
      insertRevision.run(
        article.slug,
        article.title,
        article.markdown,
        article.html,
        summaryMarkdown,
        article.plain_text,
        headlineMedia?.mediaId ?? null,
        headlineMedia?.caption ?? null,
        article.generated_at,
        Date.now(),
        revision.operation ?? "update",
        revision.instructions ?? "",
        revision.revertedFromRevisionId ?? null
      );
    }
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
  options: { updateRevisionGeneratedAt?: number } = {},
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
    if (options.updateRevisionGeneratedAt) {
      const revision = db.prepare(
        `SELECT id
         FROM article_revisions
         WHERE article_slug = ? AND generated_at = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      ).get(slug, options.updateRevisionGeneratedAt) as { id: number } | undefined;
      if (revision) {
        db.prepare(
          `UPDATE article_revisions
           SET markdown = ?,
               html = ?,
               summary_markdown = ?,
               plain_text = ?
           WHERE id = ?`,
        ).run(
          fields.markdown,
          fields.html,
          fields.summaryMarkdown,
          fields.plain_text,
          revision.id,
        );
      }
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
  options: { updateRevisionGeneratedAt?: number } = {},
) {
  const article = getArticle(db, slug);
  if (!article) return null;
  db.exec("BEGIN");
  try {
    if (options.updateRevisionGeneratedAt) {
      db.prepare(
        `UPDATE articles SET summary_markdown = ? WHERE slug = ? AND generated_at = ?`,
      ).run(summaryMarkdown, slug, options.updateRevisionGeneratedAt);
      db.prepare(
        `UPDATE article_revisions
         SET summary_markdown = ?
         WHERE article_slug = ? AND generated_at = ?`,
      ).run(summaryMarkdown, article.slug, options.updateRevisionGeneratedAt);
    } else {
      db.prepare(
        `UPDATE articles SET summary_markdown = ? WHERE slug = ?`,
      ).run(summaryMarkdown, slug);
      db.prepare(`
        UPDATE article_revisions
        SET summary_markdown = ?
        WHERE id = (
          SELECT id
          FROM article_revisions
          WHERE article_slug = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        )
      `).run(summaryMarkdown, article.slug);
    }
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

export function listHomepageNewsSourceArticles(
  db: DatabaseSync,
  cutoffGeneratedAt: number,
  count: number,
) {
  const rows = db
    .prepare(
      `SELECT slug,
              COALESCE(canonical_slug, slug) AS canonicalSlug,
              title,
              summary_markdown AS summaryMarkdown,
              markdown,
              plain_text AS plainText,
              generated_at AS generatedAt
       FROM articles
       WHERE is_disambiguation = 0
         AND generated_at <= ?
         AND slug NOT LIKE 'todays-news-day-%'
       ORDER BY generated_at DESC, title COLLATE NOCASE
       LIMIT ?`,
    )
    .all(cutoffGeneratedAt, Math.max(1, count)) as Array<{
      slug: string;
      canonicalSlug: string;
      title: string;
      summaryMarkdown: string;
      markdown: string;
      plainText: string;
      generatedAt: number;
    }>;
  return rows.map((row) => ({
    ...row,
    summaryMarkdown: row.summaryMarkdown?.trim() || summaryMarkdownFromArticle(row.markdown),
  }));
}

export function listHomepageNewsTemporalArticles(
  db: DatabaseSync,
  cutoffGeneratedAt: number,
  terms: string[],
  count: number,
) {
  const normalizedTerms = [...new Set(terms.map((term) => term.trim()).filter(Boolean))]
    .slice(0, 12);
  if (normalizedTerms.length === 0) return [];

  const predicates = normalizedTerms.map(
    () => `(title LIKE ? ESCAPE '\\'
       OR summary_markdown LIKE ? ESCAPE '\\'
       OR plain_text LIKE ? ESCAPE '\\'
       OR markdown LIKE ? ESCAPE '\\')`,
  ).join(" OR ");
  const params = normalizedTerms.flatMap((term) => {
    const pattern = `%${escapeLike(term)}%`;
    return [pattern, pattern, pattern, pattern];
  });

  const rows = db
    .prepare(
      `SELECT slug,
              COALESCE(canonical_slug, slug) AS canonicalSlug,
              title,
              summary_markdown AS summaryMarkdown,
              markdown,
              plain_text AS plainText,
              generated_at AS generatedAt
       FROM articles
       WHERE is_disambiguation = 0
         AND generated_at <= ?
         AND slug NOT LIKE 'todays-news-day-%'
         AND (${predicates})
       ORDER BY generated_at DESC, title COLLATE NOCASE
       LIMIT ?`,
    )
    .all(cutoffGeneratedAt, ...params, Math.max(1, count)) as Array<{
      slug: string;
      canonicalSlug: string;
      title: string;
      summaryMarkdown: string;
      markdown: string;
      plainText: string;
      generatedAt: number;
    }>;
  return rows.map((row) => ({
    ...row,
    summaryMarkdown: row.summaryMarkdown?.trim() || summaryMarkdownFromArticle(row.markdown),
  }));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface HomepageNewsWeatherPlaceCandidate {
  slug: string;
  name: string;
  sourceTitle: string;
  sourceKind: "article" | "link";
  generatedAt: number;
}

export function listHomepageNewsWeatherPlaceCandidates(
  db: DatabaseSync,
  cutoffGeneratedAt: number,
  count: number,
): HomepageNewsWeatherPlaceCandidate[] {
  const placeTerms = [
    " city",
    "city of ",
    " capital",
    " harbor",
    " port",
    " district",
    " settlement",
    " town",
    " village",
    " metropolis",
    " citadel",
    " station",
    " province",
    " prefecture",
  ];
  const articlePredicates = placeTerms.map(() => `(lower(title) LIKE ? OR lower(summary_markdown) LIKE ? OR lower(plain_text) LIKE ?)`).join(" OR ");
  const linkPredicates = placeTerms.map(() => `(lower(l.visible_label) LIKE ? OR lower(l.hidden_hint) LIKE ?)`).join(" OR ");
  const articleParams = placeTerms.flatMap((term) => {
    const pattern = `%${escapeLike(term)}%`;
    return [pattern, pattern, pattern];
  });
  const linkParams = placeTerms.flatMap((term) => {
    const pattern = `%${escapeLike(term)}%`;
    return [pattern, pattern];
  });

  const rows = db
    .prepare(
      `SELECT slug, name, sourceTitle, sourceKind, generatedAt
       FROM (
         SELECT a.slug AS slug,
                a.title AS name,
                a.title AS sourceTitle,
                'article' AS sourceKind,
                a.generated_at AS generatedAt
         FROM articles a
         WHERE a.is_disambiguation = 0
           AND a.generated_at <= ?
           AND a.slug NOT LIKE 'todays-news-day-%'
           AND (${articlePredicates})
         UNION ALL
         SELECT l.target_slug AS slug,
                l.visible_label AS name,
                COALESCE(a.title, l.source_slug) AS sourceTitle,
                'link' AS sourceKind,
                COALESCE(a.generated_at, l.created_at) AS generatedAt
         FROM article_links l
         LEFT JOIN articles a ON a.slug = l.source_slug
         WHERE COALESCE(a.generated_at, l.created_at) <= ?
           AND l.source_slug NOT LIKE 'todays-news-day-%'
           AND l.target_slug NOT LIKE 'todays-news-day-%'
           AND (${linkPredicates})
       )
       ORDER BY generatedAt DESC, name COLLATE NOCASE
       LIMIT ?`,
    )
    .all(
      cutoffGeneratedAt,
      ...articleParams,
      cutoffGeneratedAt,
      ...linkParams,
      Math.max(1, count),
    ) as unknown as HomepageNewsWeatherPlaceCandidate[];
  const byName = new Map<string, HomepageNewsWeatherPlaceCandidate>();
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    if (!key || byName.has(key)) continue;
    byName.set(key, { ...row, name: row.name.trim(), sourceTitle: row.sourceTitle.trim() });
  }
  return [...byName.values()];
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
 * Drop the cached homepage payload so the next refresh regenerates the
 * featured article, Did-you-know facts, and timer timestamps as one unit
 * rather than serving the still-fresh cache untouched.
 */
export function invalidateHomepageCache(db: DatabaseSync): void {
  db.prepare(`DELETE FROM homepage_cache WHERE id = 1`).run();
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

/** Persistently block slugs from being auto-added as references to an article. */
export function addArticleBlacklistSlugs(
  db: DatabaseSync,
  articleSlug: string,
  blockedSlugs: string[],
): void {
  if (blockedSlugs.length === 0) return;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO article_blacklist (article_slug, blocked_slug, created_at)
     VALUES (?, ?, ?)`,
  );
  const now = Date.now();
  for (const blocked of blockedSlugs) {
    const normalized = slugify(blocked);
    if (normalized) insert.run(articleSlug, normalized, now);
  }
}

/** Unblock slugs (e.g. the user re-added them as references). */
export function removeArticleBlacklistSlugs(
  db: DatabaseSync,
  articleSlug: string,
  blockedSlugs: string[],
): void {
  if (blockedSlugs.length === 0) return;
  const remove = db.prepare(
    `DELETE FROM article_blacklist WHERE article_slug = ? AND blocked_slug = ?`,
  );
  for (const blocked of blockedSlugs) {
    const normalized = slugify(blocked);
    if (normalized) remove.run(articleSlug, normalized);
  }
}

export function listArticleBlacklistSlugs(db: DatabaseSync, articleSlug: string): string[] {
  const rows = db
    .prepare(`SELECT blocked_slug FROM article_blacklist WHERE article_slug = ?`)
    .all(articleSlug) as Array<{ blocked_slug: string }>;
  return rows.map((row) => row.blocked_slug);
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
  const latest = prepared(
    db,
      `SELECT saved_at FROM article_references
       WHERE article_slug = ?
       ORDER BY saved_at DESC
       LIMIT 1`,
    )
    .get(articleSlug) as { saved_at: number } | undefined;
  if (!latest) return [];

  const rows = prepared(
    db,
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
  return (prepared(db, `SELECT COUNT(*) AS count FROM articles WHERE is_disambiguation = 0`).get() as { count: number }).count;
}

export function listArticles(db: DatabaseSync, offset: number, limit: number) {
  const items = prepared(
    db,
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
  const totalRow = prepared(db, `SELECT COUNT(*) AS count FROM articles WHERE is_disambiguation = 0`).get() as { count: number };
  return {
    items,
    total: totalRow.count,
    nextOffset: offset + items.length < totalRow.count ? offset + items.length : null,
  };
}

export function searchCorpus(db: DatabaseSync, query: string, limit: number, offset: number = 0): { results: Array<{ slug: string; canonicalSlug: string; title: string; summary: string; existsFlag: number }>; hasMore: boolean } {
  const q = query.toLowerCase();
  const likeContains = `%${q}%`;
  const likeStarts = `${q}%`;

  // Fetch limit+1 to determine if another page exists
  const rawExisting = prepared(
    db,
      `SELECT slug,
              COALESCE(canonical_slug, slug) AS canonicalSlug,
              title,
              summary_markdown AS summaryMarkdown,
              markdown,
              1 AS existsFlag
       FROM articles
       WHERE lower(title) LIKE ? OR lower(slug) LIKE ?
       ORDER BY
         CASE
           WHEN lower(title) = ?       THEN 0
           WHEN lower(title) LIKE ?    THEN 1
           ELSE 2
         END,
         title COLLATE NOCASE ASC
       LIMIT ? OFFSET ?`
    )
    .all(likeContains, likeContains, q, likeStarts, limit + 1, offset) as Array<{ slug: string; canonicalSlug: string; title: string; summaryMarkdown: string; markdown: string; existsFlag: number }>;

  const hasMore = rawExisting.length > limit;
  const pageExisting = rawExisting.slice(0, limit);

  const existingWithSummary = pageExisting.map((row) => ({
    slug: row.slug,
    canonicalSlug: row.canonicalSlug,
    title: row.title,
    summary: row.summaryMarkdown?.trim() || summaryMarkdownFromArticle(row.markdown),
    existsFlag: row.existsFlag,
  }));

  // Only fill with unwritten results on the first page
  const unwrittenWithSummary: Array<{ slug: string; canonicalSlug: string; title: string; summary: string; existsFlag: number }> = [];
  if (offset === 0) {
    const remaining = Math.max(0, limit - pageExisting.length);
    if (remaining > 0) {
      const unwritten = db
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
        .all(likeContains, likeContains, likeContains, remaining) as Array<{ slug: string; canonicalSlug: string; title: string; existsFlag: number }>;
      for (const row of unwritten) {
        unwrittenWithSummary.push({ ...row, summary: "" });
      }
    }
  }

  return { results: [...existingWithSummary, ...unwrittenWithSummary], hasMore };
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
    // Tombstone the slug so it can never be re-surfaced even after the content
    // rows are gone. Aliases that pointed at this article are also tombstoned.
    const now = Date.now();
    const upsertTombstone = db.prepare(
      `INSERT OR REPLACE INTO deleted_articles (slug, title, deleted_at) VALUES (?, ?, ?)`,
    );
    upsertTombstone.run(article.slug, article.title, now);
    // Tombstone all alias slugs too so redirects don't resurface deleted content.
    const aliasRows = db
      .prepare(`SELECT alias_slug FROM article_aliases WHERE article_slug = ?`)
      .all(article.slug) as Array<{ alias_slug: string }>;
    for (const { alias_slug } of aliasRows) {
      upsertTombstone.run(alias_slug, article.title, now);
    }

    // Remove this article from every other article's reference list so deleted
    // content stops appearing in References sections across the wiki.
    db.prepare(`DELETE FROM article_references WHERE referenced_slug = ?`).run(article.slug);
    db.prepare(`DELETE FROM article_see_also WHERE target_slug = ?`).run(article.slug);

    // Remove the article's own content and index entries.
    db.prepare(`DELETE FROM article_chunks WHERE slug = ?`).run(article.slug);
    db.prepare(`DELETE FROM article_links WHERE source_slug = ? OR target_slug = ?`).run(article.slug, article.slug);
    db.prepare(`DELETE FROM article_aliases WHERE article_slug = ? OR alias_slug = ?`).run(article.slug, lookupSlug);
    // Remove all sidecar data so stale metadata never lingers after deletion.
    db.prepare(`DELETE FROM article_infobox WHERE article_slug = ?`).run(article.slug);
    db.prepare(`DELETE FROM article_media WHERE article_slug = ?`).run(article.slug);
    db.prepare(`DELETE FROM article_references WHERE article_slug = ?`).run(article.slug);
    db.prepare(`DELETE FROM article_see_also WHERE article_slug = ?`).run(article.slug);
    db.prepare(`DELETE FROM sidebar_revisions WHERE article_slug = ?`).run(article.slug);
    db.prepare(`DELETE FROM protected_sections WHERE article_slug = ?`).run(article.slug);
    db.prepare(`DELETE FROM articles WHERE slug = ?`).run(article.slug);
    // article_revisions is intentionally preserved for audit purposes.
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Returns true if the slug (or any of its aliases) has been deleted. */
export function isSlugDeleted(db: DatabaseSync, slug: string): boolean {
  const row = db
    .prepare(`SELECT slug FROM deleted_articles WHERE slug = ? LIMIT 1`)
    .get(slug) as { slug: string } | undefined;
  return !!row;
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
              headline_media_id AS headlineMediaId,
              headline_media_caption AS headlineMediaCaption,
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
        headline_media_id,
        headline_media_caption,
        generated_at,
        created_at,
        operation,
        instructions,
        reverted_from_revision_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      article.slug,
      article.title,
      article.markdown,
      article.html,
      summaryMarkdown,
      article.plain_text,
      getArticleHeadlineMedia(db, article.slug)?.mediaId ?? null,
      getArticleHeadlineMedia(db, article.slug)?.caption ?? null,
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
                headline_media_id AS headlineMediaId,
                headline_media_caption AS headlineMediaCaption,
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

export interface ArticleRevisionSnapshotOptions {
  operation: string;
  instructions?: string;
  headlineMediaId?: string | null;
  headlineMediaCaption?: string | null;
}

export function insertArticleRevisionSnapshot(
  db: DatabaseSync,
  lookupSlug: string,
  options: ArticleRevisionSnapshotOptions,
): ArticleRevision | null {
  const article = getArticleByLookup(db, lookupSlug);
  if (!article) return null;
  const headlineMedia =
    options.headlineMediaId === undefined && options.headlineMediaCaption === undefined
      ? getArticleHeadlineMedia(db, article.slug)
      : null;
  const mediaId = options.headlineMediaId ?? headlineMedia?.mediaId ?? null;
  const mediaCaption = options.headlineMediaCaption ?? headlineMedia?.caption ?? null;
  const now = Date.now();
  const result = db.prepare(
    `INSERT INTO article_revisions (
       article_slug,
       title,
       markdown,
       html,
       summary_markdown,
       plain_text,
       headline_media_id,
       headline_media_caption,
       generated_at,
       created_at,
       operation,
       instructions,
       reverted_from_revision_id
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    article.slug,
    article.title,
    article.markdown,
    article.html,
    article.summaryMarkdown ?? "",
    article.plain_text,
    mediaId,
    mediaCaption,
    article.generated_at,
    now,
    options.operation,
    options.instructions ?? "",
    null,
  );
  return getArticleRevision(db, Number(result.lastInsertRowid));
}

export function updateLatestArticleRevisionMediaSnapshot(
  db: DatabaseSync,
  lookupSlug: string,
  headlineMediaId: string | null,
  headlineMediaCaption: string | null,
): boolean {
  const article = getArticleByLookup(db, lookupSlug);
  if (!article) return false;
  const result = db.prepare(
    `UPDATE article_revisions
     SET headline_media_id = ?,
         headline_media_caption = ?
     WHERE id = (
       SELECT id
       FROM article_revisions
       WHERE article_slug = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     )`,
  ).run(headlineMediaId, headlineMediaCaption, article.slug);
  return result.changes > 0;
}

export function updateLatestArticleRevisionCaptionForMedia(
  db: DatabaseSync,
  lookupSlug: string,
  headlineMediaId: string,
  headlineMediaCaption: string,
): boolean {
  const article = getArticleByLookup(db, lookupSlug);
  if (!article) return false;
  const result = db.prepare(
    `UPDATE article_revisions
     SET headline_media_caption = ?
     WHERE id = (
       SELECT id
       FROM article_revisions
       WHERE article_slug = ?
         AND headline_media_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     )`,
  ).run(headlineMediaCaption, article.slug, headlineMediaId);
  return result.changes > 0;
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

// ── Alias management ────────────────────────────────────────────────────────

export interface AliasRow {
  aliasSlug: string;
  articleSlug: string;
}

export interface ArchivedArticleRow {
  slug: string;
  title: string;
  archivedAt: number;
  reason: string;
}

/** Return all aliases for a given canonical article slug. */
export function listAliasesForSlug(db: DatabaseSync, articleSlug: string): AliasRow[] {
  return (db
    .prepare(`SELECT alias_slug AS aliasSlug, article_slug AS articleSlug FROM article_aliases WHERE article_slug = ?`)
    .all(articleSlug) as unknown) as AliasRow[];
}

/** Fuzzy search: find article slugs (and their aliases) whose slug or title contains the query. */
export function searchSlugFuzzy(
  db: DatabaseSync,
  query: string,
): Array<{ slug: string; title: string; aliases: AliasRow[] }> {
  const pattern = `%${slugify(query).replace(/-/g, "%")}%`;
  const rows = (db
    .prepare(
      `SELECT slug, title FROM articles
       WHERE slug LIKE ? OR title LIKE ?
       ORDER BY slug ASC LIMIT 20`,
    )
    .all(pattern, `%${query}%`) as unknown) as Array<{ slug: string; title: string }>;
  return rows.map((row) => ({
    ...row,
    aliases: listAliasesForSlug(db, row.slug),
  }));
}

/** Add a slug alias pointing to an existing article. Throws if the alias already exists. */
export function addSlugAlias(db: DatabaseSync, aliasSlug: string, articleSlug: string): void {
  db.prepare(`INSERT OR REPLACE INTO article_aliases (alias_slug, article_slug) VALUES (?, ?)`)
    .run(aliasSlug, articleSlug);
}

/** Remove a slug alias. */
export function removeSlugAlias(db: DatabaseSync, aliasSlug: string): void {
  db.prepare(`DELETE FROM article_aliases WHERE alias_slug = ?`).run(aliasSlug);
}

// ── Archived articles ────────────────────────────────────────────────────────

/** Archive an article (displaces it without deleting its data). */
export function archiveArticle(
  db: DatabaseSync,
  article: ArticleRecord,
  reason: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO archived_articles
     (slug, title, archived_at, markdown, html, summary_markdown, plain_text, generated_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    article.slug,
    article.title,
    Date.now(),
    article.markdown,
    article.html,
    article.summaryMarkdown ?? "",
    article.plain_text,
    article.generated_at,
    reason,
  );
}

/** List all archived articles (metadata only). */
export function listArchivedArticles(db: DatabaseSync): ArchivedArticleRow[] {
  return (db
    .prepare(
      `SELECT slug, title, archived_at AS archivedAt, reason
       FROM archived_articles ORDER BY archived_at DESC`,
    )
    .all() as unknown) as ArchivedArticleRow[];
}

/** Get one archived article's full data for restoration. */
export function getArchivedArticle(db: DatabaseSync, slug: string): ArticleRecord | null {
  const row = db
    .prepare(`SELECT * FROM archived_articles WHERE slug = ?`)
    .get(slug) as (ArchivedArticleRow & Omit<ArticleRecord, "canonicalSlug" | "isDisambiguation" | "displayTitle">) | undefined;
  if (!row) return null;
  return {
    slug: row.slug,
    canonicalSlug: row.slug,
    title: row.title,
    markdown: (row as any).markdown,
    html: (row as any).html,
    summaryMarkdown: (row as any).summary_markdown ?? "",
    plain_text: (row as any).plain_text,
    generated_at: (row as any).generated_at,
    isDisambiguation: false,
  };
}

/** Remove an archived article (after restore or manual deletion). */
export function deleteArchivedArticle(db: DatabaseSync, slug: string): void {
  db.prepare(`DELETE FROM archived_articles WHERE slug = ?`).run(slug);
}

/**
 * Return articles that reference the given image slug — either inline in the
 * markdown body via the media: scheme (e.g. ![caption](media:some-slug)) or
 * as a sidebar/headline image recorded in article_media.
 */
export function listImageBacklinks(
  db: DatabaseSync,
  imageSlug: string,
): Array<{ slug: string; title: string }> {
  return (db
    .prepare(
      `SELECT DISTINCT a.slug AS slug, a.title AS title
       FROM articles a
       WHERE a.is_disambiguation = 0
         AND (
           a.markdown LIKE ?
           OR a.slug IN (SELECT article_slug FROM article_media WHERE media_id = ?)
         )
       ORDER BY a.title COLLATE NOCASE ASC`,
    )
    .all(`%(media:${imageSlug})%`, imageSlug) as unknown) as Array<{ slug: string; title: string }>;
}

export function listTopArticles(db: DatabaseSync, limit: number): { slug: string; title: string; inboundCount: number }[] {
  return db
    .prepare(
      `SELECT l.target_slug AS slug,
              a.title AS title,
              COUNT(*) AS inboundCount
       FROM article_links l
       JOIN articles a ON a.slug = l.target_slug
       WHERE a.is_disambiguation = 0
       GROUP BY l.target_slug
       ORDER BY inboundCount DESC
       LIMIT ?`
    )
    .all(limit) as { slug: string; title: string; inboundCount: number }[];
}

/**
 * Batch-look-up the headline image (ordinal 1) for a set of article slugs.
 * Returns a Map of slug -> { mediaId, caption } for slugs that have one
 * attached (caption is "" when not yet generated/set).
 */
export function getHeadlineMediaForSlugs(
  db: DatabaseSync,
  slugs: string[],
): Map<string, { mediaId: string; caption: string }> {
  const result = new Map<string, { mediaId: string; caption: string }>();
  if (slugs.length === 0) return result;
  const placeholders = slugs.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT article_slug AS articleSlug, media_id AS mediaId, caption
       FROM article_media
       WHERE ordinal = 1 AND article_slug IN (${placeholders})`,
    )
    .all(...slugs) as { articleSlug: string; mediaId: string; caption: string }[];
  for (const row of rows) result.set(row.articleSlug, { mediaId: row.mediaId, caption: row.caption });
  return result;
}

export function getGraphData(db: DatabaseSync): {
  nodes: { slug: string; title: string; exists: boolean }[];
  links: { source: string; target: string }[];
} {
  const articles = db
    .prepare(`SELECT slug, COALESCE(title, slug) AS title FROM articles WHERE is_disambiguation = 0`)
    .all() as { slug: string; title: string }[];

  const links = db
    .prepare(`SELECT DISTINCT source_slug, target_slug FROM article_links`)
    .all() as { source_slug: string; target_slug: string }[];

  const nodeMap = new Map<string, { slug: string; title: string; exists: boolean }>();
  for (const a of articles) {
    nodeMap.set(a.slug, { slug: a.slug, title: a.title, exists: true });
  }
  for (const l of links) {
    if (!nodeMap.has(l.target_slug)) {
      nodeMap.set(l.target_slug, { slug: l.target_slug, title: l.target_slug, exists: false });
    }
    if (!nodeMap.has(l.source_slug)) {
      nodeMap.set(l.source_slug, { slug: l.source_slug, title: l.source_slug, exists: false });
    }
  }

  return {
    nodes: [...nodeMap.values()],
    links: links.map((l) => ({ source: l.source_slug, target: l.target_slug })),
  };
}

// ── Article & section protection ─────────────────────────────────────────────

export function isArticleProtected(db: DatabaseSync, slug: string): boolean {
  const row = db.prepare(`SELECT is_protected FROM articles WHERE slug = ?`).get(slug) as { is_protected: number } | undefined;
  return row ? Boolean(row.is_protected) : false;
}

export function setArticleProtection(db: DatabaseSync, slug: string, isProtected: boolean): void {
  db.prepare(`UPDATE articles SET is_protected = ? WHERE slug = ?`).run(isProtected ? 1 : 0, slug);
}

export interface ProtectedSectionRow {
  articleSlug: string;
  sectionId: string;
  heading: string;
}

export function listProtectedSections(db: DatabaseSync, articleSlug: string): ProtectedSectionRow[] {
  return (db
    .prepare(`SELECT article_slug AS articleSlug, section_id AS sectionId, heading FROM protected_sections WHERE article_slug = ?`)
    .all(articleSlug) as unknown) as ProtectedSectionRow[];
}

export function isArticleSectionProtected(db: DatabaseSync, articleSlug: string, sectionId: string): boolean {
  const row = db.prepare(`SELECT 1 FROM protected_sections WHERE article_slug = ? AND section_id = ?`).get(articleSlug, sectionId);
  return !!row;
}

export function setArticleSectionProtection(
  db: DatabaseSync,
  articleSlug: string,
  sectionId: string,
  heading: string,
  isProtected: boolean,
): void {
  if (isProtected) {
    db.prepare(`INSERT OR REPLACE INTO protected_sections (article_slug, section_id, heading) VALUES (?, ?, ?)`)
      .run(articleSlug, sectionId, heading);
  } else {
    db.prepare(`DELETE FROM protected_sections WHERE article_slug = ? AND section_id = ?`).run(articleSlug, sectionId);
  }
}

// ── Article media (image attachments) ────────────────────────────────────────

export interface ArticleMediaRow {
  id: number;
  articleSlug: string;
  mediaId: string;
  role: string;
  ordinal: number;
  caption: string;
  createdAt: number;
  updatedAt: number;
}

export function getArticleMediaRows(db: DatabaseSync, articleSlug: string): ArticleMediaRow[] {
  return (db
    .prepare(
      `SELECT id, article_slug AS articleSlug, media_id AS mediaId,
              role, ordinal, caption, created_at AS createdAt, updated_at AS updatedAt
       FROM article_media WHERE article_slug = ? ORDER BY ordinal ASC`,
    )
    .all(articleSlug) as unknown) as ArticleMediaRow[];
}

export function getArticleHeadlineMedia(db: DatabaseSync, articleSlug: string): ArticleMediaRow | null {
  return (db
    .prepare(
      `SELECT id, article_slug AS articleSlug, media_id AS mediaId,
              role, ordinal, caption, created_at AS createdAt, updated_at AS updatedAt
       FROM article_media WHERE article_slug = ? AND ordinal = 1 LIMIT 1`,
    )
    .get(articleSlug) as ArticleMediaRow | undefined) ?? null;
}

export function upsertArticleHeadlineMedia(
  db: DatabaseSync,
  articleSlug: string,
  mediaId: string,
  caption: string = "",
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO article_media (article_slug, media_id, role, ordinal, caption, created_at, updated_at)
     VALUES (?, ?, 'headline', 1, ?, ?, ?)
     ON CONFLICT(article_slug, ordinal) DO UPDATE SET
       media_id = excluded.media_id,
       caption = excluded.caption,
       updated_at = excluded.updated_at`,
  ).run(articleSlug, mediaId, caption, now, now);
}

export function updateArticleMediaCaption(
  db: DatabaseSync,
  articleSlug: string,
  ordinal: number,
  caption: string,
  operation: SidebarOperation = "generated",
  options: { updateArticleRevision?: boolean } = {},
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE article_media SET caption = ?, updated_at = ? WHERE article_slug = ? AND ordinal = ?`,
  ).run(caption, now, articleSlug, ordinal);
  if (ordinal === 1 && options.updateArticleRevision) {
    const headlineMedia = getArticleHeadlineMedia(db, articleSlug);
    if (headlineMedia) {
      updateLatestArticleRevisionCaptionForMedia(db, articleSlug, headlineMedia.mediaId, caption);
    }
  }
  // Record sidebar revision so caption changes are auditable.
  if (ordinal === 1) {
    const infoboxJson = (db
      .prepare(`SELECT json FROM article_infobox WHERE article_slug = ?`)
      .get(articleSlug) as { json: string } | undefined)?.json ?? "";
    db.prepare(
      `INSERT INTO sidebar_revisions (article_slug, infobox_json, caption, operation, changed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(articleSlug, infoboxJson, caption, operation, now);
  }
}

export function removeArticleMedia(db: DatabaseSync, articleSlug: string, ordinal: number): void {
  db.prepare(`DELETE FROM article_media WHERE article_slug = ? AND ordinal = ?`).run(articleSlug, ordinal);
}

// ── Article infobox ───────────────────────────────────────────────────────────

export interface InfoboxGroup {
  label: string;
  rows: Array<{ label: string; value: string }>;
}

export interface InfoboxData {
  title: string;
  subtitle?: string;
  image_ordinal?: number;
  groups: InfoboxGroup[];
}

/** Coerce all leaf values to strings so callers can safely call .includes/.replace. */
export function normalizeInfoboxData(data: unknown): InfoboxData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const title = String(d.title ?? "");
  if (!title) return null;
  const subtitle = d.subtitle != null ? String(d.subtitle) : undefined;
  const groups: InfoboxGroup[] = [];
  for (const g of Array.isArray(d.groups) ? d.groups : []) {
    const group = g as Record<string, unknown>;
    const rows: InfoboxGroup["rows"] = [];
    for (const r of Array.isArray(group.rows) ? group.rows : []) {
      const row = r as Record<string, unknown>;
      const lbl = String(row.label ?? "");
      const val = String(row.value ?? "");
      if (lbl || val) rows.push({ label: lbl, value: val });
    }
    groups.push({ label: String(group.label ?? ""), rows });
  }
  return { title, subtitle, image_ordinal: d.image_ordinal as number | undefined, groups };
}

export function getArticleInfobox(db: DatabaseSync, articleSlug: string): InfoboxData | null {
  const row = db
    .prepare(`SELECT json FROM article_infobox WHERE article_slug = ?`)
    .get(articleSlug) as { json: string } | undefined;
  if (!row) return null;
  try {
    return normalizeInfoboxData(JSON.parse(row.json));
  } catch {
    return null;
  }
}

export type SidebarOperation = "generated" | "user-edit" | "ai-edit" | "restore";

export interface SidebarRevision {
  id: number;
  articleSlug: string;
  infoboxJson: string;
  caption: string;
  operation: SidebarOperation;
  changedAt: number;
}

export function setArticleInfobox(
  db: DatabaseSync,
  articleSlug: string,
  data: InfoboxData,
  operation: SidebarOperation = "generated",
): void {
  const now = Date.now();
  const normalized = normalizeInfoboxData(data) ?? data;
  const json = JSON.stringify(normalized);
  db.prepare(
    `INSERT INTO article_infobox (article_slug, json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(article_slug) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
  ).run(articleSlug, json, now);
  // Record revision for audit/restore.
  const caption = (db
    .prepare(`SELECT caption FROM article_media WHERE article_slug = ? AND ordinal = 1`)
    .get(articleSlug) as { caption: string } | undefined)?.caption ?? "";
  db.prepare(
    `INSERT INTO sidebar_revisions (article_slug, infobox_json, caption, operation, changed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(articleSlug, json, caption, operation, now);
}

export function listSidebarRevisions(db: DatabaseSync, articleSlug: string): SidebarRevision[] {
  return (db
    .prepare(
      `SELECT id,
              article_slug AS articleSlug,
              infobox_json AS infoboxJson,
              caption,
              operation,
              changed_at AS changedAt
       FROM sidebar_revisions
       WHERE article_slug = ?
       ORDER BY changed_at DESC, id DESC`,
    )
    .all(articleSlug) as unknown) as SidebarRevision[];
}

export function getSidebarRevision(db: DatabaseSync, id: number): SidebarRevision | null {
  return (db
    .prepare(
      `SELECT id,
              article_slug AS articleSlug,
              infobox_json AS infoboxJson,
              caption,
              operation,
              changed_at AS changedAt
       FROM sidebar_revisions WHERE id = ?`,
    )
    .get(id) as unknown) as SidebarRevision | null;
}

/**
 * Register lookup aliases for every slug a `title` can derive — the robust
 * slug (`slugify`) and the legacy collapsing slug (`legacySlugify`) — pointing
 * at `articleSlug`. Skips any form that is already a real article's slug or
 * another article's alias, so it never shadows or steals (mirrors the guard in
 * `saveArticle`). Used after a title edit so links built from the *new* title
 * resolve back to the existing article instead of generating a duplicate.
 */
export function aliasTitleSlugs(db: DatabaseSync, articleSlug: string, title: string): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO article_aliases (alias_slug, article_slug) VALUES (?, ?)`,
  );
  const occupiedByArticle = db.prepare(`SELECT slug FROM articles WHERE slug = ?`);
  const occupiedByAlias = db.prepare(`SELECT article_slug FROM article_aliases WHERE alias_slug = ?`);
  const candidates = new Set([slugify(title), legacySlugify(title)].filter(Boolean));
  for (const aliasSlug of candidates) {
    if (aliasSlug === articleSlug) continue;
    if (occupiedByArticle.get(aliasSlug)) continue;
    const existing = occupiedByAlias.get(aliasSlug) as { article_slug: string } | undefined;
    if (existing && existing.article_slug !== articleSlug) continue;
    insert.run(aliasSlug, articleSlug);
  }
}

export function updateArticleTitle(db: DatabaseSync, slug: string, title: string): ArticleRecord | null {
  db.prepare(`UPDATE articles SET title = ? WHERE slug = ?`).run(title, slug);
  // The new title's slug forms must resolve back to this article; otherwise a
  // link built from the renamed title hits an unaliased slug and generates a
  // duplicate (the "Anomalous Article 624: Purple Cheez-Its" vs "...624 Purple
  // Cheez-Its" twins in the index).
  aliasTitleSlugs(db, slug, title);
  return getArticle(db, slug);
}

// ── Prompt revisions ─────────────────────────────────────────────────────────

export interface PromptRevisionRow {
  id: number;
  scope: string;
  key: string;
  createdAt: number;
  source: string;
  sourceRevisionId: number | null;
}

/**
 * Records a save transition. Stores reverse patches so the pre-save state can
 * be reconstructed later. Skips insertion when nothing changed.
 * Returns the new revision id, or null if skipped.
 */
export function recordPromptRevision(
  db: DatabaseSync,
  scope: string,
  key: string,
  oldSystem: string,
  oldUser: string,
  newSystem: string,
  newUser: string,
  source: "save" | "revert" | "startup",
  sourceRevisionId?: number,
): number | null {
  const systemPatch = makeReversePatch(oldSystem, newSystem);
  const userPatch = makeReversePatch(oldUser, newUser);
  if (!systemPatch && !userPatch) return null;
  const result = db
    .prepare(
      `INSERT INTO prompt_revisions (scope, key, created_at, system_reverse_patch, user_reverse_patch, source, source_revision_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(scope, key, Date.now(), systemPatch, userPatch, source, sourceRevisionId ?? null);
  return result.lastInsertRowid as number;
}

/** Returns all revisions for a prompt newest-first. */
export function listPromptRevisions(
  db: DatabaseSync,
  scope: string,
  key: string,
): PromptRevisionRow[] {
  return db
    .prepare(
      `SELECT id, scope, key,
              created_at AS createdAt,
              source,
              source_revision_id AS sourceRevisionId
       FROM prompt_revisions
       WHERE scope = ? AND key = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(scope, key) as unknown as PromptRevisionRow[];
}

/**
 * Reconstructs the content that existed just before revision `targetId` was
 * saved, by walking backwards from the current disk state.
 * Returns null if the revision is not found or a patch fails to apply.
 */
export function reconstructPromptRevision(
  db: DatabaseSync,
  scope: string,
  key: string,
  targetId: number,
  currentSystem: string,
  currentUser: string,
): { system: string; user: string } | null {
  const rows = db
    .prepare(
      `SELECT id, system_reverse_patch AS systemPatch, user_reverse_patch AS userPatch
       FROM prompt_revisions
       WHERE scope = ? AND key = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(scope, key) as Array<{ id: number; systemPatch: string; userPatch: string }>;

  let system = currentSystem;
  let user = currentUser;
  for (const row of rows) {
    const nextSystem = applyPatch(row.systemPatch, system);
    const nextUser = applyPatch(row.userPatch, user);
    if (nextSystem === null || nextUser === null) return null;
    system = nextSystem;
    user = nextUser;
    if (row.id === targetId) return { system, user };
  }
  return null;
}

// ── Prompt current content ────────────────────────────────────────────────────

export function getPromptCurrent(
  db: DatabaseSync,
  scope: string,
  key: string,
): { system: string; user: string } | null {
  const row = db
    .prepare(`SELECT system, user FROM prompt_current WHERE scope = ? AND key = ?`)
    .get(scope, key) as { system: string; user: string } | undefined;
  return row ?? null;
}

export function setPromptCurrent(
  db: DatabaseSync,
  scope: string,
  key: string,
  system: string,
  user: string,
): void {
  db.prepare(
    `INSERT INTO prompt_current (scope, key, system, user, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET
       system = excluded.system,
       user = excluded.user,
       updated_at = excluded.updated_at`,
  ).run(scope, key, system, user, Date.now());
}

export function listAllPromptCurrents(
  db: DatabaseSync,
): Array<{ scope: string; key: string; system: string; user: string }> {
  return db
    .prepare(`SELECT scope, key, system, user FROM prompt_current`)
    .all() as unknown as Array<{ scope: string; key: string; system: string; user: string }>;
}

// ── Article vibe (per-article canonical source) ──────────────────────────────

export type ArticleVibeSource = "save" | "revert" | "hint-seed";

export interface ArticleVibeRevisionRow {
  id: number;
  slug: string;
  createdAt: number;
  source: string;
}

/** Current vibe content for an article (empty string when none set). */
export function getArticleVibe(db: DatabaseSync, slug: string): string {
  const row = db
    .prepare(`SELECT content FROM article_vibe WHERE slug = ?`)
    .get(slug) as { content: string } | undefined;
  return row?.content ?? "";
}

/**
 * Saves a new vibe for an article. Records a reverse patch so the prior content
 * can be reconstructed, then upserts the current content. No-op (returns null)
 * when the content is unchanged. Returns the new revision id otherwise.
 */
export function setArticleVibe(
  db: DatabaseSync,
  slug: string,
  content: string,
  source: ArticleVibeSource = "save",
): number | null {
  const current = getArticleVibe(db, slug);
  if (current === content) return null;
  const patch = makeReversePatch(current, content);
  const result = db
    .prepare(
      `INSERT INTO article_vibe_revisions (slug, created_at, reverse_patch, source)
       VALUES (?, ?, ?, ?)`,
    )
    .run(slug, Date.now(), patch, source);
  db.prepare(
    `INSERT INTO article_vibe (slug, content, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       content = excluded.content,
       updated_at = excluded.updated_at`,
  ).run(slug, content, Date.now());
  return result.lastInsertRowid as number;
}

/** Returns all vibe revisions for an article newest-first. */
export function listArticleVibeRevisions(
  db: DatabaseSync,
  slug: string,
): ArticleVibeRevisionRow[] {
  return db
    .prepare(
      `SELECT id, slug, created_at AS createdAt, source
       FROM article_vibe_revisions
       WHERE slug = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(slug) as unknown as ArticleVibeRevisionRow[];
}

/**
 * Reconstructs the vibe content as it existed just before revision `targetId`
 * was saved, by walking the reverse patches backwards from current content.
 * Returns null if the revision is not found or a patch fails to apply.
 */
export function reconstructArticleVibeRevision(
  db: DatabaseSync,
  slug: string,
  targetId: number,
): string | null {
  const rows = db
    .prepare(
      `SELECT id, reverse_patch AS patch
       FROM article_vibe_revisions
       WHERE slug = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(slug) as Array<{ id: number; patch: string }>;

  let content = getArticleVibe(db, slug);
  for (const row of rows) {
    const next = applyPatch(row.patch, content);
    if (next === null) return null;
    content = next;
    if (row.id === targetId) return content;
  }
  return null;
}

// ===== RAG indexing job queue + source state =====
// Low-level SQL owner for the transactional outbox. Orchestration (build docs,
// embed, upsert to LanceDB) lives in src/server/rag/jobs.ts.

export type RagJobOperation = "upsert" | "delete" | "rebuild";

export interface RagIndexJobRow {
  id: number;
  articleSlug: string;
  sourceKind: string;
  sourceId: string;
  operation: RagJobOperation;
  expectedHash: string | null;
  createdAt: number;
  attempts: number;
  lastError: string | null;
}

export interface EnqueueRagJobInput {
  articleSlug: string;
  sourceKind: string;
  sourceId: string;
  operation?: RagJobOperation;
  expectedHash?: string | null;
}

/**
 * Enqueue (or coalesce) a durable indexing job. Re-enqueuing the same
 * (article, kind, source, operation) refreshes the expected hash and re-opens
 * the job rather than creating a duplicate. Safe to call inside the same
 * transaction as the content save.
 */
export function enqueueRagIndexJob(db: DatabaseSync, input: EnqueueRagJobInput): void {
  const operation = input.operation ?? "upsert";
  prepared(
    db,
    `INSERT INTO rag_index_jobs
       (article_slug, source_kind, source_id, operation, expected_hash, created_at, attempts, last_error, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL)
     ON CONFLICT(article_slug, source_kind, source_id, operation)
     DO UPDATE SET expected_hash = excluded.expected_hash,
                   created_at = excluded.created_at,
                   attempts = 0,
                   last_error = NULL,
                   completed_at = NULL`,
  ).run(
    input.articleSlug,
    input.sourceKind,
    input.sourceId,
    operation,
    input.expectedHash ?? null,
    Date.now(),
  );
}

/** Pending (incomplete) jobs oldest-first. */
export function listPendingRagJobs(db: DatabaseSync, limit = 500): RagIndexJobRow[] {
  return prepared(
    db,
    `SELECT id, article_slug AS articleSlug, source_kind AS sourceKind,
            source_id AS sourceId, operation, expected_hash AS expectedHash,
            created_at AS createdAt, attempts, last_error AS lastError
     FROM rag_index_jobs
     WHERE completed_at IS NULL
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
  ).all(limit) as unknown as RagIndexJobRow[];
}

export function countPendingRagJobs(db: DatabaseSync): number {
  const row = prepared(
    db,
    `SELECT COUNT(*) AS n FROM rag_index_jobs WHERE completed_at IS NULL`,
  ).get() as { n: number };
  return row.n;
}

export function markRagJobComplete(db: DatabaseSync, id: number): void {
  prepared(db, `UPDATE rag_index_jobs SET completed_at = ?, last_error = NULL WHERE id = ?`).run(
    Date.now(),
    id,
  );
}

export function markRagJobFailed(db: DatabaseSync, id: number, error: string): void {
  prepared(
    db,
    `UPDATE rag_index_jobs SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
  ).run(error.slice(0, 2000), id);
}

export interface RagSourceStateInput {
  sourceKind: string;
  sourceId: string;
  articleSlug: string;
  expectedHash?: string | null;
  indexedHash?: string | null;
  status: "pending" | "current" | "failed" | "deleted";
}

export function upsertRagSourceState(db: DatabaseSync, input: RagSourceStateInput): void {
  prepared(
    db,
    `INSERT INTO rag_source_state
       (source_kind, source_id, article_slug, expected_hash, indexed_hash, indexed_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_kind, source_id)
     DO UPDATE SET article_slug = excluded.article_slug,
                   expected_hash = excluded.expected_hash,
                   indexed_hash = excluded.indexed_hash,
                   indexed_at = excluded.indexed_at,
                   status = excluded.status`,
  ).run(
    input.sourceKind,
    input.sourceId,
    input.articleSlug,
    input.expectedHash ?? null,
    input.indexedHash ?? null,
    input.status === "current" ? Date.now() : null,
    input.status,
  );
}

/** Remove all source-state rows for an article (used on delete). */
export function deleteRagSourceStateForArticle(db: DatabaseSync, slug: string): void {
  prepared(db, `DELETE FROM rag_source_state WHERE article_slug = ?`).run(slug);
}

export interface OutboundLinkHint {
  targetSlug: string;
  targetTitle: string;
  hint: string;
}

/**
 * Distinct outbound links from an article with the target's title and the
 * hidden hint recorded at link time. Feeds `link_hint` RAG documents.
 */
export function listOutboundLinkHints(db: DatabaseSync, slug: string): OutboundLinkHint[] {
  return prepared(
    db,
    `SELECT l.target_slug AS targetSlug,
            COALESCE(a.title, l.target_slug) AS targetTitle,
            l.hidden_hint AS hint
     FROM article_links l
     LEFT JOIN articles a ON a.slug = l.target_slug
     WHERE l.source_slug = ?
       AND TRIM(COALESCE(l.hidden_hint, '')) <> ''
     GROUP BY l.target_slug`,
  ).all(slug) as unknown as OutboundLinkHint[];
}
