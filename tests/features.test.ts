/**
 * Tests for:
 *   1. findSelectionRangeInMarkdown – handles plain and formatted selections
 *   2. ensureDykHasSourceLink – DYK facts preserve existing links and only add source fallback when unlinked
 *   3. Rewrite endpoint with formatted (markdown) selectedText
 *   4. Homepage history endpoint and accumulation
 *   5. Halu link parsing: spaces in slug, single-quote hints
 *   6. Article references saved and restored alongside revisions
 *   7. Refresh-context normalizes markdown even without LLM rewrite
 *   8. Joining page request receives live progress and done events (no polling)
 *   9. Auto post_process is not fired when one is already in flight
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  saveArticle,
  setArticleVibe,
  saveHomepageCache,
  getHomepageCache,
  invalidateHomepageCache,
  listHomepageHistory,
  saveArticleReferences,
  getLatestArticleReferences,
} from "../src/server/db";
import { loadConfig } from "../src/server/config";
import { createApp, findSelectionRangeInMarkdown, ensureDykHasSourceLink } from "../src/server/index";
import { normalizeHomepageFact } from "../src/server/dyk";
import type { LlmRouter } from "../src/server/llm";
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
  // The vibe is the canonical edit channel: the rewrite endpoint rejects edits
  // without one. Seed a neutral default so rewrite tests reach the edit logic
  // instead of the empty-vibe gate. Pass "" to exercise the no-vibe path.
  vibe = "Keep the encyclopedic tone.",
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
  if (vibe) setArticleVibe(db, slug, vibe, "save");
  db.close();
  return markdown;
}

async function createTestServer(
  databasePath: string,
  llmClient?: LlmRouter,
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
class EchoRewriteLlm implements LlmRouter {
  constructor(private readonly response: string) {}
  async chat(): Promise<string> { return "{}"; }
  async streamChat(
    _r: "heavy" | "light",
    _s: string,
    _u: string,
    onChunk: (delta: string, acc: string) => void,
  ): Promise<{ content: string; finishReason: string }> {
    onChunk(this.response, this.response);
    return { content: this.response, finishReason: "stop" };
  }
  async embed(): Promise<number[][]> { return []; }
  supportsVision(): boolean { return false; }
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

test("ensureDykHasSourceLink: fact with halu link keeps canonical markdown source link", () => {
  const fact = `... [Glow Fruit](halu:glow-fruit "luminous orchard product") was discovered in the craters.`;
  const result = ensureDykHasSourceLink(fact, "glow-fruit", "Glow Fruit");
  assert.match(result, /\(halu:glow-fruit "Glow Fruit"\)/);
  assert.match(result, /was discovered in the craters/, "content should be preserved");
});

test("ensureDykHasSourceLink: fact with an existing non-source link strips it and wraps title in text", () => {
  const fact = "... [Lantern Index](/lantern-index) describes the southern craters near Glow Fruit.";
  const result = ensureDykHasSourceLink(fact, "glow-fruit", "Glow Fruit");
  assert.equal(
    result,
    '... Lantern Index describes the southern craters near [Glow Fruit](halu:glow-fruit "Glow Fruit").',
  );
});

test("ensureDykHasSourceLink: fact mentions title as plain text but has no link → title is wrapped as link", () => {
  const fact = "... Glow Fruit was discovered in the southern craters.";
  const result = ensureDykHasSourceLink(fact, "glow-fruit", "Glow Fruit");
  assert.equal(
    result,
    '... [Glow Fruit](halu:glow-fruit "Glow Fruit") was discovered in the southern craters.',
    "should wrap first title occurrence as link",
  );
  assert.doesNotMatch(result, /\/wiki\//, "must not use wiki-path format");
});

test("ensureDykHasSourceLink: fact does not mention title → restructured as '... that according to [Title], fact?'", () => {
  const fact = "... the craters glow at night due to bioluminescent fungi.";
  const result = ensureDykHasSourceLink(fact, "glow-fruit", "Glow Fruit");
  assert.match(result, /\.\.\. that according to \[Glow Fruit\]/);
  assert.match(result, /\(halu:glow-fruit "Glow Fruit"\)/);
  assert.match(result, /craters glow at night/, "original fact content preserved");
  assert.doesNotMatch(result, /\/wiki\//, "must not use wiki-path format");
});

test("ensureDykHasSourceLink: case-insensitive title match", () => {
  const fact = "... glow fruit was first catalogued in the old crater ledger.";
  const result = ensureDykHasSourceLink(fact, "glow-fruit", "Glow Fruit");
  assert.equal(result, '... [Glow Fruit](halu:glow-fruit "Glow Fruit") was first catalogued in the old crater ledger.');
});

test("normalizeHomepageFact: preserves fact wording and ends as a question", () => {
  const result = normalizeHomepageFact("Did you know... [Glow Fruit](/glow-fruit) was catalogued at dusk.");
  assert.equal(result, "... that [Glow Fruit](/glow-fruit) was catalogued at dusk?");
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

test("invalidateHomepageCache drops the cached payload so the next refresh regenerates it", (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = openDatabase(databasePath);
  t.after(() => db.close());

  saveHomepageCache(db, {
    featured: { slug: "glow-fruit", title: "Glow Fruit", summaryMarkdown: "A luminous orchard product." },
    didYouKnow: [{ slug: "glow-fruit", title: "Glow Fruit", fact: "... Glow Fruit glows at night." }],
    generatedAt: 1_720_000_000_000,
    expiresAt: 1_720_000_000_000 + 3_600_000,
  });
  assert.ok(getHomepageCache(db), "cache should be present after saving");

  invalidateHomepageCache(db);

  assert.equal(getHomepageCache(db), null, "cache should be gone after invalidation");
  // History is untouched — invalidation only clears the current cache row.
  assert.equal(listHomepageHistory(db, 10).length, 1);
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

test("POST /api/admin/reset-featured-article invalidates the cache so the homepage regenerates", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Seed a fresh (non-expired) cache — a plain maintenance trigger would
  // no-op here since refreshHomepageCacheNode skips regeneration while the
  // cache is still within its TTL. Resetting must force it regardless.
  const db = openDatabase(databasePath);
  const generatedAt = Date.now();
  saveHomepageCache(db, {
    featured: { slug: "glow-fruit", title: "Glow Fruit", summaryMarkdown: "A luminous orchard product." },
    didYouKnow: [{ slug: "glow-fruit", title: "Glow Fruit", fact: "... Glow Fruit glows at night." }],
    generatedAt,
    expiresAt: generatedAt + 3_600_000,
  });
  db.close();

  const server = await createTestServer(databasePath);
  t.after(() => server.shutdown());

  const before = await server.request("/api/homepage");
  const beforeBody = await before.json() as HomepagePayload;
  assert.equal(beforeBody.featured?.slug, "glow-fruit", "serves the seeded cache before reset");

  const res = await server.request("/api/admin/reset-featured-article", { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json() as { status: string };
  assert.equal(body.status, "triggered");

  // The cached payload (featured + DYK + timer) must be cleared as one unit
  // so the next refresh regenerates all three together — not served stale.
  const reopened = openDatabase(databasePath);
  t.after(() => reopened.close());
  assert.equal(getHomepageCache(reopened), null, "cache must be invalidated by the reset");
});

test("DYK facts always contain a canonical markdown link to source article", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const factWithoutLink = "... the bioluminescent properties were first documented in an old ledger.";
  const fixed = ensureDykHasSourceLink(factWithoutLink, "glow-fruit", "Glow Fruit");
  assert.match(fixed, /\(halu:glow-fruit "Glow Fruit"\)/);
  assert.doesNotMatch(fixed, /\/wiki\//, "DYK facts must NOT use wiki-path links");
});

/* ─────────────────────────────────────────────────────────────────
   5. DYK: already-has-slug-link is unchanged
   ───────────────────────────────────────────────────────────────── */

test("ensureDykHasSourceLink: fact already has slug link to source becomes canonical", () => {
  const fact = "... [Glow Fruit](/glow-fruit) was discovered in the craters.";
  const result = ensureDykHasSourceLink(fact, "glow-fruit", "Glow Fruit");
  assert.equal(result, '... [Glow Fruit](halu:glow-fruit "Glow Fruit") was discovered in the craters.');
});

test("ensureDykHasSourceLink: title in plain text → title is wrapped as link", () => {
  const fact = "... Glow Fruit was discovered in the southern craters.";
  const result = ensureDykHasSourceLink(fact, "glow-fruit", "Glow Fruit");
  assert.equal(result, '... [Glow Fruit](halu:glow-fruit "Glow Fruit") was discovered in the southern craters.');
  assert.doesNotMatch(result, /\/wiki\//, "must not use wiki-path format");
  assert.match(result, /was discovered/, "rest of fact preserved");
});

/* ─────────────────────────────────────────────────────────────────
   6. update-title endpoint
   ───────────────────────────────────────────────────────────────── */

test("update-title: PATCH response and subsequent GET both reflect new title", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedArticle(databasePath, "test-article", "Test article", "Body text.");
  const server = await createTestServer(databasePath);
  t.after(() => server.shutdown());

  const patchRes = await server.request("/api/article/test-article/update-title", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "A Proper New Title" }),
  });
  const patchData = await patchRes.json() as any;
  assert.equal(patchRes.status, 200, `PATCH failed: ${JSON.stringify(patchData)}`);

  assert.equal(patchData.article.title, "A Proper New Title", "PATCH response must have updated title");
  assert.doesNotMatch(patchData.article.title, /test.article/i, "title must not be slug-derived");

  // Subsequent GET must also return the updated title.
  const getRes = await server.request("/api/page/test-article");
  assert.equal(getRes.status, 200, "GET after title update must succeed");
  const getData = await getRes.json() as any;
  assert.equal(getData.article.title, "A Proper New Title", "GET after update must have new title");
});

test("update-title: display_title override does not shadow new title", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Seed with a non-empty displayTitle to simulate an article whose LLM-generated
  // title had a formatted variant stored in the display_title column.
  const db = openDatabase(databasePath);
  const markdown = "# Old Slug Title\n\nBody text.";
  saveArticle(db, {
    slug: "display-title-test",
    canonicalSlug: "display-title-test",
    title: "Old Slug Title",
    displayTitle: "Old Slug Title",  // non-empty — shadows the title column
    markdown,
    html: renderMarkdown(markdown),
    plain_text: markdownToPlainText(markdown),
    generated_at: Date.now(),
  }, [], ["display-title-test"]);
  db.close();

  const server = await createTestServer(databasePath);
  t.after(() => server.shutdown());

  const patchRes = await server.request("/api/article/display-title-test/update-title", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Completely New Title" }),
  });
  assert.equal(patchRes.status, 200);
  const data = await patchRes.json() as any;
  assert.equal(data.article.title, "Completely New Title", "title column must be updated");
  assert.ok(
    !data.article.displayTitle || data.article.displayTitle === "Completely New Title",
    `display_title must not shadow new title; got displayTitle=${data.article.displayTitle}`,
  );
});

/* ─────────────────────────────────────────────────────────────────
   7. Halu link parsing: spaces in slug, single-quote hints
   ───────────────────────────────────────────────────────────────── */

test("normalizeHaluLinks: slug with space before quote is parsed correctly", () => {
  // The slug extends to the first quote, not the first space.
  // 'example-topic- Extra-Words "hint"' → slug captures everything before '"'
  const md = `[Extra Words](halu:example-topic- Extra-Words "A hint about the topic")`;
  const normalized = normalizeHaluLinks(md);
  // After normalization the link must be in proper [label](halu:slug "hint") form with no spaces in slug
  assert.match(normalized, /\(halu:[a-z0-9-]+ "/, "slug must be normalized with space removed");
  assert.doesNotMatch(normalized, /halu:example-topic-\s+Extra/, "space must not remain in slug");

  // extractInternalLinks must successfully extract this link
  const links = extractInternalLinks(md);
  assert.equal(links.length, 1, "should extract exactly one link");
  assert.match(links[0].targetSlug, /example-topic/, "slug should contain the main identifier");
  assert.equal(links[0].hiddenHint, "A hint about the topic");
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
   8. Joining page request receives live progress and done events
   ───────────────────────────────────────────────────────────────── */

/**
 * An LLM that holds its stream response until `.release()` is called.
 * Lets tests interleave a second request while the first is mid-generation.
 */
class GatedStreamLlm implements LlmRouter {
  private gate: Promise<void>;
  private openGate!: () => void;
  private readonly body: string;
  private readonly chatFallback: string;

  constructor(body: string, chatFallback = "{}") {
    this.body = body;
    this.chatFallback = chatFallback;
    this.gate = new Promise<void>((res) => { this.openGate = res; });
  }

  release() { this.openGate(); }

  async chat(): Promise<string> { return this.chatFallback; }

  async streamChat(
    _r: "heavy" | "light",
    _s: string,
    _u: string,
    onChunk: (delta: string, acc: string) => void,
  ): Promise<{ content: string; finishReason: string }> {
    await this.gate;
    onChunk(this.body, this.body);
    return { content: this.body, finishReason: "stop" };
  }

  async embed(): Promise<number[][]> { return []; }
  supportsVision(): boolean { return false; }
  async probeConnections(): Promise<void> {}
}

test("joining page request receives live progress then done event", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const articleBody = "# Gate Test\n\nContent for gate test article.";
  const llm = new GatedStreamLlm(articleBody);
  const server = await createTestServer(databasePath, llm);
  t.after(() => server.shutdown());

  // Start first request (generation owner) — do not await.
  const firstReq = server.request("/api/page/Gate_Test");

  // Poll until the generation is in flight (slug registered) by checking the
  // 202 "generating" response from ?wait=0.
  let joined = false;
  for (let i = 0; i < 50 && !joined; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const probe = await server.request("/api/page/Gate_Test?wait=0");
    if (probe.status === 202) joined = true;
  }
  assert.ok(joined, "generation should be in-flight before releasing gate");

  // Start second request — should subscribe to the live progress stream.
  const secondReq = server.request("/api/page/Gate_Test");

  // Release the LLM so both streams can complete.
  llm.release();

  const [firstRes, secondRes] = await Promise.all([firstReq, secondReq]);
  assert.equal(firstRes.status, 200);
  assert.equal(secondRes.status, 200);

  const firstEvents = parseNdjson<{ type: string }>(await firstRes.text());
  const secondEvents = parseNdjson<{ type: string }>(await secondRes.text());

  // Both should end with a done event containing a full article.
  const firstDone = firstEvents.find((e) => e.type === "done") as { type: "done"; article?: { slug: string } } | undefined;
  const secondDone = secondEvents.find((e) => e.type === "done") as { type: "done"; article?: { slug: string } } | undefined;
  assert.ok(firstDone, "first stream should receive done event");
  assert.ok(secondDone, "joined stream should receive done event");
  assert.equal(secondDone.article?.slug, firstDone.article?.slug, "both streams should resolve to the same article");

  // The joined stream should have received at least one progress event.
  const secondProgress = secondEvents.filter((e) => e.type === "progress");
  assert.ok(secondProgress.length > 0, "joined stream should receive progress events");
});

/* ─────────────────────────────────────────────────────────────────
   9. Auto post_process is not fired when one is already in flight
   ───────────────────────────────────────────────────────────────── */

test("page load during in-flight post_process does not fire a second one", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  let postProcessCallCount = 0;
  // Slow LLM: chat responses count post_process LLM calls (see_also, summary, infobox).
  const llm: LlmRouter = {
    async chat() {
      postProcessCallCount += 1;
      // Slow enough that page loads can arrive mid-post-process.
      await new Promise((r) => setTimeout(r, 30));
      return "{}";
    },
    async streamChat(_r, _s, _u, onChunk) {
      const body = "# Race Test\n\nContent.";
      onChunk(body, body);
      return { content: body, finishReason: "stop" };
    },
    async embed() { return []; },
    supportsVision() { return false; },
    async probeConnections() {},
  };

  const server = await createTestServer(databasePath, llm);
  t.after(() => server.shutdown());

  // First request: generate the article (also fires post_process async).
  const firstRes = await server.request("/api/page/Race_Test");
  assert.equal(firstRes.status, 200);
  const firstText = await firstRes.text();
  const done = parseNdjson<{ type: string }>(firstText).find((e) => e.type === "done");
  assert.ok(done, "article should be generated");

  // Wait briefly so post_process is started but not finished.
  await new Promise((r) => setTimeout(r, 15));

  // Reset the counter so we only count calls from a potential second post_process.
  const callsBeforePageLoad = postProcessCallCount;

  // Second page load — should NOT trigger another post_process.
  const secondRes = await server.request("/api/page/Race_Test?wait=0");
  // May be 200 (article exists) or 202 (still generating); both are fine.
  assert.ok(secondRes.status === 200 || secondRes.status === 202);

  // Allow time for any spurious post_process to start.
  await new Promise((r) => setTimeout(r, 100));

  // Calls should not have increased beyond what the already-in-flight run uses.
  // The auto post_process check (activeOperations guard) should have blocked it.
  const spuriousCalls = postProcessCallCount - callsBeforePageLoad;
  // The in-flight post_process itself makes 3 chat calls (see_also, summary, infobox).
  // A second post_process would add 3 more. Allow up to 3 (the first one finishing).
  assert.ok(
    spuriousCalls <= 3,
    `expected ≤3 additional chat calls (first post_process), got ${spuriousCalls}`,
  );
});

/* ─────────────────────────────────────────────────────────────────
   10. Refresh-context normalizes markdown even without LLM rewrite
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
