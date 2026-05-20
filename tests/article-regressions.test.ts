import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getArticle, getLatestArticleReferences, listArticleRevisions, openDatabase, saveArticle, saveArticleReferences } from "../src/server/db";
import { loadConfig } from "../src/server/config";
import { createApp } from "../src/server/index";
import { OpenAICompatClient, type LlmClient } from "../src/server/llm";
import {
  extractInternalLinks,
  markdownToPlainText,
  renderMarkdown,
} from "../src/server/markdown";
import { indexArticleChunks, retrieveContext } from "../src/server/retrieval";

const TEST_CONFIG = loadConfig().app.tests;

class QueueLlmClient implements LlmClient {
  public streamedChunkCount = 0;
  public embedInputs: string[][] = [];

  constructor(
    private readonly streamContent: string,
    private readonly chatResponses: string[] = [],
    private readonly streamChunks?: string[],
    private readonly embedVector: number[] = [],
  ) {}

  async chat(system?: string, user?: string): Promise<string> {
    const promptText = `${system ?? ""}\n${user ?? ""}`;
    const structuredBody = this.streamContent || this.streamChunks?.join("") || "";
    if (structuredBody && promptText.includes("---halu-body")) {
      return `---halu-body\n${structuredBody}\n---halu-used-refs\n[]`;
    }
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
    onChunk: (delta: string, accumulated: string) => void,
  ): Promise<{ content: string; finishReason: string }> {
    const chunks = this.streamChunks ?? [this.streamContent];
    // Wrap article body chunks in the frame format
    const header = "---halu-body\n";
    const footer = "\n---halu-used-refs\n[]";
    const framedChunks = [header + chunks[0], ...chunks.slice(1), footer];
    let accumulated = "";
    for (const delta of framedChunks) {
      accumulated += delta;
      this.streamedChunkCount += 1;
      onChunk(delta, accumulated);
    }
    return { content: accumulated, finishReason: "stop" };
  }

  async embed(input: string[]): Promise<number[][]> {
    this.embedInputs.push(input);
    return input.map(() => this.embedVector);
  }

  async probeConnections(): Promise<void> {}
}

class CapturingChatLlmClient implements LlmClient {
  public calls: Array<{ system?: string; user?: string }> = [];
  public embedInputs: string[][] = [];

  constructor(private readonly responses: string[]) {}

  async chat(system?: string, user?: string): Promise<string> {
    this.calls.push({ system, user });
    return this.responses.shift() ?? JSON.stringify({ items: [] });
  }

  async streamChat(
    _system: string,
    _user: string,
    onChunk: (delta: string, accumulated: string) => void,
  ): Promise<{ content: string; finishReason: string }> {
    const content = "# Placeholder\n\nPlaceholder body.";
    onChunk(content, content);
    return { content, finishReason: "stop" };
  }

  async embed(input: string[]): Promise<number[][]> {
    this.embedInputs.push(input);
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
  },
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
    [article.slug],
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

function parseNdjson<T>(payload: string): T[] {
  return payload.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

test("inline TeX renders as math markup", () => {
  const html = renderMarkdown(
    "Cultural Dissipation Factor ($\\delta$): centralized systems may yield higher $\\delta$ readings.",
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
  const beforeDb = openDatabase(databasePath);
  const beforeArticle = getArticle(beforeDb, "coal-futures-markets");
  const beforeRevisions = listArticleRevisions(beforeDb, "coal-futures-markets");
  beforeDb.close();
  assert.ok(beforeArticle);

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
  const body = (await res.json()) as any;
  assert.equal(body.article.slug, "coal-futures-markets");
  assert.equal(
    body.article.summaryMarkdown,
    "A regenerated summary covers the market's ledgers, clearing houses, and ash obligations.",
  );
  assert.match(llm.calls[0]?.system ?? "", /concise summary/);
  assert.match(llm.calls[0]?.user ?? "", /Coal futures markets/);

  const db = openDatabase(databasePath);
  const stored = getArticle(db, "coal-futures-markets");
  const afterRevisions = listArticleRevisions(db, "coal-futures-markets");
  db.close();
  assert.equal(
    stored?.summaryMarkdown,
    "A regenerated summary covers the market's ledgers, clearing houses, and ash obligations.",
  );
  assert.equal(stored?.markdown, beforeArticle.markdown);
  assert.equal(stored?.html, beforeArticle.html);
  assert.equal(stored?.plain_text, beforeArticle.plain_text);
  assert.equal(stored?.generated_at, beforeArticle.generated_at);
  assert.equal(afterRevisions.length, beforeRevisions.length);
  assert.equal(afterRevisions[0]?.operation, beforeRevisions[0]?.operation);
  assert.equal(
    afterRevisions[0]?.summaryMarkdown,
    "A regenerated summary covers the market's ledgers, clearing houses, and ash obligations.",
  );
  assert.equal(afterRevisions[0]?.markdown, beforeRevisions[0]?.markdown);
});

test("admin summary regeneration accepts bare wiki paths", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  saveMarkdownArticle(databasePath, {
    slug: "archive-scouts",
    title: "Archive scouts",
    markdown: [
      "# Archive scouts",
      "",
      "**Archive scouts** are field observers for contested mountain postal routes.",
    ].join("\n"),
  });

  const llm = new CapturingChatLlmClient([
    "A regenerated summary covers archive scouts and their postal-route observations.",
  ]);
  const server = await createServer(databasePath, llm);
  const res = await server.request("/api/admin/regenerate-summary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: "wiki/Archive_scouts" }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.article.slug, "archive-scouts");
  assert.equal(
    body.article.summaryMarkdown,
    "A regenerated summary covers archive scouts and their postal-route observations.",
  );
});

test("random page endpoint preserves model title and slug separately", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new CapturingChatLlmClient([
    JSON.stringify({ title: "Ledger Tariff", slug: "ledger-tariff" }),
  ]);
  const server = await createServer(databasePath, llm);
  const res = await server.request("/api/random-page");

  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.path, "/wiki/Ledger_tariff");
  assert.equal(body.slug, "ledger-tariff");
  assert.equal(body.title, "Ledger Tariff");
});

test("random page endpoint does not expose the internal dashed slug as the wiki URL", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new CapturingChatLlmClient([
    JSON.stringify({
      title: "Archive rotation protocol",
      slug: "archive-rotation-protocol",
    }),
  ]);
  const server = await createServer(databasePath, llm);
  const res = await server.request("/api/random-page");

  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(
    body.path,
    "/wiki/Archive_rotation_protocol",
  );
  assert.doesNotMatch(body.path, /\/wiki\/archive-rotation-protocol/);
});

test("random page endpoint repairs slug-shaped model titles", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new CapturingChatLlmClient([
    JSON.stringify({
      title: "archive-rotation-mechanics-protocol",
      slug: "archive-rotation-mechanics-protocol",
    }),
  ]);
  const server = await createServer(databasePath, llm);
  const res = await server.request("/api/random-page");

  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.title, "Archive rotation mechanics protocol");
  assert.equal(body.slug, "archive-rotation-mechanics-protocol");
  assert.equal(
    body.path,
    "/wiki/Archive_rotation_mechanics_protocol",
  );
});

test("random page endpoint repairs plain wiki path model responses", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new CapturingChatLlmClient(["/wiki/archive-rotation-mechanics-protocol"]);
  const server = await createServer(databasePath, llm);
  const res = await server.request("/api/random-page");

  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.title, "Archive rotation mechanics protocol");
  assert.equal(body.slug, "archive-rotation-mechanics-protocol");
  assert.equal(
    body.path,
    "/wiki/Archive_rotation_mechanics_protocol",
  );
});

test("random page inspiration count comes from app config", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (let i = 1; i <= 15; i++) {
    saveMarkdownArticle(databasePath, {
      slug: `seed-${i}`,
      title: `Seed ${i}`,
      markdown: `# Seed ${i}\n\nSeed article ${i}.`,
      generated_at: 1_715_000_000_000 + i,
    });
  }

  const llm = new CapturingChatLlmClient([
    JSON.stringify({ title: "Adjacent Seed", slug: "adjacent-seed" }),
  ]);
  const server = await createServer(databasePath, llm);
  const res = await server.request("/api/random-page");

  assert.equal(res.status, 200);
  const userPrompt = llm.calls[0]?.user ?? "";
  const presented = userPrompt
    .split("\n")
    .filter((line) => line.startsWith("- Seed "));
  assert.equal(presented.length, 12);
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
    ["source-topic"],
  );
  await indexArticleChunks(
    db,
    new QueueLlmClient(""),
    "source-topic",
    sourceMarkdown,
    false,
    500,
  );

  const packet = await retrieveContext(
    db,
    new QueueLlmClient(""),
    "query-topic",
    ["centralized belief systems"],
    true,
    "full",
    4,
    0.2,
    false,
  );
  db.close();

  assert.equal(packet.sourceArticles.length, 1);
  assert.equal(packet.sourceArticles[0].title, "Source Topic");
  assert.match(packet.context, /Source Topic/);
});

test("generated article persists declared and body-linked refs, not every prompt ref", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const [slug, title] of [
    ["source-a", "Source A"],
    ["source-b", "Source B"],
    ["source-c", "Source C"],
  ] as const) {
    saveMarkdownArticle(databasePath, {
      slug,
      title,
      markdown: `# ${title}\n\n[Target Page](halu:target-page "source context").`,
    });
  }

  const llm = new QueueLlmClient(
    "# Target Page\n\nUses [Source A](ref:source-a) and [Source B](ref:source-b).",
    [JSON.stringify({ items: [] }), "Target summary."],
  );
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/page/Target_Page?stream=1");
  assert.equal(res.status, 200);
  const packets = parseNdjson<Record<string, unknown>>(await res.text());
  assert.ok(packets.some((packet) => packet.type === "done"), "generation should finish");

  const db = openDatabase(databasePath);
  const refs = getLatestArticleReferences(db, "target-page").map((ref) => ref.slug);
  const revisions = listArticleRevisions(db, "target-page");
  db.close();
  assert.deepEqual(refs.sort(), ["source-a", "source-b"]);
  assert.equal(revisions[0]?.operation, "generate");
});

test("new article generation searches RAG with the requested title even without backlinks", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  saveMarkdownArticle(databasePath, {
    slug: "source-topic",
    title: "Source Topic",
    markdown: "# Source Topic\n\nSource material about target page optimization.",
  });
  const db = openDatabase(databasePath);
  db.prepare(
    `INSERT INTO article_chunks (slug, chunk_index, content, embedding_json)
     VALUES (?, ?, ?, ?)`,
  ).run("source-topic", 0, "Source material about target page optimization.", "[1]");
  db.close();

  const llm = new QueueLlmClient(
    "# Target Page\n\nUses [Source Topic](ref:source-topic).",
    [JSON.stringify({ items: [] }), "Target summary."],
    undefined,
    [1],
  );
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/page/Target_Page?stream=1");
  assert.equal(res.status, 200);
  const packets = parseNdjson<Record<string, unknown>>(await res.text());
  assert.ok(packets.some((packet) => packet.type === "done"), "generation should finish");

  const checkDb = openDatabase(databasePath);
  const refs = getLatestArticleReferences(checkDb, "target-page").map((ref) => ref.slug);
  checkDb.close();
  assert.deepEqual(refs, ["source-topic"]);
  assert.match(llm.embedInputs[0]?.[0] ?? "", /Target Page/);
  assert.match(llm.embedInputs[0]?.[0] ?? "", /target-page/);
});

test("refresh rewrite prunes unused prior prompt refs from the saved sidecar", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const [slug, title] of [
    ["source-a", "Source A"],
    ["source-b", "Source B"],
    ["source-c", "Source C"],
  ] as const) {
    saveMarkdownArticle(databasePath, {
      slug,
      title,
      markdown: `# ${title}\n\n[Target Page](halu:target-page "source context").`,
    });
  }
  saveMarkdownArticle(databasePath, {
    slug: "target-page",
    title: "Target Page",
    markdown: "# Target Page\n\nOriginal body.",
  });

  const db = openDatabase(databasePath);
  db.prepare(
    `INSERT INTO article_chunks (slug, chunk_index, content, embedding_json)
     VALUES (?, ?, ?, ?)`,
  ).run("source-a", 0, "A source chunk about the original body.", "[]");
  saveArticleReferences(db, "target-page", Date.now(), [
    { slug: "source-a", title: "Source A", content: "", kind: "summary", pinned: false, revisionId: "current" },
    { slug: "source-b", title: "Source B", content: "", kind: "summary", pinned: false, revisionId: "current" },
    { slug: "source-c", title: "Source C", content: "", kind: "summary", pinned: false, revisionId: "current" },
  ]);
  db.close();

  const llm = new QueueLlmClient(
    "# Target Page\n\nRefreshed with [Source A](ref:source-a) and [Source B](ref:source-b).",
    [],
  );
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/article/Target_Page/refresh-context", { method: "POST" });
  assert.equal(res.status, 200);

  const checkDb = openDatabase(databasePath);
  const refs = getLatestArticleReferences(checkDb, "target-page").map((ref) => ref.slug);
  const revisions = listArticleRevisions(checkDb, "target-page");
  checkDb.close();
  assert.deepEqual(refs.sort(), ["source-a", "source-b"]);
  assert.equal(revisions[0]?.operation, "refresh-context-rewrite");
  assert.match(llm.embedInputs[0]?.[0] ?? "", /Target Page/);
  assert.match(llm.embedInputs[0]?.[0] ?? "", /Original body/);
});

test("refresh rewrite rejects truncated structured output without saving a revision", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  saveMarkdownArticle(databasePath, {
    slug: "source-a",
    title: "Source A",
    markdown: '# Source A\n\n[Target Page](halu:target-page "source context").',
  });
  saveMarkdownArticle(databasePath, {
    slug: "target-page",
    title: "Target Page",
    markdown: "# Target Page\n\nOriginal body stays intact.",
  });

  const beforeDb = openDatabase(databasePath);
  const beforeArticle = getArticle(beforeDb, "target-page");
  const beforeRevisions = listArticleRevisions(beforeDb, "target-page");
  beforeDb.close();
  assert.ok(beforeArticle);

  // Response with no body section → missing-body → invalid structured output
  const llm = new QueueLlmClient("", [
    "---halu-used-refs\n[\"source-a\"]",
  ]);
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/article/Target_Page/refresh-context", { method: "POST" });
  assert.equal(res.status, 500);
  const error = await res.json() as { error?: string };
  assert.match(error.error ?? "", /invalid structured output/);

  const checkDb = openDatabase(databasePath);
  const afterArticle = getArticle(checkDb, "target-page");
  const afterRevisions = listArticleRevisions(checkDb, "target-page");
  checkDb.close();
  assert.equal(afterArticle?.markdown, beforeArticle.markdown);
  assert.equal(afterArticle?.html, beforeArticle.html);
  assert.equal(afterArticle?.plain_text, beforeArticle.plain_text);
  assert.equal(afterArticle?.generated_at, beforeArticle.generated_at);
  assert.equal(afterRevisions.length, beforeRevisions.length);
  assert.deepEqual(
    afterRevisions.map((revision) => revision.operation),
    beforeRevisions.map((revision) => revision.operation),
  );
});

test("retrieveContext drops low-relevance matches below the configured score threshold", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = openDatabase(databasePath);
  const sourceMarkdown = [
    "# Distant Topic",
    "",
    "This article only discusses municipal varnishes and harbor brickwork.",
  ].join("\n");
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
    ["distant-topic"],
  );
  await indexArticleChunks(
    db,
    new QueueLlmClient(""),
    "distant-topic",
    sourceMarkdown,
    false,
    500,
  );

  const packet = await retrieveContext(
    db,
    new QueueLlmClient(""),
    "query-topic",
    ["cultural narrative stable energetic exchange"],
    true,
    4,
    0.6,
    false,
  );
  db.close();

  assert.equal(packet.sourceArticles.length, 0);
  assert.equal(packet.context, "");
});

test("article generation succeeds even when the body contains zero internal links", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new QueueLlmClient(
    ["# Plain Page", "", "This article has no internal links at all."].join(
      "\n",
    ),
    [JSON.stringify({ items: [] })],
  );
  const server = await createServer(databasePath, llm);
  const res = await server.request("/api/page/Plain_Page");

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);

  const payload = await res.text();
  assert.match(payload, /"type":"done"/);
  assert.doesNotMatch(payload, /"type":"error"/);
});

test("generated formatted slug headings do not override the requested title", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new QueueLlmClient(
    [
      "# *archive-rotation-protocol*",
      "",
      "**archive-rotation-protocol** is a malformed heading that should not win.",
    ].join("\n"),
    [JSON.stringify({ items: [] })],
  );
  const server = await createServer(databasePath, llm);
  const res = await server.request(
    "/api/page/Archive_rotation_protocol",
  );

  assert.equal(res.status, 200);
  const events = (await res.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const done = events.find((event) => event.type === "done");
  assert.ok(done);
  assert.equal(done.article.title, "Archive rotation protocol");
  assert.equal(done.article.displayTitle, undefined);
  assert.match(done.article.html, /<h1>Archive rotation protocol<\/h1>/);
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
    "Coal futures markets are complex, highly volatile financial instruments dedicated to pricing the future delivery of subterranean combustive resources.",
  );

  let cachedSummary = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const cachedRes = await server.request("/api/page/Coal_futures_markets");
    assert.equal(cachedRes.status, 200);
    const cached = await cachedRes.json();
    cachedSummary = cached.article.summaryMarkdown;
    if (
      cachedSummary ===
      "Coal futures markets turn buried fuel trading into a ceremonial pricing bureaucracy organized around ash clerks and future-delivery rites."
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    cachedSummary,
    "Coal futures markets turn buried fuel trading into a ceremonial pricing bureaucracy organized around ash clerks and future-delivery rites.",
  );
});

test("retrieveContext logs matched articles in descending relevance order", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = openDatabase(databasePath);
  const entries: Array<{ event: string; fields?: Record<string, unknown> }> =
    [];
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
      [slug],
    );
  };

  saveSeed(
    "alpha-topic",
    "Alpha Topic",
    "# Alpha Topic\n\nAlpha beta gamma delta archive.",
  );
  saveSeed("beta-topic", "Beta Topic", "# Beta Topic\n\nAlpha beta archive.");
  await indexArticleChunks(
    db,
    new QueueLlmClient(""),
    "alpha-topic",
    "# Alpha Topic\n\nAlpha beta gamma delta archive.",
    false,
    500,
  );
  await indexArticleChunks(
    db,
    new QueueLlmClient(""),
    "beta-topic",
    "# Beta Topic\n\nAlpha beta archive.",
    false,
    500,
  );

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
    logger,
  );
  db.close();

  const retrieveLog = entries.find(
    (entry) => entry.event === "rag.retrieve_complete",
  );
  assert.ok(retrieveLog, "rag.retrieve_complete log entry should be emitted");
  // `sources` lists picked articles with chunk scores; both seeds should appear
  const sources = String(retrieveLog?.fields?.sources ?? "");
  assert.match(sources, /alpha-topic/);
  assert.match(sources, /beta-topic/);
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
    JSON.stringify({
      slug: "cultural-dissipation-factor",
      description: "measure of stable energetic exchange in recorded belief systems",
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
    /\[Cultural Dissipation Factor\]\(halu:cultural-dissipation-factor "measure of stable energetic exchange in recorded belief systems"\) \(\$\\delta\$\):/,
  );
  assert.doesNotMatch(
    body.article.markdown,
    /\[Cultural Dissipation Factor \(\$\\delta\$\): This is perhaps the most abstract measurement/,
  );
});

test("add-link wraps highlighted plain text in a new halu link at that position", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Plain-text article — no existing links anywhere
  const markdown = [
    "# Stabilizing Agent 7",
    "",
    "**Stabilizing Agent 7** is a chemical additive used in the structural coatings industry to prevent atmospheric degradation.",
  ].join("\n");
  saveMarkdownArticle(databasePath, {
    slug: "stabilizing-agent-7",
    title: "Stabilizing Agent 7",
    markdown,
  });

  // LLM returns the target article identity for the suggestion call
  const llm = new QueueLlmClient("", [
    JSON.stringify({
      slug: "structural-coatings-industry",
      description: "industrial sector applying protective surface films",
    }),
  ]);
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/article/Stabilizing_Agent_7/add-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selectedText: "structural coatings industry" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  // The exact selected phrase must now be a halu link in the saved markdown
  assert.match(
    body.article.markdown,
    /\[structural coatings industry\]\(halu:structural-coatings-industry "[^"]+"\)/,
    "highlighted plain text should be wrapped in a halu: link at the selection position",
  );
  // And the surrounding sentence must still be intact
  assert.match(body.article.markdown, /used in the \[structural coatings industry\]/);
  assert.match(body.article.markdown, /\) to prevent atmospheric degradation\./);
});

test("add-link wraps unicode text with parentheses and rejects self-link suggestions", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const markdown = [
    "# Metamorphic Systems",
    "",
    "Signal Units (信号体) are self-organizing units that drive emergent behavior in complex adaptive systems.",
  ].join("\n");
  saveMarkdownArticle(databasePath, {
    slug: "metamorphic-systems",
    title: "Metamorphic Systems",
    markdown,
  });

  const llm = new QueueLlmClient("", [
    JSON.stringify({
      slug: "metamorphic-systems",
      description: "self-organizing units that drive emergent behavior",
    }),
  ]);
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/article/Metamorphic_Systems/add-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selectedText: "Signal Units (信号体)" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.match(
    body.article.markdown,
    /\[Signal Units \(信号体\)\]\(halu:signal-units-信号体 "[^"]+"\)/,
    "unicode text with parentheses should be wrapped as a halu link",
  );
  assert.match(
    body.article.markdown,
    /\[Signal Units \(信号体\)\]\(halu:signal-units-信号体 "[^"]+"\) are self-organizing/,
    "surrounding text should remain intact",
  );
  assert.doesNotMatch(
    body.article.markdown,
    /\(halu:metamorphic-systems /,
    "self-link suggestions should fall back to the selected text slug",
  );
});

test("add-link rejects link suggestion with missing description or slug fields", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const markdown = [
    "# Test Article",
    "",
    "This mentions some topic that we want to link.",
  ].join("\n");
  saveMarkdownArticle(databasePath, {
    slug: "test-article",
    title: "Test Article",
    markdown,
  });

  const llm = new QueueLlmClient("", [
    JSON.stringify({
      slug: "some-topic",
      // Missing 'description' field — should cause error
    }),
  ]);
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/article/Test_Article/add-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selectedText: "some topic" }),
  });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.ok(
    body.error.includes("link suggestion"),
    "error should mention link suggestion failure",
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
  const llm = new QueueLlmClient("", [
    rewritten,
    JSON.stringify({ items: [] }),
  ]);
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/article/San_francisco/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instructions:
        "Add a brief note about the municipal weather bureau and keep the tone dry.",
    }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.article.title, "San Francisco");
  assert.match(body.article.markdown, /municipal weather bureau/);
});

test("rewrite endpoint includes explicitly referenced articles in edit RAG", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  saveMarkdownArticle(databasePath, {
    slug: "san-francisco",
    title: "San Francisco",
    markdown: [
      "# San Francisco",
      "",
      "San Francisco is a quiet administrative district known for fog registries.",
    ].join("\n"),
  });
  saveMarkdownArticle(databasePath, {
    slug: "municipal-weather-bureau",
    title: "Municipal Weather Bureau",
    markdown: [
      "# Municipal Weather Bureau",
      "",
      "The Municipal Weather Bureau coordinates cloud permits, civic umbrellas, and brass rain ledgers.",
    ].join("\n"),
  });
  {
    const db = openDatabase(databasePath);
    await indexArticleChunks(
      db,
      new QueueLlmClient(""),
      "municipal-weather-bureau",
      [
        "# Municipal Weather Bureau",
        "",
        "The Municipal Weather Bureau coordinates cloud permits, civic umbrellas, and brass rain ledgers.",
      ].join("\n"),
      false,
      500,
    );
    db.close();
  }

  const rewritten = [
    "# San Francisco",
    "",
    "San Francisco is a quiet administrative district known for fog registries and the Municipal Weather Bureau.",
  ].join("\n");
  const llm = new CapturingChatLlmClient([rewritten, "Updated summary."]);
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/article/San_francisco/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instructions: "Revise this using the Municipal Weather Bureau article.",
      ragEnabled: true,
      ragQuery: "Municipal Weather Bureau",
    }),
  });

  assert.equal(res.status, 200);
  assert.match(llm.calls[0]?.user ?? "", /Municipal Weather Bureau/);
  assert.match(llm.calls[0]?.user ?? "", /brass rain ledgers/);
});

test("rewrite RAG uses the user's typed query as the vector search text", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  saveMarkdownArticle(databasePath, {
    slug: "ledger-index",
    title: "Ledger Index",
    markdown: "# Ledger Index\n\nThe current page tracks local ledger entries.",
  });
  saveMarkdownArticle(databasePath, {
    slug: "quiet-archive",
    title: "Quiet Archive",
    markdown: "# Quiet Archive\n\nA source page available to the retrieval index.",
  });
  {
    const db = openDatabase(databasePath);
    await indexArticleChunks(
      db,
      new QueueLlmClient(""),
      "quiet-archive",
      "# Quiet Archive\n\nA source page available to the retrieval index.",
      true,
      500,
    );
    db.close();
  }

  const llm = new CapturingChatLlmClient([
    "# Ledger Index\n\nRewritten ledger entry.",
    "Updated summary.",
  ]);
  const server = await createServer(databasePath, llm);
  const query = "arbitrary operator text about cracked brass indexes";

  const res = await server.request("/api/article/Ledger_Index/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instructions: "Use the reference search.",
      ragEnabled: true,
      ragQuery: query,
    }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(llm.embedInputs.at(-1), [query]);
});

test("rewrite RAG includes fuzzy title matches in addition to vector retrieval", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  saveMarkdownArticle(databasePath, {
    slug: "san-francisco",
    title: "San Francisco",
    markdown: "# San Francisco\n\nSan Francisco is a quiet administrative district.",
  });
  saveMarkdownArticle(databasePath, {
    slug: "municipal-weather-bureau",
    title: "Municipal Weather Bureau",
    markdown: [
      "# Municipal Weather Bureau",
      "",
      "The Municipal Weather Bureau coordinates cloud permits, civic umbrellas, and brass rain ledgers.",
    ].join("\n"),
  });

  const rewritten = [
    "# San Francisco",
    "",
    "San Francisco now cites the Municipal Weather Bureau.",
  ].join("\n");
  const llm = new CapturingChatLlmClient([rewritten, "Updated summary."]);
  const server = await createServer(databasePath, llm);

  const res = await server.request("/api/article/San_francisco/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instructions: "Use this reference.",
      ragEnabled: true,
      ragQuery: "municpal wether buro",
    }),
  });

  assert.equal(res.status, 200);
  assert.match(llm.calls[0]?.user ?? "", /Municipal Weather Bureau/);
  assert.match(llm.calls[0]?.user ?? "", /brass rain ledgers/);
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
  const llm = new QueueLlmClient("", [
    bodyRenamedRewrite,
    JSON.stringify({ items: [] }),
  ]);
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
    ],
  );
  const server = await createServer(databasePath, llm);

  const res = await server.request(
    "/api/article/Energy_storage/rewrite?stream=1",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson",
      },
      body: JSON.stringify({
        instructions: "make this article to be about your mom",
      }),
    },
  );

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
  const llm = new QueueLlmClient(rewrittenHistory, [
    JSON.stringify({ items: [] }),
  ]);
  const server = await createServer(databasePath, llm);

  const rewriteRes = await server.request(
    "/api/article/Clock_Orchard/rewrite?stream=1",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson",
      },
      body: JSON.stringify({
        sectionId: "history",
        instructions: "Add the municipal bell ledger to the history section.",
      }),
    },
  );
  assert.equal(rewriteRes.status, 200);
  assert.match(
    rewriteRes.headers.get("content-type") ?? "",
    /application\/x-ndjson/,
  );
  const events = (await rewriteRes.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const done = events.find((event) => event.type === "done");
  assert.ok(done);
  assert.match(done.article.markdown, /municipal bell ledger/);
  assert.match(
    done.article.markdown,
    /Clock Orchard has a dry introductory paragraph/,
  );
  assert.match(done.article.markdown, /The orchard is arranged in narrow rows/);
  assert.equal(
    done.sections.some((section: { id: string }) => section.id === "history"),
    true,
  );

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

  const revertedHistoryRes = await server.request("/api/article/Clock_Orchard/history");
  assert.equal(revertedHistoryRes.status, 200);
  const revertedHistory = await revertedHistoryRes.json();
  assert.equal(revertedHistory.revisions[0].operation, "revert");
  assert.equal(revertedHistory.revisions[0].revertedFromRevisionId, history.revisions[1].id);
});

test("section rewrite preserves existing references even when the UI omits them", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  saveMarkdownArticle(databasePath, {
    slug: "archive-index",
    title: "Archive Index",
    markdown: "# Archive Index\n\nArchive source summary.",
    generated_at: 10,
  });
  saveMarkdownArticle(databasePath, {
    slug: "field-report",
    title: "Field Report",
    markdown: "# Field Report\n\nField source summary.",
    generated_at: 11,
  });
  saveMarkdownArticle(databasePath, {
    slug: "survey-page",
    title: "Survey Page",
    markdown: [
      "# Survey Page",
      "",
      "Survey Page has an intro.",
      "",
      "## Notes",
      "",
      "The notes cite older field work.",
    ].join("\n"),
    generated_at: 12,
  });

  const db = openDatabase(databasePath);
  saveArticleReferences(db, "survey-page", 12, [
    {
      slug: "archive-index",
      title: "Archive Index",
      content: "Archive source summary.",
      kind: "summary",
      pinned: false,
      revisionId: "initial",
    },
    {
      slug: "field-report",
      title: "Field Report",
      content: "Field source summary.",
      kind: "summary",
      pinned: false,
      revisionId: "initial",
    },
  ]);
  db.close();

  const llm = new QueueLlmClient("## Notes\n\nThe notes cite older field work with one clarified sentence.");
  const server = await createServer(databasePath, llm);
  const res = await server.request("/api/article/Survey_Page/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sectionId: "notes",
      instructions: "Clarify the notes section.",
      blacklistSlugs: ["archive-index"],
    }),
  });

  assert.equal(res.status, 200);
  const savedDb = openDatabase(databasePath);
  t.after(() => savedDb.close());
  assert.deepEqual(
    getLatestArticleReferences(savedDb, "survey-page").map((ref) => ref.slug),
    ["archive-index", "field-report"],
  );
});

test("refresh-context always runs LLM and preserves article when content is unchanged", async (t) => {
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

  // Mock returns the same body — article content should be intact after refresh
  const server = await createServer(
    databasePath,
    new QueueLlmClient(markdown, []),
  );
  const res = await server.request("/api/article/Stable_Page/refresh-context", {
    method: "POST",
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.article.markdown, /Stable Page has a body/);
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
    ["ledger-source"],
  );
  await indexArticleChunks(
    db,
    new QueueLlmClient(""),
    "ledger-source",
    sourceMarkdown,
    false,
    500,
  );

  const targetMarkdown = [
    "# Algebra",
    "",
    "Algebra is a bureau for arranging letters.",
  ].join("\n");
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
    ["algebra"],
  );
  db.close();

  const refreshed = [
    "# Algebra",
    "",
    "Algebra is a bureau for arranging letters and storing commas in copper drawers.",
  ].join("\n");
  const server = await createServer(
    databasePath,
    new QueueLlmClient("", [refreshed, JSON.stringify({ items: [] })]),
  );
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
        {
          title: "Mercury (planet)",
          description: "The smallest planet in the solar system",
        },
        {
          title: "Mercury (element)",
          description: "A liquid metal also known as quicksilver",
        },
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

/* ─────────────────────────────────────────────────────────────────
   Reference status: notice should not fire for old-style articles
   ───────────────────────────────────────────────────────────────── */

test("old-style article with halu links and empty sidecar does not trigger missing-refs notice", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Seed the linked article so it exists in DB
  saveMarkdownArticle(databasePath, {
    slug: "resonance-transmitter",
    title: "Resonance Transmitter",
    markdown: "# Resonance Transmitter\n\n**Resonance Transmitter** is a device.",
  });
  // Old-style article: halu link to existing article, no sidecar refs
  saveMarkdownArticle(databasePath, {
    slug: "legacy-article",
    title: "Legacy Article",
    markdown: [
      "# Legacy Article",
      "",
      '**Legacy Article** uses the [Resonance Transmitter](halu:resonance-transmitter "a device").',
    ].join("\n"),
  });

  const server = await createServer(databasePath, new QueueLlmClient(""));
  const res = await server.request("/api/page/Legacy_Article");
  assert.equal(res.status, 200);
  const body = await res.json();

  // Halu links to existing articles do NOT count as "missing" — only explicit ref: links do
  assert.deepEqual(body.referenceStatus.missing, []);
  // unformatted is empty because the sidecar has no refs (nothing to flag as wrongly formatted)
  assert.deepEqual(body.referenceStatus.unformatted, []);
});

test("hasReferencesSection is false for articles without a baked-in References heading", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  saveMarkdownArticle(databasePath, {
    slug: "clean-article",
    title: "Clean Article",
    markdown: "# Clean Article\n\n**Clean Article** has no baked-in sections.",
  });

  const server = await createServer(databasePath, new QueueLlmClient(""));
  const res = await server.request("/api/page/Clean_Article");
  assert.equal(res.status, 200);
  const body = await res.json();

  // The hasReferencesSection check should correctly return false (not always-true)
  assert.equal(body.referenceStatus.hasReferencesSection, false);
});

test("old-style article with baked-in See also section renders it in page HTML", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  saveMarkdownArticle(databasePath, {
    slug: "linked-topic",
    title: "Linked Topic",
    markdown: "# Linked Topic\n\n**Linked Topic** is a topic.",
  });
  saveMarkdownArticle(databasePath, {
    slug: "old-with-see-also",
    title: "Old With See Also",
    markdown: [
      "# Old With See Also",
      "",
      "**Old With See Also** is a legacy article.",
      "",
      "## See also",
      "",
      '- [Linked Topic](halu:linked-topic "related concept")',
    ].join("\n"),
  });

  const server = await createServer(databasePath, new QueueLlmClient(""));
  const res = await server.request("/api/page/Old_With_See_Also");
  assert.equal(res.status, 200);
  const body = await res.json();

  // The baked-in See also section should appear in the rendered HTML
  assert.match(body.article.html, /See also/);
  assert.match(body.article.html, /Linked Topic/);
});

test("missing refs notice fires for explicit ref:slug links not in sidecar", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Seed the referenced article
  saveMarkdownArticle(databasePath, {
    slug: "cited-article",
    title: "Cited Article",
    markdown: "# Cited Article\n\n**Cited Article** is well-known.",
  });
  // Article that uses ref:slug syntax but has no sidecar refs
  saveMarkdownArticle(databasePath, {
    slug: "citing-article",
    title: "Citing Article",
    markdown: "# Citing Article\n\n**Citing Article** cites [Cited Article](ref:cited-article).",
  });

  const server = await createServer(databasePath, new QueueLlmClient(""));
  const res = await server.request("/api/page/Citing_Article");
  assert.equal(res.status, 200);
  const body = await res.json();

  // Explicit ref: links NOT in sidecar appear as missing
  assert.equal(body.referenceStatus.missing.length, 1);
  assert.equal(body.referenceStatus.missing[0].slug, "cited-article");
});

/* ─────────────────────────────────────────────────────────────────
   Real LLM integration: ref link format validation
   ───────────────────────────────────────────────────────────────── */

test("generated article uses ref:slug links when references are available", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const config = loadConfig();
  const testCfg = config.app.tests;

  const chatConfig = {
    base_url: testCfg.llm_base_url,
    api_key: testCfg.llm_api_key,
    model: testCfg.llm_model,
    temperature: 1,
    max_tokens: 4000,
  };
  const embeddingsConfig = {
    enabled: false,
    base_url: testCfg.llm_base_url,
    api_key: testCfg.llm_api_key,
    model: "nomic",
  };

  let llmClient: LlmClient;
  try {
    const client = new OpenAICompatClient(chatConfig, embeddingsConfig, {
      debug() {},
      info() {},
      warn() {},
      error() {},
    }, "heavy");
    await client.probeConnections();
    llmClient = client;
  } catch {
    t.skip("LLM not reachable at test URL — skipping real LLM generation test");
    return;
  }

  // Seed a reference article so there's something in the ref list
  saveMarkdownArticle(databasePath, {
    slug: "hexagonal-network",
    title: "Hexagonal Network",
    markdown: "# Hexagonal Network\n\n**Hexagonal Network** is a topology used in flat-earth grid systems.",
  });

  const { app, shutdown } = await createApp({
    databasePath,
    skipLlmProbe: true,
    skipHomepagePrepare: true,
    llmClient,
  });
  t.after(shutdown);

  const request = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://halupedia.test${path}`, init));

  // Stream a generation
  const lines: string[] = [];
  const res = await request("/api/page/Discord_software?stream=1");
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const line of text.trim().split("\n")) {
    if (line.trim()) lines.push(line);
  }
  const last = JSON.parse(lines[lines.length - 1]);
  if (last.type === "error" && String(last.message ?? "").includes("fetch failed")) {
    t.skip("LLM generation failed after probe — skipping real LLM generation test");
    return;
  }
  const markdown = last.article?.body ?? last.article?.markdown ?? "";

  // Body should not contain long cited text in ref links
  // (i.e., no [very long sentence here](ref:N))
  const longRefTextMatch = /\[([^\]]{40,})\]\(ref:/g.exec(markdown);
  assert.equal(
    longRefTextMatch,
    null,
    `ref link visible text should be short or empty, got: ${longRefTextMatch?.[1]}`,
  );

  // ref: links should be durable slug links, not numeric shorthand.
  assert.doesNotMatch(markdown, /\]\(ref:\d+\)/, "ref:N (numeric) should be resolved to ref:slug before saving");

  // referenceStatus should not show false positives
  const pageRes = await request("/api/page/Discord_software");
  assert.equal(pageRes.status, 200);
  const page = await pageRes.json();
  assert.equal(page.referenceStatus.hasReferencesSection, false);

  // When refs ARE present they must be properly formatted (no baked-in section)
  if (page.article.metadata.references.length > 0) {
    assert.match(
      page.article.html,
      /class="article-references"/,
      "rendered HTML is missing the references section when refs are present",
    );
  }
});

test("article body generation uses streamChat (not chat) and emits progress events before done", async (t) => {
  const { root, databasePath } = createTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const ARTICLE_BODY = "# Streamed Article\n\nThis body was streamed chunk by chunk.";
  const framedOutput = `---halu-body\n${ARTICLE_BODY}\n---halu-used-refs\n[]`;

  class StreamingBodyTracker implements LlmClient {
    public streamChatCalled = false;
    public chatCalledForBody = false;

    async chat(system: string, user: string): Promise<string> {
      if ((system + user).includes("---halu-body")) {
        this.chatCalledForBody = true;
        return framedOutput;
      }
      if (system.includes("concise summary")) return "Summary of streamed article.";
      return JSON.stringify({ items: [] });
    }

    async streamChat(
      _system: string,
      _user: string,
      onChunk: (delta: string, accumulated: string) => void,
    ): Promise<{ content: string; finishReason: string }> {
      this.streamChatCalled = true;
      // Emit header then body in chunks so onProgress fires mid-stream
      const header = "---halu-body\n";
      const footer = "\n---halu-used-refs\n[]";
      onChunk(header, header);
      onChunk(ARTICLE_BODY, header + ARTICLE_BODY);
      onChunk(footer, framedOutput);
      return { content: framedOutput, finishReason: "stop" };
    }

    async embed(input: string[]): Promise<number[][]> {
      return input.map(() => []);
    }

    async probeConnections(): Promise<void> {}
  }

  const tracker = new StreamingBodyTracker();
  const server = await createServer(databasePath, tracker);

  const res = await server.request("/api/page/Streamed_Article?stream=1");
  assert.equal(res.status, 200);
  const packets = parseNdjson<Record<string, unknown>>(await res.text());

  // Body generation must use streamChat, not chat
  assert.equal(tracker.streamChatCalled, true, "streamChat should be called for article body generation");
  assert.equal(tracker.chatCalledForBody, false, "chat() should NOT be called for article body generation");

  // Must receive at least one progress event during streaming
  const progressEvents = packets.filter((p) => p.type === "progress");
  assert.ok(progressEvents.length > 0, "should receive progress events during body streaming");

  // Article must still be generated successfully
  assert.ok(packets.some((p) => p.type === "done"), "should have a done event");
});
