import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, prepared, type InfoboxData } from "../src/server/db";
import {
  buildOntologyFactDocuments,
  deleteArticleOntology,
  extractDeterministic,
  indexArticleOntology,
  listArticleEntityFacts,
  loadOntologyVocabulary,
  mergeExtractions,
  validateLlmExtraction,
} from "../src/server/ontology";

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

test("deleteArticleOntology removes provenance rows and detaches entity", (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, { slug: "solana", title: "Solana", infobox: INFOBOX, vocab });
  deleteArticleOntology(db, "solana");
  const after = listArticleEntityFacts(db, "solana");
  assert.equal(after.entity, null, "owned entity detached from article");
  const relCount = prepared(db, `SELECT COUNT(*) AS n FROM entity_relations WHERE provenance_slug = 'solana'`).get() as { n: number };
  assert.equal(relCount.n, 0);
});
