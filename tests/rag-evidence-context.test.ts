import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidenceContext,
  renderArticleEvidenceText,
  toPromptSourceArticles,
  evidenceEmbeddingDiagnostics,
} from "../src/server/rag/evidenceContext";
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

test("buildEvidenceContext groups excerpts per article, deduped, preserving candidate order", () => {
  const evidence = buildEvidenceContext(
    result({
      textDocuments: [
        doc({ documentId: "a1", articleSlug: "solana", content: "body one" }),
        doc({ documentId: "a2", articleSlug: "solana", content: "body two" }),
        // Exact duplicate content for the same article is deduped.
        doc({ documentId: "a3", articleSlug: "solana", content: "body one" }),
        doc({ documentId: "b1", articleSlug: "ethereum", content: "eth body" }),
      ],
      sourceArticles: [
        { slug: "solana", title: "Solana", score: 0.5, contributingKinds: ["article_body"], provenance: "semantic" },
        { slug: "ethereum", title: "Ethereum", score: 0.4, contributingKinds: ["article_body"], provenance: "direct" },
      ],
      relatedTitles: ["Solana", "Ethereum"],
    }),
  );

  assert.deepEqual(evidence.articles.map((a) => a.slug), ["solana", "ethereum"]);
  assert.deepEqual(
    evidence.articles[0].excerpts.map((e) => e.content),
    ["body one", "body two"],
  );
  assert.deepEqual(evidence.articles[1].excerpts.map((e) => e.content), ["eth body"]);
  assert.equal(evidence.articles[0].score, 0.5);
  assert.deepEqual(evidence.relatedTitles, ["Solana", "Ethereum"]);
});

test("buildEvidenceContext separates ontology facts from prose excerpts", () => {
  const evidence = buildEvidenceContext(
    result({
      textDocuments: [
        doc({ documentId: "body-1", articleSlug: "solana", sourceKind: "article_body", content: "Solana is a blockchain." }),
        doc({ documentId: "fact-1", articleSlug: "solana", sourceKind: "ontology_fact", content: "Solana — type: blockchain", rawScore: 0.9 }),
        doc({ documentId: "fact-2", articleSlug: "solana", sourceKind: "ontology_fact", content: "Solana uses proof of history", rawScore: 0.7 }),
      ],
      sourceArticles: [
        { slug: "solana", title: "Solana", score: 0.5, contributingKinds: ["article_body", "ontology_fact"], provenance: "semantic" },
      ],
    }),
  );

  const [article] = evidence.articles;
  assert.deepEqual(article.excerpts.map((e) => e.content), ["Solana is a blockchain."]);
  assert.deepEqual(
    article.ontologyFacts,
    [
      { content: "Solana — type: blockchain", score: 0.9 },
      { content: "Solana uses proof of history", score: 0.7 },
    ],
  );
});

test("buildEvidenceContext attributes link-hint text to its target and removes exact duplicates", () => {
  const hint = "Aweewawowe: target-specific canonical context.";
  const evidence = buildEvidenceContext(
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

  assert.equal(evidence.articles.length, 1);
  // Attributed to the target, deduped despite two distinct source documents.
  assert.deepEqual(evidence.articles[0].linkHints.map((h) => h.content), [hint]);
  assert.deepEqual(evidence.articles[0].excerpts, []);
});

test("renderArticleEvidenceText renders labeled sections and omits empty ones", () => {
  const evidence = buildEvidenceContext(
    result({
      textDocuments: [
        doc({ documentId: "body-1", articleSlug: "solana", content: "Solana body excerpt." }),
        doc({ documentId: "fact-1", articleSlug: "solana", sourceKind: "ontology_fact", content: "Solana — type: blockchain" }),
      ],
      sourceArticles: [
        { slug: "solana", title: "Solana", score: 0.5, contributingKinds: ["article_body"], provenance: "semantic", summary: "Solana summary." },
      ],
    }),
  );

  const text = renderArticleEvidenceText(evidence.articles[0]);
  assert.equal(
    text,
    [
      "SUMMARY:",
      "Solana summary.",
      "",
      "RELEVANT FACTS:",
      "- Solana — type: blockchain",
      "",
      "SUPPORTING EXCERPTS:",
      "Solana body excerpt.",
    ].join("\n"),
  );
});

test("renderArticleEvidenceText returns empty string when an article has no summary, facts, or excerpts", () => {
  const evidence = buildEvidenceContext(
    result({
      sourceArticles: [
        { slug: "ghost", title: "Ghost", score: 0, contributingKinds: ["article_summary"], provenance: "direct" },
      ],
    }),
  );
  assert.equal(renderArticleEvidenceText(evidence.articles[0]), "");
});

test("toPromptSourceArticles flattens evidence into the prompt-ready shape", () => {
  const evidence = buildEvidenceContext(
    result({
      textDocuments: [doc({ documentId: "body-1", articleSlug: "solana", content: "Solana body excerpt." })],
      sourceArticles: [
        { slug: "solana", title: "Solana", score: 0.5, contributingKinds: ["article_body"], provenance: "semantic" },
      ],
    }),
  );
  const flat = toPromptSourceArticles(evidence);
  assert.deepEqual(flat, [
    { slug: "solana", title: "Solana", content: "SUPPORTING EXCERPTS:\nSolana body excerpt.", score: 0.5 },
  ]);
});

test("evidenceEmbeddingDiagnostics reports embeddings strategy + diagnostics", () => {
  const evidence = buildEvidenceContext(result());
  const embedding = evidenceEmbeddingDiagnostics(evidence);
  assert.equal(embedding.strategy, "embeddings");
  assert.equal(embedding.model, "nomic");
  assert.equal(embedding.host, "localhost");
  assert.equal(embedding.dimensions, 768);
  assert.equal(embedding.corpusChunks, 9);
});

test("evidenceEmbeddingDiagnostics reports lexical_fallback when embedding degraded", () => {
  const evidence = buildEvidenceContext(
    result({ diagnostics: { ...result().diagnostics, degraded: "embed_failed: boom" } }),
  );
  assert.equal(evidenceEmbeddingDiagnostics(evidence).strategy, "lexical_fallback");
});
