import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, saveArticle, setArticleInfobox, type InfoboxData } from "../src/server/db";
import { indexArticleOntology, loadOntologyVocabulary } from "../src/server/ontology";
import type { RagRuntime } from "../src/server/rag";
import type { RetrievalResult } from "../src/server/rag/types";
import { createSearchArticlesTool } from "../src/server/agent/tools/searchArticles";
import { createReadArticleTool } from "../src/server/agent/tools/readArticle";
import { createGetOntologyFactsTool } from "../src/server/agent/tools/ontologyFacts";
import { createFindArticlesByTitleTool } from "../src/server/agent/tools/findArticlesByTitle";
import { createExploreLinksTool } from "../src/server/agent/tools/exploreLinks";
import type { AgentToolContext } from "../src/server/agent/tools/context";
import type { SeenArticle } from "../src/server/agent/tools/context";

function makeDb(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "halu-agent-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return openDatabase(join(root, "test.db"));
}

/** A minimal fake `RagRuntime` — only `retrieve` is exercised by
 *  `search_articles`; the rest throw if a test ever calls them by mistake. */
function fakeRag(result: RetrievalResult): RagRuntime {
  return {
    store: undefined as unknown as RagRuntime["store"],
    embedder: undefined as unknown as RagRuntime["embedder"],
    vocab: undefined as unknown as RagRuntime["vocab"],
    profiles: undefined as unknown as RagRuntime["profiles"],
    retrieve: async () => result,
    assemble: () => {
      throw new Error("not exercised in this test");
    },
    drain: async () => {
      throw new Error("not exercised in this test");
    },
    reloadVocab: () => {
      throw new Error("not exercised in this test");
    },
    close: async () => {},
  };
}

function emptyDiagnostics(): RetrievalResult["diagnostics"] {
  return {
    profile: "reference_search",
    candidateTextCount: 0,
    candidateImageCount: 0,
    selectedTextCount: 0,
    selectedImageCount: 0,
    selectedKinds: [],
    exclusions: [],
  };
}

const EMPTY_RETRIEVAL: RetrievalResult = {
  textDocuments: [],
  imageDocuments: [],
  sourceArticles: [],
  relatedTitles: [],
  diagnostics: emptyDiagnostics(),
};

test("search_articles renders a condensed, ranked list", async () => {
  const result: RetrievalResult = {
    textDocuments: [],
    imageDocuments: [],
    sourceArticles: [
      {
        slug: "solana",
        title: "Solana",
        score: 0.87,
        contributingKinds: ["article_summary"],
        provenance: "semantic",
        summary: "A proof-of-history blockchain network.",
      },
    ],
    relatedTitles: [],
    diagnostics: emptyDiagnostics(),
  };
  const ctx: AgentToolContext = { db: undefined as never, rag: fakeRag(result) };
  const toolCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  ctx.onToolCall = (toolName, args) => toolCalls.push({ tool: toolName, args });

  const searchTool = createSearchArticlesTool(ctx);
  const output = await searchTool.invoke({ query: "proof of history" });

  assert.match(output as string, /Solana/);
  assert.match(output as string, /slug: solana/);
  assert.match(output as string, /0\.87/);
  assert.deepEqual(toolCalls, [
    { tool: "search_articles", args: { query: "proof of history", limit: 10 } },
  ]);
});

test("search_articles clamps a caller-supplied limit and forwards minScore", async () => {
  const ctx: AgentToolContext = { db: undefined as never, rag: fakeRag(EMPTY_RETRIEVAL) };
  const toolCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  ctx.onToolCall = (toolName, args) => toolCalls.push({ tool: toolName, args });
  const searchTool = createSearchArticlesTool(ctx);

  await searchTool.invoke({ query: "x", limit: 999, minScore: 0.5 });

  assert.deepEqual(toolCalls, [
    { tool: "search_articles", args: { query: "x", limit: 25, minScore: 0.5 } },
  ]);
});

test("search_articles inlines ontology facts per result", async () => {
  const result: RetrievalResult = {
    textDocuments: [
      {
        documentId: "d1",
        articleSlug: "solana",
        sourceKind: "ontology_fact",
        sourceId: "f1",
        content: "Solana founded_by Anatoly Yakovenko",
        rawScore: 1,
        fusedRank: 0,
        retrievalReason: "semantic",
        provenance: "semantic",
      },
    ],
    imageDocuments: [],
    sourceArticles: [
      {
        slug: "solana",
        title: "Solana",
        score: 0.87,
        contributingKinds: ["article_summary", "ontology_fact"],
        provenance: "semantic",
        summary: "A proof-of-history blockchain network.",
      },
    ],
    relatedTitles: [],
    diagnostics: emptyDiagnostics(),
  };
  const ctx: AgentToolContext = { db: undefined as never, rag: fakeRag(result) };
  const searchTool = createSearchArticlesTool(ctx);
  const output = await searchTool.invoke({ query: "solana" });
  assert.match(output as string, /Facts: Solana founded_by Anatoly Yakovenko/);
});

test("search_articles reports no matches without inventing content", async () => {
  const ctx: AgentToolContext = { db: undefined as never, rag: fakeRag(EMPTY_RETRIEVAL) };
  const searchTool = createSearchArticlesTool(ctx);
  const output = await searchTool.invoke({ query: "nonexistent topic" });
  assert.match(output as string, /No matching articles/i);
});

test("read_article returns a summary + heading outline, not the full body", async (t) => {
  const db = makeDb(t);
  saveArticle(
    db,
    {
      slug: "solana",
      canonicalSlug: "solana",
      title: "Solana",
      markdown: "# Solana\n\nIntro paragraph.\n\n## History\n\nHistory text.\n\n## Consensus\n\nConsensus text.",
      html: "",
      summaryMarkdown: "Solana is a blockchain network.",
      plain_text: "",
      generated_at: Date.now(),
    },
    [],
    [],
    {},
  );
  const ctx: AgentToolContext = { db, rag: undefined as never };
  const readTool = createReadArticleTool(ctx);

  const outline = await readTool.invoke({ slug: "solana" });
  assert.match(outline as string, /Solana is a blockchain network\./);
  assert.match(outline as string, /## History/);
  assert.match(outline as string, /## Consensus/);
  assert.doesNotMatch(outline as string, /History text\./);

  const section = await readTool.invoke({ slug: "solana", section: "History" });
  assert.match(section as string, /History text\./);
  assert.doesNotMatch(section as string, /Consensus text\./);
});

test("read_article reports a missing slug plainly", async (t) => {
  const db = makeDb(t);
  const ctx: AgentToolContext = { db, rag: undefined as never };
  const readTool = createReadArticleTool(ctx);
  const output = await readTool.invoke({ slug: "does-not-exist" });
  assert.match(output as string, /No article found/i);
});

test("find_articles_by_title returns lexical matches only", async (t) => {
  const db = makeDb(t);
  saveArticle(
    db,
    {
      slug: "solana",
      canonicalSlug: "solana",
      title: "Solana",
      markdown: "# Solana\n\nBody.",
      html: "",
      summaryMarkdown: "",
      plain_text: "",
      generated_at: Date.now(),
    },
    [],
    [],
    {},
  );
  const ctx: AgentToolContext = { db, rag: undefined as never };
  const findTool = createFindArticlesByTitleTool(ctx);
  const output = await findTool.invoke({ query: "solana" });
  assert.match(output as string, /Solana \(slug: solana\)/);

  const miss = await findTool.invoke({ query: "zzz-nonexistent" });
  assert.match(miss as string, /No articles found/i);
});

test("get_ontology_facts renders subject-predicate-object triples", async (t) => {
  const db = makeDb(t);
  const infobox: InfoboxData = {
    title: "Solana",
    subtitle: "Blockchain network",
    groups: [
      {
        rows: [{ label: "Consensus Mechanism", value: "Proof of History" }],
      },
    ],
  };
  saveArticle(
    db,
    {
      slug: "solana",
      canonicalSlug: "solana",
      title: "Solana",
      markdown: "# Solana\n\nBody.",
      html: "",
      summaryMarkdown: "",
      plain_text: "",
      generated_at: Date.now(),
    },
    [],
    [],
    {},
  );
  setArticleInfobox(db, "solana", infobox);
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox,
    vocab: loadOntologyVocabulary(),
  });

  const ctx: AgentToolContext = { db, rag: undefined as never };
  const factsTool = createGetOntologyFactsTool(ctx);
  const output = await factsTool.invoke({ slug: "solana" });
  assert.match(output as string, /Solana/);
});

test("get_ontology_facts reports an unrecorded entity plainly", async (t) => {
  const db = makeDb(t);
  const ctx: AgentToolContext = { db, rag: undefined as never };
  const factsTool = createGetOntologyFactsTool(ctx);
  const output = await factsTool.invoke({ slug: "no-such-entity" });
  assert.match(output as string, /No structured facts/i);
});

function saveStub(db: ReturnType<typeof makeDb>, slug: string, title: string, links: Array<{ targetSlug: string; visibleLabel: string; hiddenHint: string }>) {
  saveArticle(
    db,
    {
      slug,
      canonicalSlug: slug,
      title,
      markdown: `# ${title}\n\nBody.`,
      html: "",
      summaryMarkdown: "",
      plain_text: "",
      generated_at: Date.now(),
    },
    links,
    [],
    {},
  );
}

test("explore_links returns outbound links, unwritten threads, and backlinks", async (t) => {
  const db = makeDb(t);
  // alpha links out to beta (written) and gamma (never written, a thread).
  saveStub(db, "alpha", "Alpha", [
    { targetSlug: "beta", visibleLabel: "Beta", hiddenHint: "Beta funds Alpha" },
    { targetSlug: "gamma", visibleLabel: "Gamma", hiddenHint: "Gamma is Alpha's rival" },
  ]);
  // beta exists and links back to alpha — a backlink.
  saveStub(db, "beta", "Beta", [
    { targetSlug: "alpha", visibleLabel: "Alpha", hiddenHint: "" },
  ]);

  const seen: SeenArticle[] = [];
  const ctx: AgentToolContext = { db, rag: undefined as never, onArticleSeen: (a) => seen.push(a) };
  const exploreTool = createExploreLinksTool(ctx);
  const output = (await exploreTool.invoke({ slug: "alpha" })) as string;

  // Outbound: written target with hint, unwritten target flagged as a thread.
  assert.match(output, /Links out to:/);
  assert.match(output, /Beta \(slug: beta\).*Beta funds Alpha/);
  // Unwritten target has no article row, so its label falls back to the slug.
  assert.match(output, /gamma \(slug: gamma\) \[not yet written[^\]]*\].*Gamma is Alpha's rival/);
  // Backlink from beta.
  assert.match(output, /Linked to from:/);
  assert.match(output, /Beta \(slug: beta\)/);

  // Only the written neighbour (beta) is recorded as a reference candidate —
  // gamma is unwritten, so it never becomes a source. beta surfaces both as an
  // outbound link and a backlink; every sighting is tagged `via: "link"`.
  const seenSlugs = [...new Set(seen.map((s) => s.slug))];
  assert.deepEqual(seenSlugs, ["beta"]);
  assert.ok(seen.every((s) => s.via === "link"));
});

test("explore_links reports a missing slug plainly", async (t) => {
  const db = makeDb(t);
  const ctx: AgentToolContext = { db, rag: undefined as never };
  const exploreTool = createExploreLinksTool(ctx);
  const output = (await exploreTool.invoke({ slug: "does-not-exist" })) as string;
  assert.match(output, /No article found/i);
});
