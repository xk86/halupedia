import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, saveArticle } from "../src/server/db";
import { createApp } from "../src/server/index";
import type { LlmClient } from "../src/server/llm";
import { extractInternalLinks, markdownToPlainText, renderMarkdown } from "../src/server/markdown";
import { indexArticleChunks, retrieveContext } from "../src/server/retrieval";

class QueueLlmClient implements LlmClient {
  constructor(
    private readonly streamContent: string,
    private readonly chatResponses: string[] = []
  ) {}

  async chat(): Promise<string> {
    return this.chatResponses.shift() ?? JSON.stringify({ items: [] });
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
  assert.match(html, /<span class="math-inline">δ<\/span>/);
  assert.doesNotMatch(html, /\\delta/);
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
    false
  );
  db.close();

  assert.equal(packet.sourceArticles.length, 1);
  assert.equal(packet.sourceArticles[0].title, "Source Topic");
  assert.match(packet.context, /Source Topic/);
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
