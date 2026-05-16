-- Article images, lazily generated and permanently cached.
--
-- The pipeline that fills this table is admin-only (see src/worker/admin.ts
-- enrich-images endpoint). The admin picks a vote threshold, the worker
-- asks an LLM where in each article to insert images, generates UUIDs,
-- stores (uuid, slug, prompt) rows here with status='pending', and
-- rewrites the article HTML in KV to reference /img/<uuid>.
--
-- The first visitor to /img/<uuid> triggers actual image generation
-- (handled by src/worker/images.ts). The image bytes go to R2 under the
-- key `<uuid>`; status flips to 'generated'. Subsequent hits stream
-- straight from R2.
--
-- CRITICAL CREDIT-DRAIN GUARD: /img/<uuid> 404s instantly for any uuid
-- not in this table. UUIDs are only INSERTed inside the admin-gated
-- enrichment flow. So a stranger hitting /img/random-stuff never reaches
-- the image-generation API.

CREATE TABLE IF NOT EXISTS images (
  uuid          TEXT PRIMARY KEY,
  slug          TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | generating | generated | failed
  error         TEXT,
  created_at    INTEGER NOT NULL,
  generated_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_images_slug ON images(slug);
CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
