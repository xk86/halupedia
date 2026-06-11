import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, saveArticle } from "../src/server/db";
import { renderMarkdown, markdownToPlainText } from "../src/server/markdown";
import { makeVersionedCache } from "../src/server/responseCache";

function save(db: ReturnType<typeof openDatabase>, slug: string, title: string) {
  const markdown = `# ${title}\n\nBody of ${title}.`;
  saveArticle(
    db,
    {
      slug,
      canonicalSlug: slug,
      title,
      markdown,
      html: renderMarkdown(markdown),
      plain_text: markdownToPlainText(markdown),
      generated_at: 100,
      summaryMarkdown: `${title} summary.`,
    },
    [],
    [slug],
    { operation: "generate" },
  );
}

test("versioned cache serves cached body until a write occurs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-response-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, "test.db"));
  save(db, "alpha", "Alpha");

  const cache = makeVersionedCache(db);
  let builds = 0;
  const build = () => {
    builds += 1;
    return JSON.stringify({ builds });
  };

  const first = cache.get("idx:test", build);
  const second = cache.get("idx:test", build);
  assert.equal(builds, 1, "second hit should not rebuild");
  assert.equal(second.body, first.body);
  assert.equal(second.etag, first.etag);
  assert.match(first.etag, /^W\/"idx:test-\d+"$/);

  save(db, "beta", "Beta");

  const third = cache.get("idx:test", build);
  assert.equal(builds, 2, "write should invalidate the cache");
  assert.notEqual(third.etag, first.etag);
  assert.notEqual(third.body, first.body);
});

test("versioned cache keeps keys independent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-response-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, "test.db"));
  const cache = makeVersionedCache(db);

  const a = cache.get("a", () => "body-a");
  const b = cache.get("b", () => "body-b");
  assert.equal(a.body, "body-a");
  assert.equal(b.body, "body-b");
  assert.notEqual(a.etag, b.etag);
});
