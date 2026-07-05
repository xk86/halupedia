import test from "node:test";
import assert from "node:assert/strict";
import { assembleEvidence, renderLinkAllowlist } from "../src/server/rag/promptAssembly";
import type { RetrievalResult, RetrievedTextDocument } from "../src/server/rag/types";

function doc(over: Partial<RetrievedTextDocument>): RetrievedTextDocument {
  return {
    documentId: "d",
    articleSlug: "ethereum",
    sourceKind: "article_body",
    sourceId: "ethereum#0",
    content: "Ethereum is a blockchain.",
    rawScore: 0.9,
    fusedRank: 0,
    retrievalReason: "semantic",
    provenance: "semantic",
    ...over,
  };
}

function result(docs: RetrievedTextDocument[], sources = [{ slug: "ethereum", title: "Ethereum", score: 0.9, contributingKinds: [], provenance: "semantic" as const }]): RetrievalResult {
  return {
    textDocuments: docs,
    imageDocuments: [],
    sourceArticles: sources,
    relatedTitles: sources.map((s) => s.title),
    diagnostics: {
      profile: "article_generation",
      candidateTextCount: docs.length,
      candidateImageCount: 0,
      selectedTextCount: docs.length,
      selectedImageCount: 0,
      selectedKinds: [],
      exclusions: [],
    },
  };
}

test("evidence is split into distinct article / infobox / ontology blocks", () => {
  const out = assembleEvidence(
    result([
      doc({ documentId: "b", sourceKind: "article_body", content: "Body prose." }),
      doc({ documentId: "i", sourceKind: "infobox_fact", content: "Fact: Token = ETH" }),
      doc({ documentId: "o", sourceKind: "ontology_fact", content: "Ethereum — type: organization; ticker: ETH" }),
    ]),
    { maxTokens: 1000 },
  );
  assert.ok(out.articleContext.includes("Body prose."));
  assert.ok(out.infoboxContext.includes("Token = ETH"));
  assert.ok(out.ontologyFacts.includes("ticker: ETH"));
  // blocks are disjoint
  assert.ok(!out.articleContext.includes("Token = ETH"));
  assert.ok(!out.infoboxContext.includes("Body prose."));
});

test("link allowlist is independent of evidence inclusion", () => {
  // A tiny budget excludes all body evidence, but the article stays linkable.
  const out = assembleEvidence(
    result([doc({ documentId: "b", sourceKind: "article_body", content: "x ".repeat(500) })]),
    { maxTokens: 5 },
  );
  assert.equal(out.articleContext, "", "evidence dropped under budget");
  assert.ok(out.decisions.some((d) => !d.included && d.reason === "over_budget"));
  assert.deepEqual(out.linkAllowlist, [{ slug: "ethereum", title: "Ethereum" }]);
  assert.equal(renderLinkAllowlist(out.linkAllowlist), "- [Ethereum](ref:ethereum)");
});

test("relatedTitles includes a summary and a ref link, even for a candidate with only a terse fact", () => {
  const out = assembleEvidence(
    result(
      [doc({ documentId: "o", sourceKind: "ontology_fact", content: "Ababa test is a thing" })],
      [
        {
          slug: "ababa-test",
          title: "Ababa test",
          score: 0.4,
          contributingKinds: ["ontology_fact"],
          provenance: "semantic",
          summary: "A recurring diagnostic naming exercise.",
        },
      ],
    ),
    { maxTokens: 1000 },
  );
  assert.equal(
    out.relatedTitles,
    "- [Ababa test](ref:ababa-test) — A recurring diagnostic naming exercise.",
  );
});

test("relatedTitles renders a plain ref link when no summary is available", () => {
  const out = assembleEvidence(result([doc({})]), { maxTokens: 1000 });
  assert.equal(out.relatedTitles, "- [Ethereum](ref:ethereum)");
});

test("bodyReserveTokens guarantees prose survives a compact-doc-heavy budget", () => {
  // Same tight budget as above, but a body reserve keeps prose in the mix.
  const out = assembleEvidence(
    result([
      doc({ documentId: "body", sourceKind: "article_body", content: "long ".repeat(20) }),
      doc({ documentId: "onto", sourceKind: "ontology_fact", content: "Ethereum — ticker: ETH" }),
      doc({ documentId: "sum", sourceKind: "article_summary", content: "A blockchain." }),
    ]),
    { maxTokens: 40, bodyReserveTokens: 30 },
  );
  const included = out.decisions.filter((d) => d.included).map((d) => d.documentId);
  assert.ok(included.includes("body"), "body kept via reserve");
  assert.ok(out.decisions.some((d) => d.documentId === "body" && d.reason === "body_reserve"));
  assert.ok(out.articleContext.includes("long"), "prose reaches the article context");
});

test("compact high-value evidence is prioritized over body under tight budget", () => {
  const out = assembleEvidence(
    result([
      doc({ documentId: "body", sourceKind: "article_body", content: "long ".repeat(60) }),
      doc({ documentId: "onto", sourceKind: "ontology_fact", content: "Ethereum — ticker: ETH" }),
      doc({ documentId: "sum", sourceKind: "article_summary", content: "A blockchain." }),
    ]),
    { maxTokens: 40 },
  );
  const included = out.decisions.filter((d) => d.included).map((d) => d.documentId);
  assert.ok(included.includes("onto"), "ontology fact kept");
  assert.ok(included.includes("sum"), "summary kept");
  assert.ok(!included.includes("body"), "body dropped first");
});
