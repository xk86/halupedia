import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, prepared, saveArticle, setArticleInfobox, type InfoboxData } from "../src/server/db";
import { buildOntologyFactDocuments, buildOntologyGraphPayload, deleteArticleOntology, ensureArticleOntologyFresh, getArticleOntologySignature, isArticleOntologyStale, addCuratedFact, applyOntologySuggestions, deleteCuratedFact, getArticleEntityId, updateArticleEntityType, deriveLlmExtraction, emptyExtraction, extractDeterministic, inferRelations, indexArticleOntology, listArticleEntityFacts, loadOntologyVocabulary, mergeExtractions, mergeOntologyExtractions, listOntologySuggestions, resolveArticleSlugByName, validateLlmExtraction } from "../src/server/ontology";
import { sanitizeFactText } from "../src/server/ontology/extract";
import { replaceOntologySuggestions } from "../src/server/ontology/suggestions";
import type { ArticleRecord, PromptConfig } from "../src/server/types";
import type { LlmRouter } from "../src/server/llm";
import { extractOntologyNode } from "../src/server/pipeline/nodes/postProcess";
import { initialPipelineState } from "../src/server/pipeline/state";
import { randomUUID } from "node:crypto";

const vocab = loadOntologyVocabulary();

const INFOBOX: InfoboxData = {
  title: "Solana",
  subtitle: "Blockchain network",
  groups: [
    {
      label: "Operations",
      rows: [
        {
          label: "Founder",
          value: "[Anatoly Yakovenko](ref:anatoly-yakovenko)",
        },
        { label: "Ticker", value: "SOL" },
        { label: "Launched", value: "2020-03-16" },
      ],
    },
  ],
};

test("a personal honorific in the title classifies as person even when the subtitle doesn't match any keyword", () => {
  const infobox: InfoboxData = {
    title: "Mr. Test",
    subtitle: "Diagnostic Expert",
    groups: [{ label: "", rows: [{ label: "Expertise", value: "Diagnostician" }] }],
  };
  const res = extractDeterministic({
    slug: "mr-test",
    title: "Mr. Test",
    infobox,
    vocab,
  });
  const article = res.entities.find((e) => e.articleSlug === "mr-test");
  assert.equal(article?.type, "person", "'Mr.' honorific overrides an unmatched role subtitle");
  assert.ok(res.relations.some((r) => r.predicate === "is_a" && r.object === "person"));
});

test("mergeOntologyExtractions replaces a broad infobox fact with covered model facts", () => {
  const deterministic = {
    entities: [{ name: "Subject", type: "thing", articleSlug: "subject" }],
    relations: [
      {
        subject: "Subject",
        predicate: "Primary Action",
        object: "Potent catalyst; irreversible structural change",
        objectIsLiteral: true,
        source: "infobox" as const,
      },
    ],
    categories: [],
  };
  const llm = {
    entities: [{ name: "Subject", type: "thing" }],
    relations: [
      {
        subject: "Subject",
        predicate: "causes",
        object: "irreversible structural change",
        source: "extracted" as const,
      },
    ],
    categories: [],
  };

  assert.equal(mergeExtractions(deterministic, llm).relations.length, 2);
  assert.deepEqual(mergeOntologyExtractions(deterministic, llm).relations, llm.relations);
});

test("persisted ontology suggestions support per-row append and merge", (t) => {
  const db = makeDb(t);
  saveArticle(
    db,
    {
      slug: "subject",
      canonicalSlug: "subject",
      title: "Subject",
      markdown: "# Subject\n\nBody.",
      html: "",
      summaryMarkdown: "",
      plain_text: "Body.",
      generated_at: Date.now(),
    },
    [],
    [],
    {},
  );
  setArticleInfobox(db, "subject", {
    title: "Subject",
    subtitle: "Thing",
    groups: [
      {
        rows: [
          {
            label: "Primary Action",
            value: "Potent catalyst; irreversible structural change",
          },
        ],
      },
    ],
  });
  indexArticleOntology(db, {
    slug: "subject",
    title: "Subject",
    infobox: {
      title: "Subject",
      subtitle: "Thing",
      groups: [
        {
          rows: [
            {
              label: "Primary Action",
              value: "Potent catalyst; irreversible structural change",
            },
          ],
        },
      ],
    },
    vocab,
  });
  prepared(
    db,
    `INSERT INTO ontology_suggestions
       (article_slug, subject, predicate, object, validated, created_at)
     VALUES ('subject', 'Subject', 'acts_as', 'catalyst', 1, 1),
            ('subject', 'Subject', 'causes', 'irreversible structural change', 1, 2)`,
  ).run();
  const [appendSuggestion, mergeSuggestion] = listOntologySuggestions(db, "subject");

  assert.deepEqual(applyOntologySuggestions(db, "subject", "append", [appendSuggestion.id]), { applied: 1, removedInfoboxRelations: 0 });
  assert.ok(listArticleEntityFacts(db, "subject").facts.some((fact) => fact.source === "infobox" && fact.predicate === "Primary Action"));

  assert.deepEqual(applyOntologySuggestions(db, "subject", "merge", [mergeSuggestion.id]), { applied: 1, removedInfoboxRelations: 1 });
  const facts = listArticleEntityFacts(db, "subject").facts;
  assert.ok(!facts.some((fact) => fact.source === "infobox" && fact.predicate === "Primary Action"));
  assert.ok(facts.some((fact) => fact.source === "curated" && fact.predicate === "causes"));
  assert.equal(listOntologySuggestions(db, "subject").length, 0);
});

test("a personal honorific still classifies as person with no infobox at all", () => {
  const res = extractDeterministic({
    slug: "dr-okafor",
    title: "Dr. Okafor",
    infobox: null,
    vocab,
  });
  const article = res.entities.find((e) => e.articleSlug === "dr-okafor");
  assert.equal(article?.type, "person");
});

test("curated entity type edits update the article entity and is_a fact", (t) => {
  const db = makeDb(t);
  saveArticle(
    db,
    {
      slug: "subject",
      canonicalSlug: "subject",
      title: "Subject",
      markdown: "# Subject\n\nBody.",
      html: "",
      summaryMarkdown: "",
      plain_text: "Body.",
      generated_at: Date.now(),
    },
    [],
    [],
    {},
  );
  indexArticleOntology(db, {
    slug: "subject",
    title: "Subject",
    infobox: { title: "Subject", subtitle: "Thing", groups: [] },
    vocab,
  });

  assert.equal(updateArticleEntityType(db, "subject", "person"), true);
  const { entity, facts } = listArticleEntityFacts(db, "subject");
  assert.equal(entity?.entityType, "person");
  assert.ok(facts.some((fact) => fact.predicate === "is_a" && fact.object === "person"));
});

test("updateArticleEntityType absorbs a conflicting entity with the target type", (t) => {
  const db = makeDb(t);
  saveArticle(
    db,
    {
      slug: "subject",
      canonicalSlug: "subject",
      title: "Subject",
      markdown: "# Subject\n\nBody.",
      html: "",
      summaryMarkdown: "",
      plain_text: "Body.",
      generated_at: Date.now(),
    },
    [],
    [],
    {},
  );
  indexArticleOntology(db, {
    slug: "subject",
    title: "Subject",
    infobox: { title: "Subject", subtitle: "Thing", groups: [] },
    vocab,
  });

  // Manually insert a conflicting entity with the same name but target type,
  // simulating a stale duplicate left over from a vocabulary change.
  prepared(
    db,
    `INSERT INTO entities (canonical_name, entity_type, article_slug, description, created_at, updated_at)
     VALUES (?, ?, NULL, '', ?, ?)`,
  ).run("Subject", "person", Date.now(), Date.now());

  const conflict = prepared(
    db,
    `SELECT id FROM entities WHERE canonical_name = 'Subject' AND entity_type = 'person'`,
  ).get() as { id: number };
  assert.ok(conflict, "conflicting entity exists before update");

  assert.equal(updateArticleEntityType(db, "subject", "person"), true);
  const { entity } = listArticleEntityFacts(db, "subject");
  assert.equal(entity?.entityType, "person");

  const stale = prepared(
    db,
    `SELECT id FROM entities WHERE id = ?`,
  ).get(conflict.id) as { id: number } | undefined;
  assert.equal(stale, undefined, "conflicting entity was absorbed");
});

test("an unrelated word starting with an honorific-like prefix is not misclassified", () => {
  const infobox: InfoboxData = {
    title: "Drought",
    subtitle: "Climate phenomenon",
    groups: [],
  };
  const res = extractDeterministic({
    slug: "drought",
    title: "Drought",
    infobox,
    vocab,
  });
  const article = res.entities.find((e) => e.articleSlug === "drought");
  assert.notEqual(article?.type, "person");
});

function makeDb(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "halu-ontology-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return openDatabase(join(root, "test.db"));
}

test("ontology graph payload map-reduces facts into semantic metrics and coverage", (t) => {
  const db = makeDb(t);
  saveArticle(
    db,
    {
      slug: "acme-labs",
      canonicalSlug: "acme-labs",
      title: "Acme Labs",
      markdown: "# Acme Labs\n\nBody.",
      html: "",
      summaryMarkdown: "",
      plain_text: "Body.",
      generated_at: Date.now(),
    },
    [],
    [],
    {},
  );
  saveArticle(
    db,
    {
      slug: "ada-person",
      canonicalSlug: "ada-person",
      title: "Ada Person",
      markdown: "# Ada Person\n\nBody.",
      html: "",
      summaryMarkdown: "",
      plain_text: "Body.",
      generated_at: Date.now(),
    },
    [],
    [],
    {},
  );
  const now = Date.now();
  prepared(
    db,
    `INSERT INTO entities (id, canonical_name, entity_type, article_slug, description, created_at, updated_at)
     VALUES (1, 'Acme Labs', 'organization', 'acme-labs', 'test organization', ?, ?),
            (2, 'Ada Person', 'person', 'ada-person', 'test founder', ?, ?),
            (3, 'Loose Literal', 'thing', NULL, '', ?, ?)`,
  ).run(now, now, now, now, now, now);
  prepared(
    db,
    `INSERT INTO entity_relations
       (subject_entity_id, predicate, object_entity_id, object_literal, provenance_slug, provenance_revision_id, source, confidence, pinned, inferred_from, created_at)
     VALUES
       (1, 'founded_by', 2, NULL, 'acme-labs', NULL, 'extracted', 0.61, 0, NULL, ?),
       (1, 'founded_by', 2, NULL, 'acme-labs', NULL, 'curated', 1, 1, NULL, ?),
       (1, 'headquartered_in', NULL, 'Nowhere', 'acme-labs', NULL, 'infobox', 0.82, 0, NULL, ?)`,
  ).run(now, now, now);
  prepared(
    db,
    `INSERT INTO article_ontology_state (article_slug, signature, updated_at)
     VALUES ('acme-labs', ?, ?)`,
  ).run(vocab.signature, now);

  const payload = buildOntologyGraphPayload(db, vocab);

  assert.equal(payload.version, 1);
  assert.ok(payload.analysis.stages.includes("reduce:dedupe-facts"));
  assert.ok(payload.analysis.metrics.includes("pagerank"));
  assert.equal(payload.coverage.articleCount, 2);
  assert.equal(payload.coverage.entityCount, 3);
  assert.equal(payload.coverage.articleEntityCount, 2);
  assert.equal(payload.coverage.articlesWithoutEntityCount, 0);
  assert.equal(payload.coverage.relationCount, 2, "duplicate entity relation is reduced to the curated row");
  assert.equal(payload.coverage.entityEdgeCount, 1);
  assert.equal(payload.coverage.literalFactCount, 1);
  assert.equal(payload.coverage.lowConfidenceRelationCount, 0, "curated duplicate wins over low-confidence extracted row");
  assert.equal(payload.coverage.staleArticleCount, 1, "articles without a matching ontology signature are stale");

  const founded = payload.relations.find((relation) => relation.predicate === "founded_by");
  assert.equal(founded?.sourceKind, "curated");
  assert.equal(founded?.pinned, true);
  assert.equal(payload.predicates.find((predicate) => predicate.name === "founded_by")?.relationCount, 1);
  assert.equal(payload.entityTypes.find((type) => type.type === "organization")?.literalFactCount, 1);
  assert.ok(payload.nodes.find((node) => node.label === "Acme Labs")?.metrics.pagerank !== undefined);
});

test("deterministic extraction maps infobox rows to typed facts + identifiers", () => {
  const res = extractDeterministic({
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
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
  const res = extractDeterministic({
    slug: "widget",
    title: "Widget",
    infobox,
    vocab,
  });
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
          {
            label: "Hypothesis:",
            value: "Proposed explanation guiding the test",
          },
          // Unknown label + linked value -> label kept AND the link preserved.
          {
            label: "Builds on",
            value: "[Scientific Method](ref:scientific-method)",
          },
        ],
      },
    ],
  };
  const res = extractDeterministic({
    slug: "haha-test",
    title: "Haha test",
    infobox,
    vocab,
  });
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

test("sanitizeFactText unwraps links/bare-brackets but leaves real emphasis alone", () => {
  // Legitimate italics/bold/code are formatting, not stray markup — kept as-is.
  assert.equal(sanitizeFactText("*Pensi* nodes"), "*Pensi* nodes");
  assert.equal(sanitizeFactText("**bold** and `code`  spaced"), "**bold** and `code` spaced");
  // Bare [brackets] with no link target and markdown links both unwrap to plain text.
  assert.equal(sanitizeFactText("[Venous return abnormalities]"), "Venous return abnormalities");
  assert.equal(sanitizeFactText("see [the docs](https://x.y)"), "see the docs");
  // Underscores are preserved so slugs/identifiers aren't mangled.
  assert.equal(sanitizeFactText("let_const_static"), "let_const_static");
});

test("messy infobox values are cleaned without touching legitimate emphasis", () => {
  const infobox: InfoboxData = {
    title: "Wenis Tissue",
    subtitle: "Anatomical Component",
    groups: [
      {
        label: "Detail",
        rows: [
          { label: "Associated Systems", value: "*Pensi* nodes [Penis pensi]" },
          {
            label: "Flow Issues",
            value: "[Venous return abnormalities in the shaft]",
          },
        ],
      },
    ],
  };
  const res = extractDeterministic({
    slug: "wenis-tissue",
    title: "Wenis Tissue",
    infobox,
    vocab,
  });
  const assoc = res.relations.find((r) => r.predicate === "Associated Systems");
  assert.equal(assoc?.object, "*Pensi* nodes Penis pensi", "emphasis kept, bare bracket unwrapped");
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
        rows: [
          {
            label: "Hypothesis",
            value: "Proposed explanation guiding the test",
          },
        ],
      },
    ],
  };
  const db = makeDb(t);
  indexArticleOntology(db, {
    slug: "haha-test",
    title: "Haha test",
    infobox,
    vocab,
  });
  const docs = buildOntologyFactDocuments(db, "haha-test", "Haha test", Date.now(), vocab);
  const consolidated = docs.find((d) => d.sourceId === "haha-test:entity");
  assert.ok(consolidated?.content.includes("Hypothesis: Proposed explanation guiding the test"));
  assert.ok(!consolidated?.content.includes("related to"));
  const rel = docs.find((d) => d.content.includes("Hypothesis:") && d.sourceId !== "haha-test:entity");
  assert.ok(rel?.content.startsWith("Haha test — Hypothesis: Proposed explanation"));
});

test("resolveArticleSlugByName matches case-insensitively and via aliases", (t) => {
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
  saveArticle(db, mk("global-reporting-desk", "Global Reporting Desk"), [], [], {});
  saveArticle(db, mk("triton-institute", "Triton Institute of Applied Phasing"), [], [], {});
  prepared(db, `INSERT INTO article_aliases (alias_slug, article_slug) VALUES (?, ?)`).run("tiap", "triton-institute");

  // Case-insensitive direct title match — the LLM rarely gets casing exact.
  assert.equal(resolveArticleSlugByName(db, "global reporting desk"), "global-reporting-desk");
  assert.equal(resolveArticleSlugByName(db, "GLOBAL REPORTING DESK"), "global-reporting-desk");
  // Article alias slug match.
  assert.equal(resolveArticleSlugByName(db, "TIAP"), "triton-institute");
  // No backing article at all -> null, never fabricates a link.
  assert.equal(resolveArticleSlugByName(db, "Nonexistent Thing"), null);
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
  indexArticleOntology(db, {
    slug: "proprioception",
    title: "Proprioception",
    infobox: null,
    vocab,
  });
  // Source article with a related_to fact stored as a bare literal — the shape
  // an LLM-extracted relation that never got linked to an entity produces.
  saveArticle(db, mk("awa-test", "Awa test"), [], [], {});
  indexArticleOntology(db, {
    slug: "awa-test",
    title: "Awa test",
    infobox: null,
    vocab,
  });
  const { entity } = listArticleEntityFacts(db, "awa-test");
  prepared(
    db,
    `INSERT INTO entity_relations (subject_entity_id, predicate, object_literal, provenance_slug, source, pinned, confidence, created_at)
     VALUES (?, 'related_to', 'Proprioception', 'awa-test', 'curated', 1, 1, ?)`,
  ).run(entity!.id, Date.now());

  const docs = buildOntologyFactDocuments(db, "awa-test", "Awa test", Date.now(), vocab);
  const linked = docs.find((d) => d.content.includes("Proprioception"));
  assert.ok(linked?.content.includes("[Proprioception](ref:proprioception)"), "literal object naming a real article resolves to a ref link");
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
        {
          subject: "Solana",
          predicate: "founded_by",
          object: "Anatoly Yakovenko",
        }, // valid signature
        {
          subject: "Solana",
          predicate: "born_on",
          object: "Anatoly Yakovenko",
        }, // bad signature -> dropped
        {
          subject: "Solana",
          predicate: "teleports_to",
          object: "Anatoly Yakovenko",
        }, // unknown predicate -> dropped
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
        {
          subject: "Solana",
          predicate: "founded_by",
          object: { nested: true },
        },
        {
          subject: "Solana",
          predicate: "founded_by",
          object: "Anatoly Yakovenko",
        }, // valid
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
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
  const { entity, facts, identifiers, categories } = listArticleEntityFacts(db, "solana");
  assert.equal(entity?.entityType, "organization");
  // Every entity gets an explicit, provable is_a classification fact.
  assert.ok(facts.some((f) => f.predicate === "is_a" && f.object === "organization"));
  assert.ok(facts.some((f) => f.predicate === "founded_by" && f.object === "Anatoly Yakovenko"));
  assert.ok(identifiers.some((i) => i.value === "SOL"));
  assert.ok(categories.includes("Blockchain network"));
});

test("ontology staleness tracks the vocabulary signature; lazy refresh re-extracts", (t) => {
  const db = makeDb(t);
  const article: ArticleRecord = {
    slug: "solana",
    canonicalSlug: "solana",
    title: "Solana",
    markdown: "# Solana",
    html: "",
    summaryMarkdown: "",
    plain_text: "Solana",
    generated_at: 1,
  };
  saveArticle(db, article, [], [], {});
  setArticleInfobox(db, "solana", INFOBOX, "test");

  // First extraction stamps the current signature; the article is now fresh.
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
  assert.equal(getArticleOntologySignature(db, "solana"), vocab.signature);
  assert.equal(isArticleOntologyStale(db, "solana", vocab), false);
  assert.equal(ensureArticleOntologyFresh(db, "solana", vocab), false, "no work when fresh");

  // A vocabulary whose predicates changed has a different signature -> stale.
  const evolved = { ...vocab, signature: "changed-signature" };
  assert.equal(isArticleOntologyStale(db, "solana", evolved), true);

  // Lazy refresh re-extracts deterministically and re-stamps the new signature.
  assert.equal(ensureArticleOntologyFresh(db, "solana", evolved), true, "re-extracted when stale");
  assert.equal(getArticleOntologySignature(db, "solana"), "changed-signature");
  assert.equal(isArticleOntologyStale(db, "solana", evolved), false);
});

test("addCuratedFact/deleteCuratedFact manage hand-authored, re-extraction-safe facts", (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
  const subjectId = getArticleEntityId(db, "solana")!;

  const id = addCuratedFact(db, {
    subjectId,
    predicate: "related_to",
    objectLiteral: "Hand Authored",
    provenanceSlug: "solana",
  });
  assert.ok(id > 0);
  const added = listArticleEntityFacts(db, "solana").facts.find((f) => f.object === "Hand Authored");
  assert.equal(added?.source, "curated");
  assert.equal(added?.pinned, 1);

  // Adding the identical fact again is idempotent (same row id).
  assert.equal(
    addCuratedFact(db, {
      subjectId,
      predicate: "related_to",
      objectLiteral: "Hand Authored",
      provenanceSlug: "solana",
    }),
    id,
  );

  // Survives re-extraction, then can be deleted; an extracted fact cannot.
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
  assert.ok(listArticleEntityFacts(db, "solana").facts.some((f) => f.object === "Hand Authored"));

  const extractedId = listArticleEntityFacts(db, "solana").facts.find((f) => f.source === "infobox")!.relationId;
  assert.equal(deleteCuratedFact(db, "solana", extractedId), false, "extracted facts are not hand-deletable");
  assert.equal(deleteCuratedFact(db, "solana", id), true);
  assert.ok(!listArticleEntityFacts(db, "solana").facts.some((f) => f.object === "Hand Authored"));
});

test("re-extraction reconciles incrementally: unchanged facts keep their id; gone facts removed; new added", (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
  const before = listArticleEntityFacts(db, "solana").facts;
  const isAId = before.find((f) => f.predicate === "is_a")!.relationId;
  const foundedId = before.find((f) => f.predicate === "founded_by")!.relationId;

  // Re-extract from the identical infobox: every fact keeps its row id (so the
  // RAG ontology_fact docs keyed on the id don't churn).
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
  const same = listArticleEntityFacts(db, "solana").facts;
  assert.equal(same.find((f) => f.predicate === "is_a")!.relationId, isAId, "is_a id stable");
  assert.equal(same.find((f) => f.predicate === "founded_by")!.relationId, foundedId, "founded_by id stable");

  // Re-extract from a changed infobox: Founder dropped, Region added. The
  // founded_by fact is removed; a located_in fact appears; is_a keeps its id.
  const changed: InfoboxData = {
    title: "Solana",
    subtitle: "Blockchain network",
    groups: [{ label: "Operations", rows: [{ label: "Region", value: "Global" }] }],
  };
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: changed,
    vocab,
  });
  const after = listArticleEntityFacts(db, "solana").facts;
  assert.equal(after.find((f) => f.predicate === "is_a")!.relationId, isAId, "is_a id survived the change");
  assert.ok(!after.some((f) => f.predicate === "founded_by"), "unsupported founded_by removed");
  assert.ok(
    after.some((f) => f.predicate === "located_in" && f.object === "Global"),
    "new located_in added",
  );
});

test("curated/pinned relations survive re-extraction", (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
  // Simulate a curator pinning a hand-authored relation.
  const subjectId = listArticleEntityFacts(db, "solana").entity!.id;
  prepared(
    db,
    `INSERT INTO entity_relations (subject_entity_id, predicate, object_literal, provenance_slug, source, pinned, confidence, created_at)
     VALUES (?, 'related_to', 'Curated Fact', 'solana', 'curated', 1, 1, ?)`,
  ).run(subjectId, Date.now());

  // Re-extract (e.g. article edited): pinned curated relation must remain.
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
  const facts = listArticleEntityFacts(db, "solana").facts;
  assert.ok(
    facts.some((f) => f.object === "Curated Fact"),
    "pinned curated relation survived",
  );
});

test("reclassifying an article's subject on re-extraction updates its entity row instead of duplicating it", (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
  const originalId = getArticleEntityId(db, "solana");
  assert.ok(originalId !== null);

  // Simulate the admin applying a suggested type change away from what the
  // deterministic classifier currently computes for this infobox.
  assert.ok(updateArticleEntityType(db, "solana", "concept"));
  assert.equal(getArticleEntityId(db, "solana"), originalId, "type change updates the same row");

  // Re-extraction recomputes the deterministic type from the (unchanged)
  // infobox subtitle, which no longer matches "concept" — this must land on
  // the same entity row, not INSERT a second one for the same article.
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
  const rows = prepared(db, `SELECT id, entity_type FROM entities WHERE article_slug = ?`).all(
    "solana",
  ) as Array<{ id: number; entity_type: string }>;
  assert.equal(rows.length, 1, "exactly one entity row remains for the article");
  assert.equal(rows[0].id, originalId, "the surviving row is the original one, not a new duplicate");
});

test("ontology_fact documents are compact and provenance-tagged", (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
  const docs = buildOntologyFactDocuments(db, "solana", "Solana", 1, vocab);
  assert.ok(docs.length >= 2);
  const consolidated = docs.find((d) => d.sourceId === "solana:entity");
  assert.ok(consolidated?.content.includes("type: organization"));
  assert.ok(consolidated?.content.includes("ticker: SOL"));
  // The founder is an internal link, so it must render as a ref-link.
  assert.ok(consolidated?.content.includes("was founded by: [Anatoly Yakovenko](ref:anatoly-yakovenko)"));
  assert.ok(docs.every((d) => d.sourceKind === "ontology_fact" && d.articleSlug === "solana"));
});

test("merge prefers deterministic and dedupes", () => {
  const det = extractDeterministic({
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
  const llm = validateLlmExtraction(
    {
      entities: [{ name: "Solana", type: "organization" }],
      categories: ["Crypto"],
    },
    vocab,
  );
  const merged = mergeExtractions(det, llm);
  assert.ok(merged.categories.includes("Blockchain network"));
  assert.ok(merged.categories.includes("Crypto"));
});

test("inference derives inverse/symmetric relations with decayed confidence", () => {
  const inferred = inferRelations(vocab, [
    // founded_by has inverse founder_of.
    {
      subject: "Solana",
      predicate: "founded_by",
      object: "Anatoly Yakovenko",
      source: "infobox",
      confidence: 1,
    },
    // spouse_of is symmetric.
    {
      subject: "Alice",
      predicate: "spouse_of",
      object: "Bob",
      source: "infobox",
      confidence: 1,
    },
    // Literal + is_a objects must not be reversed.
    {
      subject: "Solana",
      predicate: "is_a",
      object: "organization",
      objectIsLiteral: true,
      source: "infobox",
    },
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
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
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
    relations: [
      {
        subject: "Solana",
        predicate: "founded_by",
        object: "Anatoly Yakovenko",
      },
    ],
    categories: ["Blockchain networks"],
  });
  let calls = 0;
  const opts = {
    llm: stubLlm(reply, () => (calls += 1)),
    prompts: ONTOLOGY_PROMPTS,
  };

  const first = await deriveLlmExtraction(db, vocab, article, opts);
  assert.equal(calls, 1, "model called once");
  assert.equal(first.called, true);
  assert.equal(first.reason, "first_extraction");
  assert.ok(first.extraction.relations.some((r) => r.predicate === "founded_by"));

  // Same content -> served from cache, no second model call.
  const second = await deriveLlmExtraction(db, vocab, article, opts);
  assert.equal(calls, 1, "cache hit avoids a second model call");
  assert.equal(second.called, false);
  assert.equal(second.reason, "cache_hit");
  assert.deepEqual(second.extraction.relations, first.extraction.relations);

  // Changed content -> re-derives (model called again).
  const edited = {
    ...article,
    markdown: article.markdown + " It launched in 2020.",
  };
  const third = await deriveLlmExtraction(db, vocab, edited, opts);
  assert.equal(calls, 2, "content change re-invokes the model");
  assert.equal(third.called, true);
  assert.equal(third.reason, "content_changed");
});

test("LLM reevaluation feeds the article's currently-recorded facts into the prompt", async (t) => {
  const db = makeDb(t);
  const article: ArticleRecord = {
    slug: "solana",
    canonicalSlug: "solana",
    title: "Solana",
    markdown: "# Solana\n\nSolana is a blockchain.",
    html: "",
    summaryMarkdown: "",
    plain_text: "Solana is a blockchain.",
    generated_at: 1,
  };
  saveArticle(db, article, [], [], {});
  setArticleInfobox(db, "solana", INFOBOX, "test");
  // Record deterministic facts so there is an existing set to reevaluate.
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });

  let sentUser = "";
  const capturing = {
    async chat(_model: string, _system: string, user: string) {
      sentUser = user;
      return JSON.stringify({ entities: [], relations: [], categories: [] });
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

  const prompts = {
    prompts: {
      ontology: {
        system: "s",
        user: "title: {{requested_title}}\nfacts:\n{{existing_facts}}\nbody:\n{{article_body}}",
        model: "light",
        thinking: false,
        json: true,
      },
    },
    shared: {},
  } as unknown as PromptConfig;

  await deriveLlmExtraction(db, vocab, article, { llm: capturing, prompts });
  assert.match(sentUser, /founded_by Anatoly Yakovenko/, "recorded facts are injected for reevaluation");
});

test("deleteArticleOntology removes provenance rows and detaches entity", (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, {
    slug: "solana",
    title: "Solana",
    infobox: INFOBOX,
    vocab,
  });
  deleteArticleOntology(db, "solana");
  const after = listArticleEntityFacts(db, "solana");
  assert.equal(after.entity, null, "owned entity detached from article");
  const relCount = prepared(db, `SELECT COUNT(*) AS n FROM entity_relations WHERE provenance_slug = 'solana'`).get() as { n: number };
  assert.equal(relCount.n, 0);
});

function pipelineInput(slug: string) {
  return initialPipelineState({
    requestId: randomUUID(),
    workflow: "article.post_process",
    slug,
    requestedTitle: slug,
  });
}

function noopLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function pipelineDeps(db: ReturnType<typeof openDatabase>, llm: LlmRouter, llmEnabled: boolean) {
  return {
    db,
    llm,
    logger: noopLogger(),
    runtime: {
      app: { rag: { ontology_llm_extraction: llmEnabled } },
      prompts: ONTOLOGY_PROMPTS,
    },
  };
}

test("extractOntologyNode: runs deterministic extraction synchronously at write-time", async (t) => {
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
      plain_text: "Body.",
      generated_at: Date.now(),
    },
    [],
    [],
    {},
  );
  setArticleInfobox(db, "solana", INFOBOX);

  const patch = await extractOntologyNode.run(
    pipelineInput("solana") as never,
    pipelineDeps(
      db,
      stubLlm("{}", () => {}),
      false,
    ) as never,
  );
  assert.ok(patch.ontologyExtraction);
  assert.equal(patch.ontologyExtraction?.llmEnabled, false);
  assert.ok((patch.ontologyExtraction?.entities ?? 0) > 0);
  assert.ok(
    patch.ontologyExtraction?.extraction.relations.some((relation) => relation.predicate === "founded_by"),
    "trace payload includes the extracted ontology facts",
  );
  // No async drain needed — the facts are queryable immediately.
  const { facts } = listArticleEntityFacts(db, "solana");
  assert.ok(facts.some((f) => f.predicate === "founded_by"));
});

test("extractOntologyNode: calls the LLM only when ontology_llm_extraction is on, and reports why", async (t) => {
  const db = makeDb(t);
  saveArticle(
    db,
    {
      slug: "solana",
      canonicalSlug: "solana",
      title: "Solana",
      markdown: "# Solana\n\nSolana was founded by Anatoly Yakovenko.",
      html: "",
      summaryMarkdown: "",
      plain_text: "Solana was founded by Anatoly Yakovenko.",
      generated_at: Date.now(),
    },
    [],
    [],
    {},
  );

  let calls = 0;
  const reply = JSON.stringify({ entities: [], relations: [], categories: [] });
  const offPatch = await extractOntologyNode.run(
    pipelineInput("solana") as never,
    pipelineDeps(
      db,
      stubLlm(reply, () => (calls += 1)),
      false,
    ) as never,
  );
  assert.equal(calls, 0, "LLM not called when the flag is off");
  assert.equal(offPatch.ontologyExtraction?.llmEnabled, false);
  assert.equal(offPatch.ontologyExtraction?.llmReason, undefined);

  const onPatch = await extractOntologyNode.run(
    pipelineInput("solana") as never,
    pipelineDeps(
      db,
      stubLlm(reply, () => (calls += 1)),
      true,
    ) as never,
  );
  assert.equal(calls, 1, "LLM called once when the flag is on");
  assert.equal(onPatch.ontologyExtraction?.llmEnabled, true);
  assert.equal(onPatch.ontologyExtraction?.llmReason, "first_extraction");
});

test("an is_a-shaped relation from the raw model output never becomes a fact suggestion", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halu-isa-suggestion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, "test.db"));
  saveArticle(
    db,
    {
      slug: "letter-j",
      canonicalSlug: "letter-j",
      title: "Letter J",
      markdown: "# Letter J\n\nBody.",
      html: "",
      summaryMarkdown: "",
      plain_text: "Body.",
      generated_at: Date.now(),
    } as unknown as ArticleRecord,
    [],
    [],
    {},
  );
  indexArticleOntology(db, { slug: "letter-j", title: "Letter J", infobox: null, vocab });

  // `replaceOntologySuggestions` stores the *raw* model relations, so its
  // is_a guard sees whatever string the model wrote. A light model writes the
  // predicate's human label, or its own casing, at least as often as the
  // canonical `is_a` — and every one of those spellings means "the subject's
  // type", which is the type-suggestion channel's job, not a fact suggestion.
  const raw = {
    relations: [
      { subject: "Letter J", predicate: "is a", object: "letter" },
      { subject: "Letter J", predicate: "IS_A", object: "letter" },
      { subject: "Letter J", predicate: "is_a", object: "letter" },
      { subject: "Letter J", predicate: "founded_by", object: "Someone" },
    ],
  };
  replaceOntologySuggestions(db, "letter-j", raw, emptyExtraction());

  const predicates = listOntologySuggestions(db, "letter-j").map((s) => s.predicate);
  assert.deepEqual(predicates, ["founded_by"], "no spelling of is_a survives as a fact suggestion");
});
