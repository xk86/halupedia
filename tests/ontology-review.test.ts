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
  listReviewQueue,
  reviewArticleSuggestions,
  enqueueExtractionTasks,
  claimNextExtraction,
  countActiveExtractions,
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

  const added = enqueueReviewTasks(db, vocab.signature, 10);
  assert.equal(added, 3);
  assert.equal(countActiveReviews(db), 3);

  const order = [claimNextReview(db)?.articleSlug, claimNextReview(db)?.articleSlug, claimNextReview(db)?.articleSlug];
  assert.deepEqual(order, ["new-article", "mid-article", "old-article"], "queue drains newest article first");
  assert.equal(claimNextReview(db), null, "nothing left to claim");

  // Re-enqueueing while those rows are still 'processing' must not duplicate them.
  const addedAgain = enqueueReviewTasks(db, vocab.signature, 10);
  assert.equal(addedAgain, 0);
});

test("enqueueReviewTasks skips an article whose ontology extraction is stale or still in flight", (t) => {
  const db = makeDb(t);
  makeArticle(db, "fresh-article", "Fresh Article", 1000);
  makeArticle(db, "stale-article", "Stale Article", 2000);
  makeArticle(db, "extracting-article", "Extracting Article", 3000);
  insertSuggestion(db, "fresh-article", "Fresh Article", "related_to", "Something");
  insertSuggestion(db, "stale-article", "Stale Article", "related_to", "Something");
  insertSuggestion(db, "extracting-article", "Extracting Article", "related_to", "Something");

  // Simulate a vocabulary change that staled this article's extraction.
  prepared(db, `UPDATE article_ontology_state SET signature = 'old-signature' WHERE article_slug = ?`).run(
    "stale-article",
  );
  // Simulate an in-flight (not yet completed) extraction job for this one.
  prepared(
    db,
    `INSERT INTO ontology_extract_queue (article_slug, article_rank, status, enqueued_at) VALUES (?, ?, 'pending', ?)`,
  ).run("extracting-article", 3000, Date.now());

  const added = enqueueReviewTasks(db, vocab.signature, 10);
  assert.equal(added, 1, "only the article with current, non-in-flight extraction is queued");
  assert.equal(claimNextReview(db)?.articleSlug, "fresh-article");
  assert.equal(claimNextReview(db), null, "the stale and extracting articles were not enqueued");
});

test("enqueueExtractionTasks queues only articles whose ontology signature doesn't match the current vocabulary", (t) => {
  const db = makeDb(t);
  makeArticle(db, "current-article", "Current Article", 1000);
  makeArticle(db, "never-extracted", "Never Extracted", 3000);
  makeArticle(db, "stale-article", "Stale Article", 2000);
  // makeArticle runs indexArticleOntology, which stamps the current signature —
  // simulate a never-extracted article by wiping its state row, and a stale
  // one by giving it an old signature.
  prepared(db, `DELETE FROM article_ontology_state WHERE article_slug = ?`).run("never-extracted");
  prepared(db, `UPDATE article_ontology_state SET signature = 'old-signature' WHERE article_slug = ?`).run(
    "stale-article",
  );

  const added = enqueueExtractionTasks(db, vocab.signature, 10);
  assert.equal(added, 2, "the already-current article is not queued");
  assert.equal(countActiveExtractions(db), 2);

  const order = [claimNextExtraction(db)?.articleSlug, claimNextExtraction(db)?.articleSlug];
  assert.deepEqual(order, ["never-extracted", "stale-article"], "queue drains newest article first");
  assert.equal(claimNextExtraction(db), null, "nothing left to claim");

  // Re-enqueueing while those rows are still 'processing' must not duplicate them.
  const addedAgain = enqueueExtractionTasks(db, vocab.signature, 10);
  assert.equal(addedAgain, 0);
});

test("listReviewQueue orders active rows by article_rank (the real claim order), not raw insertion id", (t) => {
  const db = makeDb(t);
  makeArticle(db, "low-rank-first", "Low Rank First", 1000);
  makeArticle(db, "high-rank-second", "High Rank Second", 2000);
  const now = Date.now();
  // Inserted in the opposite order from their rank — the low-rank row gets
  // the lower id (enqueued first), the high-rank row the higher id — the
  // exact shape that would fool an `id DESC` sort into the wrong order.
  prepared(
    db,
    `INSERT INTO ontology_review_queue (article_slug, article_rank, status, enqueued_at) VALUES (?, ?, 'pending', ?)`,
  ).run("low-rank-first", 1000, now);
  prepared(
    db,
    `INSERT INTO ontology_review_queue (article_slug, article_rank, status, enqueued_at) VALUES (?, ?, 'pending', ?)`,
  ).run("high-rank-second", 2000, now);

  const queue = listReviewQueue(db, 10);
  assert.deepEqual(
    queue.map((q) => q.articleSlug),
    ["high-rank-second", "low-rank-first"],
    "active rows follow article_rank, matching claimNextReview's real order",
  );
});

test("listReviewQueue does not force a processing row above a higher-ranked pending row", (t) => {
  const db = makeDb(t);
  makeArticle(db, "low-rank-processing", "Low Rank Processing", 1000);
  makeArticle(db, "high-rank-pending", "High Rank Pending", 2000);
  const now = Date.now();
  prepared(
    db,
    `INSERT INTO ontology_review_queue (article_slug, article_rank, status, enqueued_at, started_at) VALUES (?, ?, 'processing', ?, ?)`,
  ).run("low-rank-processing", 1000, now, now);
  prepared(
    db,
    `INSERT INTO ontology_review_queue (article_slug, article_rank, status, enqueued_at) VALUES (?, ?, 'pending', ?)`,
  ).run("high-rank-pending", 2000, now);

  const queue = listReviewQueue(db, 10);
  assert.deepEqual(
    queue.map((q) => q.articleSlug),
    ["high-rank-pending", "low-rank-processing"],
    "a lower-ranked processing row doesn't jump ahead of a higher-ranked pending one",
  );
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
      user: "{{article_title}}\n{{items}}\n{{type_change}}\n{{article_body}}",
      model: "light",
      thinking: false,
      json: true,
    },
    // Needed by deriveLlmExtraction (the extraction queue's "run" step), not
    // just the review one above.
    ontology: {
      system: "extract {{entity_types}} {{predicates}} {{existing_facts}}",
      user: "{{requested_title}}\n{{article_body}}",
      model: "light",
      thinking: false,
      json: true,
    },
  },
  shared: {},
} as unknown as PromptConfig;

test("deterministic title-equality check fails a value that truly equals the article's own title", async (t) => {
  const db = makeDb(t);
  makeArticle(db, "subject", "The Geopolitical Failure Market", Date.now());
  insertSuggestion(db, "subject", "The Geopolitical Failure Market", "is", "The Geopolitical Failure Market");

  const result = await reviewArticleSuggestions(db, "subject", {
    llm: stubLlm(JSON.stringify({ items: [], type: null })),
    prompts: REVIEW_PROMPTS,
    vocab,
    keyMaxWords: 6,
  });

  assert.equal(result.items[0]?.verdict, "fail");
  assert.equal(result.items[0]?.source, "deterministic");
  assert.equal(result.items[0]?.reason, "value equals the article's own title");
});

test("deterministic title-equality check does not fail a value that only equals the fact's own extracted subject text, not the article's real title", async (t) => {
  const db = makeDb(t);
  // A "Today's News: <date>" digest article: the article's real title carries
  // the "Today's News:" prefix, but the extractor recorded this fact's own
  // `subject` as just the bare date — coincidentally identical to the value,
  // even though neither string is the article's actual title.
  makeArticle(db, "digest", "Today's News: March 20, 2003", Date.now());
  insertSuggestion(db, "digest", "March 20, 2003", "occurred_on", "March 20, 2003");

  const reply = JSON.stringify({ items: [{ index: 1, verdict: "pass", reason: "stated in the article" }], type: null });
  const result = await reviewArticleSuggestions(db, "digest", {
    llm: stubLlm(reply),
    prompts: REVIEW_PROMPTS,
    vocab,
    keyMaxWords: 6,
  });

  assert.equal(result.items[0]?.source, "llm", "reached the model instead of being deterministically failed");
  assert.equal(result.items[0]?.verdict, "pass");
});

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

test("reviewArticleSuggestions humanizes an underscore-joined value containing an apostrophe before review", async (t) => {
  const db = makeDb(t);
  makeArticle(db, "subject", "Subject", Date.now());
  insertSuggestion(db, "subject", "Subject", "founded_by", "areas_less_than_5_percent_of_structure's_total_volume");

  const reply = JSON.stringify({ items: [{ index: 1, verdict: "pass", reason: "fine" }], type: null });
  const result = await reviewArticleSuggestions(db, "subject", {
    llm: stubLlm(reply),
    prompts: REVIEW_PROMPTS,
    vocab,
    keyMaxWords: 6,
  });

  const objects = result.items.map((i) => i.object);
  assert.ok(
    !objects.some((o) => o.includes("_")),
    "no underscored value survives into the review results",
  );
  assert.equal(result.items[0]?.object, "Areas Less Than 5 Percent Of Structure's Total Volume");
});

test("reviewArticleSuggestions overrides a model fail claiming title-equality when the value is only a substring of the title", async (t) => {
  const db = makeDb(t);
  makeArticle(db, "subject", "Today's News: March 19, 2003", Date.now());
  insertSuggestion(db, "subject", "Today's News: March 19, 2003", "occurred_on", "March 19, 2003");

  // Observed model behavior: the light model fails a value merely because it
  // overlaps with the title, even though the prompt says "character-for-
  // character identical" and "March 19, 2003" is a strict substring, not an
  // exact match, of "Today's News: March 19, 2003".
  const reply = JSON.stringify({
    items: [{ index: 1, verdict: "fail", reason: "value equals the article's own title" }],
    type: null,
  });
  const result = await reviewArticleSuggestions(db, "subject", {
    llm: stubLlm(reply),
    prompts: REVIEW_PROMPTS,
    vocab,
    keyMaxWords: 6,
  });

  assert.equal(result.items[0]?.verdict, "pass");
  assert.match(result.items[0]!.reason, /overridden/);
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

test("reviewArticleSuggestions overrides a model fail whose own reason is an out-of-scope complaint", async (t) => {
  const db = makeDb(t);
  makeArticle(db, "subject", "Subject", Date.now());
  insertSuggestion(db, "subject", "Subject", "founded_by", "Jane Doe");
  insertSuggestion(db, "subject", "Subject", "falls_under", "Anthropology Of Test");
  insertSuggestion(db, "subject", "Subject", "uses", "Test test");

  // Small/local models routinely ignore "this isn't your job" instructions
  // and fail items over format (already deterministically cleared) or content
  // judgment (recognizability, redundancy) that's explicitly out of scope for
  // this near-rubber-stamp review — none of these should cost the fact.
  const reply = JSON.stringify({
    items: [
      { index: 1, verdict: "fail", reason: "Value is not natural text (machine slug)" },
      { index: 2, verdict: "fail", reason: "Value is not a recognizable category or entity." },
      { index: 3, verdict: "fail", reason: "Value appears to be redundant/unclear phrasing ('Test test')." },
    ],
    type: null,
  });
  const result = await reviewArticleSuggestions(db, "subject", {
    llm: stubLlm(reply),
    prompts: REVIEW_PROMPTS,
    vocab,
    keyMaxWords: 6,
  });

  for (const item of result.items) {
    assert.equal(item.verdict, "pass", `${item.object} should be overridden back to pass`);
    assert.equal(item.reason, "out-of-scope concern overridden");
  }
});

test("reviewArticleSuggestions sends the article's own text to the review prompt", async (t) => {
  const db = makeDb(t);
  makeArticle(db, "subject", "Subject", Date.now());
  insertSuggestion(db, "subject", "Subject", "founded_by", "Jane Doe");

  let capturedPrompt: string | undefined;
  const llm: LlmRouter = {
    async chat(_role, _system, user) {
      capturedPrompt = user;
      return JSON.stringify({ items: [{ index: 1, verdict: "pass", reason: "fine" }], type: null });
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

  await reviewArticleSuggestions(db, "subject", { llm, prompts: REVIEW_PROMPTS, vocab, keyMaxWords: 6 });

  // makeArticle's body is `# ${title}\n\nBody.` — confirm that reaches the
  // model, not just the abstract label/value list.
  assert.match(capturedPrompt ?? "", /Body\./, "the article's own text was included in the prompt");
});

test("reviewArticleSuggestions honors — does not override — a model fail grounded in the article text", async (t) => {
  const db = makeDb(t);
  makeArticle(db, "subject", "Subject", Date.now());
  insertSuggestion(db, "subject", "Subject", "founded_by", "Someone Fabricated");
  insertSuggestion(db, "subject", "Subject", "based_in", "Rival Corp's Headquarters");

  // These are the two legitimate content-grounding fail reasons the prompt
  // now asks for — neither should be swallowed by the out-of-scope override,
  // unlike the taste/format complaints in the test above.
  const reply = JSON.stringify({
    items: [
      { index: 1, verdict: "fail", reason: "not stated anywhere in the article text" },
      { index: 2, verdict: "fail", reason: "describes a different entity mentioned in passing, not the article's own subject" },
    ],
    type: null,
  });
  const result = await reviewArticleSuggestions(db, "subject", {
    llm: stubLlm(reply),
    prompts: REVIEW_PROMPTS,
    vocab,
    keyMaxWords: 6,
  });

  for (const item of result.items) {
    assert.equal(item.verdict, "fail", `${item.object} should stay failed — this is a grounding complaint, not out-of-scope`);
  }
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
  enqueueReviewTasks(db, vocab.signature, 1);
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
      extract_enqueue_interval_minutes: 15,
      extract_enqueue_batch: 3,
      extract_run_interval_minutes: 5,
    }),
    getLlm: () => stubLlm("{}"),
    getPrompts: () => REVIEW_PROMPTS,
    getVocab: () => vocab,
  });
  t.after(() => controller.stop());

  await controller.runNow("ontology_review.enqueue");
  assert.equal(countActiveReviews(db), 3, "tops up to the batch size instead of skipping outright");
});

test("review only picks up an article after extraction has run for it (job dependency, end to end)", async (t) => {
  const db = makeDb(t);
  makeArticle(db, "subject", "Subject", Date.now());
  insertSuggestion(db, "subject", "Subject", "founded_by", "Jane Doe");
  // Stale it, as if the vocabulary changed after this article was extracted.
  prepared(db, `UPDATE article_ontology_state SET signature = 'old-signature' WHERE article_slug = ?`).run(
    "subject",
  );

  // The extraction "run" step re-derives suggestions from the model (see
  // deriveLlmExtraction), replacing whatever was inserted above — reply with
  // the same fact so it survives, matching what a real re-extraction would do
  // for an unchanged article.
  const extractReply = JSON.stringify({
    entities: [
      { name: "Subject", type: "organization" },
      { name: "Jane Doe", type: "person" },
    ],
    relations: [{ subject: "Subject", predicate: "founded_by", object: "Jane Doe" }],
    categories: [],
  });

  const controller = startScheduler({
    db,
    logger: noopLogger,
    getConfig: () => ({
      enabled: true,
      enqueue_interval_minutes: 15,
      enqueue_batch: 10,
      run_interval_minutes: 5,
      key_max_words: 6,
      extract_enqueue_interval_minutes: 15,
      extract_enqueue_batch: 10,
      extract_run_interval_minutes: 5,
    }),
    getLlm: () => stubLlm(extractReply),
    getPrompts: () => REVIEW_PROMPTS,
    getVocab: () => vocab,
  });
  t.after(() => controller.stop());

  // The article is stale, so review's enqueue must not pick it up yet.
  await controller.runNow("ontology_review.enqueue");
  assert.equal(countActiveReviews(db), 0, "review skips an article extraction hasn't caught up on");

  // Run extraction end to end: enqueue, then drain it.
  await controller.runNow("ontology_extract.enqueue");
  assert.equal(countActiveExtractions(db), 1);
  await controller.runNow("ontology_extract.run");
  assert.equal(countActiveExtractions(db), 0, "extraction job completed");

  // Now that extraction is current, review's enqueue picks the article up.
  await controller.runNow("ontology_review.enqueue");
  assert.equal(countActiveReviews(db), 1, "review now sees the article as eligible");
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

test("reviewArticleSuggestions settles an LLM-judged failing type change to human_review, not left pending", async (t) => {
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
  const suggestion = getOntologyTypeSuggestion(db, "subject");
  assert.ok(suggestion, "the suggestion survives for manual review");
  assert.equal(suggestion?.status, "human_review", "an LLM judgment-call failure is settled, not left pending");
});

test("reviewArticleSuggestions discards a deterministically failing type change (matches current type) instead of leaving it pending forever", async (t) => {
  const db = makeDb(t);
  makeArticle(db, "subject", "Subject", Date.now());
  prepared(
    db,
    `INSERT INTO ontology_type_suggestions (article_slug, suggested_type, created_at) VALUES (?, ?, ?)`,
  ).run("subject", "thing", Date.now());

  const result = await reviewArticleSuggestions(db, "subject", {
    llm: stubLlm(JSON.stringify({ items: [] })),
    prompts: REVIEW_PROMPTS,
    vocab,
    keyMaxWords: 6,
  });

  assert.equal(result.type?.verdict, "fail");
  assert.equal(result.type?.reason, "matches the current type");
  const suggestion = getOntologyTypeSuggestion(db, "subject");
  assert.equal(suggestion?.status, "discarded", "a deterministic fail is settled as discarded");

  // The reviewer settling the row is what stops enqueueReviewTasks from
  // treating this article as still having review work — regression coverage
  // for the infinite re-review loop this fixes.
  const vocabSignature = "test-signature";
  prepared(
    db,
    `INSERT INTO article_ontology_state (article_slug, signature, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(article_slug) DO UPDATE SET signature = excluded.signature`,
  ).run("subject", vocabSignature, Date.now());
  const queued = enqueueReviewTasks(db, vocabSignature, 10);
  assert.equal(queued, 0, "a settled type suggestion must not re-queue the article for review");
});
