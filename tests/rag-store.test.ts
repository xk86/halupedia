import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RagStore } from "../src/server/rag/store";
import type { EmbeddedTextDocument } from "../src/server/rag/types";

function doc(over: Partial<EmbeddedTextDocument>): EmbeddedTextDocument {
  return {
    documentId: "article_body:solana#0",
    articleSlug: "solana",
    sourceKind: "article_body",
    sourceId: "solana#0",
    content: "Solana is a blockchain.",
    contentHash: "h1",
    sourceUpdatedAt: 1000,
    sectionPath: ["Solana", "History"],
    metadata: { foo: "bar" },
    embeddingModel: "test-embed",
    vector: [1, 0, 0],
    ...over,
  };
}

async function withStore(t: { after: (fn: () => void) => void }): Promise<RagStore> {
  const root = mkdtempSync(join(tmpdir(), "halu-ragstore-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return RagStore.open(join(root, "rag.lance"));
}

test("upsert + cosine query returns nearest with metadata + provenance", async (t) => {
  const store = await withStore(t);
  await store.upsertTextDocuments([
    doc({ documentId: "d1", sourceId: "s1", vector: [1, 0, 0], content: "alpha" }),
    doc({ documentId: "d2", sourceId: "s2", vector: [0, 1, 0], content: "beta", articleSlug: "other" }),
  ]);
  const hits = await store.queryText([1, 0, 0], { k: 2 });
  assert.equal(hits[0].documentId, "d1");
  assert.ok(hits[0].score > hits[1].score);
  assert.deepEqual(hits[0].sectionPath, ["Solana", "History"]);
  assert.equal(hits[0].metadata.foo, "bar");
});

test("upsert is idempotent on document_id (update, not duplicate)", async (t) => {
  const store = await withStore(t);
  await store.upsertTextDocuments([doc({ documentId: "d1", content: "v1" })]);
  await store.upsertTextDocuments([doc({ documentId: "d1", content: "v2" })]);
  assert.equal(await store.countRows(), 1);
  const hits = await store.queryText([1, 0, 0], { k: 1 });
  assert.equal(hits[0].content, "v2");
});

test("kind + slug filters apply server-side", async (t) => {
  const store = await withStore(t);
  await store.upsertTextDocuments([
    doc({ documentId: "b", sourceKind: "article_body", articleSlug: "solana", vector: [1, 0, 0] }),
    doc({ documentId: "s", sourceKind: "article_summary", articleSlug: "solana", vector: [1, 0, 0] }),
    doc({ documentId: "x", sourceKind: "article_body", articleSlug: "excluded", vector: [1, 0, 0] }),
  ]);
  const onlyBody = await store.queryText([1, 0, 0], { k: 10, includeKinds: ["article_summary"] });
  assert.deepEqual(onlyBody.map((h) => h.documentId), ["s"]);
  const noExcluded = await store.queryText([1, 0, 0], { k: 10, excludeSlugs: ["excluded"] });
  assert.ok(!noExcluded.some((h) => h.articleSlug === "excluded"));
});

test("deleteByArticle / deleteByArticleKinds remove only the targets", async (t) => {
  const store = await withStore(t);
  await store.upsertTextDocuments([
    doc({ documentId: "b", sourceKind: "article_body", articleSlug: "solana" }),
    doc({ documentId: "s", sourceKind: "article_summary", articleSlug: "solana" }),
    doc({ documentId: "o", articleSlug: "other" }),
  ]);
  await store.deleteByArticleKinds("solana", ["article_summary"]);
  assert.equal(await store.countRows(), 2);
  await store.deleteByArticle("solana");
  assert.equal(await store.countRows(), 1);
});

test("meta round-trips", async (t) => {
  const store = await withStore(t);
  await store.writeMeta({
    schemaVersion: 1,
    chunkerVersion: 1,
    textEmbeddingModel: "m",
    imageEmbeddingModel: "",
    vectorDimensions: 3,
    configHash: "cfg",
    sourceDatabaseId: "db",
    buildTimestamp: 42,
    buildComplete: true,
    documentCountsByKind: { article_body: 5 },
  });
  const meta = await store.readMeta();
  assert.equal(meta?.schemaVersion, 1);
  assert.equal(meta?.vectorDimensions, 3);
  assert.equal(meta?.buildComplete, true);
  assert.deepEqual(meta?.documentCountsByKind, { article_body: 5 });
});
