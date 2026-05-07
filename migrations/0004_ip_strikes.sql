-- Track the originating IP for each article moderation row so we can block
-- IPs that accumulate bans (a botnet's first 2-3 spam slugs still cost tokens
-- to moderate, but the 4th+ gets refused outright before LLM generation).
--
-- Existing rows stay NULL; only new submissions get tagged. The bot's prior
-- bans don't count, but they accumulate quickly enough that this is fine.

ALTER TABLE article_moderation ADD COLUMN created_ip TEXT;

-- Composite index for the strike-count query:
--   SELECT COUNT(*) FROM article_moderation
--    WHERE created_ip = ? AND status = 'banned' AND checked_at > ?
CREATE INDEX IF NOT EXISTS idx_article_moderation_ip_banned
  ON article_moderation(created_ip, status, checked_at);
