-- Content moderation: track which articles + comments have been judged by an
-- LLM moderator, and which slugs are banned from re-generation.
--
-- Articles live in KV, not D1, so we keep a parallel moderation row keyed by
-- slug. New articles enter as 'pending'; the moderation sweep ('/api/moderate')
-- judges them in small batches and either marks them 'ok' or 'banned'. A
-- 'banned' row both removes the article from KV and prevents future
-- regeneration of that slug.
--
-- Comments use an in-row moderation_status column since they're already in D1.

CREATE TABLE IF NOT EXISTS article_moderation (
  slug        TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'ok' | 'banned'
  reason      TEXT,
  enqueued_at INTEGER NOT NULL,
  checked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_article_moderation_status
  ON article_moderation(status);

-- Default 'pending' on the new column means existing comments enter the queue
-- automatically and will be drained by the next /api/moderate sweep.
ALTER TABLE comments ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_comments_moderation
  ON comments(moderation_status);
