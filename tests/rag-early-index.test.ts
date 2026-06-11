import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, saveArticle } from "../src/server/db";
import { renderMarkdown, markdownToPlainText } from "../src/server/markdown";
import {
  awaitPendingRagIndexing,
  indexArticleChunks,
  registerPendingRagIndex,
  retrieveContext,
} from "../src/server/retrieval";
import type { LlmRouter } from "../src/server/llm";

const noEmbedLlm = { embed: async () => [] } as unknown as LlmRouter;

function save(db: ReturnType<typeof openDatabase>, slug: string, title: string, body: string) {
  const markdown = `# ${title}\n\n${body}`;
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

test("awaitPendingRagIndexing waits for registered indexing to settle", async () => {
  let settled = false;
  let resolveIndex!: () => void;
  const indexing = new Promise<void>((resolve) => {
    resolveIndex = () => {
      settled = true;
      resolve();
    };
  });
  registerPendingRagIndex("pending-article", indexing);

  const waiter = awaitPendingRagIndexing(10_000).then(() => {
    assert.equal(settled, true, "retrieval gate opened before indexing settled");
  });
  // Give the waiter a chance to (incorrectly) resolve early.
  await new Promise((r) => setTimeout(r, 20));
  resolveIndex();
  await waiter;
});

test("awaitPendingRagIndexing times out instead of hanging on a stuck index", async () => {
  registerPendingRagIndex("stuck-article", new Promise(() => {}));
  const start = Date.now();
  await awaitPendingRagIndexing(50);
  assert.ok(Date.now() - start < 2000, "should resolve via timeout");
});

test("retrieveContext sees chunks indexed right after a save (lexical fallback)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-rag-early-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, "test.db"));

  save(db, "zorblax-prime", "Zorblax Prime", "Zorblax Prime is a crystalline moon famous for its singing caverns.");
  // Simulate the early index that buildArticle now fires immediately after persist.
  const indexing = indexArticleChunks(db, noEmbedLlm, "zorblax-prime", "Zorblax Prime is a crystalline moon famous for its singing caverns.", false, 1200);
  registerPendingRagIndex("zorblax-prime", indexing);

  const packet = await retrieveContext(
    db,
    noEmbedLlm,
    "next-article",
    ["zorblax", "crystalline", "moon"],
    true,
    "summary",
    4,
    0,
    false,
  );
  assert.ok(
    packet.sourceArticles.some((s) => s.slug === "zorblax-prime"),
    "freshly indexed article should be retrievable",
  );
});
