import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getArticle, openDatabase, saveArticle } from "../src/server/db";
import { createApp } from "../src/server/index";
import type { LlmClient } from "../src/server/llm";
import { extractInternalLinks, markdownToPlainText, renderMarkdown } from "../src/server/markdown";
import { indexArticleChunks, retrieveContext } from "../src/server/retrieval";

class QueueLlmClient implements LlmClient {
  constructor(
    private readonly streamContent: string,
    private readonly chatResponses: string[] = []
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
    onChunk(this.streamContent, this.streamContent);
    return { content: this.streamContent, finishReason: "stop" };
  }

  async embed(input: string[]): Promise<number[][]> {
    return input.map(() => []);
  }

  async probeConnections(): Promise<void> {}
}

function createTempDbPath() {
  const root = mkdtempSync(join(tmpdir(), "halupedia-regression-"));
  return { root, databasePath: join(root, "halupedia.sqlite") };
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
    "Coal futures markets turn buried fuel trading into a ceremonial pricing bureaucracy organized around ash clerks and future-delivery rites."
  );
  assert.notEqual(
    done.article.summaryMarkdown,
    "Coal futures markets are complex, highly volatile financial instruments dedicated to pricing the future delivery of subterranean combustive resources."
  );
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

test("rewrite endpoint rejects generated body subject changes without mutating the stored article", async (t) => {
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
    "Maternal Energy Potential refers to a redirected concept that should not replace this article.",
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

  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error, "rewrite changed the article subject unexpectedly");

  const db = openDatabase(databasePath);
  const stored = getArticle(db, "energy-storage");
  const revisionCount = db
    .prepare(`SELECT count(*) AS count FROM article_revisions WHERE article_slug = ?`)
    .get("energy-storage") as { count: number };
  db.close();

  assert.ok(stored);
  assert.equal(stored.title, "Energy storage");
  assert.equal(stored.markdown, originalMarkdown);
  assert.equal(revisionCount.count, 1);
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
