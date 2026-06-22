import test from "node:test";
import assert from "node:assert/strict";
import { toLegacyView } from "../src/server/rag/retriever";
import type {
  RetrievalResult,
  RetrievedTextDocument,
} from "../src/server/rag/types";

function doc(over: Partial<RetrievedTextDocument>): RetrievedTextDocument {
  return {
    documentId: "article_body:solana#0",
    articleSlug: "solana",
    sourceKind: "article_body",
    sourceId: "solana#0",
    content: "body one",
    rawScore: 0.5,
    fusedRank: 0,
    retrievalReason: "semantic",
    provenance: "semantic",
    ...over,
  };
}

function result(over: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    textDocuments: [],
    imageDocuments: [],
    sourceArticles: [],
    relatedTitles: [],
    diagnostics: {
      profile: "article_generation",
      textEmbeddingModel: "nomic",
      servingHost: "localhost",
      vectorDimensions: 768,
      candidateTextCount: 9,
      candidateImageCount: 0,
      selectedTextCount: 0,
      selectedImageCount: 0,
      selectedKinds: [],
      exclusions: [],
    },
    ...over,
  };
}

test("toLegacyView concatenates per-article content and preserves candidate order", () => {
  const view = toLegacyView(
    result({
      textDocuments: [
        doc({ documentId: "a1", articleSlug: "solana", content: "body one" }),
        doc({ documentId: "a2", articleSlug: "solana", content: "body two" }),
        doc({ documentId: "b1", articleSlug: "ethereum", content: "eth body" }),
      ],
      sourceArticles: [
        { slug: "solana", title: "Solana", score: 0.5, contributingKinds: ["article_body"], provenance: "semantic" },
        { slug: "ethereum", title: "Ethereum", score: 0.4, contributingKinds: ["article_body"], provenance: "direct" },
      ],
      relatedTitles: ["Solana", "Ethereum"],
    }),
  );

  assert.deepEqual(view.sourceArticles.map((s) => s.slug), ["solana", "ethereum"]);
  assert.equal(view.sourceArticles[0].content, "body one\n\nbody two");
  assert.equal(view.sourceArticles[1].content, "eth body");
  assert.equal(view.sourceArticles[0].score, 0.5);
  assert.deepEqual(view.relatedTitles, ["Solana", "Ethereum"]);
});

test("toLegacyView reports embeddings strategy + diagnostics", () => {
  const view = toLegacyView(result());
  assert.equal(view.embedding.strategy, "embeddings");
  assert.equal(view.embedding.model, "nomic");
  assert.equal(view.embedding.host, "localhost");
  assert.equal(view.embedding.dimensions, 768);
  assert.equal(view.embedding.corpusChunks, 9);
});

test("toLegacyView reports lexical_fallback when embedding degraded", () => {
  const view = toLegacyView(result({ diagnostics: { ...result().diagnostics, degraded: "embed_failed: boom" } }));
  assert.equal(view.embedding.strategy, "lexical_fallback");
});

test("toLegacyView leaves content empty for a candidate with no selected docs", () => {
  const view = toLegacyView(
    result({
      sourceArticles: [
        { slug: "ghost", title: "Ghost", score: 0, contributingKinds: ["article_summary"], provenance: "direct" },
      ],
    }),
  );
  assert.equal(view.sourceArticles[0].content, "");
});

test("toLegacyView attributes link-hint text to its target and removes exact duplicates", () => {
  const hint = "Aweewawowe: target-specific canonical context.";
  const view = toLegacyView(
    result({
      textDocuments: [
        doc({
          documentId: "hint-1",
          articleSlug: "geomancy-institute",
          sourceKind: "link_hint",
          content: hint,
          metadata: { targetSlug: "aweewawowe", targetTitle: "Aweewawowe" },
        }),
        doc({
          documentId: "hint-2",
          articleSlug: "wawawawa",
          sourceKind: "link_hint",
          content: hint,
          metadata: { targetSlug: "aweewawowe", targetTitle: "Aweewawowe" },
        }),
      ],
      sourceArticles: [
        {
          slug: "aweewawowe",
          title: "Aweewawowe",
          score: 0.4,
          contributingKinds: ["link_hint"],
          provenance: "semantic",
        },
      ],
    }),
  );

  assert.deepEqual(view.sourceArticles, [
    { slug: "aweewawowe", title: "Aweewawowe", content: hint, score: 0.4 },
  ]);
});
