-- Article-level upvotes. Mirrors the comments/votes pair from 0001_init.sql.
-- KV remains the source of truth for article *content*; D1 owns the vote
-- state and a denormalized title (for the "Top Folios" sidebar query so we
-- don't have to walk KV on every read).
--
-- Rows are inserted lazily on the first upvote — most articles will never
-- accumulate a row, which keeps the table small.

CREATE TABLE IF NOT EXISTS articles (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  score       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- Top-N panel orders by score DESC; an index on score keeps it O(log n).
CREATE INDEX IF NOT EXISTS idx_articles_score ON articles(score DESC);

CREATE TABLE IF NOT EXISTS article_votes (
  user_id     TEXT NOT NULL,
  slug        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, slug),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_article_votes_slug ON article_votes(slug);
