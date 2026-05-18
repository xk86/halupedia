/**
 * Tests for:
 *   1. findSelectionRangeInMarkdown – handles plain and formatted selections
 *   2. ensureDykHasSourceLink – DYK facts always link to the source article
 *   3. Rewrite endpoint with formatted (markdown) selectedText
 *   4. Homepage history endpoint and accumulation
 *   5. Halu link parsing: spaces in slug, single-quote hints
 *   6. Article references saved and restored alongside revisions
 *   7. Refresh-context normalizes markdown even without LLM rewrite
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  saveArticle,
  saveHomepageCache,
  listHomepageHistory,
  saveArticleReferences,
  getLatestArticleReferences,
} from "../src/server/db";
import { loadConfig } from "../src/server/config";
import { createApp, findSelectionRangeInMarkdown, ensureDykHasSourceLink } from "../src/server/index";
import type { LlmClient } from "../src/server/llm";
import type { LogFields, Logger } from "../src/server/logger";
import {
  renderMarkdown,
  markdownToPlainText,
  normalizeHaluLinks,
  extractInternalLinks,
} from "../src/server/markdown";
import type { HomepagePayload } from "../src/server/types";

const TEST_CONFIG = loadConfig().app.tests;

function createMemoryLogger(): Logger {
  return {
    debug(_e: string, _f?: LogFields) {},
    info(_e: string, _f?: LogFields) {},
    warn(_e: string, _f?: LogFields) {},
    error(_e: string, _f?: LogFields) {},
  };
}

function createTestDb() {
  const root = mkdtempSync(join(tmpdir(), "halupedia-nf-"));
  const databasePath = join(root, TEST_CONFIG.database_path);
  return { root, databasePath };
}

function seedArticle(
  databasePath: string,
  slug: string,
  title: string,
  body: string,
) {
  const markdown = `# ${title}\n\n${body}`;
  const db = openDatabase(databasePath);
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
  db.close();
  return markdown;
}

async function createTestServer(
  databasePath: string,
  llmClient?: LlmClient,
) {
  const { app, shutdown } = await createApp({
    databasePath,
    skipLlmProbe: true,
    skipHomepagePrepare: true,
    logger: createMemoryLogger(),
    llmClient,
  });
  return {
    shutdown,
    request: (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://halupedia.test${path}`, init)),
  };
}

function parseNdjson<T>(text: string): T[] {
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

// Returns the LLM output verbatim (for selection-edit testing)
class EchoRewriteLlm implements LlmClient {
  constructor(private readonly response: string) {}
  async chat(): Promise<string> { return "{}"; }
  async streamChat(
    _s: string,
    _u: string,
    onChunk: (delta: string, acc: string) => void,
  ): Promise<{ content: string; finishReason: string }> {
    onChunk(this.response, this.response);
    return { content: this.response, finishReason: "stop" };
  }
  async embed(): Promise<number[][]> { return []; }
  async probeConnections(): Promise<void> {}
}

/* ─────────────────────────────────────────────────────────────────
   1. findSelectionRangeInMarkdown unit tests
   ───────────────────────────────────────────────────────────────── */

test("findSelectionRangeInMarkdown: exact plain-text match (fast path)", () => {
  const md = "The quick brown fox jumps.";
  const range = findSelectionRangeInMarkdown(md, "quick brown");
  assert.ok(range, "should find range");
  assert.equal(md.slice(range.start, range.end), "quick brown");
});

test("findSelectionRangeInMarkdown: selection spanning bold markers", () => {
  // "quick brown" in "The **quick** brown fox" — 'quick' is inside bold, 'brown' is outside
  const md = "The **quick** brown fox.";
  const range = findSelectionRangeInMarkdown(md, "quick brown");
  assert.ok(range, "should find range across bold markers");
  // Range should cover the whole formatted span including **...**
  const slice = md.slice(range.start, range.end);
  assert.match(slice, /quick/);
  assert.match(slice, /brown/);
  // Should include the ** markers
  assert.match(slice, /\*\*/);
});

test("findSelectionRangeInMarkdown: selection is a link label", () => {
  const md = `[Glow Fruit](halu:glow-fruit "a luminous orchard product") is special.`;
  const range = findSelectionRangeInMarkdown(md, "Glow Fruit");
  assert.ok(range, "should find range");
  const slice = md.slice(range.start, range.end);
  // Should include the entire link syntax, not just the bare label
  assert.match(slice, /\[Glow Fruit\]/);
  assert.match(slice, /halu:glow-fruit/);
});

test("findSelectionRangeInMarkdown: cross-span selection including link label and trailing text", () => {
  const md = `Visit [Glow Fruit](halu:glow-fruit "hint") today for details.`;
  const range = findSelectionRangeInMarkdown(md, "Glow Fruit today");
  assert.ok(range, "should find range spanning link and plain text");
  const slice = md.slice(range.start, range.end);
  assert.match(slice, /Glow Fruit/);
  assert.match(slice, /today/);
});

test("findSelectionRangeInMarkdown: selection inside italic markers", () => {
  const md = "An *italic phrase* appears here.";
  const range = findSelectionRangeInMarkdown(md, "italic phrase");
  assert.ok(range, "should find range inside italic");
  const slice = md.slice(range.start, range.end);
  assert.match(slice, /italic phrase/);
  // Should extend to include the * markers
  assert.match(slice, /\*/);
});

test("findSelectionRangeInMarkdown: returns null for text not in markdown", () => {
  const md = "The quick brown fox.";
  const range = findSelectionRangeInMarkdown(md, "lazy dog");
  assert.equal(range, null);
});

test("findSelectionRangeInMarkdown: selection within plain text section (no formatting)", () => {
  const md = "# Title\n\nFirst paragraph. Second sentence.\n\nAnother paragraph.";
  const range = findSelectionRangeInMarkdown(md, "Second sentence");
  assert.ok(range);
  assert.equal(md.slice(range.start, range.end), "Second sentence");
});

/* ─────────────────────────────────────────────────────────────────
   2. ensureDykHasSourceLink unit tests
   ───────────────────────────────────────────────────────────────── */

test("ensureDykHasSourceLink: fact with halu link → converts to plain slug link", () => {
  // Halu links in DYK are wrong — the function should replace them with plain slug links
  const fact = `... [Glow Fruit](halu:glow-fruit "luminous orchard product") was discovered in the craters.`;
  const result = ensureDykHasSourceLink(fact, "glow-fruit", "Glow Fruit");
  assert.match(result, /\/glow-fruit\)/, "should replace halu link with plain slug link");
  assert.doesNotMatch(result, /halu:/, "halu links must not remain in DYK facts");
  assert.doesNotMatch(result, /\/wiki\//, "must not use wiki-path format");
  assert.match(result, /was discovered in the craters/, "content should be preserved");
});

test("ensureDykHasSourceLink: fact mentions title as plain text → first occurrence becomes slug link", () => {
  const fact = "... Glow Fruit was discovered in the southern craters.";
  const result = ensureDykHasSourceLink(fact, "glow-fruit", "Glow Fruit");
  assert.match(result, /\[Glow Fruit\]\(\/glow-fruit\)/, "should linkify with plain slug link");
  assert.doesNotMatch(result, /halu:/, "must not insert halu link");
  assert.doesNotMatch(result, /\/wiki\//, "must not use wiki-path format");
  assert.match(result, /was discovered in the southern craters/, "rest of fact preserved");
});

test("ensureDykHasSourceLink: fact does not mention title → slug link prepended", () => {
  const fact = "... the craters glow at night due to bioluminescent fungi.";
  const result = ensureDykHasSourceLink(fact, "glow-fruit", "Glow Fruit");
  assert.match(result, /\/glow-fruit\)/, "should insert plain slug link when title absent");
  assert.match(result, /\[Glow Fruit\]/, "should use title as link label");
  assert.doesNotMatch(result, /halu:/, "must not insert a halu link");
  assert.doesNotMatch(result, /\/wiki\//, "must not use wiki-path format");
});

test("ensureDykHasSourceLink: case-insensitive title match", () => {
  const fact = "... glow fruit was first catalogued in the old crater ledger.";
  const result = ensureDykHasSourceLink(fact, "glow-fruit", "Glow Fruit");
  assert.match(result, /\/glow-fruit\)/);
  assert.doesNotMatch(result, /halu:/);
});

/* ─────────────────────────────────────────────────────────────────
   3. Rewrite endpoint with formatted selectedText
   ───────────────────────────────────────────────────────────────── */

test("rewrite endpoint accepts formatted selected text spanning bold markers", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // The article has bold text; user selects across the bold boundary
  const body = "**Quick** brown content about widgets.";
  seedArticle(databasePath, "format-test", "Format Test", body);

  // LLM returns a simple replacement for the selected fragment
  const llm = new EchoRewriteLlm("speedy brown content about gadgets");
  const server = await createTestServer(databasePath, llm);
  t.after(() => server.shutdown());

  // Plain-text selection "Quick brown" spans the ** boundary
  const res = await server.request("/api/article/format-test/rewrite?stream=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instructions: "replace quick with speedy",
      selectedText: "Quick brown",
    }),
  });

  // Should NOT return 422 even though "Quick brown" isn't a verbatim substring of the markdown
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const packets = parseNdjson<Record<string, unknown>>(await res.text());
  const done = packets.find((p) => p.type === "done");
  assert.ok(done, "stream should emit a done event");
  assert.ok((done as any).article, "done event should include updated article");
  // The replacement should appear in the saved markdown
  assert.match(
    String((done as any).article.markdown),
    /speedy brown content/,
    "replacement should appear in saved markdown",
  );
});

test("rewrite endpoint accepts formatted selected text that is a link label", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const body = `The [Glow Fruit](halu:glow-fruit "luminous orchard product") appears at dusk.`;
  seedArticle(databasePath, "link-select", "Link Select", body);

  // LLM returns replacement link text
  const llm = new EchoRewriteLlm(`[Night Bloom](halu:night-bloom "a dusk-flowering plant")`);
  const server = await createTestServer(databasePath, llm);
  t.after(() => server.shutdown());

  // User selects the link label text "Glow Fruit" from the rendered article
  const res = await server.request("/api/article/link-select/rewrite?stream=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instructions: "change Glow Fruit to Night Bloom",
      selectedText: "Glow Fruit",
    }),
  });

  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const packets = parseNdjson<Record<string, unknown>>(await res.text());
  const done = packets.find((p) => p.type === "done");
  assert.ok(done);
});

/* ─────────────────────────────────────────────────────────────────
   4. Homepage history endpoint and accumulation
   ───────────────────────────────────────────────────────────────── */

test("GET /api/homepage/history returns empty array when no history saved", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = await createTestServer(databasePath);
  t.after(() => server.shutdown());

  const res = await server.request("/api/homepage/history");
  assert.equal(res.status, 200);
  const body = await res.json() as { history: unknown[] };
  assert.ok(Array.isArray(body.history), "history should be an array");
  assert.equal(body.history.length, 0);
});

test("saveHomepageCache persists entry visible via listHomepageHistory", (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = openDatabase(databasePath);
  t.after(() => db.close());

  const payload: HomepagePayload = {
    featured: { slug: "glow-fruit", title: "Glow Fruit", summaryMarkdown: "A luminous orchard product." },
    didYouKnow: [{ slug: "glow-fruit", title: "Glow Fruit", fact: "... Glow Fruit glows at night." }],
    generatedAt: 1_720_000_000_000,
    expiresAt: 1_720_000_000_000 + 3_600_000,
  };

  saveHomepageCache(db, payload);

  const history = listHomepageHistory(db, 10);
  assert.equal(history.length, 1, "one history entry should be saved");
  assert.equal(history[0].featured?.slug, "glow-fruit");
  assert.equal(history[0].didYouKnow.length, 1);
});

test("listHomepageHistory returns entries newest-first, limited by count", (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = openDatabase(databasePath);
  t.after(() => db.close());

  // Save three homepage caches at different times
  for (let i = 1; i <= 3; i++) {
    const ts = 1_720_000_000_000 + i * 3_600_000;
    saveHomepageCache(db, {
      featured: { slug: `article-${i}`, title: `Article ${i}`, summaryMarkdown: "" },
      didYouKnow: [],
      generatedAt: ts,
      expiresAt: ts + 3_600_000,
    });
  }

  const all = listHomepageHistory(db, 10);
  assert.equal(all.length, 3);
  // Newest first: article-3, article-2, article-1
  assert.equal(all[0].featured?.slug, "article-3");
  assert.equal(all[1].featured?.slug, "article-2");
  assert.equal(all[2].featured?.slug, "article-1");

  // Limit to 2
  const limited = listHomepageHistory(db, 2);
  assert.equal(limited.length, 2);
  assert.equal(limited[0].featured?.slug, "article-3");
});

test("GET /api/homepage/history reflects saved caches", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Seed two homepage caches directly
  const db = openDatabase(databasePath);
  for (let i = 1; i <= 2; i++) {
    const ts = 1_720_000_000_000 + i * 3_600_000;
    saveHomepageCache(db, {
      featured: { slug: `entry-${i}`, title: `Entry ${i}`, summaryMarkdown: "" },
      didYouKnow: [],
      generatedAt: ts,
      expiresAt: ts + 3_600_000,
    });
  }
  db.close();

  const server = await createTestServer(databasePath);
  t.after(() => server.shutdown());

  const res = await server.request("/api/homepage/history");
  assert.equal(res.status, 200);
  const body = await res.json() as { history: HomepagePayload[] };
  assert.equal(body.history.length, 2);
  // Newest first
  assert.equal(body.history[0].featured?.slug, "entry-2");
  assert.equal(body.history[1].featured?.slug, "entry-1");
});

test("DYK facts always contain a slug link to source article (not a halu or wiki-path link)", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const factWithoutLink = "... the bioluminescent properties were first documented in an old ledger.";
  const fixed = ensureDykHasSourceLink(factWithoutLink, "glow-fruit", "Glow Fruit");
  assert.match(fixed, /\/glow-fruit\)/, "fixed fact should use plain slug link");
  assert.doesNotMatch(fixed, /halu:/, "DYK facts must NOT use halu links");
  assert.doesNotMatch(fixed, /\/wiki\//, "DYK facts must NOT use wiki-path links");
});

/* ─────────────────────────────────────────────────────────────────
   5. DYK: already-has-slug-link is unchanged
   ───────────────────────────────────────────────────────────────── */

test("ensureDykHasSourceLink: fact already has slug link to source → unchanged", () => {
  const fact = "... [Glow Fruit](/glow-fruit) was discovered in the craters.";
  const result = ensureDykHasSourceLink(fact, "glow-fruit", "Glow Fruit");
  assert.equal(result, fact, "fact with existing slug link should not be modified");
});

test("ensureDykHasSourceLink: title in plain text → replaced with slug link", () => {
  const fact = "... Glow Fruit was discovered in the southern craters.";
  const result = ensureDykHasSourceLink(fact, "glow-fruit", "Glow Fruit");
  assert.match(result, /\[Glow Fruit\]\(\/glow-fruit\)/, "should linkify first occurrence with plain slug link");
  assert.doesNotMatch(result, /halu:/, "must not insert a halu link");
  assert.doesNotMatch(result, /\/wiki\//, "must not use wiki-path format");
  assert.match(result, /was discovered/, "rest of fact preserved");
});

/* ─────────────────────────────────────────────────────────────────
   6. Halu link parsing: spaces in slug, single-quote hints
   ───────────────────────────────────────────────────────────────── */

test("normalizeHaluLinks: slug with space before quote is parsed correctly", () => {
  // The slug extends to the first quote, not the first space.
  // 'human-person- Junctional-Trauma-Mechanics "hint"' → slug captures everything before '"'
  const md = `[Junctional Trauma Mechanics](halu:human-person- Junctional-Trauma-Mechanics "The academic study of structural inadequacy")`;
  const normalized = normalizeHaluLinks(md);
  // After normalization the link must be in proper [label](halu:slug "hint") form with no spaces in slug
  assert.match(normalized, /\(halu:[a-z0-9-]+ "/, "slug must be normalized with space removed");
  assert.doesNotMatch(normalized, /halu:human-person-\s+Junctional/, "space must not remain in slug");

  // extractInternalLinks must successfully extract this link
  const links = extractInternalLinks(md);
  assert.equal(links.length, 1, "should extract exactly one link");
  assert.match(links[0].targetSlug, /human-person/, "slug should contain the main identifier");
  assert.equal(links[0].hiddenHint, "The academic study of structural inadequacy");
});

test("normalizeHaluLinks: single-quote hint is accepted", () => {
  const md = `[Night Bloom](halu:night-bloom 'a dusk-flowering plant')`;
  const links = extractInternalLinks(md);
  assert.equal(links.length, 1, "should extract link with single-quote hint");
  assert.equal(links[0].hiddenHint, "a dusk-flowering plant");
});

test("normalizeHaluLinks: trailing dash in slug before space is stripped", () => {
  // Slug has a trailing dash before the space; normalizer should strip it
  const md = `[Some Article](halu:some-article- Extra Words "a hint")`;
  const links = extractInternalLinks(md);
  // Should still produce a usable slug (trailing dash stripped, spaces absorbed)
  assert.equal(links.length, 1);
  assert.doesNotMatch(links[0].targetSlug, /-$/, "trailing dash should be stripped");
});

/* ─────────────────────────────────────────────────────────────────
   7. Article references saved alongside revisions
   ───────────────────────────────────────────────────────────────── */

test("saveArticleReferences and getLatestArticleReferences round-trip", (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = openDatabase(databasePath);
  t.after(() => db.close());

  const now = Date.now();
  saveArticleReferences(db, "my-article", now, [
    { slug: "source-a", title: "Source A", summaryMarkdown: "Summary of A." },
    { slug: "source-b", title: "Source B", summaryMarkdown: "Summary of B." },
  ]);

  const refs = getLatestArticleReferences(db, "my-article");
  assert.equal(refs.length, 2);
  assert.ok(refs.some((r: { slug: string }) => r.slug === "source-a"));
  assert.ok(refs.some((r: { slug: string }) => r.slug === "source-b"));
  assert.equal(refs.find((r: { slug: string }) => r.slug === "source-a")?.summaryMarkdown, "Summary of A.");
});

test("getLatestArticleReferences returns most recent set only", (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = openDatabase(databasePath);
  t.after(() => db.close());

  const t1 = 1_720_000_000_000;
  const t2 = t1 + 5000;

  saveArticleReferences(db, "art", t1, [{ slug: "old-ref", title: "Old Ref", summaryMarkdown: "" }]);
  saveArticleReferences(db, "art", t2, [{ slug: "new-ref", title: "New Ref", summaryMarkdown: "Fresh." }]);

  const refs = getLatestArticleReferences(db, "art");
  assert.equal(refs.length, 1, "should return only the most recent set");
  assert.equal(refs[0].slug, "new-ref");
});

test("saveArticle call followed by saveArticleReferences is exposed via GET endpoint", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Seed an article and manually save references
  const db = openDatabase(databasePath);
  const md = "# Reference Target\n\n**Reference Target** is a source article.";
  saveArticle(db, {
    slug: "reference-target",
    canonicalSlug: "reference-target",
    title: "Reference Target",
    markdown: md,
    html: renderMarkdown(md),
    plain_text: markdownToPlainText(md),
    generated_at: 1_720_000_000_001,
  }, [], ["reference-target"]);

  const md2 = "# Main Article\n\n**Main Article** draws from the reference.";
  saveArticle(db, {
    slug: "main-article",
    canonicalSlug: "main-article",
    title: "Main Article",
    markdown: md2,
    html: renderMarkdown(md2),
    plain_text: markdownToPlainText(md2),
    generated_at: 1_720_000_000_002,
  }, [], ["main-article"]);
  saveArticleReferences(db, "main-article", 1_720_000_000_002, [
    { slug: "reference-target", title: "Reference Target", summaryMarkdown: "Summary of target." },
  ]);
  db.close();

  const server = await createTestServer(databasePath);
  t.after(() => server.shutdown());

  const res = await server.request("/api/article/main-article/references");
  assert.equal(res.status, 200);
  const body = await res.json() as { references: Array<{ slug: string }> };
  assert.ok(Array.isArray(body.references));
  assert.ok(body.references.some((r) => r.slug === "reference-target"));
});

/* ─────────────────────────────────────────────────────────────────
   8. Refresh-context normalizes markdown even without LLM rewrite
   ───────────────────────────────────────────────────────────────── */

test("refresh-context endpoint normalizes markdown formatting", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Article with unnormalized markdown (extra blank lines, inconsistent spacing)
  const messyBody = "This paragraph has   extra  spaces.\n\n\n\nAnd three blank lines before this one.";
  seedArticle(databasePath, "norm-test", "Norm Test", messyBody);

  // Use an LLM that always throws on streamChat (so no rewrite happens)
  const llm = new EchoRewriteLlm("");  // chat() returns "" → no rewrite triggered
  const server = await createTestServer(databasePath, llm);
  t.after(() => server.shutdown());

  const res = await server.request("/api/article/norm-test/refresh-context", {
    method: "POST",
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = await res.json() as { article?: { markdown: string } };
  assert.ok(body.article, "response should include updated article");
  // Multiple blank lines should be collapsed by normalizeMarkdown
  assert.doesNotMatch(
    body.article.markdown,
    /\n{3,}/,
    "three+ consecutive blank lines should be normalized away",
  );
});
