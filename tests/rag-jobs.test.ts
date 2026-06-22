import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countPendingRagJobs,
  deleteArticleBySlug,
  enqueueRagIndexJob,
  openDatabase,
  saveArticle,
  setArticleInfobox,
  type InfoboxData,
} from "../src/server/db";
import type { ArticleRecord, ParsedInternalLink } from "../src/server/types";
import { RagStore } from "../src/server/rag/store";
import { processJobs } from "../src/server/rag/jobs";
import type { TextEmbedder } from "../src/server/rag/embeddings";

// Deterministic fake embedder: hashes content into a small fixed-dim vector so
// cosine queries are reproducible without a live embedding host.
const DIM = 16;
const fakeEmbedder: TextEmbedder = {
  model: "fake-embed",
  async embed(texts: string[]) {
    const vectors = texts.map((t) => {
      const v = new Array(DIM).fill(0);
      for (let i = 0; i < t.length; i++) v[i % DIM] += t.charCodeAt(i) % 13;
      return v;
    });
    return { vectors, model: "fake-embed", dimensions: DIM };
  },
};

function article(slug: string, markdown: string): ArticleRecord {
  return {
    slug,
    canonicalSlug: slug,
    title: slug.replace(/-/g, " "),
    markdown,
    html: "",
    summaryMarkdown: `Summary of ${slug}.`,
    plain_text: markdown,
    generated_at: 1000,
  };
}

async function setup(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "halu-ragjobs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, "test.db"));
  const store = await RagStore.open(join(root, "rag.lance"));
  return { db, store };
}

test("processJobs indexes a saved article's body + summary into LanceDB", async (t) => {
  const { db, store } = await setup(t);
  const links: ParsedInternalLink[] = [
    { targetSlug: "proof-of-history", visibleLabel: "Proof of History", hiddenHint: "Ordering mechanism for transactions." },
  ];
  saveArticle(db, article("solana", "# Solana\n\nSolana is a fast blockchain network in canon."), links, [], {});
  enqueueRagIndexJob(db, { articleSlug: "solana", sourceKind: "article_body", sourceId: "solana", operation: "upsert" });

  const res = await processJobs({ db, store, embedder: fakeEmbedder });
  assert.equal(res.articlesProcessed, 1);
  assert.ok(res.documentsUpserted >= 3, `expected body+summary+link_hint docs, got ${res.documentsUpserted}`);
  assert.equal(countPendingRagJobs(db), 0, "jobs marked complete");

  const kinds = await store.countByKind();
  assert.ok(kinds.article_body >= 1);
  assert.equal(kinds.article_summary, 1);
  assert.equal(kinds.link_hint, 1);
});

test("re-index picks up a new infobox (digest + facts)", async (t) => {
  const { db, store } = await setup(t);
  saveArticle(db, article("solana", "# Solana\n\nBody text for canon here."), [], [], {});
  enqueueRagIndexJob(db, { articleSlug: "solana", sourceKind: "article_body", sourceId: "solana" });
  await processJobs({ db, store, embedder: fakeEmbedder });

  const infobox: InfoboxData = {
    title: "Solana",
    subtitle: "Blockchain",
    groups: [{ label: "Ops", rows: [{ label: "Token", value: "SOL" }] }],
  };
  setArticleInfobox(db, "solana", infobox);
  enqueueRagIndexJob(db, { articleSlug: "solana", sourceKind: "infobox_digest", sourceId: "solana" });
  await processJobs({ db, store, embedder: fakeEmbedder });

  const kinds = await store.countByKind();
  assert.equal(kinds.infobox_digest, 1);
  assert.equal(kinds.infobox_fact, 1);
});

test("deleting an article removes its documents", async (t) => {
  const { db, store } = await setup(t);
  saveArticle(db, article("solana", "# Solana\n\nBody for canon."), [], [], {});
  enqueueRagIndexJob(db, { articleSlug: "solana", sourceKind: "article_body", sourceId: "solana" });
  await processJobs({ db, store, embedder: fakeEmbedder });
  assert.ok((await store.countRows()) > 0);

  deleteArticleBySlug(db, "solana");
  enqueueRagIndexJob(db, { articleSlug: "solana", sourceKind: "article_body", sourceId: "solana", operation: "delete" });
  const res = await processJobs({ db, store, embedder: fakeEmbedder });
  assert.equal(res.articlesDeleted, 1);
  assert.equal(await store.countRows(), 0);
});

test("a failing embed leaves jobs pending and prior docs intact", async (t) => {
  const { db, store } = await setup(t);
  saveArticle(db, article("solana", "# Solana\n\nBody for canon."), [], [], {});
  enqueueRagIndexJob(db, { articleSlug: "solana", sourceKind: "article_body", sourceId: "solana" });
  await processJobs({ db, store, embedder: fakeEmbedder });
  const before = await store.countRows();

  const boom: TextEmbedder = {
    model: "boom",
    embed() {
      throw new Error("embed host down");
    },
  };
  enqueueRagIndexJob(db, { articleSlug: "solana", sourceKind: "article_body", sourceId: "solana" });
  const res = await processJobs({ db, store, embedder: boom });
  assert.equal(res.failures, 1);
  assert.ok(countPendingRagJobs(db) > 0, "failed job stays pending");
  assert.equal(await store.countRows(), before, "prior docs untouched on failure");
});
