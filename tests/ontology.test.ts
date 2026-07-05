import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, prepared, saveArticle, type InfoboxData } from "../src/server/db";
import {
  buildOntologyFactDocuments,
  deleteArticleOntology,
  deriveLlmExtraction,
  emptyExtraction,
  extractDeterministic,
  inferRelations,
  indexArticleOntology,
  listArticleEntityFacts,
  loadOntologyVocabulary,
  mergeExtractions,
  validateLlmExtraction,
} from "../src/server/ontology";
import { sanitizeFactText } from "../src/server/ontology/extract";
import type { ArticleRecord, PromptConfig } from "../src/server/types";
import type { LlmRouter } from "../src/server/llm";

const vocab = loadOntologyVocabulary();

const INFOBOX: InfoboxData = {
  title: "Solana",
  subtitle: "Blockchain network",
  groups: [
    {
      label: "Operations",
      rows: [
        { label: "Founder", value: "[Anatoly Yakovenko](ref:anatoly-yakovenko)" },
        { label: "Ticker", value: "SOL" },
        { label: "Launched", value: "2020-03-16" },
      ],
    },
  ],
};

function makeDb(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "halu-ontology-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return openDatabase(join(root, "test.db"));
}

test("deterministic extraction maps infobox rows to typed facts + identifiers", () => {
  const res = extractDeterministic({ slug: "solana", title: "Solana", infobox: INFOBOX, vocab });
  const article = res.entities.find((e) => e.articleSlug === "solana");
  assert.equal(article?.type, "organization", "subtitle 'network' -> organization");
  // Founder maps to founded_by predicate via label_predicates
  const founded = res.relations.find((r) => r.predicate === "founded_by");
  assert.equal(founded?.object, "Anatoly Yakovenko");
  assert.equal(founded?.objectIsLiteral, false);
  // Ticker becomes an identifier, not a relation
  assert.ok(article?.identifiers?.some((i) => i.scheme === "ticker" && i.value === "SOL"));
  // ISO date literal becomes an iso_date identifier too
  assert.ok(article?.identifiers?.some((i) => i.scheme === "iso_date" && i.value === "2020-03-16"));
  assert.ok(res.categories.includes("Blockchain network"));
});

test("infobox link objects are recognized in every internal form and re-wrapped", () => {
  const infobox: InfoboxData = {
    title: "Widget",
    subtitle: "Device",
    groups: [
      {
        label: "",
        rows: [
          // Proper ref link.
          { label: "Owner", value: "[Acme Corp](ref:acme-corp)" },
          // Loose halu shorthand the model often emits.
          { label: "Part of", value: "Gadget Platform (halu:gadget-platform)" },
        ],
      },
    ],
  };
  const res = extractDeterministic({ slug: "widget", title: "Widget", infobox, vocab });
  const owned = res.relations.find((r) => r.predicate === "owned_by");
  assert.equal(owned?.object, "Acme Corp");
  assert.equal(owned?.objectSlug, "acme-corp");
  assert.equal(owned?.objectIsLiteral, false);
  const part = res.relations.find((r) => r.predicate === "part_of");
  assert.equal(part?.object, "Gadget Platform");
  assert.equal(part?.objectSlug, "gadget-platform");
  assert.equal(part?.objectIsLiteral, false);
});

test("unmapped infobox labels are preserved verbatim, not collapsed to related_to", () => {
  const infobox: InfoboxData = {
    title: "Haha test",
    subtitle: "Methodological Framework",
    groups: [
      {
        label: "Protocol Components",
        rows: [
          // Unknown label + literal value -> descriptive attribute, label kept.
          // Trailing colon is trimmed so it renders as "Hypothesis: ...".
          { label: "Hypothesis:", value: "Proposed explanation guiding the test" },
          // Unknown label + linked value -> label kept AND the link preserved.
          { label: "Builds on", value: "[Scientific Method](ref:scientific-method)" },
        ],
      },
    ],
  };
  const res = extractDeterministic({ slug: "haha-test", title: "Haha test", infobox, vocab });
  assert.ok(!res.relations.some((r) => r.predicate === "related_to"), "no related_to fabricated");
  assert.ok(!res.relations.some((r) => r.predicate.endsWith(":")), "trailing colon trimmed from labels");
  const attr = res.relations.find((r) => r.predicate === "Hypothesis");
  assert.equal(attr?.object, "Proposed explanation guiding the test");
  assert.equal(attr?.objectIsLiteral, true);
  const linked = res.relations.find((r) => r.predicate === "Builds on");
  assert.equal(linked?.object, "Scientific Method");
  assert.equal(linked?.objectSlug, "scientific-method");
  assert.equal(linked?.objectIsLiteral, false);
});

test("sanitizeFactText strips stray markup so fact text stays clean", () => {
  assert.equal(sanitizeFactText("*Pensi* nodes"), "Pensi nodes");
  assert.equal(sanitizeFactText("[Venous return abnormalities]"), "Venous return abnormalities");
  assert.equal(sanitizeFactText("see [the docs](https://x.y)"), "see the docs");
  assert.equal(sanitizeFactText("**bold** and `code`  spaced"), "bold and code spaced");
  // Underscores are preserved so slugs/identifiers aren't mangled.
  assert.equal(sanitizeFactText("let_const_static"), "let_const_static");
});

test("messy infobox values are cleaned before becoming fact literals", () => {
  const infobox: InfoboxData = {
    title: "Wenis Tissue",
    subtitle: "Anatomical Component",
    groups: [
      {
        label: "Detail",
        rows: [
          { label: "Associated Systems", value: "*Pensi* nodes [Penis pensi]" },
          { label: "Flow Issues", value: "[Venous return abnormalities in the shaft]" },
        ],
      },
    ],
  };
  const res = extractDeterministic({ slug: "wenis-tissue", title: "Wenis Tissue", infobox, vocab });
  const assoc = res.relations.find((r) => r.predicate === "Associated Systems");
  assert.equal(assoc?.object, "Pensi nodes Penis pensi", "emphasis + bare brackets stripped");
  const flow = res.relations.find((r) => r.predicate === "Flow Issues");
  assert.equal(flow?.object, "Venous return abnormalities in the shaft", "bare bracket unwrapped");
});

test("ontology fact documents render attributes with their label, links as ref-links", (t) => {
  const infobox: InfoboxData = {
    title: "Haha test",
    subtitle: "Methodological Framework",
    groups: [
      {
        label: "Protocol Components",
        rows: [{ label: "Hypothesis", value: "Proposed explanation guiding the test" }],
      },
    ],
  };
  const db = makeDb(t);
  indexArticleOntology(db, { slug: "haha-test", title: "Haha test", infobox, vocab });
  const docs = buildOntologyFactDocuments(db, "haha-test", "Haha test", Date.now(), vocab);
  const consolidated = docs.find((d) => d.sourceId === "haha-test:entity");
  assert.ok(consolidated?.content.includes("Hypothesis: Proposed explanation guiding the test"));
  assert.ok(!consolidated?.content.includes("related to"));
  const rel = docs.find((d) => d.content.includes("Hypothesis:") && d.sourceId !== "haha-test:entity");
  assert.ok(rel?.content.startsWith("Haha test — Hypothesis: Proposed explanation"));
});

test("ontology fact documents link literal objects that name a real article", (t) => {
  const db = makeDb(t);
  const mk = (slug: string, title: string): ArticleRecord => ({
    slug,
    canonicalSlug: slug,
    title,
    markdown: `# ${title}\n\nBody.`,
    html: "",
    summaryMarkdown: "",
    plain_text: "Body.",
    generated_at: 1,
  });
  // Target article exists and owns an ontology entity.
  saveArticle(db, mk("proprioception", "Proprioception"), [], [], {});
  indexArticleOntology(db, { slug: "proprioception", title: "Proprioception", infobox: null, vocab });
  // Source article with a related_to fact stored as a bare literal — the shape
  // an LLM-extracted relation that never got linked to an entity produces.
  saveArticle(db, mk("awa-test", "Awa test"), [], [], {});
  indexArticleOntology(db, { slug: "awa-test", title: "Awa test", infobox: null, vocab });
  const { entity } = listArticleEntityFacts(db, "awa-test");
  prepared(
    db,
    `INSERT INTO entity_relations (subject_entity_id, predicate, object_literal, provenance_slug, source, pinned, confidence, created_at)
     VALUES (?, 'related_to', 'Proprioception', 'awa-test', 'curated', 1, 1, ?)`,
  ).run(entity!.id, Date.now());

  const docs = buildOntologyFactDocuments(db, "awa-test", "Awa test", Date.now(), vocab);
  const linked = docs.find((d) => d.content.includes("Proprioception"));
  assert.ok(
    linked?.content.includes("[Proprioception](ref:proprioception)"),
    "literal object naming a real article resolves to a ref link",
  );
});

test("LLM extraction validation drops off-vocabulary entities and relations", () => {
  const validated = validateLlmExtraction(
    {
      entities: [
        { name: "Anatoly Yakovenko", type: "person" },
        { name: "Solana", type: "organization" },
        { name: "Bogus", type: "alien" }, // off-vocab type -> dropped
      ],
      relations: [
        { subject: "Solana", predicate: "founded_by", object: "Anatoly Yakovenko" }, // valid signature
        { subject: "Solana", predicate: "born_on", object: "Anatoly Yakovenko" }, // bad signature -> dropped
        { subject: "Solana", predicate: "teleports_to", object: "Anatoly Yakovenko" }, // unknown predicate -> dropped
      ],
      categories: ["Layer 1 blockchains"],
    },
    vocab,
  );
  assert.equal(validated.entities.length, 2);
  assert.equal(validated.relations.length, 1);
  assert.equal(validated.relations[0].predicate, "founded_by");
  assert.deepEqual(validated.categories, ["Layer 1 blockchains"]);
});

test("LLM extraction validation tolerates non-string and malformed fields", () => {
  // The model sometimes emits nested objects / numbers where strings are
  // expected; validation must coerce or skip, never throw on `.trim()`.
  const validated = validateLlmExtraction(
    {
      entities: [
        { name: "Solana", type: "organization" },
        { name: "Anatoly Yakovenko", type: "person" },
        { name: 42, type: "person" }, // non-string name -> skipped
        "garbage", // non-object entry -> skipped
      ],
      relations: [
        // object is a nested object, not a string -> must not crash, dropped.
        { subject: "Solana", predicate: "founded_by", object: { nested: true } },
        { subject: "Solana", predicate: "founded_by", object: "Anatoly Yakovenko" }, // valid
        null, // non-object entry -> skipped
      ],
      categories: ["Blockchain", 7, { bad: 1 }],
    },
    vocab,
  );
  assert.equal(validated.relations.length, 1);
  assert.equal(validated.relations[0].object, "Anatoly Yakovenko");
  assert.deepEqual(validated.categories, ["Blockchain", "7"]);
});

test("LLM extraction validation tolerates a null/garbage root", () => {
  assert.deepEqual(validateLlmExtraction(null, vocab), emptyExtraction());
  assert.deepEqual(validateLlmExtraction("nope", vocab), emptyExtraction());
});

test("indexArticleOntology persists entities, relations, categories", (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, { slug: "solana", title: "Solana", infobox: INFOBOX, vocab });
  const { entity, facts, identifiers, categories } = listArticleEntityFacts(db, "solana");
  assert.equal(entity?.entityType, "organization");
  // Every entity gets an explicit, provable is_a classification fact.
  assert.ok(facts.some((f) => f.predicate === "is_a" && f.object === "organization"));
  assert.ok(facts.some((f) => f.predicate === "founded_by" && f.object === "Anatoly Yakovenko"));
  assert.ok(identifiers.some((i) => i.value === "SOL"));
  assert.ok(categories.includes("Blockchain network"));
});

test("curated/pinned relations survive re-extraction", (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, { slug: "solana", title: "Solana", infobox: INFOBOX, vocab });
  // Simulate a curator pinning a hand-authored relation.
  const subjectId = listArticleEntityFacts(db, "solana").entity!.id;
  prepared(
    db,
    `INSERT INTO entity_relations (subject_entity_id, predicate, object_literal, provenance_slug, source, pinned, confidence, created_at)
     VALUES (?, 'related_to', 'Curated Fact', 'solana', 'curated', 1, 1, ?)`,
  ).run(subjectId, Date.now());

  // Re-extract (e.g. article edited): pinned curated relation must remain.
  indexArticleOntology(db, { slug: "solana", title: "Solana", infobox: INFOBOX, vocab });
  const facts = listArticleEntityFacts(db, "solana").facts;
  assert.ok(facts.some((f) => f.object === "Curated Fact"), "pinned curated relation survived");
});

test("ontology_fact documents are compact and provenance-tagged", (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, { slug: "solana", title: "Solana", infobox: INFOBOX, vocab });
  const docs = buildOntologyFactDocuments(db, "solana", "Solana", 1, vocab);
  assert.ok(docs.length >= 2);
  const consolidated = docs.find((d) => d.sourceId === "solana:entity");
  assert.ok(consolidated?.content.includes("type: organization"));
  assert.ok(consolidated?.content.includes("ticker: SOL"));
  // The founder is an internal link, so it must render as a ref-link.
  assert.ok(
    consolidated?.content.includes("was founded by: [Anatoly Yakovenko](ref:anatoly-yakovenko)"),
  );
  assert.ok(docs.every((d) => d.sourceKind === "ontology_fact" && d.articleSlug === "solana"));
});

test("merge prefers deterministic and dedupes", () => {
  const det = extractDeterministic({ slug: "solana", title: "Solana", infobox: INFOBOX, vocab });
  const llm = validateLlmExtraction(
    { entities: [{ name: "Solana", type: "organization" }], categories: ["Crypto"] },
    vocab,
  );
  const merged = mergeExtractions(det, llm);
  assert.ok(merged.categories.includes("Blockchain network"));
  assert.ok(merged.categories.includes("Crypto"));
});

test("inference derives inverse/symmetric relations with decayed confidence", () => {
  const inferred = inferRelations(vocab, [
    // founded_by has inverse founder_of.
    { subject: "Solana", predicate: "founded_by", object: "Anatoly Yakovenko", source: "infobox", confidence: 1 },
    // spouse_of is symmetric.
    { subject: "Alice", predicate: "spouse_of", object: "Bob", source: "infobox", confidence: 1 },
    // Literal + is_a objects must not be reversed.
    { subject: "Solana", predicate: "is_a", object: "organization", objectIsLiteral: true, source: "infobox" },
  ]);
  const inverse = inferred.find((r) => r.predicate === "founder_of");
  assert.equal(inverse?.subject, "Anatoly Yakovenko");
  assert.equal(inverse?.object, "Solana");
  assert.equal(inverse?.source, "inferred");
  assert.ok((inverse?.confidence ?? 1) < 1, "inferred confidence is decayed");
  assert.ok(inverse?.inferredFrom?.includes("founded_by"), "records its basis");
  const symmetric = inferred.find((r) => r.predicate === "spouse_of" && r.subject === "Bob");
  assert.equal(symmetric?.object, "Alice");
  // No inference off the is_a literal.
  assert.ok(!inferred.some((r) => r.predicate === "is_a"));
});

test("indexArticleOntology stores inferred relations, provable via basis", (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, { slug: "solana", title: "Solana", infobox: INFOBOX, vocab });
  // The founder relation must yield an inferred founder_of on the person entity.
  const person = listArticleEntityFacts(db, "anatoly-yakovenko");
  const founderOf = person.facts.find((f) => f.predicate === "founder_of");
  assert.ok(founderOf, "inverse founder_of inferred onto the founder");
  assert.equal(founderOf?.source, "inferred");
  assert.ok(founderOf?.inferredFrom?.includes("founded_by"));
});

const ONTOLOGY_PROMPTS = {
  prompts: {
    ontology: {
      system: "types: {{entity_types}}\npredicates: {{predicates}}",
      user: "{{requested_title}}\n{{article_body}}",
      model: "light",
      thinking: false,
      json: true,
    },
  },
  shared: {},
} as unknown as PromptConfig;

function stubLlm(reply: string, onCall: () => void): LlmRouter {
  return {
    async chat() {
      onCall();
      return reply;
    },
    supportsVision: () => false,
    async streamChat() {
      return { content: "", finishReason: "stop" };
    },
    async embed() {
      return [];
    },
    async probeConnections() {},
  } as unknown as LlmRouter;
}

test("LLM extraction is validated, merged, and cached by content hash", async (t) => {
  const db = makeDb(t);
  const article: ArticleRecord = {
    slug: "solana",
    canonicalSlug: "solana",
    title: "Solana",
    markdown: "# Solana\n\nSolana was founded by Anatoly Yakovenko.",
    html: "",
    summaryMarkdown: "",
    plain_text: "Solana was founded by Anatoly Yakovenko.",
    generated_at: 1,
  };
  saveArticle(db, article, [], [], {});

  const reply = JSON.stringify({
    entities: [
      { name: "Solana", type: "organization" },
      { name: "Anatoly Yakovenko", type: "person" },
    ],
    relations: [{ subject: "Solana", predicate: "founded_by", object: "Anatoly Yakovenko" }],
    categories: ["Blockchain networks"],
  });
  let calls = 0;
  const opts = { llm: stubLlm(reply, () => (calls += 1)), prompts: ONTOLOGY_PROMPTS };

  const first = await deriveLlmExtraction(db, vocab, article, opts);
  assert.equal(calls, 1, "model called once");
  assert.ok(first.relations.some((r) => r.predicate === "founded_by"));

  // Same content -> served from cache, no second model call.
  const second = await deriveLlmExtraction(db, vocab, article, opts);
  assert.equal(calls, 1, "cache hit avoids a second model call");
  assert.deepEqual(second.relations, first.relations);

  // Changed content -> re-derives (model called again).
  const edited = { ...article, markdown: article.markdown + " It launched in 2020." };
  await deriveLlmExtraction(db, vocab, edited, opts);
  assert.equal(calls, 2, "content change re-invokes the model");
});

test("deleteArticleOntology removes provenance rows and detaches entity", (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, { slug: "solana", title: "Solana", infobox: INFOBOX, vocab });
  deleteArticleOntology(db, "solana");
  const after = listArticleEntityFacts(db, "solana");
  assert.equal(after.entity, null, "owned entity detached from article");
  const relCount = prepared(db, `SELECT COUNT(*) AS n FROM entity_relations WHERE provenance_slug = 'solana'`).get() as { n: number };
  assert.equal(relCount.n, 0);
});
