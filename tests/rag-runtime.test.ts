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
import type { LlmRouter } from "../src/server/llm";
import { createRagRuntime } from "../src/server/rag/runtime";

const DIM = 24;
// Minimal fake router exposing only the embedding surface the RAG runtime uses.
const fakeLlm = {
  embeddingInfo: () => ({ enabled: true, model: "fake-embed", hosts: ["local"] }),
  async embed(input: string[]) {
    return input.map((t) => {
      const v = new Array(DIM).fill(0);
      for (const w of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        let h = 0;
        for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) % DIM;
        v[h] += 1;
      }
      return v;
    });
  },
} as unknown as LlmRouter;

function article(slug: string, title: string, md: string): ArticleRecord {
  return { slug, canonicalSlug: slug, title, markdown: md, html: "", summaryMarkdown: `${title} summary.`, plain_text: md, generated_at: 1000 };
}

test("RagRuntime indexes, retrieves, and assembles end-to-end", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halu-ragrt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, "test.db"));
  const rag = await createRagRuntime({ db, llm: fakeLlm, path: join(root, "rag.lance") });
  t.after(() => rag.close());

  saveArticle(db, article("ethereum", "Ethereum", "# Ethereum\n\nEthereum blockchain smart contracts virtual machine."), [], [], {});
  setArticleInfobox(db, "ethereum", {
    title: "Ethereum",
    subtitle: "Blockchain network",
    groups: [{ label: "Ops", rows: [{ label: "Ticker", value: "ETH" }] }],
  } satisfies InfoboxData);
  enqueueRagIndexJob(db, { articleSlug: "ethereum", sourceKind: "article_body", sourceId: "ethereum" });

  const drained = await rag.drain();
  assert.ok(drained.documentsUpserted > 0);

  const result = await rag.retrieve({
    targetSlug: "solana",
    queryText: "ethereum smart contracts virtual machine",
    profile: "article_generation",
  });
  assert.ok(result.sourceArticles.some((c) => c.slug === "ethereum"));

  const evidence = rag.assemble(result, "article_generation");
  assert.ok(evidence.linkAllowlist.some((e) => e.slug === "ethereum"));
  assert.ok(
    evidence.articleContext.length > 0 || evidence.infoboxContext.length > 0 || evidence.ontologyFacts.length > 0,
    "some evidence block populated",
  );
});
