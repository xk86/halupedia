-- Per-target lore hints. When article A links to /b with a context attribute,
-- we persist the blurb here so that when /b is later generated, the LLM is
-- given all prior authors' descriptions of "b" as ground truth to honor.
-- This is the consistency-while-hallucinating mechanism: every entry seeds
-- lightweight breadcrumbs about its outbound topics for future writers.

CREATE TABLE IF NOT EXISTS link_hints (
  target_slug TEXT NOT NULL,
  source_slug TEXT NOT NULL,
  blurb       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (target_slug, source_slug)
);

CREATE INDEX IF NOT EXISTS idx_link_hints_target ON link_hints(target_slug, created_at DESC);
