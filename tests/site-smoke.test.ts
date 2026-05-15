import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, saveArticle } from "../src/server/db";
import { createApp } from "../src/server/index";
import { renderMarkdown, markdownToPlainText } from "../src/server/markdown";

function buildArticleMarkdown() {
  return [
    "# Test Article",
    "",
    "Halupedia links out to [Alpha](halu:alpha \"Alpha hint\"), [Beta](halu:beta \"Beta hint\"), [Gamma](halu:gamma \"Gamma hint\"), [Delta](halu:delta \"Delta hint\"), and [Epsilon](halu:epsilon \"Epsilon hint\").",
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

async function createTestServer() {
  const { root, databasePath } = createSeedDatabasePath();
  const { app } = await createApp({ databasePath, skipLlmProbe: true });
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
});
