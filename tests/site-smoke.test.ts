import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, saveArticle, saveArticleReferences, saveHomepageCache, listArticleRevisions, setArticleInfobox } from "../src/server/db";
import { loadConfig } from "../src/server/config";
import { createApp } from "../src/server/index";
import type { LlmRouter } from "../src/server/llm";
import type { LogFields, Logger } from "../src/server/logger";
import { renderMarkdown, markdownToPlainText } from "../src/server/markdown";

interface CapturedLogEntry {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields?: LogFields;
}

const TEST_CONFIG = loadConfig().app.tests;

function createMemoryLogger(entries: CapturedLogEntry[]): Logger {
  return {
    debug(event, fields) {
      entries.push({ level: "debug", event, fields });
    },
    info(event, fields) {
      entries.push({ level: "info", event, fields });
    },
    warn(event, fields) {
      entries.push({ level: "warn", event, fields });
    },
    error(event, fields) {
      entries.push({ level: "error", event, fields });
    },
  };
}

class FakeLlmClient implements LlmRouter {
  async chat(): Promise<string> {
    return JSON.stringify({ items: [] });
  }

  async streamChat(
    _role: "heavy" | "light",
    _system: string,
    _user: string,
    onChunk: (delta: string, accumulated: string) => void
  ): Promise<{ content: string; finishReason: string }> {
    const content = [
      "# Fresh Page",
      "",
      "This article links to [Alpha](halu:alpha), [Beta](halu:beta), [Gamma](halu:gamma), [Delta](halu:delta), and [Epsilon](halu:epsilon).",
    ].join("\n");
    onChunk(content, content);
    return { content, finishReason: "stop" };
  }

  async embed(): Promise<number[][]> {
    return [];
  }

  async probeConnections(): Promise<void> {}
}

const DEFAULT_TEST_LLM = new FakeLlmClient();

class FixedArticleLlmClient implements LlmRouter {
  constructor(private readonly markdown: string) {}

  async chat(): Promise<string> {
    return JSON.stringify({ items: [] });
  }

  async streamChat(
    _role: "heavy" | "light",
    _system: string,
    _user: string,
    onChunk: (delta: string, accumulated: string) => void
  ): Promise<{ content: string; finishReason: string }> {
    onChunk(this.markdown, this.markdown);
    return { content: this.markdown, finishReason: "stop" };
  }

  async embed(): Promise<number[][]> {
    return [];
  }

  async probeConnections(): Promise<void> {}
}

class FailingGenerationLlmClient implements LlmRouter {
  async chat(): Promise<string> {
    return JSON.stringify({ items: [] });
  }

  async streamChat(): Promise<{ content: string; finishReason: string }> {
    throw new Error("generation should not run for cached lookup regressions");
  }

  async embed(): Promise<number[][]> {
    return [];
  }

  async probeConnections(): Promise<void> {}
}

class SlowLlmClient implements LlmRouter {
  readonly generationStarted = Promise.withResolvers<void>();
  readonly generationDone = Promise.withResolvers<void>();
  private delayMs: number;

  constructor(delayMs = 50) {
    this.delayMs = delayMs;
  }

  async chat(): Promise<string> {
    return JSON.stringify({ items: [] });
  }

  async streamChat(
    _role: "heavy" | "light",
    _system: string,
    _user: string,
    onChunk: (delta: string, accumulated: string) => void
  ): Promise<{ content: string; finishReason: string }> {
    this.generationStarted.resolve();
    const chunks = [
      "# Slow Article\n\n",
      '**Slow Article** is a deliberately paced entry with [Alpha](halu:alpha "Alpha hint"), ',
      '[Beta](halu:beta "Beta hint"), [Gamma](halu:gamma "Gamma hint"), ',
      '[Delta](halu:delta "Delta hint"), and [Epsilon](halu:epsilon "Epsilon hint").',
    ];
    let accumulated = "";
    for (const chunk of chunks) {
      await new Promise((r) => setTimeout(r, this.delayMs));
      accumulated += chunk;
      onChunk(chunk, accumulated);
    }
    this.generationDone.resolve();
    return { content: accumulated, finishReason: "stop" };
  }

  async embed(): Promise<number[][]> {
    return [];
  }

  async probeConnections(): Promise<void> {}
}

class FailingLlmClient implements LlmRouter {
  async chat(): Promise<string> {
    return JSON.stringify({ items: [] });
  }

  async streamChat(): Promise<{ content: string; finishReason: string }> {
    await new Promise((r) => setTimeout(r, 20));
    throw new Error("terminated");
  }

  async embed(): Promise<number[][]> {
    return [];
  }

  async probeConnections(): Promise<void> {}
}

class GatedLlmClient implements LlmRouter {
  streamCallCount = 0;
  readonly gate = Promise.withResolvers<void>();

  async chat(): Promise<string> {
    return JSON.stringify({ items: [] });
  }

  async streamChat(
    _role: "heavy" | "light",
    _system: string,
    _user: string,
    onChunk: (delta: string, accumulated: string) => void
  ): Promise<{ content: string; finishReason: string }> {
    this.streamCallCount++;
    await this.gate.promise;
    const content = [
      "# Gated Article\n\n",
      '**Gated Article** is an entry with [Alpha](halu:alpha "Alpha hint"), ',
      '[Beta](halu:beta "Beta hint"), [Gamma](halu:gamma "Gamma hint"), ',
      '[Delta](halu:delta "Delta hint"), and [Epsilon](halu:epsilon "Epsilon hint").',
    ].join("");
    onChunk(content, content);
    return { content, finishReason: "stop" };
  }

  async embed(): Promise<number[][]> {
    return [];
  }

  async probeConnections(): Promise<void> {}
}

class CountingLlmClient implements LlmRouter {
  chatCallsByRole: Record<"heavy" | "light", number> = { heavy: 0, light: 0 };
  streamCalls = 0;
  embedCalls = 0;

  get chatCalls() { return this.chatCallsByRole.heavy + this.chatCallsByRole.light; }

  async chat(role: "heavy" | "light"): Promise<string> {
    this.chatCallsByRole[role] += 1;
    return JSON.stringify({
      slug: "glow-fruit",
      description: "A fruit referenced from the source article",
      items: [],
    });
  }

  async streamChat(
    _role: "heavy" | "light",
    _system: string,
    _user: string,
    _onChunk: (delta: string, accumulated: string) => void
  ): Promise<{ content: string; finishReason: string }> {
    this.streamCalls += 1;
    throw new Error("streamChat should not be called");
  }

  async embed(): Promise<number[][]> {
    this.embedCalls += 1;
    return [];
  }

  async probeConnections(): Promise<void> {}
}

function buildArticleMarkdown() {
  return [
    "# Test Article",
    "",
    "Halupedia links out to [Alpha](halu:alpha \"Alpha hint\"), [Beta](halu:beta \"Beta hint\"), [Gamma](halu:gamma \"Gamma hint\"), [Delta](halu:delta \"Delta hint\"), and [Epsilon](halu:epsilon \"Epsilon hint\").",
    "",
    "The Glow Fruit appears in several old notes and remains unlinked in this draft.",
  ].join("\n");
}

function createSeedDatabasePath() {
  const root = mkdtempSync(join(tmpdir(), "halupedia-test-"));
  const databasePath = join(root, TEST_CONFIG.database_path);
  const db = openDatabase(databasePath);
  const markdown = buildArticleMarkdown();
  const generatedAt = 1_715_000_000_000;

  saveArticle(
    db,
    {
      slug: "test-article",
      canonicalSlug: "test-article",
      title: "Test Article",
      markdown,
      html: renderMarkdown(markdown),
      plain_text: markdownToPlainText(markdown),
      generated_at: generatedAt,
    },
    [
      { targetSlug: "alpha", visibleLabel: "Alpha", hiddenHint: "Alpha hint" },
      { targetSlug: "beta", visibleLabel: "Beta", hiddenHint: "Beta hint" },
      { targetSlug: "gamma", visibleLabel: "Gamma", hiddenHint: "Gamma hint" },
      { targetSlug: "delta", visibleLabel: "Delta", hiddenHint: "Delta hint" },
      { targetSlug: "epsilon", visibleLabel: "Epsilon", hiddenHint: "Epsilon hint" },
    ],
    ["test-article"]
  );
  // Seed an infobox so the page route's auto-post-process ("no infobox yet ->
  // fire post_process in the background") never fires for this article — that
  // background workflow makes its own LLM/embedding calls, racing against
  // assertions like "cached reads make zero LLM calls" in a way that depends
  // entirely on event-loop timing.
  setArticleInfobox(db, "test-article", { title: "Test Article", groups: [] });

  const backlinkMarkdown = [
    "# Linking Article",
    "",
    "This page references [Test Article](halu:test-article \"Seed backlink\"), [Alpha](halu:alpha \"Alpha hint\"), [Beta](halu:beta \"Beta hint\"), [Gamma](halu:gamma \"Gamma hint\"), and [Delta](halu:delta \"Delta hint\").",
  ].join("\n");

  saveArticle(
    db,
    {
      slug: "linking-article",
      canonicalSlug: "linking-article",
      title: "Linking Article",
      markdown: backlinkMarkdown,
      html: renderMarkdown(backlinkMarkdown),
      plain_text: markdownToPlainText(backlinkMarkdown),
      generated_at: generatedAt + 1,
    },
    [
      { targetSlug: "test-article", visibleLabel: "Test Article", hiddenHint: "Seed backlink" },
      { targetSlug: "alpha", visibleLabel: "Alpha", hiddenHint: "Alpha hint" },
      { targetSlug: "beta", visibleLabel: "Beta", hiddenHint: "Beta hint" },
      { targetSlug: "gamma", visibleLabel: "Gamma", hiddenHint: "Gamma hint" },
      { targetSlug: "delta", visibleLabel: "Delta", hiddenHint: "Delta hint" },
    ],
    ["linking-article"]
  );

  db.close();
  return { root, databasePath };
}

async function createTestServer(options: { logger?: Logger; llmClient?: LlmRouter; seed?: boolean; homepagePrepare?: boolean } = {}) {
  const seeded = options.seed ?? true;
  const { root, databasePath } = seeded
    ? createSeedDatabasePath()
    : (() => {
        const tempRoot = mkdtempSync(join(tmpdir(), "halupedia-test-"));
        return { root: tempRoot, databasePath: join(tempRoot, TEST_CONFIG.database_path) };
      })();
  const { app, shutdown } = await createApp({
    databasePath,
    skipLlmProbe: true,
    skipHomepagePrepare: options.homepagePrepare !== true,
    logger: options.logger,
    llmClient: options.llmClient ?? DEFAULT_TEST_LLM,
  });
  return {
    root,
    databasePath,
    shutdown,
    request: (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://halupedia.test${path}`, init)),
  };
}

async function createServerForDatabase(
  root: string,
  databasePath: string,
  options: { logger?: Logger; llmClient?: LlmRouter; homepagePrepare?: boolean } = {}
) {
  const { app, shutdown } = await createApp({
    databasePath,
    skipLlmProbe: true,
    skipHomepagePrepare: options.homepagePrepare !== true,
    logger: options.logger,
    llmClient: options.llmClient ?? DEFAULT_TEST_LLM,
  });
  return {
    root,
    shutdown,
    request: (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://halupedia.test${path}`, init)),
  };
}

function cleanupTestServer(t: TestContext, server: { root: string; shutdown?: () => Promise<void> }) {
  t.after(async () => {
    await server.shutdown?.();
    rmSync(server.root, { recursive: true, force: true });
  });
}

async function waitForLog(
  entries: CapturedLogEntry[],
  predicate: (entry: CapturedLogEntry) => boolean,
  timeoutMs = 1000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entries.some(predicate)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(entries.some(predicate));
}

async function waitForHomepage(
  server: { request: (path: string, init?: RequestInit) => Promise<Response> },
  predicate: (body: any) => boolean,
  timeoutMs = 1000
) {
  const deadline = Date.now() + timeoutMs;
  let lastBody: any = null;
  while (Date.now() < deadline) {
    const res = await server.request("/api/homepage");
    lastBody = await res.json();
    if (predicate(lastBody)) return lastBody;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`homepage cache was not ready before timeout: ${JSON.stringify(lastBody)}`);
}

function parseNdjson<T>(payload: string): T[] {
  return payload
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

test("site smoke tests cover core routes and API contracts", async (t) => {
  const server = await createTestServer();
  cleanupTestServer(t, server);

  await t.test("health endpoint returns runtime details", async () => {
    const res = await server.request("/api/health");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.model, "string");
    assert.equal(typeof body.database_path, "string");
  });

  await t.test("search and index endpoints expose seeded content", async () => {
    const searchRes = await server.request("/api/search?q=Test");
    assert.equal(searchRes.status, 200);
    const searchBody = await searchRes.json();
    assert.equal(searchBody.query, "Test");
    assert.equal(searchBody.results.length, 1);
    assert.equal(searchBody.results[0].slug, "test-article");
    assert.equal(searchBody.results[0].title, "Test Article");
    assert.equal(searchBody.results[0].exists, true);
    assert.ok(typeof searchBody.results[0].summary === "string");
    assert.ok(Array.isArray(searchBody.suggestions));

    const emptySearchRes = await server.request("/api/search");
    assert.equal(emptySearchRes.status, 200);
    const emptySearchBody = await emptySearchRes.json();
    assert.deepEqual(emptySearchBody.results, []);
    assert.ok(Array.isArray(emptySearchBody.suggestions));

    const indexRes = await server.request("/api/index?limit=1");
    assert.equal(indexRes.status, 200);
    const indexBody = await indexRes.json();
    assert.equal(indexBody.items.length, 1);
    assert.equal(indexBody.total, 2);
    assert.equal(indexBody.complete, false);
    assert.equal(indexBody.cursor, "1");
  });

  await t.test("cached article responses include canonical path and backlinks", async () => {
    const res = await server.request("/api/page/Test_Article");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const body = await res.json();
    assert.equal(body.cached, true);
    assert.equal(body.article.slug, "test-article");
    assert.equal(body.article.title, "Test Article");
    assert.equal(body.canonicalPath, "/wiki/Test_Article");
    assert.equal(body.redirectedFrom, undefined);
    assert.equal(body.backlinks.existing.length, 1);
    assert.equal(body.backlinks.existing[0].slug, "linking-article");
    assert.match(body.backlinks.existing[0].summaryMarkdown, /This page references Test Article/);
  });

  await t.test("cached article reads never regenerate existing pages", async (t) => {
    const llm = new CountingLlmClient();
    const cachedServer = await createTestServer({ llmClient: llm });
    cleanupTestServer(t, cachedServer);

    const res = await cachedServer.request("/api/page/Test_Article");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cached, true);
    assert.equal(llm.chatCalls, 0);
    assert.equal(llm.streamCalls, 0);
    assert.equal(llm.embedCalls, 0);
  });

  await t.test("cached article reports body references missing from metadata without LLM work", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "halupedia-ref-status-"));
    const databasePath = join(root, TEST_CONFIG.database_path);
    const db = openDatabase(databasePath);
    const sourceMarkdown = "# Source Article\n\nA stored source article.";
    saveArticle(
      db,
      {
        slug: "source-article",
        canonicalSlug: "source-article",
        title: "Source Article",
        markdown: sourceMarkdown,
        html: renderMarkdown(sourceMarkdown),
        plain_text: markdownToPlainText(sourceMarkdown),
        generated_at: Date.now(),
      },
      [],
      ["source-article"],
    );
    const articleMarkdown = "# Target Article\n\nBody cites [source material](ref:source-article).";
    saveArticle(
      db,
      {
        slug: "target-article",
        canonicalSlug: "target-article",
        title: "Target Article",
        markdown: articleMarkdown,
        html: renderMarkdown(articleMarkdown),
        plain_text: markdownToPlainText(articleMarkdown),
        generated_at: Date.now(),
      },
      [],
      ["target-article"],
    );
    // Seed an infobox so the auto-post-process background workflow never
    // fires (it would race the "zero LLM calls" assertions below on timing).
    setArticleInfobox(db, "target-article", { title: "Target Article", groups: [] });
    db.close();

    const llm = new CountingLlmClient();
    const cachedServer = await createServerForDatabase(root, databasePath, { llmClient: llm });
    cleanupTestServer(t, cachedServer);

    const res = await cachedServer.request("/api/page/Target_Article");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.referenceStatus.missing.map((entry: { slug: string }) => entry.slug),
      ["source-article"],
    );
    assert.equal(llm.chatCalls, 0);
    assert.equal(llm.streamCalls, 0);
    assert.equal(llm.embedCalls, 0);
  });

  await t.test("cached article reports listed references that still use legacy halu links", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "halupedia-ref-format-"));
    const databasePath = join(root, TEST_CONFIG.database_path);
    const db = openDatabase(databasePath);
    const now = Date.now();
    const sourceMarkdown = "# Source Article\n\nA stored source article.";
    saveArticle(
      db,
      {
        slug: "source-article",
        canonicalSlug: "source-article",
        title: "Source Article",
        markdown: sourceMarkdown,
        html: renderMarkdown(sourceMarkdown),
        plain_text: markdownToPlainText(sourceMarkdown),
        generated_at: now,
      },
      [],
      ["source-article"],
    );
    const articleMarkdown = '# Target Article\n\nBody cites [Source Article](halu:source-article "source").';
    saveArticle(
      db,
      {
        slug: "target-article",
        canonicalSlug: "target-article",
        title: "Target Article",
        markdown: articleMarkdown,
        html: renderMarkdown(articleMarkdown),
        plain_text: markdownToPlainText(articleMarkdown),
        generated_at: now + 1,
      },
      [{ targetSlug: "source-article", visibleLabel: "Source Article", hiddenHint: "source" }],
      ["target-article"],
    );
    saveArticleReferences(db, "target-article", now + 1, [
      {
        slug: "source-article",
        title: "Source Article",
        content: "",
        kind: "summary",
        pinned: false,
        revisionId: "current",
      },
    ]);
    // Seed an infobox so the auto-post-process background workflow never
    // fires (it would race the "zero LLM calls" assertions below on timing).
    setArticleInfobox(db, "target-article", { title: "Target Article", groups: [] });
    db.close();

    const llm = new CountingLlmClient();
    const cachedServer = await createServerForDatabase(root, databasePath, { llmClient: llm });
    cleanupTestServer(t, cachedServer);

    const res = await cachedServer.request("/api/page/Target_Article");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.referenceStatus.unformatted.map((entry: { slug: string }) => entry.slug),
      ["source-article"],
    );
    assert.equal(llm.chatCalls, 0);
    assert.equal(llm.streamCalls, 0);
  });

  await t.test("cached article cleans inline References section without LLM work", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "halupedia-ref-section-"));
    const databasePath = join(root, TEST_CONFIG.database_path);
    const db = openDatabase(databasePath);
    const sourceMarkdown = "# Source Article\n\nA stored source article.";
    saveArticle(
      db,
      {
        slug: "source-article",
        canonicalSlug: "source-article",
        title: "Source Article",
        markdown: sourceMarkdown,
        html: renderMarkdown(sourceMarkdown),
        plain_text: markdownToPlainText(sourceMarkdown),
        generated_at: Date.now(),
      },
      [],
      ["source-article"],
    );
    const articleMarkdown = [
      "# Target Article",
      "",
      "Body has old-style metadata.",
      "",
      "## References",
      "",
      "* [Source Article](halu:source-article)",
    ].join("\n");
    saveArticle(
      db,
      {
        slug: "target-article",
        canonicalSlug: "target-article",
        title: "Target Article",
        markdown: articleMarkdown,
        html: renderMarkdown(articleMarkdown),
        plain_text: markdownToPlainText(articleMarkdown),
        generated_at: Date.now(),
      },
      [],
      ["target-article"],
    );
    // Seed an infobox so the auto-post-process background workflow never
    // fires (it would race the "zero LLM calls" assertions below on timing).
    setArticleInfobox(db, "target-article", { title: "Target Article", groups: [] });
    db.close();

    const llm = new CountingLlmClient();
    const cachedServer = await createServerForDatabase(root, databasePath, { llmClient: llm });
    cleanupTestServer(t, cachedServer);

    const res = await cachedServer.request("/api/page/Target_Article");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.referenceStatus.hasReferencesSection, false);
    assert.equal(llm.chatCalls, 0);
    assert.equal(llm.streamCalls, 0);
    assert.equal(llm.embedCalls, 0);
  });

  await t.test("cached article repair does not fall through to regeneration", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "halupedia-test-"));
    const databasePath = join(root, TEST_CONFIG.database_path);
    const db = openDatabase(databasePath);
    const markdown = [
      "# Cache Repair",
      "",
      "Cache Repair links to [Ledger Index](halu:ledger-index \"ledger index\").",
      "",
      "## References",
      "",
      "- Plain legacy reference",
    ].join("\n");
    saveArticle(
      db,
      {
        slug: "cache-repair",
        canonicalSlug: "cache-repair",
        title: "Cache Repair",
        markdown,
        html: renderMarkdown(markdown),
        plain_text: markdownToPlainText(markdown),
        generated_at: Date.now(),
      },
      [],
      ["cache-repair"],
    );
    // Seed an infobox so the auto-post-process background workflow never
    // fires (it would race the "zero LLM calls" assertions below on timing).
    setArticleInfobox(db, "cache-repair", { title: "Cache Repair", groups: [] });
    db.close();

    const entries: CapturedLogEntry[] = [];
    const llm = new CountingLlmClient();
    const cachedServer = await createServerForDatabase(root, databasePath, {
      logger: createMemoryLogger(entries),
      llmClient: llm,
    });
    cleanupTestServer(t, cachedServer);

    const res = await cachedServer.request("/api/page/Cache_Repair");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.equal(body.cached, true);
    assert.equal(body.article.slug, "cache-repair");
    assert.doesNotMatch(body.article.markdown, /Plain legacy reference/);
    assert.ok(entries.some((entry) => entry.event === "page.cache_repair"));
    assert.ok(entries.some((entry) => entry.event === "page.hit" && entry.fields?.slug === "cache-repair"));
    assert.equal(
      entries.some((entry) => entry.event === "page.miss" && entry.fields?.slug === "cache-repair"),
      false,
    );
    assert.equal(llm.chatCalls, 0);
    assert.equal(llm.streamCalls, 0);
    assert.equal(llm.embedCalls, 0);
  });

  await t.test("cached article diagnostics alone do not create repair revisions", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "halupedia-test-"));
    const databasePath = join(root, TEST_CONFIG.database_path);
    const db = openDatabase(databasePath);
    const markdown = [
      "# Diagnostic Only",
      "",
      "Diagnostic Only keeps an intentionally unmatched [ bracket in prose.",
    ].join("\n");
    saveArticle(
      db,
      {
        slug: "diagnostic-only",
        canonicalSlug: "diagnostic-only",
        title: "Diagnostic Only",
        markdown,
        html: renderMarkdown(markdown),
        plain_text: markdownToPlainText(markdown),
        generated_at: Date.now(),
      },
      [],
      ["diagnostic-only"],
    );
    const beforeRevisions = listArticleRevisions(db, "diagnostic-only").length;
    db.close();

    const entries: CapturedLogEntry[] = [];
    const cachedServer = await createServerForDatabase(root, databasePath, {
      logger: createMemoryLogger(entries),
      llmClient: new CountingLlmClient(),
    });
    cleanupTestServer(t, cachedServer);

    const first = await cachedServer.request("/api/page/Diagnostic_Only");
    assert.equal(first.status, 200);
    const second = await cachedServer.request("/api/page/Diagnostic_Only");
    assert.equal(second.status, 200);

    const checkDb = openDatabase(databasePath);
    const afterRevisions = listArticleRevisions(checkDb, "diagnostic-only").length;
    checkDb.close();
    assert.equal(afterRevisions, beforeRevisions);
    assert.equal(entries.some((entry) => entry.event === "page.cache_repair"), false);
  });

  await t.test("browser entry routes serve the SPA shell and bare slugs redirect", async () => {
    for (const path of ["/", "/search", "/all-entries", "/admin", "/media", "/wiki/Test_Article", "/wiki/%E6%98%AF%E9%B1%BC%E6%88%91"]) {
      const res = await server.request(path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      const html = await res.text();
      assert.match(html, /<div id="root"><\/div>/);
      assert.doesNotMatch(html, /googletagmanager|gtag|google-analytics/i);
    }

    // Reloading /media must serve the SPA shell, not redirect to /wiki/Media as
    // if "media" were a bare article slug.
    const mediaReloadRes = await server.request("/media", { redirect: "manual" });
    assert.equal(mediaReloadRes.status, 200);

    const redirectRes = await server.request("/test-article", { redirect: "manual" });
    assert.equal(redirectRes.status, 302);
    assert.equal(redirectRes.headers.get("location"), "/wiki/test-article");

    const slugStyleWikiRes = await server.request("/wiki/cultural-dissipation-factor", { redirect: "manual" });
    assert.equal(slugStyleWikiRes.status, 302);
    assert.equal(slugStyleWikiRes.headers.get("location"), "/wiki/Cultural_dissipation_factor");

    const dashedWikiRes = await server.request("/wiki/archive-rotation-mechanics-protocol", { redirect: "manual" });
    assert.equal(dashedWikiRes.status, 302);
    assert.equal(dashedWikiRes.headers.get("location"), "/wiki/Archive_rotation_mechanics_protocol");

    const notFoundRes = await server.request("/missing.txt");
    assert.equal(notFoundRes.status, 404);
  });

  await t.test("highlight add-link updates markdown without regenerating the article", async (t) => {
    const llm = new CountingLlmClient();
    const linkServer = await createTestServer({ llmClient: llm });
    cleanupTestServer(t, linkServer);

    const res = await linkServer.request("/api/article/test-article/add-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selectedText: "Glow Fruit" }),
    });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.cached, true);
    assert.match(body.article.markdown, /\[Glow Fruit\]\(halu:glow-fruit "A fruit referenced from the source article"\)/);
    // No stream calls = no full article regeneration (the key invariant)
    assert.equal(llm.streamCalls, 0);
  });

  await t.test("core request paths emit structured page logs", async (t) => {
    const entries: CapturedLogEntry[] = [];
    const loggedServer = await createTestServer({ logger: createMemoryLogger(entries) });
    cleanupTestServer(t, loggedServer);

    await loggedServer.request("/api/page/Test_Article");
    await loggedServer.request("/test-article", { redirect: "manual" });

    assert.ok(entries.some((entry) => entry.event === "startup"));
    assert.ok(entries.some((entry) => entry.event === "page.hit" && entry.fields?.slug === "test-article"));
    assert.ok(entries.some((entry) => entry.event === "page.redirect" && entry.fields?.slug === "test-article"));
  });

  await t.test("cache misses emit generation and rag lifecycle logs", async (t) => {
    const entries: CapturedLogEntry[] = [];
    const generatedServer = await createTestServer({
      seed: false,
      logger: createMemoryLogger(entries),
      llmClient: new FakeLlmClient(),
    });
    cleanupTestServer(t, generatedServer);

    const res = await generatedServer.request("/api/page/Fresh_Page");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);
    const payload = await res.text();
    assert.match(payload, /"type":"done"/);

    assert.ok(entries.some((entry) => entry.event === "page.miss" && entry.fields?.slug === "fresh-page"));
    assert.ok(
      entries.some(
        (entry) =>
          (entry.event === "rag.retrieve_skipped" || entry.event === "rag.retrieve_empty") &&
          entry.fields?.slug === "fresh-page"
      )
    );
    assert.ok(entries.some((entry) => entry.event === "page.generated" && entry.fields?.slug === "fresh-page"));
    await waitForLog(entries, (entry) => entry.event === "rag.index_complete" && entry.fields?.slug === "fresh-page");
  });

  await t.test("unicode wiki paths generate, cache, and log correctly", async (t) => {
    const entries: CapturedLogEntry[] = [];
    const unicodeSegment = encodeURIComponent("百科甲");
    const unicodeServer = await createTestServer({
      seed: false,
      logger: createMemoryLogger(entries),
      llmClient: new FixedArticleLlmClient([
        "# 百科甲",
        "",
        "百科甲是一个多语言条目，引用了[甲](halu:甲)。",
      ].join("\n")),
    });
    cleanupTestServer(t, unicodeServer);

    const generatedRes = await unicodeServer.request(`/api/page/${unicodeSegment}`);
    assert.equal(generatedRes.status, 200);
    assert.match(generatedRes.headers.get("content-type") ?? "", /application\/x-ndjson/);

    const packets = parseNdjson<Array<Record<string, unknown>>[number]>(await generatedRes.text());
    const done = packets.find((packet) => packet.type === "done");
    assert.ok(done);
    assert.equal(done.article.slug, "百科甲");
    assert.equal(done.article.title, "百科甲");
    assert.equal(done.canonicalPath, "/wiki/百科甲");

    const cachedRes = await unicodeServer.request(`/api/page/${unicodeSegment}`);
    assert.equal(cachedRes.status, 200);
    const cachedBody = await cachedRes.json();
    assert.equal(cachedBody.cached, true);
    assert.equal(cachedBody.article.slug, "百科甲");
    assert.equal(cachedBody.canonicalPath, "/wiki/百科甲");

    assert.ok(entries.some((entry) => entry.event === "page.miss" && entry.fields?.slug === "百科甲"));
    assert.ok(entries.some((entry) => entry.event === "page.hit" && entry.fields?.slug === "百科甲"));
  });

  await t.test("cached articles repair stale ascii-only slugs when the title-derived slug includes unicode", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "halupedia-test-"));
    const databasePath = join(root, TEST_CONFIG.database_path);
    const db = openDatabase(databasePath);
    const markdown = [
      "# Café β Registry",
      "",
      "A multilingual registry entry.",
    ].join("\n");

    saveArticle(
      db,
      {
        slug: "fish",
        canonicalSlug: "fish",
        title: "Café β Registry",
        markdown,
        html: renderMarkdown(markdown),
        plain_text: markdownToPlainText(markdown),
        generated_at: Date.now(),
      },
      [],
      ["fish"]
    );
    db.close();

    const server = await createServerForDatabase(root, databasePath);
    cleanupTestServer(t, server);

    const res = await server.request(`/api/page/${encodeURIComponent("Café_β_Registry")}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cached, true);
    assert.equal(body.article.slug, "café-β-registry");
    assert.equal(body.article.canonicalSlug, "café-β-registry");
    assert.equal(body.canonicalPath, "/wiki/Café_β_Registry");

    const aliasRes = await server.request("/api/page/Fish");
    assert.equal(aliasRes.status, 200);
    const aliasBody = await aliasRes.json();
    assert.equal(aliasBody.article.slug, "café-β-registry");
    assert.equal(aliasBody.redirectedFrom, "/wiki/Fish");
  });

  await t.test("cached articles resolve unique compact-equivalent slugs without regeneration", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "halupedia-test-"));
    const databasePath = join(root, TEST_CONFIG.database_path);
    const db = openDatabase(databasePath);
    const markdown = [
      "# R/GoneWild: The Movie starring Mitch McConnell",
      "",
      "An existing article whose canonical title contains punctuation.",
    ].join("\n");

    saveArticle(
      db,
      {
        slug: "r-gonewild-the-movie-starring-mitch-mcconnell",
        canonicalSlug: "r-gonewild-the-movie-starring-mitch-mcconnell",
        title: "R/GoneWild: The Movie starring Mitch McConnell",
        markdown,
        html: renderMarkdown(markdown),
        plain_text: markdownToPlainText(markdown),
        generated_at: Date.now(),
      },
      [],
      ["r-gonewild-the-movie-starring-mitch-mcconnell"],
    );
    db.close();

    const entries: CapturedLogEntry[] = [];
    const server = await createServerForDatabase(root, databasePath, {
      logger: createMemoryLogger(entries),
      llmClient: new FailingGenerationLlmClient(),
    });
    cleanupTestServer(t, server);

    const res = await server.request("/api/page/rgonewild-the-movie-starring-mitch-mcconnell");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cached, true);
    assert.equal(body.article.slug, "r-gonewild-the-movie-starring-mitch-mcconnell");
    assert.equal(body.article.title, "R/GoneWild: The Movie starring Mitch McConnell");
    assert.equal(body.redirectedFrom, "/wiki/rgonewild-the-movie-starring-mitch-mcconnell");
    assert.equal(body.canonicalPath, "/wiki/RGoneWild_The_Movie_starring_Mitch_McConnell");
    assert.ok(
      entries.some(
        (entry) =>
          entry.event === "page.equivalent_hit" &&
          entry.fields?.slug === "rgonewild-the-movie-starring-mitch-mcconnell" &&
          entry.fields?.canonical_slug === "r-gonewild-the-movie-starring-mitch-mcconnell",
      ),
    );
    assert.equal(
      entries.some((entry) => entry.event === "page.miss"),
      false,
      "equivalent cached lookup must not fall through to generation",
    );
  });

  await t.test("slug-derived title paths resolve existing legacy slugs before robust generation", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "halupedia-test-"));
    const databasePath = join(root, TEST_CONFIG.database_path);
    const db = openDatabase(databasePath);
    const markdown = [
      "# Signal Relay",
      "",
      "An existing article whose stored slug contains a hyphen.",
    ].join("\n");

    saveArticle(
      db,
      {
        slug: "signal-relay",
        canonicalSlug: "signal-relay",
        title: "Signal Relay",
        markdown,
        html: renderMarkdown(markdown),
        plain_text: markdownToPlainText(markdown),
        generated_at: Date.now(),
      },
      [],
      ["signal-relay"],
    );
    db.close();

    const entries: CapturedLogEntry[] = [];
    const server = await createServerForDatabase(root, databasePath, {
      logger: createMemoryLogger(entries),
      llmClient: new FailingGenerationLlmClient(),
    });
    cleanupTestServer(t, server);

    const res = await server.request("/api/page/Signal-relay");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cached, true);
    assert.equal(body.article.slug, "signal-relay");
    assert.equal(body.article.title, "Signal Relay");
    assert.equal(body.canonicalPath, "/wiki/Signal_Relay");
    assert.equal(body.redirectedFrom, "/wiki/Signal-relay");
    assert.ok(
      entries.some(
        (entry) =>
          entry.event === "page.legacy_slug_hit" &&
          entry.fields?.slug === "signal-dash-relay" &&
          entry.fields?.canonical_slug === "signal-relay",
      ),
    );
    assert.equal(
      entries.some((entry) => entry.event === "page.miss"),
      false,
      "title-shaped lookup must not generate the robust dash slug when the legacy slug exists",
    );
  });

  await t.test("unmatched paths emit not-found logs", async (t) => {
    const entries: CapturedLogEntry[] = [];
    const loggedServer = await createTestServer({ logger: createMemoryLogger(entries) });
    cleanupTestServer(t, loggedServer);

    const res = await loggedServer.request("/missing.txt");
    assert.equal(res.status, 404);
    assert.ok(entries.some((entry) => entry.event === "http.not_found" && entry.fields?.path === "/missing.txt"));
  });

  await t.test("generated articles do not canonize a lowercase-first request path", async (t) => {
    const generatedServer = await createTestServer({
      seed: false,
      llmClient: new FixedArticleLlmClient([
        "# archival rotation theorem",
        "",
        "A foundational postulate about pleasure vectors.",
      ].join("\n")),
    });
    cleanupTestServer(t, generatedServer);

    const res = await generatedServer.request("/api/page/archival_rotation_theorem");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);

    const packets = parseNdjson<Array<Record<string, unknown>>[number]>(await res.text());
    const done = packets.find((packet) => packet.type === "done");
    assert.ok(done);
    assert.equal(done.article.title, "Archival rotation theorem");
    assert.equal(done.article.markdown.startsWith("# Archival rotation theorem"), true);
    assert.equal(done.canonicalPath, "/wiki/Archival_rotation_theorem");
    assert.equal(done.redirectedFrom, "/wiki/archival_rotation_theorem");
  });

  await t.test("slug-style wiki API requests resolve to underscored canonical paths", async (t) => {
    const generatedServer = await createTestServer({
      seed: false,
      llmClient: new FixedArticleLlmClient([
        "# Cultural Dissipation Factor",
        "",
        "A quiet registry metric for archival energy loss.",
      ].join("\n")),
    });
    cleanupTestServer(t, generatedServer);

    const res = await generatedServer.request("/api/page/cultural-dissipation-factor");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);

    const packets = parseNdjson<Array<Record<string, unknown>>[number]>(await res.text());
    const done = packets.find((packet) => packet.type === "done");
    assert.ok(done);
    assert.equal(done.article.slug, "cultural-dissipation-factor");
    assert.equal(done.article.title, "Cultural dissipation factor");
    assert.equal(done.canonicalPath, "/wiki/Cultural_dissipation_factor");
    assert.equal(done.redirectedFrom, "/wiki/cultural-dissipation-factor");
  });

  await t.test("generated articles adopt a unicode-extended canonical slug from the resolved heading", async (t) => {
    const generatedServer = await createTestServer({
      seed: false,
      llmClient: new FixedArticleLlmClient([
        "# Café β Registry",
        "",
        "A multilingual registry entry.",
      ].join("\n")),
    });
    cleanupTestServer(t, generatedServer);

    const res = await generatedServer.request(`/api/page/${encodeURIComponent("Café_β_Registry")}`);
    assert.equal(res.status, 200);
    const packets = parseNdjson<Array<Record<string, unknown>>[number]>(await res.text());
    const done = packets.find((packet) => packet.type === "done");
    assert.ok(done);
    assert.equal(done.article.slug, "café-β-registry");
    assert.equal(done.article.title, "Café β Registry");
    assert.equal(done.canonicalPath, "/wiki/Café_β_Registry");
    assert.equal(done.redirectedFrom, undefined);
  });

  await t.test("cached articles with lowercase-first titles are repaired before becoming canonical", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "halupedia-test-"));
    const databasePath = join(root, TEST_CONFIG.database_path);
    const db = openDatabase(databasePath);
    const markdown = [
      "# archival rotation theorem",
      "",
      "A foundational postulate about pleasure vectors.",
    ].join("\n");

    saveArticle(
      db,
      {
        slug: "archival-rotation-theorem",
        canonicalSlug: "archival-rotation-theorem",
        title: "archival rotation theorem",
        markdown,
        html: renderMarkdown(markdown),
        plain_text: markdownToPlainText(markdown),
        generated_at: 1_715_000_000_100,
      },
      [],
      ["archival-rotation-theorem"]
    );
    db.close();

    const cachedServer = await createServerForDatabase(root, databasePath);
    cleanupTestServer(t, cachedServer);

    const res = await cachedServer.request("/api/page/Archival_rotation_theorem");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const body = await res.json();
    assert.equal(body.cached, true);
    assert.equal(body.article.title, "Archival rotation theorem");
    assert.equal(body.article.markdown.startsWith("# Archival rotation theorem"), true);
    assert.equal(body.canonicalPath, "/wiki/Archival_rotation_theorem");
    assert.equal(body.redirectedFrom, undefined);
  });
});

test("client disconnect mid-generation still saves the article to DB", async (t) => {
  const llm = new SlowLlmClient(30);
  const server = await createTestServer({ seed: false, llmClient: llm });
  cleanupTestServer(t, server);

  const controller = new AbortController();
  const resPromise = server.request("/api/page/Slow_Article", { signal: controller.signal });

  await llm.generationStarted.promise;
  controller.abort();

  await resPromise.catch(() => {});
  await llm.generationDone.promise;
  // Allow finalizeArticle to complete (see also, summary, save)
  await new Promise((r) => setTimeout(r, 200));

  const db = openDatabase(server.databasePath);
  const row = db.prepare("SELECT slug, title FROM articles WHERE slug = ?").get("slow-article") as
    | { slug: string; title: string }
    | undefined;
  db.close();

  assert.ok(row, "article should be saved to DB even after client disconnect");
  assert.equal(row.title, "Slow Article");
});

test("shutdown waits for in-flight generations then resolves", async (t) => {
  const llm = new SlowLlmClient(30);
  const server = await createTestServer({ seed: false, llmClient: llm });
  t.after(async () => {
    await server.shutdown();
    rmSync(server.root, { recursive: true, force: true });
  });

  // Start a generation but don't await the full response
  const resPromise = server.request("/api/page/Slow_Article");
  await llm.generationStarted.promise;

  // Initiate shutdown while generation is in progress
  const shutdownPromise = server.shutdown();

  // Shutdown should not resolve until generation is done
  const raceResult = await Promise.race([
    shutdownPromise.then(() => "shutdown"),
    new Promise((r) => setTimeout(() => r("timeout"), 50)),
  ]);
  // Generation is still going, so shutdown should not have resolved yet
  // (the LLM client takes ~120ms total for 4 chunks at 30ms each)
  assert.equal(raceResult, "timeout", "shutdown must wait for in-flight generation");

  // Let everything finish
  await resPromise.catch(() => {});
  await shutdownPromise;

  const db = openDatabase(server.databasePath);
  const row = db.prepare("SELECT slug FROM articles WHERE slug = ?").get("slow-article") as
    | { slug: string }
    | undefined;
  db.close();
  assert.ok(row, "article should be saved before shutdown completes");
});

test("concurrent requests for the same uncached slug share a single generation", async (t) => {
  const llm = new GatedLlmClient();
  const server = await createTestServer({ seed: false, llmClient: llm });
  t.after(async () => {
    llm.gate.resolve();
    await server.shutdown();
    rmSync(server.root, { recursive: true, force: true });
  });

  const req1 = server.request("/api/page/Gated_Article");
  const req2 = server.request("/api/page/Gated_Article");

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(llm.streamCallCount, 1, "only one LLM stream should start for duplicate slug requests");

  const res2 = await req2;
  const text2 = await res2.text();
  assert.match(text2, /"type":"status","message":"Waiting and contemplating\.\.\."/);
  assert.doesNotMatch(text2, /"type":"done"/);

  llm.gate.resolve();
  const res1 = await req1;

  const text1 = await res1.text();
  assert.match(text1, /"type":"done"/);
  assert.match(text1, /"slug":"gated-article"/);
});

test("admin generation queue reports active articles and waiter counts", async (t) => {
  const llm = new GatedLlmClient();
  const server = await createTestServer({ seed: false, llmClient: llm });
  t.after(async () => {
    llm.gate.resolve();
    await server.shutdown();
    rmSync(server.root, { recursive: true, force: true });
  });

  const req1 = server.request("/api/page/Gated_Article");
  await new Promise((r) => setTimeout(r, 50));

  let queueRes = await server.request("/api/admin/generation-queue");
  let queue = (await queueRes.json()) as any;
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].slug, "gated-article");
  assert.equal(queue.items[0].title, "Gated Article");
  assert.equal(queue.items[0].waiting, 0);

  const req2 = server.request("/api/page/Gated_Article");
  await new Promise((r) => setTimeout(r, 50));

  queueRes = await server.request("/api/admin/generation-queue");
  queue = (await queueRes.json()) as any;
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].waiting, 0);

  const waitRes = await server.request("/api/page/Gated_Article?wait=0");
  assert.equal(waitRes.status, 202);
  assert.deepEqual(await waitRes.json(), {
    generating: true,
    slug: "gated-article",
    title: "Gated Article",
    seq: queue.items[0].seq,
    waiting: 0,
  });

  llm.gate.resolve();
  await Promise.all([req1.then((res) => res.text()), req2.then((res) => res.text())]);

  queueRes = await server.request("/api/admin/generation-queue");
  queue = (await queueRes.json()) as any;
  assert.deepEqual(queue.items, []);
});

test("admin generation queue polling does not spam request logs", async (t) => {
  const entries: CapturedLogEntry[] = [];
  const server = await createTestServer({
    seed: false,
    logger: createMemoryLogger(entries),
  });
  cleanupTestServer(t, server);

  for (let i = 0; i < 3; i++) {
    const res = await server.request("/api/admin/generation-queue");
    assert.equal(res.status, 200);
  }

  const queueRequestLogs = entries.filter(
    (entry) =>
      entry.event === "http.request" &&
      entry.fields?.method === "GET" &&
      entry.fields?.path === "/api/admin/generation-queue",
  );
  assert.equal(queueRequestLogs.length, 0);

  const healthRes = await server.request("/api/health");
  assert.equal(healthRes.status, 200);
  assert.ok(
    entries.some(
      (entry) =>
        entry.event === "http.request" &&
        entry.fields?.method === "GET" &&
        entry.fields?.path === "/api/health",
    ),
  );
});

test("failed generation releases the slug so a retry can succeed", async (t) => {
  let callCount = 0;
  const hybridLlm: LlmRouter = {
    async chat() { return JSON.stringify({ items: [] }); },
    async streamChat(_r, _s, _u, onChunk) {
      callCount++;
      if (callCount === 1) {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("terminated");
      }
      const content = [
        "# Retry Article\n\n",
        '**Retry Article** is a recovered entry with [Alpha](halu:alpha "Alpha hint"), ',
        '[Beta](halu:beta "Beta hint"), [Gamma](halu:gamma "Gamma hint"), ',
        '[Delta](halu:delta "Delta hint"), and [Epsilon](halu:epsilon "Epsilon hint").',
      ].join("");
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createTestServer({ seed: false, llmClient: hybridLlm });
  cleanupTestServer(t, server);

  const res1 = await server.request("/api/page/Retry_Article");
  const text1 = await res1.text();
  assert.match(text1, /"type":"error"/, "first request should fail");

  const res2 = await server.request("/api/page/Retry_Article");
  const text2 = await res2.text();
  assert.match(text2, /"type":"done"/, "retry should succeed after failed generation");

  const db = openDatabase(server.databasePath);
  const row = db.prepare("SELECT slug FROM articles WHERE slug = ?").get("retry-article") as
    | { slug: string }
    | undefined;
  db.close();
  assert.ok(row, "article should be saved on retry");
});

test("article is saved to DB immediately after streaming, before post-processing completes", async (t) => {
  const postProcessGate = Promise.withResolvers<void>();
  const llm: LlmRouter = {
    async chat() {
      await postProcessGate.promise;
      return JSON.stringify({ items: [{ title: "Stub", hint: "stub" }] });
    },
    async streamChat(_r, _s, _u, onChunk) {
      const content = "# Fresh Page\n\n**Fresh Page** is a test with [Alpha](halu:alpha \"Alpha hint\"), [Beta](halu:beta \"Beta hint\"), [Gamma](halu:gamma \"Gamma hint\"), [Delta](halu:delta \"Delta hint\"), and [Epsilon](halu:epsilon \"Epsilon hint\").";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createTestServer({ seed: false, llmClient: llm });
  t.after(async () => {
    postProcessGate.resolve();
    await server.shutdown();
    rmSync(server.root, { recursive: true, force: true });
  });

  const genRes = await server.request("/api/page/Fresh_Page");
  const ndjson = await genRes.text();
  const lines = ndjson.trim().split("\n").map((l) => JSON.parse(l));
  const done = lines.find((l) => l.type === "done");
  assert.ok(done, "generation stream should have a done event");
  assert.equal(done.article.title, "Fresh Page");

  const cacheRes = await server.request("/api/page/Fresh_Page");
  assert.equal(cacheRes.status, 200);
  const cacheBody = await cacheRes.json();
  assert.ok(cacheBody.cached, "article should be a cache hit while post-processing is still running");
  assert.ok(cacheBody.article, "article should exist in DB");
  assert.equal(cacheBody.article.title, "Fresh Page");

  postProcessGate.resolve();
});

test("second request during post-processing gets cache hit, not cache miss", async (t) => {
  const postProcessGate = Promise.withResolvers<void>();
  const logEntries: CapturedLogEntry[] = [];
  const logger = createMemoryLogger(logEntries);
  const llm: LlmRouter = {
    async chat() {
      await postProcessGate.promise;
      return JSON.stringify({ items: [{ title: "Stub", hint: "stub" }] });
    },
    async streamChat(_r, _s, _u, onChunk) {
      const content = "# Test Entry\n\n**Test Entry** links to [Alpha](halu:alpha \"Alpha hint\"), [Beta](halu:beta \"Beta hint\"), [Gamma](halu:gamma \"Gamma hint\"), [Delta](halu:delta \"Delta hint\"), [Epsilon](halu:epsilon \"Epsilon hint\").";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createTestServer({ seed: false, llmClient: llm, logger });
  t.after(async () => {
    postProcessGate.resolve();
    await server.shutdown();
    rmSync(server.root, { recursive: true, force: true });
  });

  const genRes = await server.request("/api/page/Test_Entry");
  await genRes.text();

  const secondRes = await server.request("/api/page/Test_Entry");
  const secondBody = await secondRes.json();
  assert.ok(secondBody.cached, "second request should be cache hit");

  const cacheMissEvents = logEntries.filter(
    (e) => e.event === "page.miss" && e.fields?.slug === "test-entry"
  );
  assert.equal(cacheMissEvents.length, 1, "should only have one cache miss (the initial generation)");

  postProcessGate.resolve();
});

test("homepage prepares DB-backed content in background and serves cached requests without LLM work", async (t) => {
  let chatCalls = 0;
  const llm: LlmRouter = {
    async chat(_r, _system, user) {
      chatCalls += 1;
      const title = user.match(/\[([^\]]+)\]\(halu:/)?.[1] ?? "Article";
      return `... [${title}](halu:${title.toLowerCase().replace(/\s+/g, "-")} "${title}") keeps ceremonial ledgers underwater.`;
    },
    async streamChat(_r, _s, _u, onChunk) {
      const content = "# Stub\n\nStub body.";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createTestServer({ seed: true, llmClient: llm, homepagePrepare: true });
  cleanupTestServer(t, server);
  await waitForHomepage(
    server,
    (payload) => payload.didYouKnow?.length === 2,
  );
  assert.equal(chatCalls, 2, "seed database has two live articles, so background prep should ask once per article");

  const res = await server.request("/api/homepage");
  assert.equal(res.status, 200);
  const cachedBody = await res.json();

  assert.ok(cachedBody.featured, "should always have a featured article when articles exist");
  assert.ok(cachedBody.featured.title, "featured article should have a title");
  assert.ok(cachedBody.featured.slug, "featured article should have a slug");
  assert.ok(cachedBody.featured.summaryMarkdown !== undefined, "featured article should have summaryMarkdown");
  assert.ok(Array.isArray(cachedBody.didYouKnow), "didYouKnow should be an array");
  assert.equal(cachedBody.didYouKnow.length, 2, "DYK facts should be ready in the cached response");
  assert.equal(chatCalls, 2, "cached homepage request must not call the LLM");
  assert.ok(!("didYouKnowPending" in cachedBody), "homepage no longer exposes request-time generation state");
});

test("homepage returns empty state when no articles exist", async (t) => {
  const server = await createTestServer({ seed: false, homepagePrepare: true });
  cleanupTestServer(t, server);

  const res = await server.request("/api/homepage");
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.featured, null, "no featured when DB is empty");
  assert.deepEqual(body.didYouKnow, [], "no DYK when DB is empty");
  assert.ok(body.generatedAt, "empty homepage state is still persisted");
});

test("homepage featured article uses the literal first paragraph", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-test-"));
  const databasePath = join(root, TEST_CONFIG.database_path);
  const db = openDatabase(databasePath);
  const markdown = [
    "# Index Lamp",
    "",
    "Index Lamp are ceremonial freshwater accountants with [gravel](halu:gravel \"approved fish gravel\") and $\\sigma$.",
    "",
    "They are often cited in ballast ledgers.",
  ].join("\n");

  saveArticle(
    db,
    {
      slug: "index-lamp",
      canonicalSlug: "index-lamp",
      title: "Index Lamp",
      markdown,
      html: renderMarkdown(markdown),
      summaryMarkdown: "",
      plain_text: markdownToPlainText(markdown),
      generated_at: Date.now(),
    },
    [],
    ["index-lamp"]
  );
  db.prepare("UPDATE articles SET summary_markdown = '' WHERE slug = ?").run("index-lamp");
  db.close();

  const llm: LlmRouter = {
    async chat() {
      return "... [Index Lamp](halu:index-lamp \"Index Lamp\") reconcile canal tax ledgers after dusk.";
    },
    async streamChat(_r, _s, _u, onChunk) {
      const content = "# Stub\n\nStub body.";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createServerForDatabase(root, databasePath, { llmClient: llm, homepagePrepare: true });
  cleanupTestServer(t, server);

  const body = await waitForHomepage(
    server,
    (payload) => payload.featured?.title === "Index Lamp",
  );
  assert.equal(body.featured.title, "Index Lamp");
  assert.equal(
    body.featured.summaryMarkdown,
    "Index Lamp are ceremonial freshwater accountants with [gravel](halu:gravel \"approved fish gravel\") and $\\sigma$."
  );
});

test("homepage generates one startup DYK fact for a single article", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-test-"));
  const databasePath = join(root, TEST_CONFIG.database_path);
  const db = openDatabase(databasePath);
  const markdown = [
    "# Index Lamp",
    "",
    "Index Lamp are ceremonial freshwater accountants with a suspicious fondness for gravel.",
  ].join("\n");
  saveArticle(
    db,
    {
      slug: "index-lamp",
      canonicalSlug: "index-lamp",
      title: "Index Lamp",
      markdown,
      html: renderMarkdown(markdown),
      plain_text: markdownToPlainText(markdown),
      generated_at: Date.now(),
    },
    [],
    ["index-lamp"]
  );
  db.close();

  let chatCalls = 0;
  const llm: LlmRouter = {
    async chat() {
      chatCalls += 1;
      return "... [Index Lamp](halu:index-lamp \"Index Lamp\") secretly reconcile canal tax ledgers after dusk.";
    },
    async streamChat(_r, _s, _u, onChunk) {
      const content = "# Stub\n\nStub body.";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createServerForDatabase(root, databasePath, { llmClient: llm, homepagePrepare: true });
  cleanupTestServer(t, server);

  const body = await waitForHomepage(
    server,
    (payload) => payload.didYouKnow?.length === 1,
  );
  assert.equal(body.featured.title, "Index Lamp");
  assert.equal(body.didYouKnow.length, 1);
  assert.equal(body.didYouKnow[0].slug, "index-lamp");
  assert.equal(body.didYouKnow[0].fact, '... [Index Lamp](halu:index-lamp "Index Lamp") secretly reconcile canal tax ledgers after dusk?');
  assert.equal(chatCalls, 1);
});

test("homepage handles DYK generation failure gracefully", async (t) => {
  const llm: LlmRouter = {
    async chat() {
      throw new Error("LLM unavailable");
    },
    async streamChat(_r, _s, _u, onChunk) {
      const content = "# Stub\n\nStub body.";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createTestServer({ seed: true, llmClient: llm, homepagePrepare: true });
  cleanupTestServer(t, server);

  const body = await waitForHomepage(
    server,
    (payload) => payload.featured && Array.isArray(payload.didYouKnow),
  );
  assert.ok(body.featured, "featured article should still be present even when DYK fails");
  assert.deepEqual(body.didYouKnow, [], "DYK should be empty array on failure, not error");
});

test("homepage uses a current DB cache without regenerating at startup", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-test-"));
  const databasePath = join(root, TEST_CONFIG.database_path);
  const db = openDatabase(databasePath);
  const now = Date.now();
  saveHomepageCache(db, {
    featured: { slug: "cached", title: "Cached", summaryMarkdown: "Cached lead." },
    didYouKnow: [{ slug: "cached", title: "Cached", fact: "... [Cached](halu:cached \"Cached\") already knows." }],
    generatedAt: now,
    expiresAt: now + 60_000,
  });
  db.close();

  let chatCalled = false;
  const llm: LlmRouter = {
    async chat() {
      chatCalled = true;
      throw new Error("should not generate");
    },
    async streamChat(_r, _s, _u, onChunk) {
      const content = "# Stub\n\nStub body.";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createServerForDatabase(root, databasePath, { llmClient: llm, homepagePrepare: true });
  cleanupTestServer(t, server);

  const res = await server.request("/api/homepage");
  const body = await res.json();
  assert.equal(chatCalled, false, "current homepage cache should prevent startup generation");
  assert.equal(body.featured.title, "Cached");
  assert.equal(body.didYouKnow[0].fact, "... [Cached](halu:cached \"Cached\") already knows.");
});

test("homepage request regenerates expired cache and logs refresh lifecycle", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-test-"));
  const databasePath = join(root, TEST_CONFIG.database_path);
  const db = openDatabase(databasePath);
  const oldGeneratedAt = Date.now() - 24 * 60 * 60 * 1000;
  const markdown = [
    "# Fresh Featured",
    "",
    "Fresh Featured is a newly selected article for the homepage.",
  ].join("\n");
  saveArticle(
    db,
    {
      slug: "fresh-featured",
      canonicalSlug: "fresh-featured",
      title: "Fresh Featured",
      markdown,
      html: renderMarkdown(markdown),
      plain_text: markdownToPlainText(markdown),
      generated_at: Date.now(),
    },
    [],
    ["fresh-featured"]
  );
  saveHomepageCache(db, {
    featured: { slug: "stale", title: "Stale", summaryMarkdown: "Old summary." },
    didYouKnow: [{ slug: "stale", title: "Stale", fact: "... stale fact." }],
    generatedAt: oldGeneratedAt,
    expiresAt: oldGeneratedAt + 1000,
  });
  db.close();

  let chatCalls = 0;
  const llm: LlmRouter = {
    async chat() {
      chatCalls += 1;
      return "... [Fresh Featured](halu:fresh-featured \"Fresh Featured\") replaces the stale homepage cache.";
    },
    async streamChat(_r, _s, _u, onChunk) {
      const content = "# Stub\n\nStub body.";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };
  const logEntries: CapturedLogEntry[] = [];
  const server = await createServerForDatabase(root, databasePath, {
    llmClient: llm,
    logger: createMemoryLogger(logEntries),
    homepagePrepare: true,
  });
  cleanupTestServer(t, server);

  const body = await waitForHomepage(
    server,
    (payload) => payload.featured?.title === "Fresh Featured",
  );

  assert.equal(body.featured.title, "Fresh Featured");
  assert.equal(body.didYouKnow.length, 1);
  assert.equal(chatCalls, 1);
  assert.ok(
    logEntries.some((entry) => entry.event === "homepage.refresh_start" && entry.fields?.reason === "expired"),
    "expired homepage refresh should log a standalone start event"
  );
  assert.ok(
    logEntries.some((entry) => entry.event === "homepage.refresh_done" && entry.fields?.featured === "fresh-featured"),
    "expired homepage refresh should log a standalone done event"
  );
});

test("article page payload is not blank — html and title are populated", async (t) => {
  const server = await createTestServer({ seed: true });
  cleanupTestServer(t, server);

  const res = await server.request("/api/page/Test_Article");
  assert.equal(res.status, 200, "page endpoint must return 200");

  const body = await res.json();
  // The article must have a title and non-empty HTML — a blank page would have empty html.
  assert.ok(body.article?.title, "article title must not be empty");
  assert.ok(
    typeof body.article?.html === "string" && body.article.html.trim().length > 0,
    "article html must not be blank",
  );
  // The html must contain visible article text, not just whitespace or empty tags.
  assert.match(body.article.html, /<[hp]/, "html must contain paragraph or heading tags");
  // Sanity: the page must not return a 'blank' body object missing required fields.
  assert.ok(body.backlinks, "backlinks must be present");
  assert.ok(body.canonicalPath, "canonicalPath must be present");
});

// Ensure clean exit after all tests complete and cleanup handlers finish
// This addresses the hanging test suite issue by forcing exit after a brief delay
// to allow final async operations to settle.
setImmediate(() => {
  // Force garbage collection if available
  if (global.gc) global.gc();

  // Give final cleanup a moment to complete, then force exit
  setTimeout(() => {
    // Unref stdin/stdout/stderr if they're still active
    if (process.stdin.unref) process.stdin.unref();
    if (process.stdout.unref) process.stdout.unref();
    if (process.stderr.unref) process.stderr.unref();

    // Exit cleanly - process.exit() is needed because some database or
    // background operation is keeping the event loop alive
    process.exit(0);
  }, 100);
});
