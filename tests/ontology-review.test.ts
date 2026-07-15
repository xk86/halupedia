import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, prepared, saveArticle } from "../src/server/db";
import {
  indexArticleOntology,
  loadOntologyVocabulary,
  listOntologySuggestions,
  listArticleEntityFacts,
  getOntologyTypeSuggestion,
  enqueueReviewTasks,
  claimNextReview,
  countActiveReviews,
  reviewArticleSuggestions,
} from "../src/server/ontology";
import { startScheduler } from "../src/server/pipeline/scheduler";
import type { PromptConfig } from "../src/server/types";
import type { LlmRouter } from "../src/server/llm";
import type { Logger } from "../src/server/logger";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const vocab = loadOntologyVocabulary();

function makeDb(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "halu-ontology-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return openDatabase(join(root, "test.db"));
}

function makeArticle(db: ReturnType<typeof openDatabase>, slug: string, title: string, generatedAt: number) {
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
      generated_at: generatedAt,
    },
    [],
    [],
    {},
  );
  indexArticleOntology(db, { slug, title, infobox: null, vocab });
}

function insertSuggestion(db: ReturnType<typeof openDatabase>, slug: string, subject: string, predicate: string, object: string) {
  prepared(
    db,
    `INSERT INTO ontology_suggestions (article_slug, subject, predicate, object, validated, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(slug, subject, predicate, object, Date.now());
}

test("enqueueReviewTasks orders newest-first and skips already-queued articles", (t) => {
  const db = makeDb(t);
  makeArticle(db, "old-article", "Old Article", 1000);
  makeArticle(db, "new-article", "New Article", 3000);
  makeArticle(db, "mid-article", "Mid Article", 2000);
  for (const slug of ["old-article", "new-article", "mid-article"]) {
    insertSuggestion(db, slug, slug, "related_to", "Something");
  }

  const added = enqueueReviewTasks(db, 10);
  assert.equal(added, 3);
  assert.equal(countActiveReviews(db), 3);

  const order = [claimNextReview(db)?.articleSlug, claimNextReview(db)?.articleSlug, claimNextReview(db)?.articleSlug];
  assert.deepEqual(order, ["new-article", "mid-article", "old-article"], "queue drains newest article first");
  assert.equal(claimNextReview(db), null, "nothing left to claim");

  // Re-enqueueing while those rows are still 'processing' must not duplicate them.
  const addedAgain = enqueueReviewTasks(db, 10);
  assert.equal(addedAgain, 0);
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
    ontology_review: {
      system: "review {{items}}",
      user: "{{article_title}}\n{{items}}\n{{type_change}}",
      model: "light",
      thinking: false,
      json: true,
    },
  },
  shared: {},
} as unknown as PromptConfig;

test("reviewArticleSuggestions humanizes a machine-identifier value instead of failing it, but still fails an overlong label deterministically", async (t) => {
  const db = makeDb(t);
  makeArticle(db, "subject", "Subject", Date.now());
  insertSuggestion(db, "subject", "Subject", "founded_by", "Jane Doe");
  insertSuggestion(db, "subject", "Subject", "founded_by", "jane-doe-corp");
  const longLabelPredicate = "this_is_a_very_long_predicate_name";
  insertSuggestion(db, "subject", "Subject", longLabelPredicate, "Some Value");

  // Both well-formed items reach the model and pass; the model is never even
  // asked about the overlong-label item (it's filtered before the call).
  const reply = JSON.stringify({
    items: [
      { index: 1, verdict: "pass", reason: "fine" },
      { index: 2, verdict: "pass", reason: "fine" },
    ],
    type: null,
  });
  const result = await reviewArticleSuggestions(db, "subject", {
    llm: stubLlm(reply),
    prompts: REVIEW_PROMPTS,
    vocab,
    keyMaxWords: 6,
  });

  assert.equal(result.items.length, 3);
  const byObject = new Map(result.items.map((i) => [i.object, i]));
  assert.equal(byObject.get("Jane Doe")?.verdict, "pass");
  assert.equal(byObject.get("Jane Doe")?.source, "llm");
  // "jane-doe-corp" was humanized to "Jane Doe Corp" before review, not failed.
  assert.equal(byObject.get("Jane Doe Corp")?.verdict, "pass");
  assert.equal(byObject.get("Jane Doe Corp")?.source, "llm");
  assert.ok(!byObject.has("jane-doe-corp"), "the raw machine-identifier value no longer appears");
  assert.equal(byObject.get("Some Value")?.verdict, "fail");
  assert.equal(byObject.get("Some Value")?.source, "deterministic");
  assert.match(byObject.get("Some Value")!.reason, /too long/);

  // The humanized value was persisted (both items passed and got merged).
  const facts = listArticleEntityFacts(db, "subject").facts;
  assert.ok(facts.some((f) => f.object === "Jane Doe Corp"));
});

test("reviewArticleSuggestions treats a capitalized model verdict as pass, not a spurious fail", async (t) => {
  const db = makeDb(t);
  makeArticle(db, "subject", "Subject", Date.now());
  insertSuggestion(db, "subject", "Subject", "founded_by", "Jane Doe");

  // Observed model behavior: capitalized "Pass" instead of lowercase.
  const reply = JSON.stringify({ items: [{ index: 1, verdict: "Pass", reason: "Pass" }], type: null });
  const result = await reviewArticleSuggestions(db, "subject", {
    llm: stubLlm(reply),
    prompts: REVIEW_PROMPTS,
    vocab,
    keyMaxWords: 6,
  });

  assert.equal(result.items[0]?.verdict, "pass");
});

test("reviewArticleSuggestions overrides a model fail whose own reason is a stale format complaint", async (t) => {
  const db = makeDb(t);
  makeArticle(db, "subject", "Subject", Date.now());
  insertSuggestion(db, "subject", "Subject", "founded_by", "Jane Doe");

  // Small/local models sometimes ignore the "already checked, don't re-judge
  // this" instruction and fail an item over slug-shape/length anyway. Since
  // this item already cleared both deterministically, that fail is wrong and
  // must not cost the fact.
  const reply = JSON.stringify({
    items: [{ index: 1, verdict: "fail", reason: "Value is not natural text (machine slug)" }],
    type: null,
  });
  const result = await reviewArticleSuggestions(db, "subject", {
    llm: stubLlm(reply),
    prompts: REVIEW_PROMPTS,
    vocab,
    keyMaxWords: 6,
  });

  assert.equal(result.items[0]?.verdict, "pass");
  assert.equal(result.items[0]?.reason, "format concern already cleared");
});

test("ontology_review.enqueue schedule tops up to the configured batch instead of skipping while partially full", async (t) => {
  const db = makeDb(t);
  makeArticle(db, "old-article", "Old Article", 1000);
  makeArticle(db, "new-article", "New Article", 3000);
  makeArticle(db, "mid-article", "Mid Article", 2000);
  for (const slug of ["old-article", "new-article", "mid-article"]) {
    insertSuggestion(db, slug, slug, "related_to", "Something");
  }
  // Pre-seed one already-active queue row so the queue isn't empty.
  enqueueReviewTasks(db, 1);
  assert.equal(countActiveReviews(db), 1);

  const controller = startScheduler({
    db,
    logger: noopLogger,
    getConfig: () => ({
      enabled: true,
      enqueue_interval_minutes: 15,
      enqueue_batch: 3,
      run_interval_minutes: 5,
      key_max_words: 6,
    }),
    getLlm: () => stubLlm("{}"),
    getPrompts: () => REVIEW_PROMPTS,
    getVocab: () => vocab,
  });
  t.after(() => controller.stop());

  await controller.runNow("ontology_review.enqueue");
  assert.equal(countActiveReviews(db), 3, "tops up to the batch size instead of skipping outright");
});

test("reviewArticleSuggestions merges passing items, keeps failing ones queued, and applies a passing type change", async (t) => {
  const db = makeDb(t);
  makeArticle(db, "subject", "Subject", Date.now());
  insertSuggestion(db, "subject", "Subject", "founded_by", "Jane Doe");
  insertSuggestion(db, "subject", "Subject", "based_in", "Nowhere Really");
  prepared(
    db,
    `INSERT INTO ontology_type_suggestions (article_slug, suggested_type, created_at) VALUES (?, ?, ?)`,
  ).run("subject", "organization", Date.now());

  assert.equal(listArticleEntityFacts(db, "subject").entity?.entityType, "thing");

  const reply = JSON.stringify({
    items: [
      { index: 1, verdict: "pass", reason: "well formed" },
      { index: 2, verdict: "fail", reason: "not clear" },
    ],
    type: { verdict: "pass", reason: "clearly an organization" },
  });
  const result = await reviewArticleSuggestions(db, "subject", {
    llm: stubLlm(reply),
    prompts: REVIEW_PROMPTS,
    vocab,
    keyMaxWords: 6,
  });

  assert.equal(result.verdict, "partial");
  assert.equal(result.passed, 2); // 1 relation + type
  assert.equal(result.failed, 1);

  const remaining = listOntologySuggestions(db, "subject");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].object, "Nowhere Really", "the failed item is left in place for manual review");

  const facts = listArticleEntityFacts(db, "subject").facts;
  assert.ok(
    facts.some((f) => f.source === "curated" && f.predicate === "founded_by" && f.object === "Jane Doe"),
    "the passing relation was merged into the ontology",
  );

  assert.equal(listArticleEntityFacts(db, "subject").entity?.entityType, "organization", "the passing type change was applied");
  assert.equal(getOntologyTypeSuggestion(db, "subject"), null, "the applied type suggestion is cleared");
});

test("reviewArticleSuggestions leaves a failing type change in place", async (t) => {
  const db = makeDb(t);
  makeArticle(db, "subject", "Subject", Date.now());
  prepared(
    db,
    `INSERT INTO ontology_type_suggestions (article_slug, suggested_type, created_at) VALUES (?, ?, ?)`,
  ).run("subject", "organization", Date.now());

  const reply = JSON.stringify({ items: [], type: { verdict: "fail", reason: "not convincing" } });
  const result = await reviewArticleSuggestions(db, "subject", {
    llm: stubLlm(reply),
    prompts: REVIEW_PROMPTS,
    vocab,
    keyMaxWords: 6,
  });

  assert.equal(result.verdict, "fail");
  assert.equal(listArticleEntityFacts(db, "subject").entity?.entityType, "thing", "type unchanged on a failing verdict");
  assert.ok(getOntologyTypeSuggestion(db, "subject"), "the suggestion survives for manual review");
});
