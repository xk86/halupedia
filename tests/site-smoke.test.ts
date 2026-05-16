import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, saveArticle } from "../src/server/db";
import { createApp } from "../src/server/index";
import type { LlmClient } from "../src/server/llm";
import type { LogFields, Logger } from "../src/server/logger";
import { renderMarkdown, markdownToPlainText } from "../src/server/markdown";

interface CapturedLogEntry {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields?: LogFields;
}

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

class FakeLlmClient implements LlmClient {
  async chat(): Promise<string> {
    return JSON.stringify({ items: [] });
  }

  async streamChat(
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

class CountingLlmClient implements LlmClient {
  chatCalls = 0;
  streamCalls = 0;
  embedCalls = 0;

  async chat(): Promise<string> {
    this.chatCalls += 1;
    return JSON.stringify({
      title: "Glow Fruit",
      hint: "A fruit referenced from the source article",
      items: [],
    });
  }

  async streamChat(
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
  const databasePath = join(root, "halupedia.sqlite");
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

async function createTestServer(options: { logger?: Logger; llmClient?: LlmClient; seed?: boolean } = {}) {
  const seeded = options.seed ?? true;
  const { root, databasePath } = seeded
    ? createSeedDatabasePath()
    : (() => {
        const tempRoot = mkdtempSync(join(tmpdir(), "halupedia-test-"));
        return { root: tempRoot, databasePath: join(tempRoot, "halupedia.sqlite") };
      })();
  const { app } = await createApp({
    databasePath,
    skipLlmProbe: true,
    logger: options.logger,
    llmClient: options.llmClient,
  });
  return {
    root,
    request: (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://halupedia.test${path}`, init)),
  };
}

test("site smoke tests cover core routes and API contracts", async (t) => {
  const server = await createTestServer();
  t.after(() => {
    rmSync(server.root, { recursive: true, force: true });
  });

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
    assert.deepEqual(searchBody.results[0], {
      slug: "test-article",
      title: "Test Article",
      exists: true,
    });

    const emptySearchRes = await server.request("/api/search");
    assert.equal(emptySearchRes.status, 200);
    const emptySearchBody = await emptySearchRes.json();
    assert.deepEqual(emptySearchBody.results, []);

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
    t.after(() => {
      rmSync(cachedServer.root, { recursive: true, force: true });
    });

    const res = await cachedServer.request("/api/page/Test_Article");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cached, true);
    assert.equal(llm.chatCalls, 0);
    assert.equal(llm.streamCalls, 0);
    assert.equal(llm.embedCalls, 0);
  });

  await t.test("browser entry routes serve the SPA shell and bare slugs redirect", async () => {
    for (const path of ["/", "/search", "/all-entries", "/admin", "/wiki/Test_Article"]) {
      const res = await server.request(path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      const html = await res.text();
      assert.match(html, /<div id="root"><\/div>/);
    }

    const redirectRes = await server.request("/test-article", { redirect: "manual" });
    assert.equal(redirectRes.status, 302);
    assert.equal(redirectRes.headers.get("location"), "/wiki/test-article");

    const notFoundRes = await server.request("/missing.txt");
    assert.equal(notFoundRes.status, 404);
  });

  await t.test("highlight add-link updates markdown without regenerating the article", async (t) => {
    const llm = new CountingLlmClient();
    const linkServer = await createTestServer({ llmClient: llm });
    t.after(() => {
      rmSync(linkServer.root, { recursive: true, force: true });
    });

    const res = await linkServer.request("/api/article/test-article/add-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selectedText: "Glow Fruit" }),
    });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.cached, true);
    assert.match(body.article.markdown, /\[Glow Fruit\]\(halu:glow-fruit "A fruit referenced from the source article"\)/);
    assert.equal(llm.chatCalls, 1);
    assert.equal(llm.streamCalls, 0);
  });

  await t.test("core request paths emit structured page logs", async (t) => {
    const entries: CapturedLogEntry[] = [];
    const loggedServer = await createTestServer({ logger: createMemoryLogger(entries) });
    t.after(() => {
      rmSync(loggedServer.root, { recursive: true, force: true });
    });

    await loggedServer.request("/api/page/Test_Article");
    await loggedServer.request("/test-article", { redirect: "manual" });

    assert.ok(entries.some((entry) => entry.event === "startup"));
    assert.ok(entries.some((entry) => entry.event === "page.request" && entry.fields?.slug === "test-article"));
    assert.ok(entries.some((entry) => entry.event === "page.cache_hit" && entry.fields?.slug === "test-article"));
    assert.ok(entries.some((entry) => entry.event === "page.redirect" && entry.fields?.bare_slug === "test-article"));
  });

  await t.test("cache misses emit generation and rag lifecycle logs", async (t) => {
    const entries: CapturedLogEntry[] = [];
    const generatedServer = await createTestServer({
      seed: false,
      logger: createMemoryLogger(entries),
      llmClient: new FakeLlmClient(),
    });
    t.after(() => {
      rmSync(generatedServer.root, { recursive: true, force: true });
    });

    const res = await generatedServer.request("/api/page/Fresh_Page");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);
    const payload = await res.text();
    assert.match(payload, /"type":"done"/);

    assert.ok(entries.some((entry) => entry.event === "page.cache_miss" && entry.fields?.slug === "fresh-page"));
    assert.ok(entries.some((entry) => entry.event === "page.generation_start" && entry.fields?.slug === "fresh-page"));
    assert.ok(
      entries.some(
        (entry) =>
          (entry.event === "rag.retrieve_skipped" || entry.event === "rag.retrieve_empty") &&
          entry.fields?.slug === "fresh-page"
      )
    );
    assert.ok(entries.some((entry) => entry.event === "page.generation_attempt" && entry.fields?.slug === "fresh-page"));
    assert.ok(entries.some((entry) => entry.event === "rag.index_complete" && entry.fields?.slug === "fresh-page"));
    assert.ok(entries.some((entry) => entry.event === "page.generation_done" && entry.fields?.slug === "fresh-page"));
  });
});
