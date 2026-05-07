-- One-time slug migration for the brand rename Hallucinopedia → Halupedia.
-- Move all rows that point at the old root slug to the new one so that
-- the comments, link hints, and moderation history follow the redirect.

-- comments.slug is non-unique → simple update.
UPDATE comments
  SET slug = 'halupedia'
  WHERE slug = 'hallucinopedia';

-- link_hints PK is (target_slug, source_slug). UPDATE OR IGNORE silently
-- skips rows that would collide with an existing pair.
UPDATE OR IGNORE link_hints
  SET target_slug = 'halupedia'
  WHERE target_slug = 'hallucinopedia';
UPDATE OR IGNORE link_hints
  SET source_slug = 'halupedia'
  WHERE source_slug = 'hallucinopedia';

-- article_moderation.slug is PK. Drop any stray 'halupedia' row first so
-- the rename can proceed without a unique-constraint conflict.
DELETE FROM article_moderation WHERE slug = 'halupedia';
UPDATE article_moderation
  SET slug = 'halupedia'
  WHERE slug = 'hallucinopedia';
