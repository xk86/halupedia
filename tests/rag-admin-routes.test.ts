import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, prepared, saveArticle } from "../src/server/db";
import { loadOntologyVocabulary } from "../src/server/ontology";
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

function makeDb(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "halu-rag-admin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return openDatabase(join(root, "test.db"));
}

function seedArticle(db: ReturnType<typeof makeDb>, slug: string, title: string) {
  saveArticle(
    db,
    {
      slug,
      canonicalSlug: slug,
      title,
      markdown: `# ${title}\n\nBody.`,
      html: "",
      summaryMarkdown: "",
      plain_text: "Body.",
      generated_at: Date.now(),
    },
    [],
    [],
    {},
  );
}

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

test("admin ontology suggestions groups pending rows by article", async (t) => {
  const db = makeDb(t);
  seedArticle(db, "apple-broker", "Apple Broker");
  seedArticle(db, "citrus-processor", "Citrus Processor");
  prepared(
    db,
    `INSERT INTO ontology_suggestions
       (article_slug, subject, predicate, object, validated, created_at)
     VALUES
       ('apple-broker', 'Apple Broker', 'manages', 'orchard inventory', 1, 10),
       ('apple-broker', 'Apple Broker', 'requires_knowledge_of', 'grade standards', 0, 11),
       ('citrus-processor', 'Citrus Processor', 'interfaces_with', 'regulatory boards', 1, 12)`,
  ).run();

  const app = new Hono();
  const runtime = { vocab: loadOntologyVocabulary() } as unknown as RagRuntime;
  registerRagAdminRoutes(app, () => runtime, () => 0.4, {
    db,
    getLlm() {
      throw new Error("unused");
    },
    getPrompts() {
      throw new Error("unused");
    },
  });

  const response = await app.request("/api/admin/ontology/suggestions");

  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.articleCount, 2);
  assert.equal(body.suggestionCount, 3);
  assert.deepEqual(
    body.articles.map((article: any) => ({
      slug: article.slug,
      title: article.title,
      count: article.suggestionCount,
    })),
    [
      { slug: "apple-broker", title: "Apple Broker", count: 2 },
      { slug: "citrus-processor", title: "Citrus Processor", count: 1 },
    ],
  );
  assert.equal(body.articles[0].suggestions[0].label, "manages");
  assert.equal(body.articles[0].suggestions[0].objectHtml, "orchard inventory");
  assert.equal(body.articles[0].suggestions[1].validated, false);
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
