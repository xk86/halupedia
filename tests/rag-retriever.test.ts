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
import { retrieveContext } from "../src/server/rag/retriever";
import type { TextEmbedder } from "../src/server/rag/embeddings";
import { createOntologyDocumentProvider, loadOntologyVocabulary } from "../src/server/ontology";

const DIM = 24;
// Deterministic content-based embedder: shared salient words pull vectors close.
const embedder: TextEmbedder = {
  model: "fake",
  async embed(texts: string[]) {
    return {
      vectors: texts.map((t) => {
        const v = new Array(DIM).fill(0);
        for (const w of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
          let h = 0;
          for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) % DIM;
          v[h] += 1;
        }
        return v;
      }),
      model: "fake",
    };
  },
};

function article(slug: string, title: string, markdown: string): ArticleRecord {
  return {
    slug,
    canonicalSlug: slug,
    title,
    markdown,
    html: "",
    summaryMarkdown: `${title} summary.`,
    plain_text: markdown,
    generated_at: 1000,
  };
}

async function buildCorpus(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "halu-retr-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, "test.db"));
  const store = await RagStore.open(join(root, "rag.lance"));
  const vocab = loadOntologyVocabulary();

  saveArticle(
    db,
    article("solana", "Solana", "# Solana\n\nSolana blockchain proof of history consensus validator staking."),
    [{
      targetSlug: "proof-of-history",
      visibleLabel: "Proof of History",
      hiddenHint: "Ordering mechanism for transactions.",
    }],
    [],
    {},
  );
  saveArticle(db, article("ethereum", "Ethereum", "# Ethereum\n\nEthereum blockchain smart contracts virtual machine gas."), [], [], {});
  saveArticle(db, article("bitcoin", "Bitcoin", "# Bitcoin\n\nBitcoin blockchain mining proof of work nakamoto."), [], [], {});
  const infobox: InfoboxData = {
    title: "Ethereum",
    subtitle: "Blockchain network",
    groups: [{ label: "Ops", rows: [{ label: "Founder", value: "[Vitalik Buterin](ref:vitalik-buterin)" }, { label: "Ticker", value: "ETH" }] }],
  };
  setArticleInfobox(db, "ethereum", infobox);
  const solInfobox: InfoboxData = { title: "Solana", subtitle: "Blockchain network", groups: [{ label: "Ops", rows: [{ label: "Ticker", value: "SOL" }] }] };
  setArticleInfobox(db, "solana", solInfobox);

  for (const slug of ["solana", "ethereum", "bitcoin"]) {
    enqueueRagIndexJob(db, { articleSlug: slug, sourceKind: "article_body", sourceId: slug });
  }
  await processJobs({ db, store, embedder, extraDocuments: createOntologyDocumentProvider(db, vocab) });
  return { db, store };
}

test("semantic retrieval ranks the on-topic article first and excludes target", async (t) => {
  const { db, store } = await buildCorpus(t);
  const res = await retrieveContext(
    { db, store, embedder },
    { targetSlug: "solana", queryText: "ethereum smart contracts virtual machine gas", profile: "article_generation" },
  );
  assert.ok(!res.textDocuments.some((d) => d.articleSlug === "solana"), "target excluded");
  assert.equal(res.sourceArticles[0]?.slug, "ethereum", "most relevant article surfaced first");
  assert.ok(res.textDocuments.every((d) => d.provenance), "every doc has provenance");
});

test("blacklist/excludeSlugs removes an article from results", async (t) => {
  const { db, store } = await buildCorpus(t);
  const res = await retrieveContext(
    { db, store, embedder },
    { targetSlug: "solana", queryText: "ethereum smart contracts", excludeSlugs: ["ethereum"], profile: "article_generation" },
  );
  assert.ok(!res.textDocuments.some((d) => d.articleSlug === "ethereum"));
});

test("direct references load bounded docs with direct provenance", async (t) => {
  const { db, store } = await buildCorpus(t);
  const res = await retrieveContext(
    { db, store, embedder },
    { targetSlug: "solana", queryText: "unrelated", directSlugs: ["bitcoin"], profile: "article_rewrite" },
  );
  const direct = res.textDocuments.filter((d) => d.provenance === "direct");
  assert.ok(direct.length > 0, "direct docs present");
  assert.ok(direct.every((d) => d.articleSlug === "bitcoin"));
});

test("ontology quota guarantees symbolic facts for same-category neighbours", async (t) => {
  const { db, store } = await buildCorpus(t);
  // solana & ethereum share category "Blockchain network" -> symbolic facts pulled.
  const res = await retrieveContext(
    { db, store, embedder },
    { targetSlug: "solana", queryText: "history of validators", profile: "article_generation" },
  );
  // The ontology quota guarantees ontology facts surface; the same-category
  // neighbour (ethereum) contributes them via the symbolic path.
  const ontologyDocs = res.textDocuments.filter((d) => d.sourceKind === "ontology_fact");
  assert.ok(ontologyDocs.length > 0, "ontology facts surfaced under quota");
  assert.ok(ontologyDocs.some((d) => d.articleSlug === "ethereum"), "category neighbour facts present");
});

test("diagnostics report profile, model, and selection", async (t) => {
  const { db, store } = await buildCorpus(t);
  const res = await retrieveContext(
    { db, store, embedder },
    { targetSlug: "solana", queryText: "ethereum", profile: "article_refresh" },
  );
  assert.equal(res.diagnostics.profile, "article_refresh");
  assert.equal(res.diagnostics.textEmbeddingModel, "fake");
  assert.equal(res.diagnostics.selectedTextCount, res.textDocuments.length);
});

test("link-hint candidates are attributed to the described target", async (t) => {
  const { db, store } = await buildCorpus(t);
  const res = await retrieveContext(
    { db, store, embedder },
    {
      targetSlug: "bitcoin",
      queryText: "ordering mechanism for transactions",
      includeKinds: ["link_hint"],
      profile: "article_generation",
    },
  );

  assert.equal(res.sourceArticles[0]?.slug, "proof-of-history");
  assert.equal(res.sourceArticles[0]?.title, "proof-of-history");
  assert.ok(!res.sourceArticles.some((candidate) => candidate.slug === "solana"));
});

test("semantic retrieval excludes documents below minScore", async (t) => {
  const { db, store } = await buildCorpus(t);
  const res = await retrieveContext(
    { db, store, embedder },
    {
      targetSlug: "solana",
      queryText: "ethereum smart contracts",
      minScore: 2,
      includeKinds: ["article_body"],
      profile: "reference_search",
    },
  );

  assert.deepEqual(res.sourceArticles, []);
  assert.ok(res.diagnostics.exclusions.some((entry) => entry.reason === "below_min_score"));
});
