import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugify } from "../src/server/slug";
import {
  addArticleBlacklistSlugs,
  getArticle,
  getArticleByLookup,
  getLatestArticleReferences,
  listArticleBlacklistSlugs,
  openDatabase,
  removeArticleBlacklistSlugs,
  saveArticle,
  saveArticleReferences,
} from "../src/server/db";
import { renderMarkdown, markdownToPlainText } from "../src/server/markdown";
import { buildReferenceList } from "../src/server/referenceList";
import { formatRagContextForPrompt, retrieveDirectArticleContext } from "../src/server/retrieval";
import { applyReferenceOnlyEdit, hasReferenceEditFields, persistBlacklistForEdit } from "../src/server/referenceEdits";
import { rebuildReferenceListNode } from "../src/server/pipeline/nodes/postProcess";
import { buildReferenceListNode } from "../src/server/pipeline/nodes/articleGeneration";

const RAG_CONFIG = {
  reference_max_results: 8,
  reference_min_score: 0,
  max_references: 10,
  reference_recursive_depth: 0,
  reference_recursive_max_per_article: 0,
  reference_cull_min_score: 0,
  reference_cull_top_k: 0,
};

function makeDb(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "halupedia-edit-refs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return openDatabase(join(root, "test.db"));
}

function save(db: ReturnType<typeof openDatabase>, slug: string, title: string, body?: string) {
  const markdown = `# ${title}\n\n${body ?? `Body of ${title}.`}`;
  saveArticle(
    db,
    {
      slug,
      canonicalSlug: slug,
      title,
      markdown,
      html: renderMarkdown(markdown),
      plain_text: markdownToPlainText(markdown),
      generated_at: 100,
      summaryMarkdown: `${title} summary.`,
    },
    [],
    [slug],
    { operation: "generate" },
  );
}

test("blacklist persistence: add, list, remove", (t) => {
  const db = makeDb(t);
  addArticleBlacklistSlugs(db, "alpha", ["Bad Ref", "worse-ref"]);
  assert.deepEqual(listArticleBlacklistSlugs(db, "alpha").sort(), ["bad-ref", "worse-ref"]);
  // Re-adding is idempotent.
  addArticleBlacklistSlugs(db, "alpha", ["bad-ref"]);
  assert.equal(listArticleBlacklistSlugs(db, "alpha").length, 2);
  removeArticleBlacklistSlugs(db, "alpha", ["bad-ref"]);
  assert.deepEqual(listArticleBlacklistSlugs(db, "alpha"), ["worse-ref"]);
});

test("buildReferenceList excludes persistently blacklisted slugs from every source", (t) => {
  const db = makeDb(t);
  save(db, "alpha", "Alpha");
  save(db, "blocked", "Blocked");
  save(db, "kept", "Kept");
  addArticleBlacklistSlugs(db, "alpha", ["blocked"]);

  const refs = buildReferenceList(db, {
    articleSlug: "alpha",
    ragSources: [
      { slug: "blocked", title: "Blocked", content: "x", score: 0.9 },
      { slug: "kept", title: "Kept", content: "y", score: 0.9 },
    ],
    priorReferences: [
      { slug: "blocked", title: "Blocked", content: "x", kind: "summary", pinned: false, revisionId: "current", source: "prior" },
    ],
    revisionId: "current",
    config: RAG_CONFIG,
  });
  const slugs = refs.map((r) => r.slug);
  assert.ok(slugs.includes("kept"));
  assert.ok(!slugs.includes("blocked"), "stored blacklist must apply without request plumbing");
});

test("refs-only edit replaces sidecar refs without touching the article body", (t) => {
  const db = makeDb(t);
  save(db, "alpha", "Alpha");
  save(db, "ref-one", "Ref One");
  save(db, "ref-two", "Ref Two");
  saveArticleReferences(db, "alpha", 200, [
    { slug: "ref-one", title: "Ref One", content: "", kind: "summary", pinned: false, revisionId: "current", source: "user" },
  ]);
  const before = getArticle(db, "alpha")!;

  assert.equal(hasReferenceEditFields({}), false);
  assert.equal(hasReferenceEditFields({ referenceSlugs: [] }), true);

  const refs = applyReferenceOnlyEdit(
    db,
    "alpha",
    { referenceSlugs: ["ref-two"], pinnedSlugs: ["ref-two"], blacklistSlugs: ["ref-one"] },
    RAG_CONFIG,
  );
  assert.deepEqual(refs.map((r) => r.slug), ["ref-two"]);
  assert.equal(refs[0].pinned, true);

  const stored = getLatestArticleReferences(db, "alpha");
  assert.deepEqual(stored.map((r) => `${r.slug}:${r.pinned}`), ["ref-two:true"]);
  assert.equal(listArticleBlacklistSlugs(db, "alpha").includes("ref-one"), true);
  assert.equal(getArticle(db, "alpha")!.markdown, before.markdown, "body must be untouched");
});

test("blacklist-only edit removes blocked refs from the sidecar and syncs the stored blocklist", (t) => {
  const db = makeDb(t);
  save(db, "alpha", "Alpha");
  save(db, "ref-one", "Ref One");
  save(db, "ref-two", "Ref Two");
  addArticleBlacklistSlugs(db, "alpha", ["stale-block"]);
  saveArticleReferences(db, "alpha", 200, [
    { slug: "ref-one", title: "Ref One", content: "", kind: "summary", pinned: false, revisionId: "current", source: "user" },
    { slug: "ref-two", title: "Ref Two", content: "", kind: "summary", pinned: true, revisionId: "current", source: "pinned" },
  ]);

  // The client's immediate blacklist sync: no instructions, no referenceSlugs —
  // priors are kept minus the blocked slug, and the sent array is authoritative
  // (stale persisted blocks not in it are removed).
  const refs = applyReferenceOnlyEdit(db, "alpha", { blacklistSlugs: ["ref-one"] }, RAG_CONFIG);
  assert.deepEqual(refs.map((r) => r.slug), ["ref-two"], "blocked ref must leave the sidecar");
  assert.deepEqual(getLatestArticleReferences(db, "alpha").map((r) => r.slug), ["ref-two"]);
  assert.deepEqual(listArticleBlacklistSlugs(db, "alpha"), ["ref-one"], "stored blocklist mirrors the sent array");

  // Unblocking via an empty authoritative array restores nothing automatically
  // but clears the stored blocklist.
  applyReferenceOnlyEdit(db, "alpha", { blacklistSlugs: [] }, RAG_CONFIG);
  assert.deepEqual(listArticleBlacklistSlugs(db, "alpha"), []);
});

test("direct-context retrieval caps chunks per article and clips unindexed fallbacks", (t) => {
  const db = makeDb(t);
  save(db, "alpha", "Alpha");
  save(db, "chunky", "Chunky");
  save(db, "longform", "Longform", "x".repeat(10_000));
  const ins = db.prepare(
    `INSERT INTO article_chunks (slug, chunk_index, content, embedding_json) VALUES (?, ?, ?, NULL)`,
  );
  for (let i = 0; i < 8; i++) ins.run("chunky", i, `chunk ${i}`);

  const packet = retrieveDirectArticleContext(db, "alpha", ["chunky", "longform"], "full", 12, undefined, {
    maxChunksPerArticle: 2,
  });
  const chunkyRows = packet.sourceArticles.filter((s) => s.slug === "chunky");
  // One merged entry per article (no repeated headings), holding up to the
  // per-article chunk cap of content.
  assert.equal(chunkyRows.length, 1, "article collapses to a single merged entry");
  assert.match(chunkyRows[0].content, /chunk 0/);
  assert.match(chunkyRows[0].content, /chunk 1/);
  assert.doesNotMatch(chunkyRows[0].content, /chunk 2/, "per-article chunk cap (2) must hold");
  const longform = packet.sourceArticles.find((s) => s.slug === "longform");
  assert.ok(longform, "unindexed article still contributes context");
  assert.ok(longform!.content.length >= 10_000, "unindexed fallback now contributes the full body");
});

test("formatRagContextForPrompt enforces the character budget at entry boundaries", () => {
  const sources = [
    { title: "A", content: "a".repeat(100) },
    { title: "B", content: "b".repeat(100) },
    { title: "C", content: "c".repeat(100) },
  ];
  const out = formatRagContextForPrompt(sources, 250);
  assert.ok(out.includes("a".repeat(100)) && out.includes("b".repeat(100)));
  assert.ok(!out.includes("c".repeat(100)), "content past the budget is not emitted whole");
  // C's content doesn't fit, but its title is surfaced in the overflow list.
  assert.match(out, /Additional related topics[^\n]*\n- C/);
  assert.match(out, /^## A$/m, "entries use their own markdown heading");
});

test("re-adding a blocked slug as a reference unblocks it", (t) => {
  const db = makeDb(t);
  save(db, "alpha", "Alpha");
  save(db, "blocked", "Blocked");
  addArticleBlacklistSlugs(db, "alpha", ["blocked"]);
  persistBlacklistForEdit(db, "alpha", { referenceSlugs: ["blocked"] });
  assert.deepEqual(listArticleBlacklistSlugs(db, "alpha"), []);
});

test("post-process reference rebuild keeps pins for slugs that are also body refs", async (t) => {
  const db = makeDb(t);
  save(db, "alpha", "Alpha", "Alpha mentions [Pinned Ref](ref:pinned-ref) inline.");
  save(db, "pinned-ref", "Pinned Ref");
  saveArticleReferences(db, "alpha", 200, [
    { slug: "pinned-ref", title: "Pinned Ref", content: "", kind: "summary", pinned: true, revisionId: "current", source: "pinned" },
  ]);

  const deps = {
    db,
    llm: {},
    logger: undefined,
    runtime: { app: { rag: { ...RAG_CONFIG, mode: "summary", max_results: 8 } } },
  };
  const out = await rebuildReferenceListNode.run(
    {
      input: { requestId: "t", workflow: "article.post_process", slug: "alpha" },
      finalArticleBody: "Alpha mentions [Pinned Ref](ref:pinned-ref) inline.",
      retrievedContext: undefined,
    } as never,
    deps as never,
  );
  const rebuilt = (out as { references: Array<{ slug: string; pinned: boolean }> }).references;
  const pinnedRef = rebuilt.find((r) => r.slug === "pinned-ref");
  assert.ok(pinnedRef, "pinned ref must survive the rebuild");
  assert.equal(pinnedRef!.pinned, true, "pin must not be demoted by the body-ref addition");
});

test("buildReferenceListNode treats re-sent prior slugs as priors, not fresh user adds", async (t) => {
  const db = makeDb(t);
  save(db, "alpha", "Alpha");
  save(db, "old-prior", "Old Prior");
  save(db, "fresh-add", "Fresh Add");
  // A prior the user hand-added in an earlier run, saved with a low score.
  saveArticleReferences(db, "alpha", 200, [
    { slug: "old-prior", title: "Old Prior", content: "", kind: "summary", pinned: false, revisionId: "current", source: "user", score: 0.1 },
  ]);

  const deps = {
    db,
    llm: {},
    logger: undefined,
    runtime: { app: { rag: { ...RAG_CONFIG, reference_cull_min_score: 0.3 } } },
  };
  // The editor panel re-sends the whole list, so both slugs arrive as
  // userReferenceSlugs even though the user only just added "fresh-add".
  const out = await buildReferenceListNode.run(
    {
      input: {
        requestId: "t",
        workflow: "article.generate",
        slug: "alpha",
        userReferenceSlugs: ["old-prior", "fresh-add"],
        pinnedSlugs: [],
      },
      retrievedContext: undefined,
    } as never,
    deps as never,
  );
  const refs = (out as { references: Array<{ slug: string; source?: string }> }).references;
  const fresh = refs.find((r) => r.slug === "fresh-add");
  assert.ok(fresh, "a genuinely new selection is kept as a user addition");
  assert.equal(fresh!.source, "user", "fresh add counts as user-added");
  // The re-sent prior is reranked on its stored score (0.1) and culled below
  // reference_cull_min_score (0.3) — it does NOT survive as a trusted user ref.
  assert.equal(refs.find((r) => r.slug === "old-prior"), undefined, "re-sent prior is reranked and discarded, not trusted");
});

test("buildReferenceListNode re-applies a pin to a re-sent prior slug", async (t) => {
  const db = makeDb(t);
  save(db, "alpha", "Alpha");
  save(db, "old-prior", "Old Prior");
  saveArticleReferences(db, "alpha", 200, [
    { slug: "old-prior", title: "Old Prior", content: "", kind: "summary", pinned: false, revisionId: "current", source: "user", score: 0.1 },
  ]);

  const deps = {
    db,
    llm: {},
    logger: undefined,
    runtime: { app: { rag: { ...RAG_CONFIG, reference_cull_min_score: 0.3 } } },
  };
  const out = await buildReferenceListNode.run(
    {
      input: {
        requestId: "t",
        workflow: "article.generate",
        slug: "alpha",
        userReferenceSlugs: ["old-prior"],
        pinnedSlugs: ["old-prior"],
      },
      retrievedContext: undefined,
    } as never,
    deps as never,
  );
  const refs = (out as { references: Array<{ slug: string; pinned: boolean }> }).references;
  const pinned = refs.find((r) => r.slug === "old-prior");
  assert.ok(pinned, "pinning a prior keeps it even when its score would be culled");
  assert.equal(pinned!.pinned, true, "the new pin is applied to the prior slug");
});

// ── robust-slug back-compat (alias backfill + auto legacy alias) ─────────────

test("openDatabase backfills robust-slug aliases for legacy-keyed articles", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-slug-compat-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "test.db");
  let db = openDatabase(path);
  // Simulate a pre-robust-slugifier article: legacy slug, punctuated title.
  db.prepare(
    `INSERT INTO articles (slug, canonical_slug, title, markdown, html, plain_text, generated_at)
     VALUES ('title-x', 'title-x', 'Title (x)', '# Title (x)', '', 'Title x', 100)`,
  ).run();
  db.close();
  db = openDatabase(path);
  // A fresh slugify("Title (x)") lookup must reach the legacy row via alias.
  const hit = getArticleByLookup(db, slugify("Title (x)"));
  assert.ok(hit, "robust slug should resolve via backfilled alias");
  assert.equal(hit!.slug, "title-x");
});

test("saveArticle auto-aliases the legacy slug of punctuated titles", (t) => {
  const db = makeDb(t);
  save(db, "dash-dash-apples", "--Apples");
  // Model-emitted legacy-style slug still resolves to the robust-keyed row.
  const viaLegacy = getArticleByLookup(db, "apples");
  assert.ok(viaLegacy, "legacy slug should alias to the article");
  assert.equal(viaLegacy!.slug, "dash-dash-apples");
});


// ── production-DB safety: legacy collisions must never be shadowed ──────────

test("saving a hyphen-titled article never shadows the existing spaced-title article", (t) => {
  const db = makeDb(t);
  save(db, "foo-bar", "Foo bar");
  // "Foo-bar"'s legacy slug collapses to "foo-bar" — occupied by a real
  // article, so no alias may be written for it.
  save(db, "foo-dash-bar", "Foo-bar");
  const spaced = getArticleByLookup(db, "foo-bar");
  assert.equal(spaced?.slug, "foo-bar");
  assert.equal(spaced?.title, "Foo bar", "existing article must keep winning its own slug");
  assert.equal(getArticleByLookup(db, "foo-dash-bar")?.title, "Foo-bar");
});

test("auto legacy alias never steals another article's alias", (t) => {
  const db = makeDb(t);
  // Article A owns the alias "shared-alias".
  saveArticle(
    db,
    {
      slug: "a-article",
      canonicalSlug: "a-article",
      title: "A Article",
      markdown: "# A Article\n\nBody.",
      html: "",
      plain_text: "A Article Body.",
      generated_at: 100,
      summaryMarkdown: "A.",
    },
    [],
    ["a-article", "shared-alias"],
    { operation: "generate" },
  );
  // "Shared, alias" legacy-collapses to "shared-alias" — already A's alias.
  save(db, "shared-comma-alias", "Shared, alias");
  assert.equal(getArticleByLookup(db, "shared-alias")?.slug, "a-article");
  assert.equal(getArticleByLookup(db, "shared-comma-alias")?.title, "Shared, alias");
});
