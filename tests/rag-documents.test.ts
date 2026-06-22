import test from "node:test";
import assert from "node:assert/strict";
import type { InfoboxData } from "../src/server/db";
import {
  buildBodyDocuments,
  buildImageTextDocuments,
  buildInfoboxDigest,
  buildInfoboxFacts,
  buildLinkHintDocuments,
  buildSummaryDocument,
  contentHash,
} from "../src/server/rag/documents";
import type { TextDocumentKind } from "../src/server/rag/types";

const INFOBOX: InfoboxData = {
  title: "Solana",
  subtitle: "Blockchain network",
  groups: [
    {
      label: "Operations",
      rows: [
        { label: "Founder", value: "[Anatoly Yakovenko](ref:anatoly-yakovenko)" },
        { label: "Token", value: "SOL" },
      ],
    },
  ],
};

test("body builder produces stable ids + content hashes", () => {
  const md = "# Solana\n\nSolana is a blockchain network used widely in canon.";
  const a = buildBodyDocuments({ slug: "solana", markdown: md, updatedAt: 1 });
  const b = buildBodyDocuments({ slug: "solana", markdown: md, updatedAt: 1 });
  assert.deepEqual(a, b);
  assert.ok(a[0].documentId.startsWith("article_body:solana#"));
  assert.equal(a[0].contentHash, contentHash(a[0].content));
});

test("summary builder yields one document, null when empty", () => {
  assert.equal(buildSummaryDocument("solana", "   ", 1), null);
  const doc = buildSummaryDocument("solana", "A fast blockchain.", 5);
  assert.equal(doc?.sourceKind, "article_summary");
  assert.equal(doc?.documentId, "article_summary:solana");
});

test("infobox digest strips links and is one dense doc", () => {
  const digest = buildInfoboxDigest("solana", "Solana", INFOBOX, 1);
  assert.equal(digest?.sourceKind, "infobox_digest");
  assert.ok(digest?.content.includes("Category: Blockchain network"));
  assert.ok(digest?.content.includes("Founder = Anatoly Yakovenko"));
  assert.ok(!digest?.content.includes("ref:"), "links must be stripped");
});

test("infobox facts: one document per row with metadata", () => {
  const facts = buildInfoboxFacts("solana", "Solana", INFOBOX, 1);
  assert.equal(facts.length, 2);
  assert.deepEqual(
    facts.map((f) => f.metadata?.label),
    ["Founder", "Token"],
  );
  assert.ok(facts[0].content.includes("Infobox group: Operations"));
  assert.ok(facts[0].content.includes("Founder = Anatoly Yakovenko"));
});

test("link hints dedupe by target and carry the hint text", () => {
  const docs = buildLinkHintDocuments(
    "solana",
    [
      { targetSlug: "proof-of-history", targetTitle: "Proof of History", hint: "Ordering mechanism." },
      { targetSlug: "proof-of-history", targetTitle: "Proof of History", hint: "dup" },
      { targetSlug: "blank", hint: "" },
    ],
    1,
  );
  assert.equal(docs.length, 1);
  assert.equal(docs[0].sourceKind, "link_hint");
  assert.ok(docs[0].content.includes("Proof of History: Ordering mechanism."));
});

test("image text builder emits caption + description docs", () => {
  const docs = buildImageTextDocuments(
    "solana",
    [{ mediaId: "m1", caption: "The logo.", description: "A purple gradient mark." }],
    1,
  );
  const kinds = docs.map((d) => d.sourceKind);
  assert.deepEqual(kinds, ["image_caption", "image_description"]);
});

test("no builder ever emits a vibe document kind", () => {
  const allKinds: TextDocumentKind[] = [
    ...buildBodyDocuments({ slug: "s", markdown: "# S\n\nbody text here for canon.", updatedAt: 1 }),
    ...(buildSummaryDocument("s", "sum", 1) ? [buildSummaryDocument("s", "sum", 1)!] : []),
    ...buildInfoboxFacts("s", "S", INFOBOX, 1),
    ...buildImageTextDocuments("s", [{ mediaId: "m", caption: "c", description: "d" }], 1),
  ].map((d) => d.sourceKind);
  assert.ok(!allKinds.some((k) => String(k).includes("vibe")));
});
