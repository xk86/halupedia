import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { openDatabase, type InfoboxData } from "../src/server/db";
import {
  indexArticleOntology,
  loadOntologyVocabulary,
  getPredicateUsageStats,
  getUnmappedLabelStats,
  runOntologyVocabularyReview,
  appendPredicates,
  removePredicates,
  reloadOntologyVocabularyInto,
  type PredicateAdditionProposal,
} from "../src/server/ontology";
import type { PromptConfig } from "../src/server/types";
import type { LlmRouter } from "../src/server/llm";

const vocab = loadOntologyVocabulary();

function makeDb(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "halu-ontology-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return openDatabase(join(root, "test.db"));
}

const INFOBOX_WITH_GAP: InfoboxData = {
  title: "Widget Co",
  subtitle: "Company",
  groups: [
    {
      label: "",
      rows: [
        { label: "Founder", value: "Jane Doe" },
        // "Mascot" maps to no known predicate -> kept verbatim (the gap signal).
        { label: "Mascot", value: "Wally the Widget" },
      ],
    },
  ],
};

test("getPredicateUsageStats counts stored relations per predicate", (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, { slug: "widget-co", title: "Widget Co", infobox: INFOBOX_WITH_GAP, vocab });
  const stats = getPredicateUsageStats(db, vocab);
  const foundedBy = stats.find((s) => s.name === "founded_by");
  assert.ok(foundedBy);
  assert.equal(foundedBy!.usageCount, 1);
  const neverUsed = stats.find((s) => s.name === "listed_on");
  assert.ok(neverUsed);
  assert.equal(neverUsed!.usageCount, 0);
});

test("getUnmappedLabelStats surfaces infobox labels that never mapped to a predicate", (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, { slug: "widget-co", title: "Widget Co", infobox: INFOBOX_WITH_GAP, vocab });
  const unmapped = getUnmappedLabelStats(db, vocab);
  const mascot = unmapped.find((u) => u.label === "Mascot");
  assert.ok(mascot, "unmapped 'Mascot' label surfaced");
  assert.equal(mascot!.count, 1);
  assert.equal(mascot!.example, "Wally the Widget");
  // A label that does map (Founder -> founded_by) must not appear.
  assert.ok(!unmapped.some((u) => u.label === "Founder"));
});

function stubLlm(reply: string): LlmRouter {
  return {
    async chat() {
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

const REVIEW_PROMPTS = {
  prompts: {
    ontology_vocabulary_review: {
      system: "types: {{entity_types}}",
      user: "{{existing_predicates}}\n{{unmapped_labels}}",
      model: "light",
      thinking: false,
      json: true,
    },
  },
  shared: {},
} as unknown as PromptConfig;

test("runOntologyVocabularyReview validates and filters model proposals", async (t) => {
  const db = makeDb(t);
  indexArticleOntology(db, { slug: "widget-co", title: "Widget Co", infobox: INFOBOX_WITH_GAP, vocab });

  const reply = JSON.stringify({
    additions: [
      {
        name: "Mascot Of!!",
        arity: "binary",
        subject: "organization",
        object: "thing",
        label: "has mascot",
        labelMappings: ["mascot"],
        reason: "Recurs across articles",
      },
      // Malformed: no name -> dropped.
      { arity: "binary", subject: "organization", object: "thing" },
      // Collides with an existing predicate -> dropped.
      { name: "founded_by", arity: "binary", subject: "organization", object: "person" },
    ],
    removals: [
      { name: "listed_on", reason: "unused" },
      // Protected -> dropped even though the model proposed it.
      { name: "is_a", reason: "trying to remove a protected predicate" },
      { name: "related_to", reason: "trying to remove a protected predicate" },
      // Unknown predicate -> dropped.
      { name: "not_a_real_predicate", reason: "nonsense" },
    ],
  });

  const { proposals } = await runOntologyVocabularyReview(db, vocab, {
    llm: stubLlm(reply),
    prompts: REVIEW_PROMPTS,
  });

  assert.equal(proposals.additions.length, 1);
  // "Mascot Of!!" sanitized to a snake_case-safe name (lowercased, non
  // [a-z0-9_] chars replaced).
  assert.equal(proposals.additions[0].name, "mascot_of__");
  assert.equal(proposals.additions[0].labelMappings[0], "mascot");

  assert.equal(proposals.removals.length, 1);
  assert.equal(proposals.removals[0].name, "listed_on");
  assert.ok(!proposals.removals.some((r) => r.name === "is_a" || r.name === "related_to"));
});

test("appendPredicates/removePredicates round-trip through the real ontology.toml file", () => {
  const raw = readFileSync(resolve(process.cwd(), "config/ontology.toml"), "utf8");

  const addition: PredicateAdditionProposal = {
    name: "test_mascot_of",
    arity: "binary",
    subject: "organization",
    object: "thing",
    label: "has mascot",
    symmetric: false,
    transitive: false,
    labelMappings: ["mascot"],
    reason: "test",
  };

  const withAddition = appendPredicates(raw, [addition]);
  assert.match(withAddition, /\[\[predicates\]\]\nname = "test_mascot_of"/);
  assert.match(withAddition, /mascot = "test_mascot_of"/);

  // Re-parse to confirm it's still valid TOML with the new predicate visible.
  const parsed = parseToml(withAddition) as { predicates: Array<{ name: string }>; label_predicates: Record<string, string> };
  assert.ok(parsed.predicates.some((p) => p.name === "test_mascot_of"));
  assert.equal(parsed.label_predicates.mascot, "test_mascot_of");
  // Original predicates untouched.
  assert.ok(parsed.predicates.some((p) => p.name === "founded_by"));

  const removed = removePredicates(withAddition, ["test_mascot_of"]);
  const reparsed = parseToml(removed) as { predicates: Array<{ name: string }> };
  assert.ok(!reparsed.predicates.some((p) => p.name === "test_mascot_of"));
  assert.ok(reparsed.predicates.some((p) => p.name === "founded_by"), "unrelated predicates survive removal");
  // No double-blank-line artifact left behind.
  assert.ok(!removed.includes("\n\n\n"));
});

test("reloadOntologyVocabularyInto mutates the same object in place", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halu-ontology-review-cfg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cfgPath = join(root, "ontology.toml");
  const baseRaw = readFileSync(resolve(process.cwd(), "config/ontology.toml"), "utf8");
  writeFileSync(cfgPath, baseRaw);

  const target = loadOntologyVocabulary(cfgPath);
  assert.ok(!target.predicates.has("test_reload_predicate"));
  const originalSignature = target.signature;

  const addition: PredicateAdditionProposal = {
    name: "test_reload_predicate",
    arity: "binary",
    subject: "*",
    object: "*",
    label: "test reload",
    symmetric: false,
    transitive: false,
    labelMappings: [],
    reason: "test",
  };
  writeFileSync(cfgPath, appendPredicates(baseRaw, [addition]));

  reloadOntologyVocabularyInto(target, cfgPath);
  assert.ok(target.predicates.has("test_reload_predicate"), "same object reflects the file change after reload");
  assert.notEqual(target.signature, originalSignature, "signature changed with the predicate set");
});
