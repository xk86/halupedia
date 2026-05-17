import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getArticle, openDatabase, saveArticle } from "../src/server/db";
import { loadConfig } from "../src/server/config";
import { createApp } from "../src/server/index";
import type { LlmClient } from "../src/server/llm";
import { extractInternalLinks, markdownToPlainText, renderMarkdown } from "../src/server/markdown";
import { indexArticleChunks, retrieveContext } from "../src/server/retrieval";

const TEST_CONFIG = loadConfig().app.tests;

class QueueLlmClient implements LlmClient {
  public streamedChunkCount = 0;

  constructor(
    private readonly streamContent: string,
    private readonly chatResponses: string[] = [],
    private readonly streamChunks?: string[]
  ) {}

  async chat(system?: string): Promise<string> {
    if (this.chatResponses.length) {
      return this.chatResponses.shift()!;
    }
    if ((system ?? "").includes("concise summary")) {
      return "Fallback summary for the article as a whole.";
    }
    return JSON.stringify({ items: [] });
  }

  async streamChat(
    _system: string,
    _user: string,
    onChunk: (delta: string, accumulated: string) => void
  ): Promise<{ content: string; finishReason: string }> {
    let accumulated = "";
    for (const delta of this.streamChunks ?? [this.streamContent]) {
      accumulated += delta;
      this.streamedChunkCount += 1;
      onChunk(delta, accumulated);
    }
    return { content: accumulated, finishReason: "stop" };
  }

  async embed(input: string[]): Promise<number[][]> {
    return input.map(() => []);
  }

  async probeConnections(): Promise<void> {}
}

class CapturingChatLlmClient implements LlmClient {
  public calls: Array<{ system?: string; user?: string }> = [];

  constructor(private readonly responses: string[]) {}

  async chat(system?: string, user?: string): Promise<string> {
    this.calls.push({ system, user });
    return this.responses.shift() ?? JSON.stringify({ items: [] });
  }

  async streamChat(
    _system: string,
    _user: string,
    onChunk: (delta: string, accumulated: string) => void
  ): Promise<{ content: string; finishReason: string }> {
    const content = "# Placeholder\n\nPlaceholder body.";
    onChunk(content, content);
    return { content, finishReason: "stop" };
  }

  async embed(input: string[]): Promise<number[][]> {
    return input.map(() => []);
  }

  async probeConnections(): Promise<void> {}
}

function createTempDbPath() {
  const root = mkdtempSync(join(tmpdir(), "halupedia-regression-"));
  return { root, databasePath: join(root, TEST_CONFIG.database_path) };
}

function saveMarkdownArticle(
  databasePath: string,
  article: {
    slug: string;
    title: string;
    markdown: string;
    generated_at?: number;
  }
) {
  const db = openDatabase(databasePath);
  const links = extractInternalLinks(article.markdown);
  saveArticle(
    db,
    {
      slug: article.slug,
      canonicalSlug: article.slug,
      title: article.title,
      markdown: article.markdown,
      html: renderMarkdown(article.markdown),
      plain_text: markdownToPlainText(article.markdown),
      generated_at: article.generated_at ?? Date.now(),
    },
    links,
    [article.slug]
  );
  db.close();
}

async function createServer(databasePath: string, llmClient: LlmClient) {
  const { app } = await createApp({
    databasePath,
    skipLlmProbe: true,
    skipHomepagePrepare: true,
    llmClient,
  });
  return {
    request: (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://halupedia.test${path}`, init)),
  };
}

test("inline TeX renders as math markup", () => {
  const html = renderMarkdown(
    "Cultural Dissipation Factor ($\\delta$): centralized systems may yield higher $\\delta$ readings."
  );
  assert.match(html, /class="[^"]*katex/);
  assert.match(html, /class="[^"]*math-inline/);
  assert.doesNotMatch(html, /<img/i);
});

test("admin summary regeneration accepts pasted wiki links and updates stored summary", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  saveMarkdownArticle(databasePath, {
    slug: "coal-futures-markets",
    title: "Coal futures markets",
    markdown: [
      "# Coal futures markets",
      "",
      "**Coal futures markets** are regulated ledgers for ceremonial fuel delivery.",
      "",
      "Their clearing houses track ash obligations and delayed industrial omens.",
    ].join("\n"),
  });

  const llm = new CapturingChatLlmClient([
    "A regenerated summary covers the market's ledgers, clearing houses, and ash obligations.",
  ]);
  const server = await createServer(databasePath, llm);
  const res = await server.request("/api/admin/regenerate-summary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slug: "https://anything.invalid/prefix/wiki/Coal_futures_markets?old=1",
    }),
  });

  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.article.slug, "coal-futures-markets");
  assert.equal(
    body.article.summaryMarkdown,
    "A regenerated summary covers the market's ledgers, clearing houses, and ash obligations.",
  );
  assert.match(llm.calls[0]?.system ?? "", /concise summary/);
  assert.match(llm.calls[0]?.user ?? "", /Coal futures markets/);

  const db = openDatabase(databasePath);
  const stored = getArticle(db, "coal-futures-markets");
  db.close();
  assert.equal(
    stored?.summaryMarkdown,
    "A regenerated summary covers the market's ledgers, clearing houses, and ash obligations.",
  );
});

test("admin summary regeneration accepts bare wiki paths", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  saveMarkdownArticle(databasePath, {
    slug: "corvid-scouts-of-armenia",
    title: "Corvid scouts of Armenia",
    markdown: [
      "# Corvid scouts of Armenia",
      "",
      "**Corvid scouts of Armenia** are field observers for contested mountain postal routes.",
    ].join("\n"),
  });

  const llm = new CapturingChatLlmClient([
    "A regenerated summary covers Armenian corvid scouts and their postal-route observations.",
  ]);
  const server = await createServer(databasePath, llm);
  const res = await server.request("/api/admin/regenerate-summary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: "wiki/Corvid_scouts_of_Armenia" }),
  });

  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.article.slug, "corvid-scouts-of-armenia");
  assert.equal(
    body.article.summaryMarkdown,
    "A regenerated summary covers Armenian corvid scouts and their postal-route observations.",
  );
});

test("random page endpoint asks the model for one wiki path and normalizes redirects", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new CapturingChatLlmClient(["wiki/night soil tariff"]);
  const server = await createServer(databasePath, llm);
  const res = await server.request("/api/random-page");

  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.path, "/wiki/Night_soil_tariff");
  assert.match(llm.calls[0]?.system ?? "", /single random Halupedia article URL/);
});

test("retrieveContext works with joined article lookups when RAG is enabled", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = openDatabase(databasePath);
  const sourceMarkdown = [
    "# Source Topic",
    "",
    "A cultural narrative with stable energetic exchange and centralized belief systems.",
  ].join("\n");
  saveArticle(
    db,
    {
      slug: "source-topic",
      canonicalSlug: "source-topic",
      title: "Source Topic",
      markdown: sourceMarkdown,
      html: renderMarkdown(sourceMarkdown),
      plain_text: markdownToPlainText(sourceMarkdown),
      generated_at: Date.now(),
    },
    [],
    ["source-topic"]
  );
  await indexArticleChunks(db, new QueueLlmClient(""), "source-topic", sourceMarkdown, false, 500);

  const packet = await retrieveContext(
    db,
    new QueueLlmClient(""),
    "query-topic",
    ["centralized belief systems"],
    true,
    "full",
    4,
    0.2,
    false
  );
  db.close();

  assert.equal(packet.sourceArticles.length, 1);
  assert.equal(packet.sourceArticles[0].title, "Source Topic");
  assert.match(packet.context, /Source Topic/);
});

test("retrieveContext drops low-relevance matches below the configured score threshold", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = openDatabase(databasePath);
  const sourceMarkdown = ["# Distant Topic", "", "This article only discusses municipal varnishes and harbor brickwork."].join("\n");
  saveArticle(
    db,
    {
      slug: "distant-topic",
      canonicalSlug: "distant-topic",
      title: "Distant Topic",
      markdown: sourceMarkdown,
      html: renderMarkdown(sourceMarkdown),
      plain_text: markdownToPlainText(sourceMarkdown),
      generated_at: Date.now(),
    },
    [],
    ["distant-topic"]
  );
  await indexArticleChunks(db, new QueueLlmClient(""), "distant-topic", sourceMarkdown, false, 500);

  const packet = await retrieveContext(
    db,
    new QueueLlmClient(""),
    "query-topic",
    ["cultural narrative stable energetic exchange"],
    true,
    4,
    0.6,
    false
  );
  db.close();

  assert.equal(packet.sourceArticles.length, 0);
  assert.equal(packet.context, "");
});

test("article generation succeeds even when the body contains zero internal links", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new QueueLlmClient(
    ["# Plain Page", "", "This article has no internal links at all."].join("\n"),
    [JSON.stringify({ items: [] })]
  );
  const server = await createServer(databasePath, llm);
  const res = await server.request("/api/page/Plain_Page");

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);

  const payload = await res.text();
  assert.match(payload, /"type":"done"/);
  assert.doesNotMatch(payload, /"type":"error"/);
});

test("generated articles store an actual summary instead of the opening paragraph", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const body = [
    "# Coal futures markets",
    "",
    "Coal futures markets are complex, highly volatile financial instruments dedicated to pricing the future delivery of subterranean combustive resources.",
    "",
    "Their exchanges are run by ash clerks, delayed furnace indices, and regional reserve ceremonies.",
  ].join("\n");
  const llm = new QueueLlmClient(body, [
    JSON.stringify({ items: [] }),
    "Coal futures markets turn buried fuel trading into a ceremonial pricing bureaucracy organized around ash clerks and future-delivery rites.",
  ]);
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/page/Coal_futures_markets");
  assert.equal(res.status, 200);
  const events = (await res.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const done = events.find((event) => event.type === "done");
  assert.ok(done);
  assert.equal(
    done.article.summaryMarkdown,
    "Coal futures markets are complex, highly volatile financial instruments dedicated to pricing the future delivery of subterranean combustive resources."
  );

  let cachedSummary = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const cachedRes = await server.request("/api/page/Coal_futures_markets");
    assert.equal(cachedRes.status, 200);
    const cached = await cachedRes.json();
    cachedSummary = cached.article.summaryMarkdown;
    if (cachedSummary === "Coal futures markets turn buried fuel trading into a ceremonial pricing bureaucracy organized around ash clerks and future-delivery rites.") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    cachedSummary,
    "Coal futures markets turn buried fuel trading into a ceremonial pricing bureaucracy organized around ash clerks and future-delivery rites."
  );
});

test("retrieveContext logs matched articles in descending relevance order", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = openDatabase(databasePath);
  const entries: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    debug(event: string, fields?: Record<string, unknown>) {
      entries.push({ event, fields });
    },
    info(event: string, fields?: Record<string, unknown>) {
      entries.push({ event, fields });
    },
    warn(event: string, fields?: Record<string, unknown>) {
      entries.push({ event, fields });
    },
    error(event: string, fields?: Record<string, unknown>) {
      entries.push({ event, fields });
    },
  };
  const saveSeed = (slug: string, title: string, markdown: string) => {
    saveArticle(
      db,
      {
        slug,
        canonicalSlug: slug,
        title,
        markdown,
        html: renderMarkdown(markdown),
        plain_text: markdownToPlainText(markdown),
        generated_at: Date.now(),
      },
      [],
      [slug]
    );
  };

  saveSeed("alpha-topic", "Alpha Topic", "# Alpha Topic\n\nAlpha beta gamma delta archive.");
  saveSeed("beta-topic", "Beta Topic", "# Beta Topic\n\nAlpha beta archive.");
  await indexArticleChunks(db, new QueueLlmClient(""), "alpha-topic", "# Alpha Topic\n\nAlpha beta gamma delta archive.", false, 500);
  await indexArticleChunks(db, new QueueLlmClient(""), "beta-topic", "# Beta Topic\n\nAlpha beta archive.", false, 500);

  await retrieveContext(
    db,
    new QueueLlmClient(""),
    "query-topic",
    ["alpha beta gamma delta archive"],
    true,
    "full",
    4,
    0.2,
    false,
    logger
  );
  db.close();

  const retrieveLog = entries.find((entry) => entry.event === "rag.retrieve_complete");
  assert.match(String(retrieveLog?.fields?.matched_articles), /^alpha-topic \([0-9.]+\), beta-topic \([0-9.]+\)$/);
});

test("add-link refines oversized selections before wrapping markdown", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const markdown = [
    "# Aetheric index",
    "",
    "3. Cultural Dissipation Factor ($\\delta$): This is perhaps the most abstract measurement, quantifying the degree to which recorded cultural narratives or belief systems generate a predictable, stable pattern of energetic exchange. Highly centralized belief systems tend to yield higher, though sometimes unstable, $\\delta$ readings.",
  ].join("\n");
  saveMarkdownArticle(databasePath, {
    slug: "aetheric-index",
    title: "Aetheric index",
    markdown,
  });

  const llm = new QueueLlmClient("", [
    JSON.stringify({ selected_text: "Cultural Dissipation Factor" }),
    JSON.stringify({
      title: "Cultural Dissipation Factor",
      hint: "measure of stable energetic exchange in recorded belief systems",
    }),
  ]);
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/article/Aetheric_index/add-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      selectedText:
        "Cultural Dissipation Factor ($\\delta$): This is perhaps the most abstract measurement, quantifying the degree to which recorded cultural narratives or belief systems generate a predictable, stable pattern of energetic exchange.",
    }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(
    body.article.markdown,
    /\[Cultural Dissipation Factor\]\(halu:cultural-dissipation-factor "measure of stable energetic exchange in recorded belief systems"\) \(\$\\delta\$\):/
  );
  assert.doesNotMatch(
    body.article.markdown,
    /\[Cultural Dissipation Factor \(\$\\delta\$\): This is perhaps the most abstract measurement/
  );
});

test("rewrite endpoint applies user instructions and preserves the article title", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const markdown = [
    "# San Francisco",
    "",
    "San Francisco is a quiet administrative district known for fog registries.",
  ].join("\n");
  saveMarkdownArticle(databasePath, {
    slug: "san-francisco",
    title: "San Francisco",
    markdown,
  });

  const rewritten = [
    "# San Francisco",
    "",
    "San Francisco is a quiet administrative district known for fog registries and an elaborate municipal weather bureau.",
  ].join("\n");
  const llm = new QueueLlmClient("", [rewritten, JSON.stringify({ items: [] })]);
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/article/San_Francisco/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instructions: "Add a brief note about the municipal weather bureau and keep the tone dry.",
    }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.article.title, "San Francisco");
  assert.match(body.article.markdown, /municipal weather bureau/);
});

test("rewrite endpoint saves even when lead subject diverges from title", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const originalMarkdown = [
    "# Energy storage",
    "",
    "Energy storage is the practice of retaining usable energy for later deployment.",
  ].join("\n");
  saveMarkdownArticle(databasePath, {
    slug: "energy-storage",
    title: "Energy storage",
    markdown: originalMarkdown,
  });

  const bodyRenamedRewrite = [
    "# Energy storage",
    "",
    "Maternal Energy Potential refers to a redirected concept.",
  ].join("\n");
  const llm = new QueueLlmClient("", [bodyRenamedRewrite, JSON.stringify({ items: [] })]);
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/article/Energy_storage/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instructions: "make this article to be about your mom",
    }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.article);

  const db = openDatabase(databasePath);
  const stored = getArticle(db, "energy-storage");
  db.close();

  assert.ok(stored);
  assert.match(stored!.markdown, /Maternal Energy Potential/);
});

test("streaming rewrite saves even when lead subject diverges from title", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const originalMarkdown = [
    "# Energy storage",
    "",
    "Energy storage is the practice of retaining usable energy for later deployment.",
  ].join("\n");
  saveMarkdownArticle(databasePath, {
    slug: "energy-storage",
    title: "Energy storage",
    markdown: originalMarkdown,
  });

  const llm = new QueueLlmClient(
    "",
    [JSON.stringify({ items: [] })],
    [
      "# Energy storage\n\nMaternal Energy Potential refers to",
      " a redirected concept.",
    ]
  );
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/article/Energy_storage/rewrite?stream=1", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify({
      instructions: "make this article to be about your mom",
    }),
  });

  assert.equal(res.status, 200);
  const events = (await res.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  const types = events.map((event: { type: string }) => event.type);
  assert.ok(types.includes("done"), "rewrite should complete successfully");

  const db = openDatabase(databasePath);
  const stored = getArticle(db, "energy-storage");
  db.close();

  assert.ok(stored);
  assert.match(stored.markdown, /Maternal Energy Potential/);
});

test("section rewrite streams only the selected section and records revertable history", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const markdown = [
    "# Clock Orchard",
    "",
    "Clock Orchard has a dry introductory paragraph.",
    "",
    "## History",
    "",
    "The orchard originally counted minutes with brass ladders.",
    "",
    "## Layout",
    "",
    "The orchard is arranged in narrow rows.",
  ].join("\n");
  saveMarkdownArticle(databasePath, {
    slug: "clock-orchard",
    title: "Clock Orchard",
    markdown,
  });

  const rewrittenHistory = [
    "## History",
    "",
    "The orchard originally counted minutes with brass ladders and a municipal bell ledger.",
  ].join("\n");
  const llm = new QueueLlmClient(rewrittenHistory, [JSON.stringify({ items: [] })]);
  const server = await createServer(databasePath, llm);

  const rewriteRes = await server.request("/api/article/Clock_Orchard/rewrite?stream=1", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify({
      sectionId: "history",
      instructions: "Add the municipal bell ledger to the history section.",
    }),
  });
  assert.equal(rewriteRes.status, 200);
  assert.match(rewriteRes.headers.get("content-type") ?? "", /application\/x-ndjson/);
  const events = (await rewriteRes.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "progress" && event.markdown.includes("municipal bell ledger")));
  const done = events.find((event) => event.type === "done");
  assert.ok(done);
  assert.match(done.article.markdown, /municipal bell ledger/);
  assert.match(done.article.markdown, /Clock Orchard has a dry introductory paragraph/);
  assert.match(done.article.markdown, /The orchard is arranged in narrow rows/);
  assert.equal(done.sections.some((section: { id: string }) => section.id === "history"), true);

  const historyRes = await server.request("/api/article/Clock_Orchard/history");
  assert.equal(historyRes.status, 200);
  const history = await historyRes.json();
  assert.equal(history.revisions[0].operation, "section-rewrite");
  assert.equal(history.revisions[1].operation, "update");

  const revertRes = await server.request("/api/article/Clock_Orchard/revert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revisionId: history.revisions[1].id }),
  });
  assert.equal(revertRes.status, 200);
  const reverted = await revertRes.json();
  assert.doesNotMatch(reverted.article.markdown, /municipal bell ledger/);
  assert.match(reverted.article.markdown, /brass ladders/);
});

test("refresh-context reports when references are already current", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const markdown = [
    "# Stable Page",
    "",
    "Stable Page has a body that does not need derived reference changes.",
  ].join("\n");
  saveMarkdownArticle(databasePath, {
    slug: "stable-page",
    title: "Stable Page",
    markdown,
  });

  const server = await createServer(databasePath, new QueueLlmClient("", [JSON.stringify({ items: [] })]));
  const res = await server.request("/api/article/Stable_Page/refresh-context", {
    method: "POST",
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.refreshChanged, false);
  assert.equal(body.article.markdown, markdown);
});

test("refresh-context can rewrite from retrieved context", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = openDatabase(databasePath);
  const sourceMarkdown = [
    "# Ledger Source",
    "",
    "The archived ledger says the algebra office stores commas in copper drawers.",
  ].join("\n");
  saveArticle(
    db,
    {
      slug: "ledger-source",
      canonicalSlug: "ledger-source",
      title: "Ledger Source",
      markdown: sourceMarkdown,
      html: renderMarkdown(sourceMarkdown),
      plain_text: markdownToPlainText(sourceMarkdown),
      generated_at: Date.now(),
    },
    [
      {
        targetSlug: "algebra",
        visibleLabel: "Algebra",
        hiddenHint: "copper drawers archived ledger",
      },
    ],
    ["ledger-source"]
  );
  await indexArticleChunks(db, new QueueLlmClient(""), "ledger-source", sourceMarkdown, false, 500);

  const targetMarkdown = ["# Algebra", "", "Algebra is a bureau for arranging letters."].join("\n");
  saveArticle(
    db,
    {
      slug: "algebra",
      canonicalSlug: "algebra",
      title: "Algebra",
      markdown: targetMarkdown,
      html: renderMarkdown(targetMarkdown),
      plain_text: markdownToPlainText(targetMarkdown),
      generated_at: Date.now(),
    },
    [],
    ["algebra"]
  );
  db.close();

  const refreshed = [
    "# Algebra",
    "",
    "Algebra is a bureau for arranging letters and storing commas in copper drawers.",
  ].join("\n");
  const server = await createServer(databasePath, new QueueLlmClient("", [refreshed, JSON.stringify({ items: [] })]));
  const res = await server.request("/api/article/Algebra/refresh-context", {
    method: "POST",
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.refreshChanged, true);
  assert.match(body.article.markdown, /copper drawers/);
});

test("self-links are stripped from generated articles", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const body = [
    "# Fog Registry",
    "",
    '**Fog Registry** is a [Fog Registry](halu:fog-registry "self link") that tracks [municipal fog](halu:municipal-fog "fog classification system") patterns.',
  ].join("\n");
  const llm = new QueueLlmClient(body, [
    JSON.stringify({ items: [] }),
    "Fog Registry tracks municipal fog patterns.",
  ]);
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/page/Fog_Registry");
  assert.equal(res.status, 200);
  const events = (await res.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const done = events.find((event) => event.type === "done");
  assert.ok(done);
  assert.doesNotMatch(done.article.markdown, /\(halu:fog-registry/);
  assert.match(done.article.markdown, /\(halu:municipal-fog/);
  assert.match(done.article.markdown, /is a Fog Registry that tracks/);
});

test("disambiguation pages can be created and retrieved via API", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const server = await createServer(databasePath, new QueueLlmClient("", []));

  const createRes = await server.request("/api/disambiguation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Mercury",
      entries: [
        { title: "Mercury (planet)", description: "The smallest planet in the solar system" },
        { title: "Mercury (element)", description: "A liquid metal also known as quicksilver" },
        { title: "Mercury (mythology)", description: "Roman messenger god" },
      ],
    }),
  });
  assert.equal(createRes.status, 200);
  const created = await createRes.json();
  assert.equal(created.article.isDisambiguation, true);
  assert.match(created.article.title, /disambiguation/);
  assert.match(created.article.markdown, /\(halu:mercury-planet/);
  assert.match(created.article.markdown, /\(halu:mercury-element/);
  assert.match(created.article.markdown, /\(halu:mercury-mythology/);

  const getRes = await server.request("/api/disambiguation/Mercury");
  assert.equal(getRes.status, 200);
  const fetched = await getRes.json();
  assert.equal(fetched.article.isDisambiguation, true);
});

test("disambiguation API rejects fewer than 2 entries", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const server = await createServer(databasePath, new QueueLlmClient("", []));
  const res = await server.request("/api/disambiguation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Solo",
      entries: [{ title: "Solo (film)", description: "A space western" }],
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "at least 2 entries required");
});
