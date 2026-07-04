import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enqueueRagIndexJob,
  openDatabase,
  saveArticle,
  setArticleInfobox,
  type InfoboxData,
} from "../src/server/db";
import type { ArticleRecord } from "../src/server/types";
import { RagStore } from "../src/server/rag/store";
import { processJobs } from "../src/server/rag/jobs";
import type { TextEmbedder } from "../src/server/rag/embeddings";
import { createOntologyDocumentProvider, loadOntologyVocabulary } from "../src/server/ontology";

const DIM = 16;
const fakeEmbedder: TextEmbedder = {
  model: "fake",
  async embed(texts: string[]) {
    return {
      vectors: texts.map((t) => {
        const v = new Array(DIM).fill(0);
        for (let i = 0; i < t.length; i++) v[i % DIM] += t.charCodeAt(i) % 13;
        return v;
      }),
      model: "fake",
    };
  },
};

function article(slug: string): ArticleRecord {
  return {
    slug,
    canonicalSlug: slug,
    title: "Solana",
    markdown: "# Solana\n\nSolana is a blockchain network in canon.",
    html: "",
    summaryMarkdown: "A blockchain.",
    plain_text: "Solana is a blockchain.",
    generated_at: 1000,
  };
}

test("ontology facts flow through processJobs into LanceDB", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halu-ontjobs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, "test.db"));
  const store = await RagStore.open(join(root, "rag.lance"));
  const vocab = loadOntologyVocabulary();

  saveArticle(db, article("solana"), [], [], {});
  const infobox: InfoboxData = {
    title: "Solana",
    subtitle: "Blockchain network",
    groups: [
      {
        label: "Operations",
        rows: [
          { label: "Founder", value: "[Anatoly Yakovenko](ref:anatoly-yakovenko)" },
          { label: "Ticker", value: "SOL" },
        ],
      },
    ],
  };
  setArticleInfobox(db, "solana", infobox);
  enqueueRagIndexJob(db, { articleSlug: "solana", sourceKind: "article_body", sourceId: "solana" });

  await processJobs({
    db,
    store,
    embedder: fakeEmbedder,
    extraDocuments: createOntologyDocumentProvider(db, vocab),
  });

  const kinds = await store.countByKind();
  assert.ok(kinds.ontology_fact >= 2, `expected ontology_fact docs, got ${JSON.stringify(kinds)}`);

  // The consolidated fact should be retrievable as a distinct kind.
  const onto = await store.fetchByArticle("solana", ["ontology_fact"], 10);
  assert.ok(onto.some((d) => d.content.includes("ticker: SOL")));
  assert.ok(
    onto.some((d) => d.content.includes("was founded by: [Anatoly Yakovenko](ref:anatoly-yakovenko)")),
  );
});
