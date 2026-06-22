import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { registerRagAdminRoutes } from "../src/server/rag/adminRoutes";
import type { RagRuntime } from "../src/server/rag/runtime";
import type {
  RetrievalResult,
  RetrieveContextArgs,
} from "../src/server/rag/types";

const retrieval: RetrievalResult = {
  textDocuments: [
    {
      documentId: "article_summary:alpha",
      articleSlug: "alpha",
      sourceKind: "article_summary",
      sourceId: "alpha",
      content: "Alpha evidence.",
      rawScore: 0.91,
      fusedRank: 0,
      retrievalReason: "semantic",
      provenance: "semantic",
    },
  ],
  imageDocuments: [],
  sourceArticles: [
    {
      slug: "alpha",
      title: "Alpha",
      score: 0.91,
      contributingKinds: ["article_summary"],
      provenance: "semantic",
    },
  ],
  relatedTitles: ["Alpha"],
  diagnostics: {
    profile: "article_generation",
    queryText: "alpha",
    textEmbeddingModel: "test-embedding",
    candidateTextCount: 1,
    candidateImageCount: 0,
    selectedTextCount: 1,
    selectedImageCount: 0,
    selectedKinds: ["article_summary"],
    exclusions: [],
  },
};

test("admin RAG query runs the structured retriever and evidence assembler", async () => {
  const calls: RetrieveContextArgs[] = [];
  const runtime = {
    async retrieve(args: RetrieveContextArgs) {
      calls.push(args);
      return retrieval;
    },
    assemble(result: RetrievalResult) {
      assert.equal(result, retrieval);
      return {
        articleContext: "[alpha]\nAlpha evidence.",
        infoboxContext: "",
        ontologyFacts: "",
        relatedTitles: "- Alpha",
        linkAllowlist: [{ slug: "alpha", title: "Alpha" }],
        decisions: [
          {
            documentId: "article_summary:alpha",
            kind: "article_summary" as const,
            included: true,
            reason: "semantic",
          },
        ],
        tokensUsed: 12,
        tokenBudget: 7000,
      };
    },
  } as unknown as RagRuntime;
  const app = new Hono();
  registerRagAdminRoutes(app, () => runtime, () => 0.4);

  const response = await app.request("/api/admin/rag/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: "Find [Alpha](ref:alpha) and [Beta](halu:beta \"hint\")",
      profile: "article_generation",
      targetSlug: "Test Target",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    {
      targetSlug: "test-target",
      queryText: "Find [Alpha](ref:alpha) and [Beta](halu:beta \"hint\")",
      directSlugs: ["alpha", "beta"],
      minScore: 0.4,
      profile: "article_generation",
    },
  ]);
  const body = (await response.json()) as any;
  assert.equal(body.retrieval.textDocuments[0].documentId, "article_summary:alpha");
  assert.equal(body.evidence.decisions[0].reason, "semantic");
  assert.deepEqual(body.request.directSlugs, ["alpha", "beta"]);
});

test("admin RAG query rejects empty queries and unknown profiles", async () => {
  const app = new Hono();
  const unusedRuntime = {} as RagRuntime;
  registerRagAdminRoutes(app, () => unusedRuntime, () => 0.4);

  const empty = await app.request("/api/admin/rag/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "" }),
  });
  assert.equal(empty.status, 400);

  const invalidProfile = await app.request("/api/admin/rag/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "alpha", profile: "legacy" }),
  });
  assert.equal(invalidProfile.status, 400);
});
