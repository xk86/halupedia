import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, saveArticle, setArticleInfobox, upsertArticleHeadlineMedia } from "../src/server/db";
import { markdownToPlainText, renderMarkdown } from "../src/server/markdown";
import { insertMedia, openMediaDatabase } from "../src/server/mediaDb";
import {
  loadEncyclopediaPdfDump,
  readPdfDumpTombstone,
  writeEncyclopediaPdfDump,
  writePdfDumpTombstone,
} from "../src/server/encyclopediaPdfDump";
import { createEncyclopediaPdfExportJobs } from "../src/server/encyclopediaPdfExportJobs";

const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR1er7kAAAAAElFTkSuQmCC";

function saveCurrentArticle(db: ReturnType<typeof openDatabase>, slug: string, title: string, markdown: string): void {
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
}

test("encyclopedia PDF dump reads live article/sidebar/media tables and writes an indexed PDF", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halu-pdf-dump-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const articlePath = join(root, "articles.sqlite");
  const mediaPath = join(root, "media.sqlite");
  const outputPath = join(root, "encyclopedia.pdf");
  const articleDb = openDatabase(articlePath);
  const mediaDb = openMediaDatabase(mediaPath);
  saveCurrentArticle(articleDb, "zeta", "Zeta", "# Zeta\n\nSee [Alpha](ref:alpha) in the current dump.");
  saveCurrentArticle(articleDb, "alpha", "Alpha", "# Alpha\n\nCurrent Alpha body.");
  setArticleInfobox(articleDb, "alpha", { title: "Alpha", groups: [{ label: "Facts", rows: [{ label: "State", value: "Current" }] }] });
  insertMedia(mediaDb, {
    id: "alpha-image",
    sha256: "a".repeat(64),
    sourceUrl: null,
    mime: "image/png",
    width: 1,
    height: 1,
    bytes: Buffer.from(TINY_PNG_B64, "base64"),
    byteSize: 1,
    modelB64: TINY_PNG_B64,
    modelMime: "image/png",
    modelWidth: 1,
    modelHeight: 1,
    description: "Alpha image",
  });
  upsertArticleHeadlineMedia(articleDb, "alpha", "alpha-image", "Current caption");
  articleDb.prepare("UPDATE articles SET generated_at = 100").run();
  articleDb.prepare("UPDATE article_infobox SET updated_at = 200 WHERE article_slug = 'alpha'").run();
  articleDb.prepare("UPDATE article_media SET updated_at = 300 WHERE article_slug = 'alpha'").run();
  articleDb.close();
  mediaDb.close();

  const dump = loadEncyclopediaPdfDump(articlePath, mediaPath);
  assert.deepEqual(dump.map((article) => article.title), ["Alpha", "Zeta"]);
  assert.equal(dump[0].markdown, "# Alpha\n\nCurrent Alpha body.");
  assert.match(dump[0].infoboxJson ?? "", /Current/);
  assert.equal(dump[0].media[0].caption, "Current caption");
  assert.ok(dump[0].media[0].bytes?.length);
  assert.deepEqual(loadEncyclopediaPdfDump(articlePath, mediaPath, 250).map((article) => article.title), ["Alpha"]);
  assert.deepEqual(loadEncyclopediaPdfDump(articlePath, mediaPath, 300), []);

  const tombstonePath = join(root, "encyclopedia.tombstone.json");
  writePdfDumpTombstone(tombstonePath, {
    version: 1,
    lastFullExtractionAt: "2026-07-15T00:00:00.000Z",
    lastPublishedAt: "2026-07-15T01:00:00.000Z",
  });
  assert.deepEqual(readPdfDumpTombstone(tombstonePath), {
    version: 1,
    lastFullExtractionAt: "2026-07-15T00:00:00.000Z",
    lastPublishedAt: "2026-07-15T01:00:00.000Z",
  });

  const logs: string[] = [];
  await writeEncyclopediaPdfDump({
    articleDatabasePath: articlePath,
    mediaDatabasePath: mediaPath,
    outputPath,
    log: (message) => logs.push(message),
  });
  assert.ok(existsSync(outputPath));
  const pdf = readFileSync(outputPath);
  assert.ok(pdf.subarray(0, 4).equals(Buffer.from("%PDF")));
  assert.match(pdf.toString("latin1"), /\/Outlines/);
  assert.ok((pdf.toString("latin1").match(/\/GoTo/g) ?? []).length >= 3, "TOC and ref link have PDF destinations");
  assert.deepEqual(logs, [
    "PDF dump: loading 2 current articles",
    "PDF dump: 1/2 Alpha",
    "PDF dump: 2/2 Zeta",
    `PDF dump: wrote ${outputPath}`,
  ]);
});

test("PDF export jobs generate off-thread and retain the full-export checkpoint", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halu-pdf-job-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const articlePath = join(root, "articles.sqlite");
  const mediaPath = join(root, "media.sqlite");
  const articleDb = openDatabase(articlePath);
  const mediaDb = openMediaDatabase(mediaPath);
  saveCurrentArticle(articleDb, "alpha", "Alpha", "# Alpha\n\nCurrent Alpha body.");
  articleDb.close();
  mediaDb.close();

  const jobs = createEncyclopediaPdfExportJobs({ articleDatabasePath: articlePath, mediaDatabasePath: mediaPath, outputDir: join(root, "output") });
  assert.equal(jobs.start("full")?.state, "running");
  const complete = await waitForJob(jobs);
  assert.equal(complete.state, "complete");
  assert.equal(complete.articleCount, 1);
  assert.equal(complete.downloads.full.available, true);

  assert.equal(jobs.start("update")?.state, "running");
  const update = await waitForJob(jobs);
  assert.equal(update.state, "no_changes");
  assert.equal(update.articleCount, 0);
  assert.equal(update.downloads.update.available, false);
});

async function waitForJob(jobs: ReturnType<typeof createEncyclopediaPdfExportJobs>) {
  const timeout = Date.now() + 20_000;
  while (jobs.status().state === "running" && Date.now() < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const status = jobs.status();
  assert.notEqual(status.state, "running", "PDF worker timed out");
  return status;
}
