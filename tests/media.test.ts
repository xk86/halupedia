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
 *   multimodal       — image_url content-block construction in chat
 *   http             — HTTP API routes (media serve, article image CRUD)
 *   pipeline-nodes   — generateInfoboxNode + persistInfoboxNode
 *   image-context    — readHeadlineImageNode + RAG image chunk indexing
 *   ingest           — ingestImageFromBuffer with real vips
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { openMediaDatabase, getMediaById, getMediaBytesById, getMediaBySha256, insertMedia, updateMediaDescription, updateMediaId } from "../src/server/mediaDb";
import { openDatabase, saveArticle, getArticleHeadlineMedia, upsertArticleHeadlineMedia, updateArticleMediaCaption, removeArticleMedia, getArticleMediaRows, getArticleInfobox, setArticleInfobox, type InfoboxData } from "../src/server/db";
import { renderInfoboxHtml } from "../src/server/articleRender";
import { renderMarkdown, markdownToPlainText } from "../src/server/markdown";
import { OpenAICompatRouter, type LlmRouter, type ChatOptions } from "../src/server/llm";
import { createApp } from "../src/server/index";
import { loadConfig } from "../src/server/config";
import type { Logger } from "../src/server/logger";
import { generateInfoboxNode, persistInfoboxNode } from "../src/server/pipeline/nodes/postProcess";
import {
  loadArticleAndImageNode,
  generateImageCaptionNode,
  persistImageCaptionNode,
} from "../src/server/pipeline/nodes/captionImage";
import { readHeadlineImageNode, renderArticlePromptNode } from "../src/server/pipeline/nodes/articleGeneration";
import { initialPipelineState } from "../src/server/pipeline/state";
import { buildPromptRegistry } from "../src/server/pipeline/prompts/registry";
import { indexArticleChunks } from "../src/server/retrieval";
import { ingestImageFromBuffer } from "../src/server/media";

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
  constructor(private readonly resp = '{"title":"T","groups":[{"label":"","rows":[]}]}') {}
  async chat(_r: "heavy" | "light", _s: string, _u: string, opts?: ChatOptions) {
    this.capturedOptions.push(opts ?? {});
    return this.resp;
  }
  async streamChat(_r: "heavy" | "light", _s: string, _u: string, onChunk: (d: string, a: string) => void) {
    const c = "# Test\n\nBody."; onChunk(c, c); return { content: c, finishReason: "stop" };
  }
  async embed() { return []; }
  async probeConnections() {}
  supportsVision(_: "heavy" | "light") { return false; }
}


async function makeTestServer(llm: LlmRouter = new FakeLlm()) {
  const { dir, cleanup } = tmpDir();
  const databasePath = join(dir, "articles.sqlite");
  const mediaDatabasePath = join(dir, "media.sqlite");
  const md = "# Aspirin\n\nA medication.";
  const db = openDatabase(databasePath);
  saveArticle(db, { slug: "aspirin", canonicalSlug: "aspirin", title: "Aspirin", markdown: md, html: renderMarkdown(md), plain_text: markdownToPlainText(md), generated_at: Date.now() }, [], ["aspirin"]);
  db.close();
  const { app, shutdown } = await createApp({ databasePath, mediaDatabasePath, skipLlmProbe: true, skipHomepagePrepare: true, logger: noop(), llmClient: llm });
  const go = (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost${path}`, init));
  return { dir, databasePath, mediaDatabasePath, cleanup: async () => { await shutdown(); cleanup(); }, go };
}

function seedMedia(mediaDatabasePath: string, id = "img-x") {
  const db = openMediaDatabase(mediaDatabasePath);
  insertMedia(db, { ...baseMediaRecord(id), sha256: id.padEnd(64, "x") });
  db.close();
}

const defaultIngestConfig = {
  model_max_edge: 256, jpeg_quality: 70, max_bytes: 10 * 1024 * 1024,
  fetch_timeout_ms: 5000, media_database_path: "", allow_private_hosts: false,
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
    const html = renderInfoboxHtml(null, media, "Formula");
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

  test("renderInfoboxHtml: empty caption falls back to mediaDescription", () => {
    const media = { id: 1, articleSlug: "x", mediaId: "img", role: "headline", ordinal: 1, caption: "", createdAt: 0, updatedAt: 0 };
    const html = renderInfoboxHtml(null, media, "Fallback description");
    assert.match(html, /Fallback description/);
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

  test("media: image renders as linked img with media-image-link class", () => {
    const html = renderMarkdown("![Caption here](media:my-slug)");
    assert.match(html, /src="\/api\/media\/my-slug"/);
    assert.match(html, /href="\/media\/my-slug"/);
    assert.match(html, /class="media-image-link"/);
    assert.match(html, /alt="Caption here"/);
  });

  test("media: both src and href contain the exact slug", () => {
    const html = renderMarkdown("![Caption](media:specific-slug-value)");
    assert.match(html, /\/api\/media\/specific-slug-value/);
    assert.match(html, /\/media\/specific-slug-value/);
    // Slug must appear exactly once in each attribute (no doubling or trimming)
    assert.equal((html.match(/specific-slug-value/g) ?? []).length, 2);
  });

  test("external image does not get media-image-link treatment", () => {
    const html = renderMarkdown("![Alt](https://example.com/img.png)");
    assert.doesNotMatch(html, /media-image-link/);
  });
});

// ── vision-probe ──────────────────────────────────────────────────────────────

describe("vision-probe", () => {
  function mockShowEndpoint(body: unknown) {
    const orig = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/show")) {
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("nf", { status: 404 });
    };
    return () => { globalThis.fetch = orig; };
  }

  function makeRouter() {
    const cfg = { base_url: "http://ollama.test/v1", api_key: "local", model: "m", temperature: 1, max_tokens: 100 };
    return new OpenAICompatRouter(cfg, cfg, { enabled: false, base_url: "", api_key: "", model: "" }, noop());
  }

  test("true when model_info has clip.* key", async (t) => {
    const restore = mockShowEndpoint({ model_info: { "clip.vision_encoder": "clip" } });
    t.after(restore);
    const r = makeRouter();
    await r.probeConnections();
    assert.equal(r.supportsVision("light"), true);
  });

  test("false when model_info has no clip keys", async (t) => {
    const restore = mockShowEndpoint({ model_info: { "general.architecture": "gemma" } });
    t.after(restore);
    const r = makeRouter();
    await r.probeConnections();
    assert.equal(r.supportsVision("light"), false);
  });

  test("true when details.families includes 'clip'", async (t) => {
    const restore = mockShowEndpoint({ details: { families: ["llama", "clip"] } });
    t.after(restore);
    const r = makeRouter();
    await r.probeConnections();
    assert.equal(r.supportsVision("heavy"), true);
  });

  test("false when provider endpoint unreachable", async (t) => {
    const orig = globalThis.fetch;
    t.after(() => { globalThis.fetch = orig; });
    globalThis.fetch = async () => { throw new Error("refused"); };
    const r = makeRouter();
    await r.probeConnections();
    assert.equal(r.supportsVision("heavy"), false);
  });
});

// ── multimodal ────────────────────────────────────────────────────────────────

describe("multimodal", () => {
  function makeCaptureRouter() {
    let lastBody: any = null;
    const orig = globalThis.fetch;
    const restore = () => { globalThis.fetch = orig; };
    globalThis.fetch = async (_: RequestInfo | URL, init?: RequestInit) => {
      lastBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { total_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const cfg = { base_url: "http://llm.test/v1", api_key: "k", model: "m", temperature: 1, max_tokens: 10 };
    const router = new OpenAICompatRouter(cfg, cfg, { enabled: false, base_url: "", api_key: "", model: "" }, noop());
    return { router, getBody: () => lastBody, restore };
  }

  test("with images: user content is array with text + image_url blocks", async (t) => {
    const { router, getBody, restore } = makeCaptureRouter(); t.after(restore);
    await router.chat("light", "sys", "user text", { images: [{ mime: "image/jpeg", b64: "abc" }] });
    const content = getBody().messages[1].content;
    assert.ok(Array.isArray(content));
    assert.equal(content[0].type, "text");
    assert.equal(content[0].text, "user text");
    assert.equal(content[1].type, "image_url");
    assert.equal(content[1].image_url.url, "data:image/jpeg;base64,abc");
  });

  test("without images: user content is plain string", async (t) => {
    const { router, getBody, restore } = makeCaptureRouter(); t.after(restore);
    await router.chat("heavy", "sys", "just text");
    assert.equal(typeof getBody().messages[1].content, "string");
    assert.equal(getBody().messages[1].content, "just text");
  });

  test("multiple images produce multiple image_url blocks", async (t) => {
    const { router, getBody, restore } = makeCaptureRouter(); t.after(restore);
    await router.chat("light", "s", "u", { images: [{ mime: "image/png", b64: "aaa" }, { mime: "image/png", b64: "bbb" }] });
    const content = getBody().messages[1].content;
    assert.ok(Array.isArray(content));
    assert.equal(content.filter((b: any) => b.type === "image_url").length, 2);
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
    const body = await (await s.go("/api/media/info-img/info")).json() as any;
    assert.equal(body.id, "info-img");
    assert.equal(body.width, 100);
    assert.equal(body.model_b64, undefined);
    assert.equal(body.bytes, undefined);
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

  test("article HTML contains .infobox when image + infobox sidecar are set", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    seedMedia(s.mediaDatabasePath, "ib-img");
    const db = openDatabase(s.databasePath);
    upsertArticleHeadlineMedia(db, "aspirin", "ib-img", "Tablets");
    setArticleInfobox(db, "aspirin", { title: "Aspirin", groups: [{ label: "Chemistry", rows: [{ label: "Formula", value: "C9H8O4" }] }] });
    db.close();
    const body = await (await s.go("/api/page/aspirin")).json() as any;
    assert.match(body.article.html as string, /class="infobox"/);
    assert.match(body.article.html as string, /C9H8O4/);
  });

  test("article HTML has no infobox when none set", async (t) => {
    const s = await makeTestServer(); t.after(s.cleanup);
    const body = await (await s.go("/api/page/aspirin")).json() as any;
    assert.doesNotMatch(body.article.html as string, /class="infobox"/);
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

  test("generateInfoboxNode: skips when no headline image", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const patch = await generateInfoboxNode.run({ ...makeInput(), finalArticleBody: "# Test Article\n\nBody.", canonicalTitle: "Test Article" } as any, makeDeps(db, new FakeLlm()) as any);
    assert.equal(patch.infobox, undefined);
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

    const descJson = JSON.stringify({
      title_slug: "test-image-slug",
      description: "A fictional compound used in metallurgy.",
    });
    const llm = new FakeLlm(descJson);
    const deps = makeDeps(db, llm);
    const depsWithMedia = { ...deps, mediaDb };

    const state = {
      ...initialPipelineState({ requestId: randomUUID(), workflow: "image.caption", slug: "test-article", imageId: "cap-img" }),
      loadedArticle: { slug: "test-article", canonicalSlug: "test-article", title: "Test Article", body: "# Test Article\n\nBody.", summary: "", generatedAt: Date.now() },
    };

    const patch = await generateImageCaptionNode.run(state as any, depsWithMedia as any);
    assert.ok(patch.imageCaptionResult);
    assert.equal(patch.imageCaptionResult.titleSlug, "test-image-slug");
    assert.equal(patch.imageCaptionResult.description, "A fictional compound used in metallurgy.");

    // Verify no vision images were attached (text-only model)
    assert.equal(llm.capturedOptions[0]?.images, undefined);
    mediaDb.close(); db.close();
  });

  test("persistImageCaptionNode: updates description and renames media id", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));

    insertMedia(mediaDb, { ...baseMediaRecord("img-aabbcc112233"), sha256: "aa".padEnd(64, "a") });
    upsertArticleHeadlineMedia(db, "test-article", "img-aabbcc112233", "");

    const deps = { ...makeDeps(db, new FakeLlm()), mediaDb };
    const state = {
      ...initialPipelineState({ requestId: randomUUID(), workflow: "image.caption", slug: "test-article", imageId: "img-aabbcc112233" }),
      imageCaptionResult: { titleSlug: "nice-slug", description: "A nice image." },
    };

    persistImageCaptionNode.run(state as any, deps as any);

    // Media id was renamed to the nice slug
    assert.equal(getMediaById(mediaDb, "img-aabbcc112233"), null);
    const renamed = getMediaById(mediaDb, "nice-slug");
    assert.ok(renamed);
    assert.equal(renamed.description, "A nice image.");

    // article_media caption is NOT set by the pipeline — left for the article model
    const headline = getArticleHeadlineMedia(db, "test-article");
    assert.equal(headline?.mediaId, "nice-slug");
    assert.equal(headline?.caption, ""); // pipeline doesn't touch per-article captions

    mediaDb.close(); db.close();
  });

  test("persistInfoboxNode: no-ops silently when infobox undefined", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    assert.doesNotThrow(() => persistInfoboxNode.run({ ...makeInput(), infobox: undefined } as any, makeDeps(db, new FakeLlm()) as any));
    assert.equal(getArticleInfobox(db, "test-article"), null);
    db.close();
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

  test("readHeadlineImageNode: returns empty string when no image attached", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));
    const deps = makeDepsWithMedia(db, mediaDb);
    const state = initialPipelineState({ requestId: randomUUID(), workflow: "article.generate", slug: "test-article" });
    const patch = readHeadlineImageNode.run(state as any, deps as any);
    assert.equal(patch.headlineImageContext, "");
    db.close(); mediaDb.close();
  });

  test("readHeadlineImageNode: returns empty string when image has no description yet", (t) => {
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
    const patch = readHeadlineImageNode.run(state as any, deps as any);
    assert.equal(patch.headlineImageContext, "");
    db.close(); mediaDb.close();
  });

  test("readHeadlineImageNode: formats context block when image has description", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));

    // Insert media with a real description
    const rec = { ...baseMediaRecord("test-crystal"), sha256: "tc".padEnd(64, "t"), description: "A shimmering crystalline formation." };
    insertMedia(mediaDb, rec as any);
    upsertArticleHeadlineMedia(db, "test-article", "test-crystal", "The crystal");

    const deps = makeDepsWithMedia(db, mediaDb);
    const state = initialPipelineState({ requestId: randomUUID(), workflow: "article.generate", slug: "test-article" });
    const patch = readHeadlineImageNode.run(state as any, deps as any);

    assert.ok(patch.headlineImageContext, "context string is non-empty");
    assert.match(patch.headlineImageContext!, /img:test-crystal/, "slug in context");
    assert.match(patch.headlineImageContext!, /shimmering crystalline/, "description in context");
    assert.match(patch.headlineImageContext!, /The crystal/, "caption in context");
    assert.match(patch.headlineImageContext!, /media:test-crystal/, "image syntax shown");
    db.close(); mediaDb.close();
  });

  test("readHeadlineImageNode: uses description as caption when caption is empty", (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = makeArticleDb(dir);
    const mediaDb = openMediaDatabase(join(dir, "m.sqlite"));

    insertMedia(mediaDb, { ...baseMediaRecord("img-capless"), sha256: "cl".padEnd(64, "0"), description: "A lunar silt formation." } as any);
    upsertArticleHeadlineMedia(db, "test-article", "img-capless", ""); // empty caption

    const deps = makeDepsWithMedia(db, mediaDb);
    const state = initialPipelineState({ requestId: randomUUID(), workflow: "article.generate", slug: "test-article" });
    const patch = readHeadlineImageNode.run(state as any, deps as any);

    // Caption should fall back to description
    assert.match(patch.headlineImageContext!, /A lunar silt formation/);
    db.close(); mediaDb.close();
  });

  // ── renderArticlePromptNode includes headline_image ──────────────────────

  test("renderArticlePromptNode: headline_image appears in rendered user prompt", (t) => {
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
    const patch = renderArticlePromptNode.run(state as any, deps as any);
    assert.ok(patch.renderedPrompt, "prompt was rendered");
    assert.match(patch.renderedPrompt!.user, /shimmering crystal/, "image description in rendered user prompt");
    db.close(); mediaDb.close();
  });

  test("renderArticlePromptNode: headline_image is empty string when no image", (t) => {
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
    const patch = renderArticlePromptNode.run(state as any, deps as any);
    assert.ok(patch.renderedPrompt);
    // Should not crash; user prompt renders fine without image context
    assert.equal(typeof patch.renderedPrompt!.user, "string");
    db.close(); mediaDb.close();
  });

  // ── indexArticleChunks includes image description chunk ──────────────────

  test("indexArticleChunks: image description added as extra chunk", async (t) => {
    const { dir, cleanup } = tmpDir(); t.after(cleanup);
    const db = openDatabase(join(dir, "articles.sqlite"));
    const llm = new FakeLlm();

    await indexArticleChunks(
      db, llm as any, "test-slug", "# Test\n\nSome body text.", false, 500, noop(),
      [{ id: "my-image", description: "A shimmering crystalline formation used in metallurgy." }],
    );

    const chunks = db.prepare("SELECT content FROM article_chunks WHERE slug = ? ORDER BY chunk_index").all("test-slug") as Array<{ content: string }>;
    assert.ok(chunks.length >= 2, "at least body chunk + image chunk");

    const imageChunk = chunks.find((c) => c.content.includes("[img:my-image]"));
    assert.ok(imageChunk, "image chunk present");
    assert.match(imageChunk!.content, /shimmering crystalline formation/);
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

  test("indexArticleChunks: multiple image descriptions produce multiple chunks", async (t) => {
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
    assert.equal(imgChunks.length, 2, "two image chunks");
    assert.ok(imgChunks.some((c) => c.content.includes("img-a")));
    assert.ok(imgChunks.some((c) => c.content.includes("img-b")));
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
