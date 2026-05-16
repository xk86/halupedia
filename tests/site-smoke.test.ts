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

class FixedArticleLlmClient implements LlmClient {
  constructor(private readonly markdown: string) {}

  async chat(): Promise<string> {
    return JSON.stringify({ items: [] });
  }

  async streamChat(
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

class SlowLlmClient implements LlmClient {
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

class FailingLlmClient implements LlmClient {
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

class GatedLlmClient implements LlmClient {
  streamCallCount = 0;
  readonly gate = Promise.withResolvers<void>();

  async chat(): Promise<string> {
    return JSON.stringify({ items: [] });
  }

  async streamChat(
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
  const { app, shutdown } = await createApp({
    databasePath,
    skipLlmProbe: true,
    logger: options.logger,
    llmClient: options.llmClient,
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
  options: { logger?: Logger; llmClient?: LlmClient } = {}
) {
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

function parseNdjson<T>(payload: string): T[] {
  return payload
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
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

  await t.test("generated articles do not canonize a lowercase-first request path", async (t) => {
    const generatedServer = await createTestServer({
      seed: false,
      llmClient: new FixedArticleLlmClient([
        "# invertible sexuality theorem",
        "",
        "A foundational postulate about pleasure vectors.",
      ].join("\n")),
    });
    t.after(() => {
      rmSync(generatedServer.root, { recursive: true, force: true });
    });

    const res = await generatedServer.request("/api/page/invertible_sexuality_theorem");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);

    const packets = parseNdjson<Array<Record<string, unknown>>[number]>(await res.text());
    const done = packets.find((packet) => packet.type === "done");
    assert.ok(done);
    assert.equal(done.article.title, "Invertible sexuality theorem");
    assert.equal(done.article.markdown.startsWith("# Invertible sexuality theorem"), true);
    assert.equal(done.canonicalPath, "/wiki/Invertible_sexuality_theorem");
    assert.equal(done.redirectedFrom, "/wiki/invertible_sexuality_theorem");
  });

  await t.test("cached articles with lowercase-first titles are repaired before becoming canonical", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "halupedia-test-"));
    const databasePath = join(root, "halupedia.sqlite");
    const db = openDatabase(databasePath);
    const markdown = [
      "# invertible sexuality theorem",
      "",
      "A foundational postulate about pleasure vectors.",
    ].join("\n");

    saveArticle(
      db,
      {
        slug: "invertible-sexuality-theorem",
        canonicalSlug: "invertible-sexuality-theorem",
        title: "invertible sexuality theorem",
        markdown,
        html: renderMarkdown(markdown),
        plain_text: markdownToPlainText(markdown),
        generated_at: 1_715_000_000_100,
      },
      [],
      ["invertible-sexuality-theorem"]
    );
    db.close();

    const cachedServer = await createServerForDatabase(root, databasePath);
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const res = await cachedServer.request("/api/page/Invertible_sexuality_theorem");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const body = await res.json();
    assert.equal(body.cached, true);
    assert.equal(body.article.title, "Invertible sexuality theorem");
    assert.equal(body.article.markdown.startsWith("# Invertible sexuality theorem"), true);
    assert.equal(body.canonicalPath, "/wiki/Invertible_sexuality_theorem");
    assert.equal(body.redirectedFrom, undefined);
  });
});

test("client disconnect mid-generation still saves the article to DB", async (t) => {
  const llm = new SlowLlmClient(30);
  const server = await createTestServer({ seed: false, llmClient: llm });
  t.after(() => {
    rmSync(server.root, { recursive: true, force: true });
  });

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
  t.after(() => {
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
  t.after(() => {
    rmSync(server.root, { recursive: true, force: true });
  });

  const req1 = server.request("/api/page/Gated_Article");
  const req2 = server.request("/api/page/Gated_Article");

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(llm.streamCallCount, 1, "only one LLM stream should start for duplicate slug requests");

  llm.gate.resolve();
  const [res1, res2] = await Promise.all([req1, req2]);

  const text1 = await res1.text();
  const text2 = await res2.text();
  assert.match(text1, /"type":"done"/);
  const body2 = JSON.parse(text2);
  assert.equal(body2.cached, true);
  assert.equal(body2.article.slug, "gated-article");
});

test("failed generation releases the slug so a retry can succeed", async (t) => {
  let callCount = 0;
  const hybridLlm: LlmClient = {
    async chat() { return JSON.stringify({ items: [] }); },
    async streamChat(_s, _u, onChunk) {
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
  t.after(() => {
    rmSync(server.root, { recursive: true, force: true });
  });

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
  const llm: LlmClient = {
    async chat() {
      await postProcessGate.promise;
      return JSON.stringify({ items: [{ title: "Stub", hint: "stub" }] });
    },
    async streamChat(_s, _u, onChunk) {
      const content = "# Fresh Page\n\n**Fresh Page** is a test with [Alpha](halu:alpha \"Alpha hint\"), [Beta](halu:beta \"Beta hint\"), [Gamma](halu:gamma \"Gamma hint\"), [Delta](halu:delta \"Delta hint\"), and [Epsilon](halu:epsilon \"Epsilon hint\").";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createTestServer({ seed: false, llmClient: llm });
  t.after(() => {
    postProcessGate.resolve();
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
  const llm: LlmClient = {
    async chat() {
      await postProcessGate.promise;
      return JSON.stringify({ items: [{ title: "Stub", hint: "stub" }] });
    },
    async streamChat(_s, _u, onChunk) {
      const content = "# Test Entry\n\n**Test Entry** links to [Alpha](halu:alpha \"Alpha hint\"), [Beta](halu:beta \"Beta hint\"), [Gamma](halu:gamma \"Gamma hint\"), [Delta](halu:delta \"Delta hint\"), [Epsilon](halu:epsilon \"Epsilon hint\").";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createTestServer({ seed: false, llmClient: llm, logger });
  t.after(() => {
    postProcessGate.resolve();
    rmSync(server.root, { recursive: true, force: true });
  });

  const genRes = await server.request("/api/page/Test_Entry");
  await genRes.text();

  const secondRes = await server.request("/api/page/Test_Entry");
  const secondBody = await secondRes.json();
  assert.ok(secondBody.cached, "second request should be cache hit");

  const cacheMissEvents = logEntries.filter(
    (e) => e.event === "page.cache_miss" && e.fields?.slug === "test-entry"
  );
  assert.equal(cacheMissEvents.length, 1, "should only have one cache miss (the initial generation)");

  postProcessGate.resolve();
});

test("homepage returns instantly with featured article from DB without blocking on LLM", async (t) => {
  let chatCalled = false;
  const chatGate = Promise.withResolvers<void>();
  const llm: LlmClient = {
    async chat() {
      chatCalled = true;
      await chatGate.promise;
      return JSON.stringify({ items: [] });
    },
    async streamChat(_s, _u, onChunk) {
      const content = "# Stub\n\nStub body.";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createTestServer({ seed: true, llmClient: llm });
  t.after(() => {
    chatGate.resolve();
    rmSync(server.root, { recursive: true, force: true });
  });

  const res = await server.request("/api/homepage");
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(body.featured, "should always have a featured article when articles exist");
  assert.ok(body.featured.title, "featured article should have a title");
  assert.ok(body.featured.slug, "featured article should have a slug");
  assert.ok(body.featured.summaryMarkdown !== undefined, "featured article should have summaryMarkdown");
  assert.ok(Array.isArray(body.didYouKnow), "didYouKnow should be an array");
  chatGate.resolve();
});

test("homepage returns empty state when no articles exist", async (t) => {
  const server = await createTestServer({ seed: false });
  t.after(() => {
    rmSync(server.root, { recursive: true, force: true });
  });

  const res = await server.request("/api/homepage");
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.featured, null, "no featured when DB is empty");
  assert.deepEqual(body.didYouKnow, [], "no DYK when DB is empty");
});

test("homepage DYK populates after background generation completes", async (t) => {
  const dykResponse = JSON.stringify({
    items: [
      { fact: "the Glow Fruit emits a faint bioluminescent haze when submerged in vinegar" },
      { fact: "Halupedia was originally founded as a dispute resolution registry for fictional canal networks" },
    ],
  });
  const chatGate = Promise.withResolvers<void>();
  const llm: LlmClient = {
    async chat(_system, user) {
      if (user.includes("Did you know")) {
        await chatGate.promise;
        return dykResponse;
      }
      return JSON.stringify({ items: [] });
    },
    async streamChat(_s, _u, onChunk) {
      const content = "# Stub\n\nStub body.";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createTestServer({ seed: true, llmClient: llm });
  t.after(() => {
    rmSync(server.root, { recursive: true, force: true });
  });

  const res1 = await server.request("/api/homepage");
  const body1 = await res1.json();
  assert.ok(body1.featured, "featured article available immediately");

  chatGate.resolve();
  await new Promise((r) => setTimeout(r, 100));

  const res2 = await server.request("/api/homepage?refresh=1");
  const body2 = await res2.json();
  assert.ok(body2.didYouKnow.length > 0, "DYK should be populated after background generation");
  assert.ok(body2.didYouKnow[0].fact, "DYK items should have facts");
  assert.ok(body2.didYouKnow[0].slug, "DYK items should have slugs");
});

test("homepage handles DYK generation failure gracefully", async (t) => {
  const llm: LlmClient = {
    async chat() {
      throw new Error("LLM unavailable");
    },
    async streamChat(_s, _u, onChunk) {
      const content = "# Stub\n\nStub body.";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createTestServer({ seed: true, llmClient: llm });
  t.after(() => {
    rmSync(server.root, { recursive: true, force: true });
  });

  const res = await server.request("/api/homepage");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.featured, "featured article should still be present even when DYK fails");
  assert.deepEqual(body.didYouKnow, [], "DYK should be empty array on failure, not error");
});

test("homepage handles JSON wrapped in code fences from LLM", async (t) => {
  const fencedResponse = '```json\n' + JSON.stringify({
    items: [{ fact: "the earth is actually a hexagon" }],
  }) + '\n```';
  const chatGate = Promise.withResolvers<void>();
  let chatCalled = false;
  const llm: LlmClient = {
    async chat(_system, user) {
      if (user.includes("Did you know")) {
        chatCalled = true;
        await chatGate.promise;
        return fencedResponse;
      }
      return JSON.stringify({ items: [] });
    },
    async streamChat(_s, _u, onChunk) {
      const content = "# Stub\n\nStub body.";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createTestServer({ seed: true, llmClient: llm });
  t.after(() => {
    rmSync(server.root, { recursive: true, force: true });
  });

  await server.request("/api/homepage");
  chatGate.resolve();
  await new Promise((r) => setTimeout(r, 100));

  const res = await server.request("/api/homepage?refresh=1");
  const body = await res.json();
  assert.ok(chatCalled, "DYK background task should have called LLM");
  assert.ok(body.didYouKnow.length > 0, "should parse fenced JSON successfully");
  assert.equal(body.didYouKnow[0].fact, "the earth is actually a hexagon");
});
