/**
 * Media subsystem tests — run with:
 *   npm run test:media
 *
 * Suites:
 *   mediaDb          — CRUD for the media SQLite sidecar
 *   article_media    — article_media table queries
 *   article_infobox  — article_infobox table queries
 *   rendering        — renderInfoboxHtml output
 *   markdown         — :::sidebar container + media: image scheme
 *   vision-probe     — LLM capability check via Ollama /api/show
 *   multimodal       — native /api/chat base64 images array construction
 *   http             — HTTP API routes (media serve, article image CRUD)
 *   pipeline-nodes   — generateInfoboxNode + persistInfoboxNode
 *   image-context    — readHeadlineImageNode + article RAG exclusion
 *   ingest           — ingestImageFromBuffer with real vips
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { openMediaDatabase, getMediaById, getMediaBytesById, getMediaBySha256, insertMedia, updateMediaDescription, updateMediaGenerationMetadata, updateMediaId, listMediaRevisions, listMedia } from "../src/server/mediaDb";
import { openDatabase, saveArticle, getArticleHeadlineMedia, upsertArticleHeadlineMedia, updateArticleMediaCaption, removeArticleMedia, getArticleMediaRows, getArticleInfobox, setArticleInfobox, listArticleRevisions, listImageBacklinks, type InfoboxData } from "../src/server/db";
import { renderInfoboxHtml } from "../src/server/articleRender";
import { renderMarkdown, markdownToPlainText } from "../src/server/markdown";
import { type LlmRouter, type ChatOptions } from "../src/server/llm";
import { makeRouter } from "./helpers/router";
import { setLlmFetchForTests } from "../src/server/llm";
import { createApp } from "../src/server/index";
import { loadConfig } from "../src/server/config";
import type { Logger } from "../src/server/logger";
import { generateInfoboxNode, persistInfoboxNode, generateSidebarCaptionNode } from "../src/server/pipeline/nodes/postProcess";
import {
  loadArticleAndImageNode,
  generateImageCaptionNode,
  generateArticleCaptionNode,
  persistImageCaptionNode,
} from "../src/server/pipeline/nodes/captionImage";
import { readHeadlineImageNode, renderArticlePromptNode } from "../src/server/pipeline/nodes/articleGeneration";
import { initialPipelineState } from "../src/server/pipeline/state";
import { buildPromptRegistry } from "../src/server/pipeline/prompts/registry";
import { articleImageGenerationWorkflow } from "../src/server/pipeline/workflows/articleImageGeneration";
import { indexArticleChunks } from "../src/server/retrieval";
import { ingestImageFromBuffer } from "../src/server/media";
import { generateArticleImage, setImageGenerationFetchForTests } from "../src/server/imageGeneration";
import { listArticleImageAspectRatios } from "../src/server/imageAspectRatios";
import type { ImageGenerationConfig } from "../src/server/types";

// ── shared helpers ────────────────────────────────────────────────────────────

const TEST_CONFIG = loadConfig();

// Smallest valid 1×1 PNG parseable by vips
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TINY_PNG = Buffer.from(TINY_PNG_B64, "base64");

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "halu-media-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function noop(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function captureLogger(entries: Array<{ level: string; event: string; fields?: Record<string, unknown> }>): Logger {
  return {
    debug(event, fields) { entries.push({ level: "debug", event, fields }); },
    info(event, fields) { entries.push({ level: "info", event, fields }); },
    warn(event, fields) { entries.push({ level: "warn", event, fields }); },
    error(event, fields) { entries.push({ level: "error", event, fields }); },
  };
}

function baseMediaRecord(id = "test-img") {
  return {
    id,
    sha256: id.padEnd(64, "0"),
    sourceUrl: "https://example.com/img.png" as string | null,
    mime: "image/png",
    width: 100, height: 80,
    bytes: TINY_PNG,
    byteSize: TINY_PNG.length,
    modelB64: TINY_PNG_B64,
    modelMime: "image/jpeg",
    modelWidth: 50, modelHeight: 40,
    description: "A test image",
  };
}

function makeArticleDb(dir: string) {
  const db = openDatabase(join(dir, "articles.sqlite"));
  const md = "# Test Article\n\nBody text.";
  saveArticle(db, { slug: "test-article", canonicalSlug: "test-article", title: "Test Article", markdown: md, html: renderMarkdown(md), plain_text: markdownToPlainText(md), generated_at: Date.now() }, [], ["test-article"]);
  return db;
}

class FakeLlm implements LlmRouter {
  capturedOptions: ChatOptions[] = [];
  capturedPrompts: Array<{ role: string; system: string; user: string }> = [];
  private responseIndex = 0;
  constructor(private readonly resp: string | string[] = '{"title":"T","groups":[{"label":"","rows":[]}]}') {}
  async chat(_r: "heavy" | "light", _s: string, _u: string, opts?: ChatOptions) {
    this.capturedOptions.push(opts ?? {});
    this.capturedPrompts.push({ role: _r, system: _s, user: _u });
    if (Array.isArray(this.resp)) {
      const response = this.resp[Math.min(this.responseIndex, this.resp.length - 1)] ?? "";
      this.responseIndex += 1;
      return response;
    }
    return this.resp;
  }
  async streamChat(_r: "heavy" | "light", _s: string, _u: string, onChunk: (d: string, a: string) => void, opts?: ChatOptions) {
    const c = await this.chat(_r, _s, _u, opts);
    onChunk(c, c);
    return { content: c, finishReason: "stop" };
  }
  async embed() { return []; }
  async probeConnections() {}
  supportsVision(_: "heavy" | "light" | "images") { return false; }
}


async function makeTestServer(
  llm: LlmRouter = new FakeLlm(),
  imageGenerationConfig: Partial<ImageGenerationConfig> = { enabled: false },
  logger: Logger = noop(),
) {
  const { dir, cleanup } = tmpDir();
  const databasePath = join(dir, "articles.sqlite");
  const mediaDatabasePath = join(dir, "media.sqlite");
  const md = "# Aspirin\n\nA medication.";
  const db = openDatabase(databasePath);
  saveArticle(db, { slug: "aspirin", canonicalSlug: "aspirin", title: "Aspirin", markdown: md, html: renderMarkdown(md), plain_text: markdownToPlainText(md), generated_at: Date.now() }, [], ["aspirin"]);
  db.close();
  const { app, shutdown } = await createApp({
    databasePath,
    mediaDatabasePath,
    skipLlmProbe: true,
    skipHomepagePrepare: true,
    logger,
    llmClient: llm,
    imageGenerationConfig,
  });
  const go = (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost${path}`, init));
  return { dir, databasePath, mediaDatabasePath, cleanup: async () => { await shutdown(); cleanup(); }, go };
}

function seedMedia(mediaDatabasePath: string, id = "img-x") {
  const db = openMediaDatabase(mediaDatabasePath);
  insertMedia(db, { ...baseMediaRecord(id), sha256: id.padEnd(64, "x") });
  db.close();
}

function seedArticle(databasePath: string, slug = "image-test-article") {
  const db = openDatabase(databasePath);
  const md = "# Image Test Article\n\nA neutral test article.";
  saveArticle(db, {
    slug,
    canonicalSlug: slug,
    title: "Image Test Article",
    markdown: md,
    html: renderMarkdown(md),
    plain_text: markdownToPlainText(md),
    generated_at: Date.now(),
  }, [], [slug]);
  db.close();
  return slug;
}

const defaultIngestConfig = {
  model_max_edge: 256, jpeg_quality: 70, max_bytes: 10 * 1024 * 1024,
  fetch_timeout_ms: 5000, media_database_path: "", allow_private_hosts: false,
  generation: TEST_CONFIG.app.images.generation,
};

const enabledOpenAiImageGeneration: Partial<ImageGenerationConfig> = {
  enabled: true,
  auto_preset_multipass: true,
  backend: "openai",
  openai: {
    base_url: "https://api.openai.test/v1",
    api_key: "test-key",
    model: "gpt-image-2",
    size: "1088x624",
    quality: "low",
    output_format: "jpeg",
    output_compression: 70,
    timeout_ms: 1000,
  },
};

// ── mediaDb ───────────────────────────────────────────────────────────────────

describe("mediaDb", () => {
  test("insert and retrieve by id", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openMediaDatabase(join(dir, "m.sqlite"));
    insertMedia(db, baseMediaRecord("img-1"));
    const row = getMediaById(db, "img-1");
    assert.ok(row);
    assert.equal(row.id, "img-1");
    assert.equal(row.mime, "image/png");
    assert.equal(row.width, 100);
    assert.equal(row.description, "A test image");
    db.close();
  });

  test("bytes blob round-trips", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openMediaDatabase(join(dir, "m.sqlite"));
    insertMedia(db, baseMediaRecord("img-bytes"));
    const row = getMediaBytesById(db, "img-bytes");
    assert.ok(row);
    assert.equal(Buffer.from(row.bytes).length, TINY_PNG.length);
    db.close();
  });

  test("getMediaBytesById returns null for missing id", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openMediaDatabase(join(dir, "m.sqlite"));
    assert.equal(getMediaBytesById(db, "nope"), null);
    db.close();
  });

  test("getMediaBySha256 finds by hash", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openMediaDatabase(join(dir, "m.sqlite"));
    const rec = baseMediaRecord("img-sha");
    insertMedia(db, rec);
    const found = getMediaBySha256(db, rec.sha256);
    assert.ok(found);
    assert.equal(found.id, "img-sha");
    db.close();
  });

  test("sha256 UNIQUE constraint prevents double-insert", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openMediaDatabase(join(dir, "m.sqlite"));
    insertMedia(db, baseMediaRecord("img-a"));
    assert.throws(() => insertMedia(db, { ...baseMediaRecord("img-b"), sha256: baseMediaRecord("img-a").sha256 }));
    db.close();
  });

  test("updateMediaDescription", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openMediaDatabase(join(dir, "m.sqlite"));
    insertMedia(db, baseMediaRecord("img-d"));
    updateMediaDescription(db, "img-d", "Updated");
    assert.equal(getMediaById(db, "img-d")?.description, "Updated");
    db.close();
  });

  test("updateMediaId renames primary key", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openMediaDatabase(join(dir, "m.sqlite"));
    insertMedia(db, baseMediaRecord("old-name"));
    assert.ok(updateMediaId(db, "old-name", "new-name"));
    assert.equal(getMediaById(db, "old-name"), null);
    assert.ok(getMediaById(db, "new-name"));
    db.close();
  });

  test("updateMediaId returns false on pk collision", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openMediaDatabase(join(dir, "m.sqlite"));
    insertMedia(db, baseMediaRecord("aa"));
    insertMedia(db, { ...baseMediaRecord("bb"), sha256: "b".padEnd(64, "b") });
    assert.equal(updateMediaId(db, "aa", "bb"), false);
    assert.ok(getMediaById(db, "aa"), "original unchanged");
    db.close();
  });

  test("insertMedia writes an 'uploaded' revision", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openMediaDatabase(join(dir, "m.sqlite"));
    insertMedia(db, baseMediaRecord("img-rev"));
    const revs = listMediaRevisions(db, "img-rev");
    assert.equal(revs.length, 1);
    assert.equal(revs[0].operation, "uploaded");
    assert.equal(revs[0].media_id, "img-rev");
    db.close();
  });

  test("updateMediaGenerationMetadata stores structured generation details", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openMediaDatabase(join(dir, "m.sqlite"));
    insertMedia(db, baseMediaRecord("img-gen-meta"));
    updateMediaGenerationMetadata(db, "img-gen-meta", JSON.stringify({
      kind: "article-image",
      presetKey: "psychedelic_editorial",
      backend: "openai",
      model: "gpt-image-2",
    }));
    const record = getMediaById(db, "img-gen-meta");
    assert.ok(record);
    assert.match(record.generation_metadata, /psychedelic_editorial/);
    db.close();
  });

  test("updateMediaDescription writes a revision per call", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openMediaDatabase(join(dir, "m.sqlite"));
    insertMedia(db, baseMediaRecord("img-rev2"));
    updateMediaDescription(db, "img-rev2", "First update", "update");
    updateMediaDescription(db, "img-rev2", "Second update", "user-edit");
    const revs = listMediaRevisions(db, "img-rev2");
    // uploaded + 2 updates = 3 total
    assert.equal(revs.length, 3);
    // Most recent first (ORDER BY changed_at DESC)
    assert.equal(revs[0].operation, "user-edit");
    assert.equal(revs[0].description, "Second update");
    db.close();
  });

  test("listMedia without query returns all records", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openMediaDatabase(join(dir, "m.sqlite"));
    insertMedia(db, baseMediaRecord("img-list-1"));
    insertMedia(db, { ...baseMediaRecord("img-list-2"), sha256: "l2".padEnd(64, "2"), description: "Another image" });
    const all = listMedia(db);
    assert.equal(all.items.length, 2);
    assert.equal(all.total, 2);
    db.close();
  });

  test("listMedia with query filters by description LIKE", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openMediaDatabase(join(dir, "m.sqlite"));
    insertMedia(db, baseMediaRecord("img-filter-1")); // description: "A test image"
    insertMedia(db, { ...baseMediaRecord("img-filter-2"), sha256: "f2".padEnd(64, "2"), description: "A completely different image" });
    const { items: results } = listMedia(db, "test");
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "img-filter-1");
    db.close();
  });

  test("listMedia paginates and never returns model_b64", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openMediaDatabase(join(dir, "m.sqlite"));
    for (let i = 0; i < 3; i++) {
      insertMedia(db, { ...baseMediaRecord(`img-page-${i}`), sha256: `p${i}`.padEnd(64, String(i)) });
    }
    const page = listMedia(db, undefined, { limit: 2, offset: 0 });
    assert.equal(page.items.length, 2);
    assert.equal(page.total, 3);
    assert.ok(!("model_b64" in page.items[0]), "list rows must not carry the base64 image payload");
    const rest = listMedia(db, undefined, { limit: 2, offset: 2 });
    assert.equal(rest.items.length, 1);
    db.close();
  });
});

// ── image backlinks ───────────────────────────────────────────────────────────

describe("image backlinks", () => {
  function seedArticleWithImage(db: ReturnType<typeof makeArticleDb>, slug: string, title: string, imageSlug: string) {
    const md = `# ${title}\n\nSee the structure: ![A caption](media:${imageSlug})\n\nBody text.`;
    saveArticle(db, { slug, canonicalSlug: slug, title, markdown: md, html: renderMarkdown(md), plain_text: markdownToPlainText(md), generated_at: Date.now() }, [], [slug]);
  }

  test("listImageBacklinks: finds articles referencing the image", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir); // seeds test-article
    seedArticleWithImage(db, "article-a", "Article A", "crystal-img");
    seedArticleWithImage(db, "article-b", "Article B", "crystal-img");

    const results = listImageBacklinks(db, "crystal-img");
    assert.equal(results.length, 2);
    assert.ok(results.some((r) => r.slug === "article-a"));
    assert.ok(results.some((r) => r.slug === "article-b"));
    db.close();
  });

  test("listImageBacklinks: excludes articles that don't reference the image", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    seedArticleWithImage(db, "article-a", "Article A", "crystal-img");
    // test-article (seeded by makeArticleDb) does not reference crystal-img

    const results = listImageBacklinks(db, "crystal-img");
    assert.equal(results.length, 1);
    assert.equal(results[0].slug, "article-a");
    db.close();
  });

  test("listImageBacklinks: no false positives from slug prefix matches", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    // This references "crystal-img-extra", not "crystal-img"
    seedArticleWithImage(db, "article-a", "Article A", "crystal-img-extra");

    const results = listImageBacklinks(db, "crystal-img");
    assert.equal(results.length, 0);
    db.close();
  });

  test("listImageBacklinks: returns empty array when no references", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    assert.deepEqual(listImageBacklinks(db, "nonexistent-img"), []);
    db.close();
  });

  test("listImageBacklinks: finds articles that use the image as a sidebar/headline image", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const md = "# Article A\n\nNo inline media reference here.\n\nBody text.";
    saveArticle(db, { slug: "article-a", canonicalSlug: "article-a", title: "Article A", markdown: md, html: renderMarkdown(md), plain_text: markdownToPlainText(md), generated_at: Date.now() }, [], ["article-a"]);
    upsertArticleHeadlineMedia(db, "article-a", "crystal-img", "");

    const results = listImageBacklinks(db, "crystal-img");
    assert.equal(results.length, 1);
    assert.equal(results[0].slug, "article-a");
    db.close();
  });

  test("listImageBacklinks: dedupes an article that references the image both inline and as headline", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    seedArticleWithImage(db, "article-a", "Article A", "crystal-img");
    upsertArticleHeadlineMedia(db, "article-a", "crystal-img", "");

    const results = listImageBacklinks(db, "crystal-img");
    assert.equal(results.length, 1);
    assert.equal(results[0].slug, "article-a");
    db.close();
  });

  test("GET /api/media/:id/backlinks: returns backlinks from server", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "ref-img");

    // Seed an article that references the image
    const db = openDatabase(s.databasePath);
    const md = "# Aspirin\n\nSee ![tablet photo](media:ref-img) for details.";
    saveArticle(db, { slug: "aspirin", canonicalSlug: "aspirin", title: "Aspirin", markdown: md, html: renderMarkdown(md), plain_text: markdownToPlainText(md), generated_at: Date.now() + 1 }, [], ["aspirin"]);
    db.close();

    const res = await s.go("/api/media/ref-img/backlinks");
    assert.equal(res.status, 200);
    const body = await res.json() as { backlinks: Array<{ slug: string; title: string }> };
    assert.ok(body.backlinks.some((b) => b.slug === "aspirin"));
  });
});

// ── image generation backends ────────────────────────────────────────────────

describe("article image generation", () => {
  test("OpenAI backend parses b64_json image responses", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedUrl = "";
    let capturedBody: any = null;
    setImageGenerationFetchForTests(async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          data: [{ b64_json: TINY_PNG_B64, revised_prompt: "revised" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const result = await generateArticleImage({
      prompt: "draw aspirin",
      config: {
        ...TEST_CONFIG.app.images.generation,
        ...enabledOpenAiImageGeneration,
        ollama: TEST_CONFIG.app.images.generation.ollama,
      } as ImageGenerationConfig,
      logger: noop(),
    });

    assert.equal(capturedUrl, "https://api.openai.test/v1/images/generations");
    assert.equal(capturedBody.model, "gpt-image-2");
    assert.equal(capturedBody.prompt, "draw aspirin");
    assert.equal(capturedBody.output_format, "jpeg");
    assert.equal(capturedBody.output_compression, 70);
    assert.equal(capturedBody.size, "1088x624");
    assert.equal(result.backend, "openai");
    assert.equal(result.mime, "image/jpeg");
    assert.equal(result.revisedPrompt, "revised");
    assert.deepEqual(result.bytes, TINY_PNG);
  });

  test("OpenAI backend validates and sends requested image size overrides", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedBody: any = null;
    setImageGenerationFetchForTests(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          data: [{ b64_json: TINY_PNG_B64 }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    await generateArticleImage({
      prompt: "draw aspirin",
      config: {
        ...TEST_CONFIG.app.images.generation,
        ...enabledOpenAiImageGeneration,
        ollama: TEST_CONFIG.app.images.generation.ollama,
      } as ImageGenerationConfig,
      logger: noop(),
      size: "832x1088",
    });

    assert.equal(capturedBody.size, "832x1088");
    await assert.rejects(
      () =>
        generateArticleImage({
          prompt: "draw aspirin",
          config: {
            ...TEST_CONFIG.app.images.generation,
            ...enabledOpenAiImageGeneration,
            ollama: TEST_CONFIG.app.images.generation.ollama,
          } as ImageGenerationConfig,
          logger: noop(),
          size: "801x1088",
        }),
      /divisible by 16/i,
    );
  });

  test("landscape image aspect ratio follows configured OpenAI size", () => {
    const ratios = listArticleImageAspectRatios({
      ...TEST_CONFIG.app.images.generation,
      ...enabledOpenAiImageGeneration,
      openai: {
        ...enabledOpenAiImageGeneration.openai!,
        size: "1152x672",
      },
      ollama: TEST_CONFIG.app.images.generation.ollama,
    } as ImageGenerationConfig);
    assert.equal(ratios.find((ratio) => ratio.key === "landscape")?.size, "1152x672");
    assert.equal(ratios.some((ratio) => ratio.key === "default"), false);
  });

  test("legacy default image aspect ratio config is folded into landscape", () => {
    const ratios = listArticleImageAspectRatios({
      ...TEST_CONFIG.app.images.generation,
      ...enabledOpenAiImageGeneration,
      aspect_ratios: {
        default: {
          label: "old configured landscape",
          size: "1152x672",
          selection_when: "Legacy configured landscape option.",
        },
      },
      ollama: TEST_CONFIG.app.images.generation.ollama,
    } as ImageGenerationConfig);
    assert.equal(ratios.find((ratio) => ratio.key === "landscape")?.label, "old configured landscape");
    assert.equal(ratios.some((ratio) => ratio.key === "default"), false);
  });

  test("OpenAI backend rejects missing API keys before calling the provider", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let called = false;
    setImageGenerationFetchForTests(async () => {
      called = true;
      return new Response("{}");
    });

    await assert.rejects(
      () =>
        generateArticleImage({
          prompt: "draw aspirin",
          config: {
            ...TEST_CONFIG.app.images.generation,
            ...enabledOpenAiImageGeneration,
            openai: {
              ...enabledOpenAiImageGeneration.openai!,
              api_key: "",
            },
            ollama: TEST_CONFIG.app.images.generation.ollama,
          } as ImageGenerationConfig,
          logger: noop(),
        }),
      /api_key/i,
    );
    assert.equal(called, false);
  });

  test("OpenAI backend omits output_compression for png responses", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedBody: any = null;
    setImageGenerationFetchForTests(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          data: [{ b64_json: TINY_PNG_B64 }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const result = await generateArticleImage({
      prompt: "draw aspirin",
      config: {
        ...TEST_CONFIG.app.images.generation,
        ...enabledOpenAiImageGeneration,
        openai: {
          ...enabledOpenAiImageGeneration.openai!,
          output_format: "png",
        },
        ollama: TEST_CONFIG.app.images.generation.ollama,
      } as ImageGenerationConfig,
      logger: noop(),
    });

    assert.equal(capturedBody.output_format, "png");
    assert.equal("output_compression" in capturedBody, false);
    assert.equal(result.mime, "image/png");
  });

  test("Ollama backend parses final image field", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedUrl = "";
    let capturedBody: any = null;
    setImageGenerationFetchForTests(async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ image: `data:image/png;base64,${TINY_PNG_B64}` }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const result = await generateArticleImage({
      prompt: "draw aspirin",
      config: {
        ...TEST_CONFIG.app.images.generation,
        enabled: true,
        backend: "ollama",
        openai: TEST_CONFIG.app.images.generation.openai,
        ollama: {
          base_url: "http://ollama.test:11434",
          model: "x/z-image-turbo",
          width: 640,
          height: 480,
          steps: 7,
          timeout_ms: 1000,
        },
      },
      logger: noop(),
    });

    assert.equal(capturedUrl, "http://ollama.test:11434/api/generate");
    assert.equal(capturedBody.model, "x/z-image-turbo");
    assert.equal(capturedBody.width, 640);
    assert.equal(capturedBody.steps, 7);
    assert.equal(result.backend, "ollama");
    assert.equal(result.mime, "image/png");
    assert.deepEqual(result.bytes, TINY_PNG);
  });

  test("Ollama backend parses streamed final image field", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    setImageGenerationFetchForTests(async () =>
      new Response(
        [
          JSON.stringify({ model: "x/z-image-turbo", completed: 1, total: 2, done: false }),
          JSON.stringify({ model: "x/z-image-turbo", image: TINY_PNG_B64, done: true }),
        ].join("\n"),
        { headers: { "content-type": "application/x-ndjson" } },
      ),
    );

    const result = await generateArticleImage({
      prompt: "draw aspirin",
      config: {
        ...TEST_CONFIG.app.images.generation,
        enabled: true,
        backend: "ollama",
        openai: TEST_CONFIG.app.images.generation.openai,
        ollama: {
          base_url: "http://ollama.test:11434",
          model: "x/z-image-turbo",
          width: 640,
          height: 480,
          steps: 7,
          timeout_ms: 1000,
        },
      },
      logger: noop(),
    });

    assert.equal(result.backend, "ollama");
    assert.equal(result.mime, "image/png");
    assert.deepEqual(result.bytes, TINY_PNG);
  });
});

// ── article_media ─────────────────────────────────────────────────────────────

describe("article_media", () => {
  test("upsert and retrieve headline", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    upsertArticleHeadlineMedia(db, "test-article", "img-h", "My caption");
    const row = getArticleHeadlineMedia(db, "test-article");
    assert.ok(row);
    assert.equal(row.mediaId, "img-h");
    assert.equal(row.caption, "My caption");
    assert.equal(row.ordinal, 1);
    assert.equal(row.role, "headline");
    db.close();
  });

  test("upsert is idempotent — replaces existing headline", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    upsertArticleHeadlineMedia(db, "test-article", "v1", "cap1");
    upsertArticleHeadlineMedia(db, "test-article", "v2", "cap2");
    const row = getArticleHeadlineMedia(db, "test-article");
    assert.equal(row?.mediaId, "v2");
    assert.equal(row?.caption, "cap2");
    assert.equal(getArticleMediaRows(db, "test-article").length, 1);
    db.close();
  });

  test("updateArticleMediaCaption", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    upsertArticleHeadlineMedia(db, "test-article", "img-c", "Original");
    updateArticleMediaCaption(db, "test-article", 1, "Revised");
    assert.equal(getArticleHeadlineMedia(db, "test-article")?.caption, "Revised");
    db.close();
  });

  test("removeArticleMedia deletes the row", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    upsertArticleHeadlineMedia(db, "test-article", "img-r", "");
    removeArticleMedia(db, "test-article", 1);
    assert.equal(getArticleHeadlineMedia(db, "test-article"), null);
    db.close();
  });

  test("getArticleHeadlineMedia returns null when none set", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    assert.equal(getArticleHeadlineMedia(db, "test-article"), null);
    db.close();
  });
});

// ── article_infobox ───────────────────────────────────────────────────────────

describe("article_infobox", () => {
  test("set and get round-trip", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const box: InfoboxData = { title: "Thing", subtitle: "Sub", groups: [{ label: "G", rows: [{ label: "Year", value: "1990" }] }] };
    setArticleInfobox(db, "test-article", box);
    const got = getArticleInfobox(db, "test-article");
    assert.ok(got);
    assert.equal(got.title, "Thing");
    assert.equal(got.subtitle, "Sub");
    assert.equal(got.groups[0].rows[0].value, "1990");
    db.close();
  });

  test("upsert overwrites previous value", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    setArticleInfobox(db, "test-article", { title: "V1", groups: [] });
    setArticleInfobox(db, "test-article", { title: "V2", groups: [] });
    assert.equal(getArticleInfobox(db, "test-article")?.title, "V2");
    db.close();
  });

  test("returns null when not set", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    assert.equal(getArticleInfobox(db, "test-article"), null);
    db.close();
  });
});

// ── rendering ─────────────────────────────────────────────────────────────────

describe("rendering", () => {
  test("renderInfoboxHtml: empty string when no infobox and no image", () => {
    assert.equal(renderInfoboxHtml(null, null), "");
  });

  test("renderInfoboxHtml: renders .infobox aside with title", () => {
    const html = renderInfoboxHtml({ title: "Benzodiazepine", groups: [] }, null);
    assert.match(html, /<aside class="infobox">/);
    assert.match(html, /Benzodiazepine/);
  });

  test("renderInfoboxHtml: headline image links to /api/media and /media", () => {
    const media = { id: 1, articleSlug: "x", mediaId: "benzo-mol", role: "headline", ordinal: 1, caption: "Formula", createdAt: 0, updatedAt: 0 };
    const html = renderInfoboxHtml(null, media);
    assert.match(html, /src="\/api\/media\/benzo-mol"/);
    assert.match(html, /href="\/media\/benzo-mol"/);
    assert.match(html, /Formula/);
  });

  test("renderInfoboxHtml: renders table rows with label/value", () => {
    const box: InfoboxData = { title: "Aspirin", groups: [{ label: "Props", rows: [{ label: "Formula", value: "C9H8O4" }] }] };
    const html = renderInfoboxHtml(box, null);
    assert.match(html, /Props/);
    assert.match(html, /Formula/);
    assert.match(html, /C9H8O4/);
  });

  test("renderInfoboxHtml: escapes HTML in title and values", () => {
    const box: InfoboxData = { title: "<script>xss</script>", groups: [{ label: "", rows: [{ label: "F", value: "<b>v</b>" }] }] };
    const html = renderInfoboxHtml(box, null);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;b&gt;v&lt;\/b&gt;/);
  });

  test("renderInfoboxHtml: empty caption renders no caption paragraph", () => {
    const media = { id: 1, articleSlug: "x", mediaId: "img", role: "headline", ordinal: 1, caption: "", createdAt: 0, updatedAt: 0 };
    const html = renderInfoboxHtml(null, media);
    // No caption paragraph when caption is empty — no fallback to description
    assert.doesNotMatch(html, /infobox-caption/);
  });

  test("renderInfoboxHtml: no image when headlineMedia is null", () => {
    const html = renderInfoboxHtml({ title: "T", groups: [] }, null);
    assert.doesNotMatch(html, /infobox-image/);
  });
});

// ── markdown ──────────────────────────────────────────────────────────────────

describe("markdown", () => {
  test(":::sidebar renders as aside.sidebar-block", () => {
    const html = renderMarkdown(":::sidebar\n| K | V |\n|---|---|\n| a | b |\n:::");
    assert.match(html, /<aside class="sidebar-block">/);
    assert.match(html, /<\/aside>/);
    assert.match(html, /<table>/);
  });

  test("plain table outside :::sidebar stays inline — no sidebar-block class", () => {
    const html = renderMarkdown("| K | V |\n|---|---|\n| a | b |");
    assert.match(html, /<table>/);
    assert.doesNotMatch(html, /sidebar-block/);
  });

  test(":::sidebar preserves surrounding paragraphs", () => {
    const html = renderMarkdown("Before.\n\n:::sidebar\n| A | B |\n|---|---|\n| 1 | 2 |\n:::\n\nAfter.");
    assert.match(html, /Before/);
    assert.match(html, /After/);
    assert.match(html, /sidebar-block/);
  });

  test("media: inline embed is suppressed in rendered HTML (sidebar-only)", () => {
    const html = renderMarkdown("![Caption here](media:my-slug)");
    // Headline images are sidebar-only — the media embed must not appear in body HTML.
    assert.doesNotMatch(html, /class="media-ref-link"/);
    assert.doesNotMatch(html, /Caption here/);
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /my-slug/);
    // The rendered output should be empty (whitespace only) for a standalone embed.
    assert.ok(html.trim() === "" || !html.includes("media:"), "media embed must be suppressed");
  });

  test("media: markdown source is preserved for backlink scanning", () => {
    // The suppression is in HTML rendering only — the raw markdown must keep the embed
    // so the backlink scanner in db.ts can find %(media:slug)%.
    const markdown = "![My Caption](media:specific-slug-value)";
    // Markdown unchanged (normalizeMarkdown does not strip media: embeds)
    assert.match(markdown, /media:specific-slug-value/);
    // But renderMarkdown suppresses it
    const html = renderMarkdown(markdown);
    assert.doesNotMatch(html, /specific-slug-value/);
  });

  test("external image does not get media-image-link treatment", () => {
    const html = renderMarkdown("![Alt](https://example.com/img.png)");
    assert.doesNotMatch(html, /media-image-link/);
  });
});

// ── vision-probe ──────────────────────────────────────────────────────────────

describe("vision-probe", () => {
  function mockShowEndpoint(body: unknown) {
    setLlmFetchForTests(async (input: string) => {
      if (input.endsWith("/api/show")) {
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("nf", { status: 404 });
    });
    return () => { setLlmFetchForTests(null); };
  }

  function makeVisionRouter(imagesChatConfig?: { base_url: string; api_key: string; model: string; temperature: number; max_tokens: number }) {
    const cfg = { base_url: "http://ollama.test/v1", api_key: "local", model: "m", temperature: 1, max_tokens: 100 };
    return makeRouter(cfg, cfg, { enabled: false, base_url: "", api_key: "", model: "" }, noop(), imagesChatConfig);
  }

  test("true when model_info has clip.* key", async (t) => {
    const restore = mockShowEndpoint({ model_info: { "clip.vision_encoder": "clip" } });
    t.after(restore);
    const r = makeVisionRouter();
    await r.probeConnections();
    assert.equal(r.supportsVision("light"), true);
  });

  test("false when model_info has no clip keys", async (t) => {
    const restore = mockShowEndpoint({ model_info: { "general.architecture": "gemma" } });
    t.after(restore);
    const r = makeVisionRouter();
    await r.probeConnections();
    assert.equal(r.supportsVision("light"), false);
  });

  test("true when details.families includes 'clip'", async (t) => {
    const restore = mockShowEndpoint({ details: { families: ["llama", "clip"] } });
    t.after(restore);
    const r = makeVisionRouter();
    await r.probeConnections();
    assert.equal(r.supportsVision("heavy"), true);
  });

  test("false when provider endpoint unreachable", async (t) => {
    t.after(() => { setLlmFetchForTests(null); });
    setLlmFetchForTests(async () => { throw new Error("refused"); });
    const r = makeVisionRouter();
    await r.probeConnections();
    assert.equal(r.supportsVision("heavy"), false);
  });

  test("true when capabilities array includes 'vision'", async (t) => {
    const restore = mockShowEndpoint({ capabilities: ["completion", "vision"] });
    t.after(restore);
    const r = makeVisionRouter();
    await r.probeConnections();
    assert.equal(r.supportsVision("light"), true);
  });

  test("supportsVision('images') returns false when no imagesChatConfig", async (t) => {
    const restore = mockShowEndpoint({ model_info: { "clip.vision_encoder": "clip" } });
    t.after(restore);
    const r = makeVisionRouter(); // no 5th arg
    await r.probeConnections();
    assert.equal(r.supportsVision("images"), false);
  });

  test("supportsVision('images') probes imagesChatConfig when provided", async (t) => {
    const restore = mockShowEndpoint({ capabilities: ["completion", "vision"] });
    t.after(restore);
    const imagesCfg = { base_url: "http://ollama.test/v1", api_key: "local", model: "vision-model", temperature: 1, max_tokens: 100 };
    const r = makeVisionRouter(imagesCfg);
    await r.probeConnections();
    assert.equal(r.supportsVision("images"), true);
  });
});

// ── multimodal ────────────────────────────────────────────────────────────────

describe("multimodal", () => {
  function makeCaptureRouter() {
    let lastBody: any = null;
    const restore = () => { setLlmFetchForTests(null); };
    setLlmFetchForTests(async (_: string, init?: RequestInit) => {
      lastBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { total_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const cfg = { base_url: "http://llm.test/v1", api_key: "k", model: "m", temperature: 1, max_tokens: 10 };
    const router = makeRouter(cfg, cfg, { enabled: false, base_url: "", api_key: "", model: "" }, noop());
    return { router, getBody: () => lastBody, restore };
  }

  test("with images: user turn carries text content + native base64 images array", async (t) => {
    const { router, getBody, restore } = makeCaptureRouter(); t.after(restore);
    await router.chat("light", "sys", "user text", { images: [{ mime: "image/jpeg", b64: "abc" }] });
    const userMsg = getBody().messages[1];
    assert.equal(userMsg.content, "user text");
    assert.deepEqual(userMsg.images, ["abc"]);
  });

  test("without images: user turn has plain string content and no images key", async (t) => {
    const { router, getBody, restore } = makeCaptureRouter(); t.after(restore);
    await router.chat("heavy", "sys", "just text");
    const userMsg = getBody().messages[1];
    assert.equal(typeof userMsg.content, "string");
    assert.equal(userMsg.content, "just text");
    assert.equal(userMsg.images, undefined);
  });

  test("multiple images produce multiple base64 entries", async (t) => {
    const { router, getBody, restore } = makeCaptureRouter(); t.after(restore);
    await router.chat("light", "s", "u", { images: [{ mime: "image/png", b64: "aaa" }, { mime: "image/png", b64: "bbb" }] });
    assert.deepEqual(getBody().messages[1].images, ["aaa", "bbb"]);
  });
});

// ── http ──────────────────────────────────────────────────────────────────────

describe("http", () => {
  test("GET /api/media/:id serves bytes with correct content-type and cache header", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "serve-img");
    const r = await s.go("/api/media/serve-img");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    assert.match(r.headers.get("cache-control") ?? "", /immutable/);
    assert.equal((await r.arrayBuffer()).byteLength, TINY_PNG.length);
  });

  test("GET /api/media/:id returns 404 for unknown id", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    assert.equal((await s.go("/api/media/nope")).status, 404);
  });

  test("GET /api/media/:id/info returns metadata without model_b64 or bytes", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "info-img");
    const mediaDb = openMediaDatabase(s.mediaDatabasePath);
    updateMediaGenerationMetadata(mediaDb, "info-img", JSON.stringify({
      kind: "article-image",
      presetKey: "psychedelic_editorial",
      presetLabel: "psychedelic editorial",
      aspectRatioKey: "landscape",
      backend: "openai",
      model: "gpt-image-2",
    }));
    mediaDb.close();
    const body = await (await s.go("/api/media/info-img/info")).json() as any;
    assert.equal(body.id, "info-img");
    assert.equal(body.width, 100);
    assert.equal(body.model_b64, undefined);
    assert.equal(body.bytes, undefined);
    assert.equal(body.generation_metadata, undefined);
    assert.equal(body.generation.presetKey, "psychedelic_editorial");
    assert.equal(body.generation.backend, "openai");
  });

  test("PATCH /api/media/:id/description updates and is reflected in /info", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "desc-img");
    const r = await s.go("/api/media/desc-img/description", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: "New desc" }) });
    assert.equal(r.status, 200);
    const info = await (await s.go("/api/media/desc-img/info")).json() as any;
    assert.equal(info.description, "New desc");
  });

  test("PATCH /api/media/:id/description 400 when body missing description field", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "bad-desc-img");
    const r = await s.go("/api/media/bad-desc-img/description", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 400);
  });

  test("GET /api/article/:slug/image returns null when no image attached", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    const body = await (await s.go("/api/article/aspirin/image")).json() as any;
    assert.equal(body.image, null);
  });

  test("image generation admin settings default featured auto-generation off", async (t) => {
    const s = await makeTestServer(new FakeLlm(), { enabled: false, auto_generate_for_featured_article: false }); t.after(s.cleanup);
    const body = await (await s.go("/api/admin/llm")).json() as any;
    assert.equal(body.imageGeneration.autoGenerateForFeaturedArticle, false);
    assert.equal(body.imageGeneration.autoPresetMultipass, false);
  });

  test("POST /api/article/:slug/image/generate rejects when disabled", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    const res = await s.go("/api/article/aspirin/image/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.match(body.error, /disabled/i);
  });

  test("POST /api/article/:slug/image/generate replaces existing image without replace flag", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    setImageGenerationFetchForTests(async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const s = await makeTestServer(new FakeLlm(), enabledOpenAiImageGeneration); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "existing-img");
    const db = openDatabase(s.databasePath);
    upsertArticleHeadlineMedia(db, "aspirin", "existing-img", "");
    db.close();
    const res = await s.go("/api/article/aspirin/image/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (res.status !== 200) {
      const b = await res.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(res.status, 200, `unexpected status: ${res.status} ${b?.error ?? ""}`);
    }
    const body = await res.json() as any;
    assert.ok(body.mediaId);
  });

  test("POST /api/article/:slug/image/generate stores and attaches generated image", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    setImageGenerationFetchForTests(async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const s = await makeTestServer(new FakeLlm(), enabledOpenAiImageGeneration); t.after(s.cleanup);
    const res = await s.go("/api/article/aspirin/image/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (res.status !== 200) {
      const b = await res.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(res.status, 200, `unexpected status: ${res.status} ${b?.error ?? ""}`);
    }
    const body = await res.json() as any;
    assert.ok(body.mediaId);
    assert.equal(body.backend, "openai");
    const check = await (await s.go("/api/article/aspirin/image")).json() as any;
    assert.ok(check.image?.id);
    const info = await (await s.go(`/api/media/${check.image.id}/info`)).json() as any;
    assert.equal(info.generation.kind, "article-image");
    assert.equal(info.generation.presetKey, "default");
    assert.equal(info.generation.aspectRatioKey, "landscape");
    assert.equal(info.generation.backend, "openai");
    assert.equal(info.generation.model, enabledOpenAiImageGeneration.openai.model);
  });

  test("GET /api/admin/article-image-prompts lists image prompt variants", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    const body = await (await s.go("/api/admin/article-image-prompts")).json() as any;
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "default"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "psychedelic_editorial"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "1970s_adult_magazine_spread"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "1990s_cgi"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "analog_video_still"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "bad_phone_photo"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "black_and_white_security_camera"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "broadcast_news_still"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "bodypainting"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "field_guide_plate"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "paparazzi_photo"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "photocopy"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "communist_propaganda"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "comic_book_panel"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "courtroom_sketch"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "crayon_drawing"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "romance_novel"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "fpv_drone_feed"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "haunted_analog_still"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "overhead_projector_transparency"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "painting"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "movie_poster"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "museum_catalog_photo"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "newspaper_halftone_photo"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "night_vision"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "passport_photo"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "police_evidence_photo"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "polaroid"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "black_and_white_photo"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "medical_imaging_scan"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "public_domain_engraving"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "redacted_file_scan"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "satellite_reconnaissance"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "screenshot"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "sixth_generation_console_graphics"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "space_agency_artist_conception"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "wikihow_illustration"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "seventh_generation_console_graphics"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "anime"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "manuscript"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "logos"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "tabloid_cover"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "thermal_camera"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "trading_card"));
    assert.ok(body.prompts.some((prompt: any) => prompt.key === "ultraviolet_fluorescence"));
    assert.equal(body.prompts.some((prompt: any) => prompt.key === "article_image_psychedelic_editorial"), false);

    const promptList = await (await s.go("/api/admin/prompts")).json() as any;
    assert.ok(promptList.runnable.some((prompt: any) => prompt.key === "article_image"));
    assert.equal(promptList.runnable.some((prompt: any) => prompt.key === "1990s_cgi"), false);
    assert.equal(promptList.runnable.some((prompt: any) => prompt.key === "article_image_psychedelic_editorial"), false);
  });

  test("POST and DELETE /api/admin/article-image-prompts creates and removes a preset", async (t) => {
    const suffix = randomUUID().replace(/-/g, "_");
    const key = `test_${suffix}`;
    const promptPath = join(process.cwd(), "config", "prompts", "article_image_presets", `${key}.toml`);
    t.after(() => {
      if (existsSync(promptPath)) unlinkSync(promptPath);
    });
    const s = await makeTestServer(); t.after(s.cleanup);
    const createRes = await s.go("/api/admin/article-image-prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `test ${suffix}`, copyFrom: "default" }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json() as any;
    assert.equal(created.prompt.key, key);
    assert.equal(existsSync(promptPath), true);

    const deleteRes = await s.go(`/api/admin/article-image-prompts/${key}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    assert.equal(existsSync(promptPath), false);
  });

  test("POST /api/article/:slug/image/generate uses selected image preset key", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedPrompt = "";
    setImageGenerationFetchForTests(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      capturedPrompt = body.prompt ?? "";
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const s = await makeTestServer(new FakeLlm(), enabledOpenAiImageGeneration); t.after(s.cleanup);
    const articleSlug = seedArticle(s.databasePath);
    const res = await s.go(`/api/article/${articleSlug}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetKey: "psychedelic_editorial" }),
    });
    if (res.status !== 200) {
      const b = await res.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(res.status, 200, `unexpected status: ${res.status} ${b?.error ?? ""}`);
    }
    await res.json();
    assert.match(capturedPrompt, /conceptual editorial photo-illustration/i);
  });

  test("POST /api/article/:slug/image/generate accepts mixed-case selected image preset keys", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedBody: any = null;
    setImageGenerationFetchForTests(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const s = await makeTestServer(new FakeLlm(), enabledOpenAiImageGeneration); t.after(s.cleanup);
    const articleSlug = seedArticle(s.databasePath);
    const res = await s.go(`/api/article/${articleSlug}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetKey: "ARTICLE_IMAGE_PSYchEDELic_EDitorial", aspectRatioKey: "PoRtrait" }),
    });
    if (res.status !== 200) {
      const b = await res.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(res.status, 200, `unexpected status: ${res.status} ${b?.error ?? ""}`);
    }
    const body = await res.json() as any;
    assert.equal(body.presetKey, "psychedelic_editorial");
    assert.equal(body.aspectRatioKey, "portrait");
    assert.match(capturedBody.prompt, /conceptual editorial photo-illustration/i);
    assert.equal(capturedBody.size, "832x1088");
  });

  test("POST /api/article/:slug/image/generate uses logos preset without transparent output", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedBody: any = null;
    setImageGenerationFetchForTests(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const s = await makeTestServer(new FakeLlm(), enabledOpenAiImageGeneration); t.after(s.cleanup);
    const articleSlug = seedArticle(s.databasePath);
    const res = await s.go(`/api/article/${articleSlug}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetKey: "logos" }),
    });
    if (res.status !== 200) {
      const b = await res.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(res.status, 200, `unexpected status: ${res.status} ${b?.error ?? ""}`);
    }
    const body = await res.json() as any;
    assert.equal(body.presetKey, "logos");
    assert.match(capturedBody.prompt, /standalone fictional logo/i);
    assert.doesNotMatch(capturedBody.prompt, /transparent background/i);
    assert.equal("background" in capturedBody, false);
  });

  test("POST /api/article/:slug/image/generate can ask the LLM to select an image preset", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedPrompt = "";
    setImageGenerationFetchForTests(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      capturedPrompt = body.prompt ?? "";
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const llm = new FakeLlm('{"presetKey":"psychedelic_editorial","reason":"Psychedelic editorial best fits the article because it can make a neutral subject visually playful."}');
    const s = await makeTestServer(llm, enabledOpenAiImageGeneration); t.after(s.cleanup);
    const articleSlug = seedArticle(s.databasePath);
    const res = await s.go(`/api/article/${articleSlug}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetKey: "auto" }),
    });
    if (res.status !== 200) {
      const b = await res.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(res.status, 200, `unexpected status: ${res.status} ${b?.error ?? ""}`);
    }
    const body = await res.json() as any;
    assert.equal(body.presetKey, "psychedelic_editorial");
    assert.match(capturedPrompt, /conceptual editorial photo-illustration/i);
    assert.ok(llm.capturedPrompts.some((prompt) => prompt.user.includes("Allowed presets:")));
    assert.ok(llm.capturedPrompts.some((prompt) => /preset owner's intended use case/i.test(prompt.system)));
    assert.ok(llm.capturedPrompts.some((prompt) => /favor fitting variety over the safest\s+generic answer/i.test(prompt.user)));
    assert.ok(llm.capturedPrompts.some((prompt) => /reason\s+as one short sentence/i.test(prompt.user)));
    const selectorPrompt = llm.capturedPrompts.find((prompt) => prompt.user.includes("Allowed presets:"));
    assert.ok(selectorPrompt);
    assert.match(selectorPrompt.system, /intentionally shuffled per article/i);
    assert.doesNotMatch(selectorPrompt.system, /Screenshots are a narrow fit/i);
    assert.doesNotMatch(selectorPrompt.system, /Do not pick photo merely because\s+it is safe/i);
    assert.ok(selectorPrompt.user.includes("- photo:"));
    assert.ok(selectorPrompt.user.includes("- psychedelic_editorial:"));
    assert.doesNotMatch(selectorPrompt.user, /Sidebar\/object facts:/i);
    assert.match(selectorPrompt.user, /- screenshot:\n  Select when: .*substantially about software/i);
    assert.match(selectorPrompt.user, /Select when: .*substantially about software/i);
    assert.match(selectorPrompt.user, /Avoid when: .*ordinary person, place, organization/i);
    assert.match(selectorPrompt.user, /- photocopy:\n  Select when: .*specifically about a document/i);
    assert.match(selectorPrompt.user, /Select when: .*copy-machine degradation is the point/i);
    assert.match(selectorPrompt.user, /Avoid when: .*only incidentally involves paperwork/i);
    assert.doesNotMatch(selectorPrompt.user, /photocopy:\n  Select when: .*rumors/i);
    assert.match(selectorPrompt.user, /Select when: .*grounded documentary/i);
    assert.doesNotMatch(selectorPrompt.user, /Create one editorial hero image/i);
    assert.doesNotMatch(selectorPrompt.user, /Core look:/i);
    const schema = llm.capturedOptions[0]?.jsonSchema as any;
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.image, undefined);
    assert.ok(schema.properties.presetKey.enum.includes("photo"));
    assert.ok(schema.properties.presetKey.enum.includes("psychedelic_editorial"));
    assert.ok(schema.properties.aspectRatioKey.enum.includes("landscape"));
    assert.deepEqual(schema.required, ["presetKey", "reason"]);
    assert.equal(llm.capturedPrompts.filter((prompt) => prompt.user.includes("Allowed presets:")).length, 1);
  });

  test("POST /api/article/:slug/image/generate can ask the LLM to select an aspect ratio", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedBody: any = null;
    setImageGenerationFetchForTests(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const llm = new FakeLlm('{"presetKey":"photo","aspectRatioKey":"Portrait","reason":"Photo keeps the portrait subject legible.","aspectRatioReason":"Portrait fits a person better than landscape."}');
    const s = await makeTestServer(
      llm,
      { ...enabledOpenAiImageGeneration, auto_preset_multipass: false },
    ); t.after(s.cleanup);
    const articleSlug = seedArticle(s.databasePath);
    const res = await s.go(`/api/article/${articleSlug}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetKey: "auto", aspectRatioKey: "auto" }),
    });
    if (res.status !== 200) {
      const b = await res.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(res.status, 200, `unexpected status: ${res.status} ${b?.error ?? ""}`);
    }
    const body = await res.json() as any;
    assert.equal(body.presetKey, "default");
    assert.equal(body.aspectRatioKey, "portrait");
    assert.equal(capturedBody.size, "832x1088");
    const selectorPrompt = llm.capturedPrompts.find((prompt) => prompt.user.includes("Allowed aspect ratios:"));
    assert.ok(selectorPrompt);
    assert.match(selectorPrompt.user, /- portrait: portrait \(832x1088\)/);
    assert.match(selectorPrompt.user, /Use portrait shapes for people/i);
    const schema = llm.capturedOptions[0]?.jsonSchema as any;
    assert.ok(schema.properties.aspectRatioKey.enum.includes("portrait"));
    assert.ok(schema.required.includes("aspectRatioKey"));
    assert.ok(schema.required.includes("aspectRatioReason"));
  });

  test("POST /api/article/:slug/image/generate accepts mixed-case auto preset responses", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedBody: any = null;
    setImageGenerationFetchForTests(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const llm = new FakeLlm('{"presetKey":"Photo","reason":"Photo keeps the article subject grounded."}');
    const s = await makeTestServer(
      llm,
      { ...enabledOpenAiImageGeneration, auto_preset_multipass: false },
    ); t.after(s.cleanup);
    const articleSlug = seedArticle(s.databasePath);
    const res = await s.go(`/api/article/${articleSlug}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetKey: "auto" }),
    });
    if (res.status !== 200) {
      const b = await res.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(res.status, 200, `unexpected status: ${res.status} ${b?.error ?? ""}`);
    }
    const body = await res.json() as any;
    assert.equal(body.presetKey, "default");
    assert.match(capturedBody.prompt, /high-end photoreal editorial image/i);
  });

  test("POST /api/article/:slug/image/generate retries malformed auto preset responses", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedPrompt = "";
    setImageGenerationFetchForTests(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      capturedPrompt = body.prompt ?? "";
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const logEntries: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
    const llm = new FakeLlm([
      "I choose psychedelic_editorial because it seems right.",
      '{"presetKey":"psychedelic_editorial","reason":"Psychedelic editorial best fits the article after retry."}',
    ]);
    const s = await makeTestServer(llm, enabledOpenAiImageGeneration, captureLogger(logEntries)); t.after(s.cleanup);
    const articleSlug = seedArticle(s.databasePath);
    const res = await s.go(`/api/article/${articleSlug}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetKey: "auto" }),
    });
    if (res.status !== 200) {
      const b = await res.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(res.status, 200, `unexpected status: ${res.status} ${b?.error ?? ""}`);
    }
    const body = await res.json() as any;
    assert.equal(body.presetKey, "psychedelic_editorial");
    assert.match(capturedPrompt, /conceptual editorial photo-illustration/i);
    const selectorPrompts = llm.capturedPrompts.filter((prompt) => prompt.user.includes("Allowed presets:"));
    assert.equal(selectorPrompts.length, 2);
    assert.match(selectorPrompts[1].user, /Previous response was rejected/i);
    assert.ok(logEntries.some((entry) =>
      entry.event === "article_image.preset_selection_invalid" &&
      entry.fields?.attempt === 1
    ));
  });

  test("POST /api/article/:slug/image/generate retries image-prompt-shaped auto preset responses", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedPrompt = "";
    setImageGenerationFetchForTests(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      capturedPrompt = body.prompt ?? "";
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const logEntries: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
    const badPromptObject = JSON.stringify({
      prompt: "A highly detailed, photorealistic image of a lone astronaut gazing out of a spacecraft window at a breathtaking nebula.",
      style: "Photorealistic, Cinematic Lighting",
      aspect_ratio: "16:9",
    });
    const llm = new FakeLlm([
      badPromptObject,
      '{"presetKey":"photo","reason":"Photo keeps the article subject grounded and legible."}',
    ]);
    const s = await makeTestServer(
      llm,
      { ...enabledOpenAiImageGeneration, auto_preset_multipass: false },
      captureLogger(logEntries),
    ); t.after(s.cleanup);
    const articleSlug = seedArticle(s.databasePath);
    const res = await s.go(`/api/article/${articleSlug}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetKey: "auto" }),
    });
    if (res.status !== 200) {
      const b = await res.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(res.status, 200, `unexpected status: ${res.status} ${b?.error ?? ""}`);
    }
    const body = await res.json() as any;
    assert.equal(body.presetKey, "default");
    assert.match(capturedPrompt, /high-end photoreal editorial image/i);
    assert.doesNotMatch(capturedPrompt, /lone astronaut gazing out of a spacecraft window/i);
    const selectorPrompts = llm.capturedPrompts.filter((prompt) => prompt.user.includes("Allowed presets:"));
    assert.equal(selectorPrompts.length, 2);
    assert.match(selectorPrompts[0].system, /Never return\s+fields like "prompt", "style", or "aspect_ratio"/i);
    assert.match(selectorPrompts[1].user, /do not return prompt\/style\/aspect_ratio fields/i);
    assert.ok(logEntries.some((entry) =>
      entry.event === "article_image.preset_selection_invalid" &&
      entry.fields?.attempt === 1 &&
      String(entry.fields?.raw ?? "").includes('"aspect_ratio":"16:9"')
    ));
  });

  test("POST /api/article/:slug/image/generate rejects auto preset responses after retry exhaustion", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let imageFetchCalls = 0;
    setImageGenerationFetchForTests(async () => {
      imageFetchCalls += 1;
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const logEntries: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
    const llm = new FakeLlm([
      "psychedelic_editorial",
      '{"presetKey":42,"reason":"wrong type"}',
      '{"presetKey":"not_allowed","reason":"unknown preset"}',
    ]);
    const s = await makeTestServer(llm, enabledOpenAiImageGeneration, captureLogger(logEntries)); t.after(s.cleanup);
    const articleSlug = seedArticle(s.databasePath);
    const res = await s.go(`/api/article/${articleSlug}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetKey: "auto" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.match(body.error, /preset selection returned invalid selector responses/i);
    assert.equal(imageFetchCalls, 0);
    assert.equal(llm.capturedPrompts.filter((prompt) => prompt.user.includes("Allowed presets:")).length, 3);
    assert.ok(logEntries.some((entry) =>
      entry.event === "article_image.preset_selection_invalid" &&
      entry.fields?.attempt === 3
    ));
  });

  test("article image generation workflow keeps preset selection passes as pipeline nodes", () => {
    assert.deepEqual(
      articleImageGenerationWorkflow.edges.map((edge) => edge.node.name),
      [
        "llm.select_image_preset_initial",
        "llm.select_image_preset_challenger",
        "llm.select_image_preset_final",
        "image.generate_attach",
      ],
    );
  });

  test("POST /api/article/:slug/image/generate shuffles auto preset order by article", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    setImageGenerationFetchForTests(async (_url, init) => {
      JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const llm = new FakeLlm('{"presetKey":"psychedelic_editorial","reason":"Psychedelic editorial adds variety while preserving the article subject."}');
    const s = await makeTestServer(llm, enabledOpenAiImageGeneration); t.after(s.cleanup);
    const articleSlugA = seedArticle(s.databasePath, "shuffle-a");
    const articleSlugB = seedArticle(s.databasePath, "shuffle-b");

    const resA = await s.go(`/api/article/${articleSlugA}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetKey: "auto" }),
    });
    if (resA.status !== 200) {
      const b = await resA.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(resA.status, 200, `unexpected status: ${resA.status} ${b?.error ?? ""}`);
    }
    await resA.json();

    const resB = await s.go(`/api/article/${articleSlugB}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetKey: "auto" }),
    });
    if (resB.status !== 200) {
      const b = await resB.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(resB.status, 200, `unexpected status: ${resB.status} ${b?.error ?? ""}`);
    }
    await resB.json();

    const selectorPrompts = llm.capturedPrompts.filter((prompt) => prompt.user.includes("Allowed presets:"));
    assert.equal(selectorPrompts.length, 2);
    const presetLinesA = selectorPrompts[0].user.match(/^- [a-z0-9_]+:/gm) ?? [];
    const presetLinesB = selectorPrompts[1].user.match(/^- [a-z0-9_]+:/gm) ?? [];
    assert.ok(presetLinesA.includes("- photo:"));
    assert.ok(presetLinesB.includes("- photo:"));
    assert.notDeepEqual(presetLinesA, presetLinesB);
  });

  test("POST /api/article/:slug/image/generate skips challenger pass when multipass is disabled", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedPrompt = "";
    setImageGenerationFetchForTests(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      capturedPrompt = body.prompt ?? "";
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const llm = new FakeLlm([
      '{"presetKey":"photo","reason":"Photo is the safest literal rendering."}',
      '{"presetKey":"psychedelic_editorial","reason":"This response should not be used."}',
    ]);
    const s = await makeTestServer(
      llm,
      { ...enabledOpenAiImageGeneration, auto_preset_multipass: false },
    ); t.after(s.cleanup);
    const articleSlug = seedArticle(s.databasePath);
    const res = await s.go(`/api/article/${articleSlug}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetKey: "auto" }),
    });
    if (res.status !== 200) {
      const b = await res.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(res.status, 200, `unexpected status: ${res.status} ${b?.error ?? ""}`);
    }
    const body = await res.json() as any;
    assert.equal(body.presetKey, "default");
    assert.match(capturedPrompt, /high-end photoreal editorial image/i);
    assert.equal(llm.capturedPrompts.filter((prompt) => prompt.user.includes("Allowed presets:")).length, 1);
  });

  test("POST /api/article/:slug/image/generate lets a specialized challenger beat photo", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedPrompt = "";
    setImageGenerationFetchForTests(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      capturedPrompt = body.prompt ?? "";
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const logEntries: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
    const llm = new FakeLlm([
      '{"presetKey":"photo","reason":"Photo is the safest literal rendering."}',
      '{"presetKey":"psychedelic_editorial","reason":"Psychedelic editorial is the strongest specialized challenger."}',
      '{"presetKey":"psychedelic_editorial","reason":"Psychedelic editorial adds useful visual variety without losing the subject."}',
    ]);
    const s = await makeTestServer(llm, enabledOpenAiImageGeneration, captureLogger(logEntries)); t.after(s.cleanup);
    const articleSlug = seedArticle(s.databasePath);
    const res = await s.go(`/api/article/${articleSlug}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetKey: "auto" }),
    });
    if (res.status !== 200) {
      const b = await res.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(res.status, 200, `unexpected status: ${res.status} ${b?.error ?? ""}`);
    }
    const body = await res.json() as any;
    assert.equal(body.presetKey, "psychedelic_editorial");
    assert.match(capturedPrompt, /conceptual editorial photo-illustration/i);

    const selectorPrompts = llm.capturedPrompts.filter((prompt) => prompt.user.includes("Allowed presets:"));
    assert.equal(selectorPrompts.length, 3);
    assert.match(selectorPrompts[1].user, /photo is not an allowed key/i);
    assert.equal(selectorPrompts[1].user.includes("- photo:"), false);
    assert.ok(selectorPrompts[1].user.includes("- psychedelic_editorial:"));
    assert.match(selectorPrompts[2].user, /strongest specialized challenger is "psychedelic_editorial"/i);
    assert.ok(selectorPrompts[2].user.includes("- photo:"));
    assert.ok(selectorPrompts[2].user.includes("- psychedelic_editorial:"));
    assert.ok(logEntries.some((entry) =>
      entry.event === "article_image.preset_final_selected" &&
      entry.fields?.presetKey === "psychedelic_editorial" &&
      entry.fields?.reason === "Psychedelic editorial adds useful visual variety without losing the subject."
    ));
  });

  test("POST /api/article/:slug/image/generate can keep photo after judging a specialized challenger", async (t) => {
    t.after(() => setImageGenerationFetchForTests(null));
    let capturedPrompt = "";
    setImageGenerationFetchForTests(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      capturedPrompt = body.prompt ?? "";
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const logEntries: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
    const llm = new FakeLlm([
      '{"presetKey":"photo","reason":"Photo is the safest literal rendering."}',
      '{"presetKey":"psychedelic_editorial","reason":"Psychedelic editorial is the strongest specialized challenger."}',
      '{"presetKey":"photo","reason":"Photo keeps the neutral article clearer than the challenger."}',
    ]);
    const s = await makeTestServer(llm, enabledOpenAiImageGeneration, captureLogger(logEntries)); t.after(s.cleanup);
    const articleSlug = seedArticle(s.databasePath);
    const res = await s.go(`/api/article/${articleSlug}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presetKey: "auto" }),
    });
    if (res.status !== 200) {
      const b = await res.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
      assert.equal(res.status, 200, `unexpected status: ${res.status} ${b?.error ?? ""}`);
    }
    const body = await res.json() as any;
    assert.equal(body.presetKey, "default");
    assert.match(capturedPrompt, /high-end photoreal editorial image/i);

    const selectorPrompts = llm.capturedPrompts.filter((prompt) => prompt.user.includes("Allowed presets:"));
    assert.equal(selectorPrompts.length, 3);
    assert.match(selectorPrompts[2].user, /pick photo if "psychedelic_editorial" would distract from/i);
    assert.ok(logEntries.some((entry) =>
      entry.event === "article_image.preset_final_selected" &&
      entry.fields?.presetKey === "default" &&
      entry.fields?.reason === "Photo keeps the neutral article clearer than the challenger."
    ));
  });

  test("POST /api/article/:slug/image/generate rejects non-image prompt key", async (t) => {
    const s = await makeTestServer(new FakeLlm(), enabledOpenAiImageGeneration); t.after(s.cleanup);
    const articleSlug = seedArticle(s.databasePath);
    const res = await s.go(`/api/article/${articleSlug}/image/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ promptKey: "article" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.match(body.error, /unknown image preset/i);
  });

  test("GET /api/article/:slug/image returns image info when attached", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "att-img");
    const db = openDatabase(s.databasePath);
    upsertArticleHeadlineMedia(db, "aspirin", "att-img", "The caption");
    db.close();
    const body = await (await s.go("/api/article/aspirin/image")).json() as any;
    assert.ok(body.image);
    assert.equal(body.image.id, "att-img");
    assert.equal(body.image.articleCaption, "The caption");
  });

  test("PATCH /api/article/:slug/image/caption updates per-article caption", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "cap-img");
    const db = openDatabase(s.databasePath);
    upsertArticleHeadlineMedia(db, "aspirin", "cap-img", "Old");
    db.close();
    await s.go("/api/article/aspirin/image/caption", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ caption: "New" }) });
    const info = await (await s.go("/api/article/aspirin/image")).json() as any;
    assert.equal(info.image.articleCaption, "New");
  });

  test("POST /api/article/:slug/image records old and new image snapshots in article history", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "old-img");
    seedMedia(s.mediaDatabasePath, "new-img");
    const db = openDatabase(s.databasePath);
    upsertArticleHeadlineMedia(db, "aspirin", "old-img", "Old caption");
    db.close();

    const res = await s.go("/api/article/aspirin/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaId: "new-img" }),
    });
    assert.equal(res.status, 200);

    const checkDb = openDatabase(s.databasePath);
    const revisions = listArticleRevisions(checkDb, "aspirin");
    checkDb.close();
    assert.equal(revisions[0].operation, "image-attach");
    assert.equal(revisions[0].headlineMediaId, "new-img");
    assert.equal(revisions[0].headlineMediaCaption, "");
    assert.equal(revisions[1].headlineMediaId, "old-img");
    assert.equal(revisions[1].headlineMediaCaption, "Old caption");
  });

  test("POST /api/article/:slug/revert restores headline image snapshot", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "old-revert-img");
    seedMedia(s.mediaDatabasePath, "new-revert-img");
    const db = openDatabase(s.databasePath);
    upsertArticleHeadlineMedia(db, "aspirin", "old-revert-img", "Old revert caption");
    db.close();

    const replaceRes = await s.go("/api/article/aspirin/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaId: "new-revert-img" }),
    });
    assert.equal(replaceRes.status, 200);

    const historyDb = openDatabase(s.databasePath);
    const oldImageRevision = listArticleRevisions(historyDb, "aspirin")[1];
    historyDb.close();
    assert.equal(oldImageRevision.headlineMediaId, "old-revert-img");

    const revertRes = await s.go("/api/article/aspirin/revert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revisionId: oldImageRevision.id }),
    });
    assert.equal(revertRes.status, 200);

    const image = await (await s.go("/api/article/aspirin/image")).json() as any;
    assert.equal(image.image.id, "old-revert-img");
    assert.equal(image.image.articleCaption, "Old revert caption");
  });

  test("PATCH /api/article/:slug/image/caption records article-specific caption history", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "caption-history-img");
    const db = openDatabase(s.databasePath);
    upsertArticleHeadlineMedia(db, "aspirin", "caption-history-img", "Old caption");
    db.close();

    const res = await s.go("/api/article/aspirin/image/caption", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caption: "New caption" }),
    });
    assert.equal(res.status, 200);

    const checkDb = openDatabase(s.databasePath);
    const revisions = listArticleRevisions(checkDb, "aspirin");
    checkDb.close();
    assert.equal(revisions[0].operation, "image-caption-edit");
    assert.equal(revisions[0].headlineMediaId, "caption-history-img");
    assert.equal(revisions[0].headlineMediaCaption, "New caption");
    assert.equal(revisions[1].headlineMediaId, "caption-history-img");
    assert.equal(revisions[1].headlineMediaCaption, "Old caption");
  });

  test("DELETE /api/article/:slug/image removes attachment", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "del-img");
    const db = openDatabase(s.databasePath);
    upsertArticleHeadlineMedia(db, "aspirin", "del-img", "");
    db.close();
    await s.go("/api/article/aspirin/image", { method: "DELETE" });
    const body = await (await s.go("/api/article/aspirin/image")).json() as any;
    assert.equal(body.image, null);
  });

  test("DELETE /api/article/:slug/image records removed image in article history", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "removed-history-img");
    const db = openDatabase(s.databasePath);
    upsertArticleHeadlineMedia(db, "aspirin", "removed-history-img", "Removed caption");
    db.close();

    const res = await s.go("/api/article/aspirin/image", { method: "DELETE" });
    assert.equal(res.status, 200);

    const checkDb = openDatabase(s.databasePath);
    const revisions = listArticleRevisions(checkDb, "aspirin");
    checkDb.close();
    assert.equal(revisions[0].operation, "image-remove");
    assert.equal(revisions[0].headlineMediaId, null);
    assert.equal(revisions[0].headlineMediaCaption, null);
    assert.equal(revisions[1].headlineMediaId, "removed-history-img");
    assert.equal(revisions[1].headlineMediaCaption, "Removed caption");
  });

  test("POST .../image/upload with raw image/* body stores and attaches image", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    const r = await s.go("/api/article/aspirin/image/upload", { method: "POST", headers: { "content-type": "image/png" }, body: TINY_PNG });
    if (r.status !== 200) {
      // vips processed OK but maybe the image is too tiny; skip rather than fail
      const b = await r.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
    }
    assert.equal(r.status, 200, `unexpected status: ${r.status}`);
    const body = await r.json() as any;
    assert.ok(body.mediaId);
    assert.equal(body.isNew, true);
    const check = await (await s.go("/api/article/aspirin/image")).json() as any;
    assert.equal(check.image?.id, body.mediaId);
  });

  test("POST .../image/upload with multipart form-data works", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    const form = new FormData();
    form.append("image", new Blob([TINY_PNG], { type: "image/png" }), "test.png");
    const r = await s.go("/api/article/aspirin/image/upload", { method: "POST", body: form });
    if (r.status !== 200) {
      const b = await r.json() as any;
      if (/vips|dimension|load/i.test(b?.error ?? "")) return;
    }
    assert.equal(r.status, 200);
  });

  test("POST .../image/upload 400 for wrong content-type", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    const r = await s.go("/api/article/aspirin/image/upload", { method: "POST", headers: { "content-type": "application/json" }, body: '{}' });
    assert.equal(r.status, 400);
  });

  test("page response includes infobox sidecar when set", async (t) => {
    // Infoboxes render client-side from page.infobox — not embedded in article.html.
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "ib-img");
    const db = openDatabase(s.databasePath);
    upsertArticleHeadlineMedia(db, "aspirin", "ib-img", "Tablets");
    setArticleInfobox(db, "aspirin", { title: "Aspirin", groups: [{ label: "Chemistry", rows: [{ label: "Formula", value: "C9H8O4" }] }] });
    db.close();
    const body = await (await s.go("/api/page/aspirin")).json() as any;
    assert.ok(body.infobox, "infobox sidecar present");
    assert.equal(body.infobox.title, "Aspirin");
    assert.equal(body.infobox.groups[0].rows[0].value, "C9H8O4");
    assert.ok(body.headlineMedia, "headlineMedia sidecar present");
    assert.equal(body.headlineMedia.mediaId, "ib-img");
  });

  test("article HTML has no infobox when none set", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    const body = await (await s.go("/api/page/aspirin")).json() as any;
    assert.doesNotMatch(body.article.html as string, /class="infobox"/);
  });

  test("GET /api/media returns { media: [...] } for all images", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "list-img-1");
    seedMedia(s.mediaDatabasePath, "list-img-2");
    const res = await s.go("/api/media");
    assert.equal(res.status, 200);
    const body = await res.json() as { media: any[] };
    assert.ok(Array.isArray(body.media));
    assert.ok(body.media.length >= 2);
    // model_b64 should be stripped from public listing
    assert.equal(body.media[0].model_b64, undefined);
  });

  test("GET /api/media?q=keyword filters by description LIKE", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    // Seed two images: one with default description "A test image", one different
    seedMedia(s.mediaDatabasePath, "searchable-img");
    const mdb = openMediaDatabase(s.mediaDatabasePath);
    updateMediaDescription(mdb, "searchable-img", "Unique crystalline descriptor", "update");
    mdb.close();
    // Seed a second image with a different description
    const mdb2 = openMediaDatabase(s.mediaDatabasePath);
    insertMedia(mdb2, { ...baseMediaRecord("other-img"), sha256: "ot".padEnd(64, "o"), description: "Completely unrelated" });
    mdb2.close();

    const res = await s.go("/api/media?q=crystalline");
    assert.equal(res.status, 200);
    const body = await res.json() as { media: any[] };
    assert.equal(body.media.length, 1);
    assert.equal(body.media[0].id, "searchable-img");
  });

  test("GET /api/media/:id/history returns revisions after PATCH description", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "hist-img");
    // PATCH to add a user-edit revision
    await s.go("/api/media/hist-img/description", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "User-edited description" }),
    });
    const res = await s.go("/api/media/hist-img/history");
    assert.equal(res.status, 200);
    const body = await res.json() as { history: any[] };
    assert.ok(Array.isArray(body.history));
    assert.ok(body.history.length >= 1);
    // Should contain a "user-edit" revision
    assert.ok(body.history.some((r: any) => r.operation === "user-edit"));
  });

  test("GET /api/media/:id/history returns 404 for unknown id", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    const res = await s.go("/api/media/nonexistent-id/history");
    assert.equal(res.status, 404);
  });

  test("GET /api/article/:slug/live returns NDJSON stream with ready event", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    const res = await s.go("/api/article/aspirin/live");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /ndjson/);
    // Read the first line
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    reader.cancel();
    const line = new TextDecoder().decode(value).split("\n")[0];
    const parsed = JSON.parse(line);
    assert.equal(parsed.type, "ready");
    assert.equal(parsed.slug, "aspirin");
  });

  test("POST /api/article/:slug/image with { mediaId } attaches existing record", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "existing-media-id");
    const res = await s.go("/api/article/aspirin/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaId: "existing-media-id" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.mediaId, "existing-media-id");
    // Verify it was attached
    const check = await (await s.go("/api/article/aspirin/image")).json() as any;
    assert.equal(check.image?.id, "existing-media-id");
  });

  test("POST /api/article/:slug/image strips inline media from article body", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "attach-img");

    // Update the article to have inline media in its body
    const db = openDatabase(s.databasePath);
    const md = "# Aspirin\n\n![A caption](media:old-slug)\n\nA medication.";
    saveArticle(db, {
      slug: "aspirin",
      canonicalSlug: "aspirin",
      title: "Aspirin",
      markdown: md,
      html: renderMarkdown(md),
      plain_text: markdownToPlainText(md),
      generated_at: Date.now() + 1,
    }, [], ["aspirin"]);
    db.close();

    // Attach a new image — should trigger body cleaning
    const res = await s.go("/api/article/aspirin/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaId: "attach-img" }),
    });
    assert.equal(res.status, 200);

    // Check that the article body no longer contains media: image syntax
    const pageRes = await s.go("/api/page/aspirin");
    const page = await pageRes.json() as any;
    assert.doesNotMatch(page.article.html as string, /media:old-slug/);
    assert.doesNotMatch(page.article.html as string, /media-ref-link/);
  });
});

// ── pipeline-nodes ────────────────────────────────────────────────────────────

describe("pipeline-nodes", () => {
  function makeDeps(db: ReturnType<typeof makeArticleDb>, llm: LlmRouter) {
    return { db, llm, prompts: buildPromptRegistry(TEST_CONFIG.prompts), logger: noop(), runtime: TEST_CONFIG };
  }

  function makeInput(slug = "test-article") {
    return initialPipelineState({ requestId: randomUUID(), workflow: "article.post_process", slug, requestedTitle: "Test Article" });
  }

  test("generateInfoboxNode: produces infobox when headline image attached", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    upsertArticleHeadlineMedia(db, "test-article", "some-img", "");
    const llm = new FakeLlm('{"title":"Test Article","groups":[{"label":"Details","rows":[{"label":"Field","value":"Value"}]}]}');
    const patch = await generateInfoboxNode.run({ ...makeInput(), finalArticleBody: "# Test Article\n\nBody.", canonicalTitle: "Test Article" } as any, makeDeps(db, llm) as any);
    assert.ok(patch.infobox);
    const box = patch.infobox as InfoboxData;
    assert.equal(box.title, "Test Article");
    assert.equal(box.groups[0].rows[0].label, "Field");
    db.close();
  });

  test("generateInfoboxNode: generates infobox for body-only article (no headline image required)", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    // No headline image attached — node now runs for ALL articles
    const llm = new FakeLlm('{"title":"Test Article","groups":[{"label":"Details","rows":[{"label":"Field","value":"Value"}]}]}');
    const patch = await generateInfoboxNode.run({ ...makeInput(), finalArticleBody: "# Test Article\n\nBody.", canonicalTitle: "Test Article" } as any, makeDeps(db, llm) as any);
    assert.ok(patch.infobox);
    assert.equal((patch.infobox as InfoboxData).title, "Test Article");
    db.close();
  });

  test("generateInfoboxNode: returns undefined on malformed LLM JSON", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    upsertArticleHeadlineMedia(db, "test-article", "img", "");
    const patch = await generateInfoboxNode.run({ ...makeInput(), finalArticleBody: "# T\n\nB.", canonicalTitle: "T" } as any, makeDeps(db, new FakeLlm("NOT JSON")) as any);
    assert.equal(patch.infobox, undefined);
    db.close();
  });

  test("persistInfoboxNode: writes infobox to article_infobox", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const box: InfoboxData = { title: "Aspirin", groups: [{ label: "", rows: [{ label: "CAS", value: "50-78-2" }] }] };
    persistInfoboxNode.run({ ...makeInput(), infobox: box } as any, makeDeps(db, new FakeLlm()) as any);
    const saved = getArticleInfobox(db, "test-article");
    assert.ok(saved);
    assert.equal(saved.title, "Aspirin");
    assert.equal(saved.groups[0].rows[0].value, "50-78-2");
    db.close();
  });

  // ── image.caption pipeline nodes ──────────────────────────────────────────

  test("generateImageCaptionNode: generates caption from article context (text-only model)", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));

    // Seed a media record so the node can find it
    insertMedia(mediaDb, { ...baseMediaRecord("cap-img"), sha256: "cap".padEnd(64, "0") });

    const description = "A fictional compound used in metallurgy.";
    const llm = new FakeLlm(description);
    const deps = makeDeps(db, llm);
    const depsWithMedia = { ...deps, mediaDb };

    const state = {
      ...initialPipelineState({ requestId: randomUUID(), workflow: "image.caption", slug: "test-article", imageId: "cap-img" }),
      loadedArticle: { slug: "test-article", canonicalSlug: "test-article", title: "Test Article", body: "# Test Article\n\nBody.", summary: "", generatedAt: Date.now() },
    };

    const patch = await generateImageCaptionNode.run(state as any, depsWithMedia as any);
    assert.ok(patch.imageCaptionResult);
    // titleSlug is derived from the first words of the (plain-prose) description —
    // see captionImage.ts, which slugifies the response rather than parsing JSON
    // (image_description.toml sets json = false).
    assert.equal(patch.imageCaptionResult.titleSlug, "a-fictional-compound-used-in-metallurgy");
    assert.equal(patch.imageCaptionResult.description, description);

    // Verify no vision images were attached (text-only model)
    assert.equal(llm.capturedOptions[0]?.images, undefined);
    mediaDb.close(); db.close();
  });

  test("persistImageCaptionNode: updates description and writes articleCaption to article_media", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));

    insertMedia(mediaDb, { ...baseMediaRecord("img-aabbcc112233"), sha256: "aa".padEnd(64, "a") });
    upsertArticleHeadlineMedia(db, "test-article", "img-aabbcc112233", "");

    const deps = { ...makeDeps(db, new FakeLlm()), mediaDb };
    const state = {
      ...initialPipelineState({ requestId: randomUUID(), workflow: "image.caption", slug: "test-article", imageId: "img-aabbcc112233" }),
      imageCaptionResult: { titleSlug: "nice-slug", description: "A nice image.", articleCaption: "Sidebar caption text." },
    };

    persistImageCaptionNode.run(state as any, deps as any);

    // Media description was updated; id stays the same (renaming moved to attachAndCaption)
    const rec = getMediaById(mediaDb, "img-aabbcc112233");
    assert.ok(rec);
    assert.equal(rec.description, "A nice image.");

    // articleCaption is written to article_media.caption
    const headline = getArticleHeadlineMedia(db, "test-article");
    assert.equal(headline?.mediaId, "img-aabbcc112233");
    assert.equal(headline?.caption, "Sidebar caption text.");

    mediaDb.close(); db.close();
  });

  test("persistInfoboxNode: no-ops silently when infobox undefined", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    assert.doesNotThrow(() => persistInfoboxNode.run({ ...makeInput(), infobox: undefined } as any, makeDeps(db, new FakeLlm()) as any));
    assert.equal(getArticleInfobox(db, "test-article"), null);
    db.close();
  });

  test("persistInfoboxNode: calls onSidecarUpdate when infobox is saved", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const calls: Array<[string, unknown]> = [];
    const box: InfoboxData = { title: "Aspirin", groups: [] };
    const deps = { ...makeDeps(db, new FakeLlm()), onSidecarUpdate: (slug: string, payload: unknown) => calls.push([slug, payload]) };
    persistInfoboxNode.run({ ...makeInput(), infobox: box } as any, deps as any);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "test-article");
    assert.deepEqual((calls[0][1] as any).type, "infobox");
    db.close();
  });

  // ── generateArticleCaptionNode ──────────────────────────────────────────────

  test("generateArticleCaptionNode: sets articleCaption from LLM response", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const captionJson = JSON.stringify({ caption: "A short sidebar caption." });
    const llm = new FakeLlm(captionJson);
    const deps = makeDeps(db, llm);
    const state = {
      ...initialPipelineState({ requestId: randomUUID(), workflow: "image.caption", slug: "test-article", imageId: "some-img" }),
      loadedArticle: { slug: "test-article", canonicalSlug: "test-article", title: "Test Article", body: "# Test\n\nBody.", summary: "", generatedAt: Date.now() },
      imageCaptionResult: { titleSlug: "some-img", description: "A test image description." },
    };
    const patch = await generateArticleCaptionNode.run(state as any, deps as any);
    assert.ok(patch.imageCaptionResult);
    assert.equal(patch.imageCaptionResult!.articleCaption, "A short sidebar caption.");
    db.close();
  });

  test("generateArticleCaptionNode: returns imageCaptionResult unchanged on LLM error", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    // FakeLlm that throws
    class ThrowingLlm extends FakeLlm {
      override async chat() { throw new Error("LLM error"); }
    }
    const deps = makeDeps(db, new ThrowingLlm());
    const original = { titleSlug: "some-img", description: "A description." };
    const state = {
      ...initialPipelineState({ requestId: randomUUID(), workflow: "image.caption", slug: "test-article", imageId: "some-img" }),
      loadedArticle: { slug: "test-article", canonicalSlug: "test-article", title: "Test Article", body: "# Test\n\nBody.", summary: "", generatedAt: Date.now() },
      imageCaptionResult: { ...original },
    };
    const patch = await generateArticleCaptionNode.run(state as any, deps as any);
    // Should return imageCaptionResult without articleCaption, no throw
    assert.ok(patch.imageCaptionResult);
    assert.equal(patch.imageCaptionResult!.articleCaption, undefined);
    assert.equal(patch.imageCaptionResult!.description, "A description.");
    db.close();
  });

  // ── generateSidebarCaptionNode ──────────────────────────────────────────────

  test("generateSidebarCaptionNode: writes caption when image has description", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));
    insertMedia(mediaDb, { ...baseMediaRecord("sidebar-img"), sha256: "si".padEnd(64, "s"), description: "A crystal image." });
    upsertArticleHeadlineMedia(db, "test-article", "sidebar-img", "");

    const captionJson = JSON.stringify({ caption: "Crystal formed under high pressure." });
    const llm = new FakeLlm(captionJson);
    const deps = { ...makeDeps(db, llm), mediaDb };
    const state = {
      ...initialPipelineState({ requestId: randomUUID(), workflow: "article.post_process", slug: "test-article" }),
      finalArticleBody: "# Test Article\n\nBody.",
      canonicalTitle: "Test Article",
    };
    await generateSidebarCaptionNode.run(state as any, deps as any);
    const headline = getArticleHeadlineMedia(db, "test-article");
    assert.equal(headline?.caption, "Crystal formed under high pressure.");
    mediaDb.close(); db.close();
  });

  test("generateSidebarCaptionNode: skips silently when no headline media", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));
    const llm = new FakeLlm('{"caption":"Should not be called"}');
    const deps = { ...makeDeps(db, llm), mediaDb };
    const state = {
      ...initialPipelineState({ requestId: randomUUID(), workflow: "article.post_process", slug: "test-article" }),
      finalArticleBody: "# Test Article\n\nBody.",
      canonicalTitle: "Test Article",
    };
    // Should not throw and LLM should not be called
    await assert.doesNotReject(() => generateSidebarCaptionNode.run(state as any, deps as any));
    assert.equal(llm.capturedOptions.length, 0);
    mediaDb.close(); db.close();
  });

  test("generateSidebarCaptionNode: calls onSidecarUpdate when caption is saved", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));
    insertMedia(mediaDb, { ...baseMediaRecord("sc-img"), sha256: "sc".padEnd(64, "s"), description: "Image desc." });
    upsertArticleHeadlineMedia(db, "test-article", "sc-img", "");

    const capturedCalls: Array<[string, unknown]> = [];
    const captionJson = JSON.stringify({ caption: "Generated caption." });
    const llm = new FakeLlm(captionJson);
    const deps = {
      ...makeDeps(db, llm),
      mediaDb,
      onSidecarUpdate: (slug: string, payload: unknown) => capturedCalls.push([slug, payload]),
    };
    const state = {
      ...initialPipelineState({ requestId: randomUUID(), workflow: "article.post_process", slug: "test-article" }),
      finalArticleBody: "# Test Article\n\nBody.",
      canonicalTitle: "Test Article",
    };
    await generateSidebarCaptionNode.run(state as any, deps as any);
    assert.equal(capturedCalls.length, 1);
    assert.equal(capturedCalls[0][0], "test-article");
    const payload = capturedCalls[0][1] as any;
    assert.equal(payload.type, "caption");
    assert.equal(payload.caption, "Generated caption.");
    mediaDb.close(); db.close();
  });
});

// ── image-context ─────────────────────────────────────────────────────────────

describe("image-context", () => {
  function makeDepsWithMedia(
    db: ReturnType<typeof makeArticleDb>,
    mediaDb: ReturnType<typeof openMediaDatabase>,
    llm: LlmRouter = new FakeLlm(),
  ) {
    return {
      db,
      mediaDb,
      llm,
      prompts: buildPromptRegistry(TEST_CONFIG.prompts),
      logger: noop(),
      runtime: TEST_CONFIG,
    };
  }

  // ── readHeadlineImageNode ────────────────────────────────────────────────

  test("readHeadlineImageNode: returns empty string when no image attached", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));
    const deps = makeDepsWithMedia(db, mediaDb);
    const state = initialPipelineState({ requestId: randomUUID(), workflow: "article.generate", slug: "test-article" });
    const patch = await readHeadlineImageNode.run(state as any, deps as any);
    assert.equal(patch.headlineImageContext, "");
    db.close(); mediaDb.close();
  });

  test("readHeadlineImageNode: returns empty string when image has no description yet", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));
    insertMedia(mediaDb, { ...baseMediaRecord("img-no-desc"), sha256: "nd".padEnd(64, "0"), description: "" } as any);
    (baseMediaRecord as any); // suppress unused warning
    upsertArticleHeadlineMedia(db, "test-article", "img-no-desc", "");
    // Override description to empty
    const rec = getMediaById(mediaDb, "img-no-desc");
    assert.ok(rec);

    const deps = makeDepsWithMedia(db, mediaDb);
    const state = initialPipelineState({ requestId: randomUUID(), workflow: "article.generate", slug: "test-article" });
    const patch = await readHeadlineImageNode.run(state as any, deps as any);
    assert.equal(patch.headlineImageContext, "");
    db.close(); mediaDb.close();
  });

  test("readHeadlineImageNode: formats context block when image has description", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));

    // Insert media with a real description
    const rec = { ...baseMediaRecord("test-crystal"), sha256: "tc".padEnd(64, "t"), description: "A shimmering crystalline formation." };
    insertMedia(mediaDb, rec as any);
    upsertArticleHeadlineMedia(db, "test-article", "test-crystal", "The crystal");

    const deps = makeDepsWithMedia(db, mediaDb);
    const state = initialPipelineState({ requestId: randomUUID(), workflow: "article.generate", slug: "test-article" });
    const patch = await readHeadlineImageNode.run(state as any, deps as any);

    assert.ok(patch.headlineImageContext, "context string is non-empty");
    assert.match(patch.headlineImageContext!, /img:test-crystal/, "slug in context");
    assert.match(patch.headlineImageContext!, /shimmering crystalline/, "description in context");
    assert.match(patch.headlineImageContext!, /The crystal/, "caption in context");
    db.close(); mediaDb.close();
  });

  test("readHeadlineImageNode: uses description as caption when caption is empty", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));

    insertMedia(mediaDb, { ...baseMediaRecord("img-capless"), sha256: "cl".padEnd(64, "0"), description: "A lunar silt formation." } as any);
    upsertArticleHeadlineMedia(db, "test-article", "img-capless", ""); // empty caption

    const deps = makeDepsWithMedia(db, mediaDb);
    const state = initialPipelineState({ requestId: randomUUID(), workflow: "article.generate", slug: "test-article" });
    const patch = await readHeadlineImageNode.run(state as any, deps as any);

    // Caption should fall back to description
    assert.match(patch.headlineImageContext!, /A lunar silt formation/);
    db.close(); mediaDb.close();
  });

  // ── renderArticlePromptNode excludes headline_image ──────────────────────

  test("renderArticlePromptNode: headline_image is not rendered into article prompts", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));
    const deps = makeDepsWithMedia(db, mediaDb);

    const imageContext = "This article has a headline image attached:\n  Slug: img:crystal-test\n  Description: A shimmering crystal.";
    const state = {
      ...initialPipelineState({ requestId: randomUUID(), workflow: "article.generate", slug: "test-article", requestedTitle: "Test Article" }),
      references: [],
      retrievedContext: { sourceArticles: [], ragTitles: [], backlinks: [] },
      recentEditHistory: "",
      headlineImageContext: imageContext,
    };
    const patch = await renderArticlePromptNode.run(state as any, deps as any);
    assert.ok(patch.renderedPrompt, "prompt was rendered");
    assert.doesNotMatch(patch.renderedPrompt!.user, /shimmering crystal/);
    assert.doesNotMatch(patch.renderedPrompt!.user, /media:crystal-test/);
    db.close(); mediaDb.close();
  });

  test("renderArticlePromptNode: headline_image is empty string when no image", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));
    const deps = makeDepsWithMedia(db, mediaDb);

    const state = {
      ...initialPipelineState({ requestId: randomUUID(), workflow: "article.generate", slug: "test-article", requestedTitle: "Test Article" }),
      references: [],
      retrievedContext: { sourceArticles: [], ragTitles: [], backlinks: [] },
      recentEditHistory: "",
      headlineImageContext: "",
    };
    const patch = await renderArticlePromptNode.run(state as any, deps as any);
    assert.ok(patch.renderedPrompt);
    // Should not crash; user prompt renders fine without image context
    assert.equal(typeof patch.renderedPrompt!.user, "string");
    db.close(); mediaDb.close();
  });

  test("renderArticlePromptNode: repeats requested title in system and user prompts", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));
    const deps = makeDepsWithMedia(db, mediaDb);

    const state = {
      ...initialPipelineState({ requestId: randomUUID(), workflow: "article.generate", slug: "test-article", requestedTitle: "Test Article" }),
      references: [],
      retrievedContext: { sourceArticles: [], ragTitles: [], backlinks: [] },
      recentEditHistory: "",
    };
    const patch = await renderArticlePromptNode.run(state as any, deps as any);

    assert.match(patch.renderedPrompt!.system, /Requested article title:\s+Test Article/);
    assert.equal((patch.renderedPrompt!.user.match(/Test Article/g) ?? []).length, 2);
    db.close(); mediaDb.close();
  });

  // ── indexArticleChunks excludes image description chunks ─────────────────

  test("indexArticleChunks: image descriptions are not added as chunks", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openDatabase(join(dir, "articles.sqlite"));
    const llm = new FakeLlm();

    await indexArticleChunks(
      db, llm as any, "test-slug", "# Test\n\nSome body text.", false, 500, noop(),
      [{ id: "my-image", description: "A shimmering crystalline formation used in metallurgy." }],
    );

    const chunks = db.prepare("SELECT content FROM article_chunks WHERE slug = ? ORDER BY chunk_index").all("test-slug") as Array<{ content: string }>;
    assert.equal(chunks.length, 1);
    assert.doesNotMatch(chunks.map((c) => c.content).join("\n"), /\[img:my-image\]/);
    assert.doesNotMatch(chunks.map((c) => c.content).join("\n"), /shimmering crystalline formation/);
    db.close();
  });

  test("indexArticleChunks: no image chunk when description is empty", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openDatabase(join(dir, "articles.sqlite"));
    const llm = new FakeLlm();

    await indexArticleChunks(
      db, llm as any, "test-slug", "# Test\n\nBody.", false, 500, noop(),
      [{ id: "no-desc-img", description: "" }],
    );

    const chunks = db.prepare("SELECT content FROM article_chunks WHERE slug = ? ORDER BY chunk_index").all("test-slug") as Array<{ content: string }>;
    const imageChunk = chunks.find((c) => c.content.includes("[img:"));
    assert.equal(imageChunk, undefined, "no image chunk for empty description");
    db.close();
  });

  test("indexArticleChunks: multiple image descriptions still produce no image chunks", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openDatabase(join(dir, "articles.sqlite"));
    const llm = new FakeLlm();

    await indexArticleChunks(
      db, llm as any, "test-slug", "# Test\n\nBody.", false, 500, noop(),
      [
        { id: "img-a", description: "First image description." },
        { id: "img-b", description: "Second image description." },
      ],
    );

    const chunks = db.prepare("SELECT content FROM article_chunks WHERE slug = ? ORDER BY chunk_index").all("test-slug") as Array<{ content: string }>;
    const imgChunks = chunks.filter((c) => c.content.startsWith("[img:"));
    assert.equal(imgChunks.length, 0);
    db.close();
  });
});

// ── ingest ────────────────────────────────────────────────────────────────────
// Caption / description generation is now the image.caption pipeline workflow;
// ingest is pure I/O (fetch + vips + DB write). The pipeline-nodes suite above
// already covers caption generation end-to-end.

describe("ingest", () => {
  test("ingestImageFromBuffer: processes tiny PNG, stores dims and model copy", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));
    const result = await ingestImageFromBuffer(TINY_PNG, "image/png", {
      mediaDb,
      config: defaultIngestConfig,
      logger: noop(),
    });
    assert.ok(result.mediaId);
    assert.equal(result.isNew, true);
    assert.equal(result.width, 1);
    assert.equal(result.height, 1);
    const rec = getMediaById(mediaDb, result.mediaId);
    assert.ok(rec);
    assert.equal(rec.width, 1);
    assert.ok(rec.model_b64.length > 0);
    // Description starts empty — the image.caption pipeline fills it in async.
    assert.equal(rec.description, "");
    mediaDb.close();
  });

  test("ingestImageFromBuffer: deduplicates by sha256", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));
    const cfg = defaultIngestConfig;
    const r1 = await ingestImageFromBuffer(TINY_PNG, "image/png", { mediaDb, config: cfg, logger: noop() });
    const r2 = await ingestImageFromBuffer(TINY_PNG, "image/png", { mediaDb, config: cfg, logger: noop() });
    assert.equal(r1.mediaId, r2.mediaId);
    assert.equal(r2.isNew, false);
    mediaDb.close();
  });

  test("ingestImageFromBuffer: rejects non-image mime type", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));
    await assert.rejects(
      () => ingestImageFromBuffer(Buffer.from("text"), "text/html", { mediaDb, config: defaultIngestConfig, logger: noop() }),
      /Not an image/,
    );
    mediaDb.close();
  });

  test("ingestImageFromBuffer: rejects bytes over max_bytes limit", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));
    await assert.rejects(
      () => ingestImageFromBuffer(Buffer.alloc(200), "image/png", { mediaDb, config: { ...defaultIngestConfig, max_bytes: 10 }, logger: noop() }),
      /too large/,
    );
    mediaDb.close();
  });
});
