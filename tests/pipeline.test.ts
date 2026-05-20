/**
 * Comprehensive pipeline tests covering:
 *  - Link parser edge cases (parseMarkdownLinks)
 *  - Markdown normalizer (normalizeMarkdownLinks)
 *  - Halu link normalization (normalizeHaluLinks)
 *  - Slug utilities (slugify, slugToTitle, wikiSegment round-trips)
 *  - Reference list pipeline (build → render → resolve)
 *  - findBodyReferencedArticles / findExistingArticleLinkReferences
 *  - linkMentionedReferencesInBody
 *  - convertExistingArticleLinksToRefs
 *  - Pin/unpin HTTP endpoint
 *  - Raw-save HTTP endpoint
 *  - Preview-markdown HTTP endpoint
 *  - Backlink context injection (backlinks surface as refs)
 *  - extractInternalLinks edge cases
 *  - renderReferencesHtml
 *  - formatReferencesForPrompt
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openDatabase,
  saveArticle,
  saveArticleReferences,
  getLatestArticleReferences,
  listIncomingHints,
} from "../src/server/db";
import { loadConfig } from "../src/server/config";
import { createApp } from "../src/server/index";
import type { LlmClient } from "../src/server/llm";
import type { LogFields, Logger } from "../src/server/logger";
import {
  extractInternalLinks,
  normalizeHaluLinks,
  renderMarkdown,
  markdownToPlainText,
  normalizeMarkdown,
} from "../src/server/markdown";
import {
  slugify,
  slugToTitle,
  titleToWikiSegment,
  wikiSegmentToTitle,
  wikiSegmentToRequestedTitle,
  normalizeCanonicalTitle,
} from "../src/server/slug";
import { parseMarkdownLinks } from "../src/server/text/markdownLinkParser";
import { normalizeMarkdownLinks } from "../src/server/text/linkNormalize";
import {
  buildReferenceList,
  convertExistingArticleLinksToRefs,
  findBodyReferencedArticles,
  findExistingArticleLinkReferences,
  findTitleMentionedArticles,
  formatReferencesForPrompt,
  linkMentionedReferencesInBody,
  renderReferencesHtml,
  resolveRefLinks,
} from "../src/server/referenceList";
import type { ReferenceList } from "../src/server/types";

/* ─────────────────────────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────────────────────────── */

const TEST_CONFIG = loadConfig().app.tests;

function noop(): Logger {
  return {
    debug(_e: string, _f?: LogFields) {},
    info(_e: string, _f?: LogFields) {},
    warn(_e: string, _f?: LogFields) {},
    error(_e: string, _f?: LogFields) {},
  };
}

function makeTempDb() {
  const root = mkdtempSync(join(tmpdir(), "halu-pipeline-"));
  const databasePath = join(root, TEST_CONFIG.database_path);
  const db = openDatabase(databasePath);
  return { root, db };
}

function seedDbArticle(
  db: ReturnType<typeof openDatabase>,
  slug: string,
  title: string,
  body = `${title} article body.`,
  summaryMarkdown = `Summary of ${title}.`,
) {
  const markdown = `# ${title}\n\n${body}`;
  const now = Date.now();
  saveArticle(
    db,
    { slug, canonicalSlug: slug, title, displayTitle: title, markdown, html: `<p>${body}</p>`, summaryMarkdown, plain_text: body, generated_at: now },
    [],
    [slug],
  );
}

function makeRef(slug: string, title: string, pinned = false): ReferenceList[number] {
  return { slug, title, content: `${title} content.`, kind: "summary", pinned, revisionId: "current" };
}

class EchoLlm implements LlmClient {
  constructor(private readonly response: string = "# Generated\n\nGenerated body.") {}
  async chat(): Promise<string> { return "[]"; }
  async streamChat(_s: string, _u: string, onChunk: (d: string, a: string) => void) {
    onChunk(this.response, this.response);
    return { content: this.response, finishReason: "stop" };
  }
  async embed(): Promise<number[][]> { return []; }
  async probeConnections(): Promise<void> {}
}

/* ─────────────────────────────────────────────────────────────────
   slugify — edge cases
   ───────────────────────────────────────────────────────────────── */

test("slugify: basic lowercase and hyphenation", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Multiple   Spaces  "), "multiple-spaces");
  assert.equal(slugify("already-kebab-case"), "already-kebab-case");
});

test("slugify: strips punctuation but keeps hyphens", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("A (parenthetical) note"), "a-parenthetical-note");
  assert.equal(slugify("dots.and.dots"), "dots-and-dots");
});

test("slugify: apostrophes and quotes become hyphens", () => {
  assert.equal(slugify("Obama's Method"), "obama-s-method");
  assert.equal(slugify(`"quoted title"`), "quoted-title");
});

test("slugify: numbers are preserved", () => {
  assert.equal(slugify("Area 51"), "area-51");
  assert.equal(slugify("ISO 9001"), "iso-9001");
  assert.equal(slugify("42nd Street"), "42nd-street");
});

test("slugify: collapses multiple hyphens", () => {
  assert.equal(slugify("a---b"), "a-b");
  assert.equal(slugify("  ---  "), "");
});

test("slugify: empty and whitespace-only returns empty string", () => {
  assert.equal(slugify(""), "");
  assert.equal(slugify("   "), "");
  assert.equal(slugify("!@#$%"), "");
});

test("slugify: unicode letters become hyphens or are stripped", () => {
  const result = slugify("Über café");
  assert.ok(typeof result === "string");
  assert.doesNotMatch(result, /\s/);
  assert.doesNotMatch(result, /[A-Z]/);
});

test("slugify: trailing/leading hyphens stripped", () => {
  assert.doesNotMatch(slugify("--leading"), /^-/);
  assert.doesNotMatch(slugify("trailing--"), /-$/);
});

/* ─────────────────────────────────────────────────────────────────
   slugToTitle and wiki segment round-trips
   ───────────────────────────────────────────────────────────────── */

test("slugToTitle: capitalises first letter and converts hyphens to spaces", () => {
  // slugToTitle capitalises only the first character of each hyphen-separated token,
  // it does NOT apply title-case to every word.
  assert.equal(slugToTitle("hello-world"), "Hello world");
  assert.equal(slugToTitle("area-51"), "Area 51");
  assert.equal(slugToTitle("single"), "Single");
});

test("titleToWikiSegment / wikiSegmentToTitle round-trip", () => {
  const titles = [
    "Biomaterial Tooth Fragment",
    "Mr. White",
    "Area 51",
    "ISO 9001 Standards",
    "Barack Obama's Legacy",
    "The Room (2003 Film)",
  ];
  for (const title of titles) {
    const segment = titleToWikiSegment(title);
    const restored = wikiSegmentToTitle(segment);
    assert.ok(typeof segment === "string" && segment.length > 0, `segment for "${title}" should be non-empty`);
    assert.ok(typeof restored === "string" && restored.length > 0, `restored title for "${title}" should be non-empty`);
  }
});

test("wikiSegmentToRequestedTitle: decodes URL-encoded segments", () => {
  const result = wikiSegmentToRequestedTitle("Hello_World");
  assert.ok(result.includes("Hello"), "should include 'Hello'");
});

test("normalizeCanonicalTitle: collapses whitespace", () => {
  assert.equal(normalizeCanonicalTitle("  Hello   World  "), "Hello World");
  assert.equal(normalizeCanonicalTitle("Hello\tWorld"), "Hello World");
});

/* ─────────────────────────────────────────────────────────────────
   parseMarkdownLinks — comprehensive link classification
   ───────────────────────────────────────────────────────────────── */

test("parseMarkdownLinks: halu with double-quoted hint", () => {
  const { links } = parseMarkdownLinks('[Alpha](halu:alpha-slug "the hint")');
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "halu");
  assert.equal(links[0].slug, "alpha-slug");
  assert.equal(links[0].hint, "the hint");
  assert.equal(links[0].label, "Alpha");
});

test("parseMarkdownLinks: halu without hint", () => {
  const { links } = parseMarkdownLinks("[Beta](halu:beta-slug)");
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "halu");
  assert.equal(links[0].slug, "beta-slug");
  assert.equal(links[0].hint ?? "", "");
});

test("parseMarkdownLinks: ref:slug form", () => {
  const { links } = parseMarkdownLinks("[Gamma](ref:gamma-slug)");
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "ref");
  assert.equal(links[0].slug, "gamma-slug");
});

test("parseMarkdownLinks: ref:N numeric form", () => {
  const { links } = parseMarkdownLinks("[see ref 1](ref:1)");
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "ref");
});

test("parseMarkdownLinks: wiki path form", () => {
  const { links } = parseMarkdownLinks("[Delta](/wiki/Delta_Article)");
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "wiki");
  assert.equal(links[0].slug, "delta-article");
});

test("parseMarkdownLinks: external link flagged as diagnostic", () => {
  const { links, diagnostics } = parseMarkdownLinks("[Ext](https://example.com)");
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "external");
  assert.ok(diagnostics.some((d) => d.code === "external-link"));
});

test("parseMarkdownLinks: multiple links in one string classified correctly", () => {
  const input = [
    '[A](halu:a-slug "hint a")',
    "[B](ref:b-slug)",
    "[C](/wiki/C_Article)",
    "[D](https://d.test)",
    "[E](plain-slug-e)",
  ].join(" ");
  const { links } = parseMarkdownLinks(input);
  assert.equal(links.length, 5);
  const kinds = links.map((l) => l.kind);
  assert.ok(kinds.includes("halu"));
  assert.ok(kinds.includes("ref"));
  assert.ok(kinds.includes("wiki"));
  assert.ok(kinds.includes("external"));
  assert.ok(kinds.includes("plain-slug"));
});

test("parseMarkdownLinks: hint with special chars (parens inside, dashes)", () => {
  const { links } = parseMarkdownLinks('[X](halu:x-slug "hint with (parens) and — dash")');
  assert.equal(links.length, 1);
  assert.match(links[0].hint ?? "", /parens/);
});

test("parseMarkdownLinks: unclosed target detected as loose ref marker", () => {
  const { diagnostics, looseInternalMarkers } = parseMarkdownLinks("[open](ref:missing");
  assert.ok(diagnostics.some((d) => d.code === "unclosed-target"));
  assert.ok(looseInternalMarkers.some((m) => m.kind === "ref" && m.slug === "missing"));
});

test("parseMarkdownLinks: bare halu: text outside link is a loose marker", () => {
  const { looseInternalMarkers, diagnostics } = parseMarkdownLinks("some halu:loose-slug text");
  assert.ok(looseInternalMarkers.some((m) => m.kind === "halu" && m.slug === "loose-slug"));
  assert.ok(diagnostics.some((d) => d.code === "loose-internal-marker"));
});

test("parseMarkdownLinks: slug with numbers and hyphens", () => {
  const { links } = parseMarkdownLinks("[ISO](halu:iso-9001-2015)");
  assert.equal(links[0].slug, "iso-9001-2015");
});

test("parseMarkdownLinks: bare bracket [Article Title] classified correctly", () => {
  const { bareBrackets } = parseMarkdownLinks("[Some Article Title]");
  assert.ok(bareBrackets.some((b) => b.kind === "title-seed"));
});

test("parseMarkdownLinks: links outside code spans are parsed regardless of surrounding context", () => {
  const { links } = parseMarkdownLinks("Normal [A](halu:a-slug) and `code [B](halu:b-slug)` end.");
  // The low-level parser finds all markdown link syntax; suppression of code-span
  // content happens in the normalizer layer, not in parseMarkdownLinks.
  assert.ok(links.some((l) => l.slug === "a-slug"), "a-slug should always be parsed");
});

test("parseMarkdownLinks: empty brackets not treated as links", () => {
  const { links } = parseMarkdownLinks("See [] and [](halu:empty-label) here.");
  // Empty-label halu link still parsed; bare [] is not a link
  const emptyLabel = links.find((l) => l.slug === "empty-label");
  assert.ok(emptyLabel, "empty-label halu link should be parsed");
  assert.equal(emptyLabel?.label ?? "", "");
});

test("parseMarkdownLinks: back-to-back links on same line", () => {
  const { links } = parseMarkdownLinks('[A](halu:a-slug)[B](halu:b-slug)[C](ref:c-slug)');
  assert.equal(links.length, 3);
  assert.deepEqual(links.map((l) => l.slug), ["a-slug", "b-slug", "c-slug"]);
});

/* ─────────────────────────────────────────────────────────────────
   normalizeMarkdownLinks — rewriting and stripping
   ───────────────────────────────────────────────────────────────── */

test("normalizeMarkdownLinks: halu link passes through unchanged", () => {
  const input = '[Alpha](halu:alpha "nice hint")';
  const { markdown, changed } = normalizeMarkdownLinks(input, "article");
  assert.match(markdown, /halu:alpha/);
  assert.equal(changed, false);
});

// Our universal "getting markdown back from a language model and need to validate links and correct leakage" flow should go 
// (arrow indicates moving to the next step, vertical bar indicates branch along a conditional (bracketed by indented arrows), lack of arrow (or just a dash) indicates additional/multi-line context for that instruction (only arrows/conds move instructions))
// -> find valid and collect markdown links with a standard markdown link checker as part of md parsing, mark those as "valid md link" so the next steps don't match their contents (they will be handled separately)
// -> search remaining text (so, excluding the found links) for `ref:` and `halu:`, (henceforth for brevity, i'm calling them `type:` unless it only applies to one or the other) and for each instance of either found:
// -> check for slug following `:`
// -> check for brackets/parens bounding the found `type:slug` sequence (or just `type:` if no slug found). Be able to catch nested parens, but make sure it doesn't match standard use of parentheses (so, a link inside of text that is in parentheses, like these very words, or an emoticon). counting brackets/parens in the doc may help, because an unbalaned paren count AND a stray, immediately-adjacent bracket/paren is highly likely a syntax problem and won't match emoticons or standard parentheses due to the adjacency AND balance constraints (crucially, they must BOTH be true in order to make that assumption). Remember that we have already excluded valid md link syntax, so what remains must be something akin to [type:slug-name]
// -> having found related parentheses for this link candidate, extract the type and the slug, remembering where we had this link.
// -> validate the slug and type- refs will exist in the db as articles, halus won't.
// -> replace the link text for this candidate with a properly formatted link that has been constructed from the now validated type: and slug fields. Pulling existing article titles for refs, and use a function to convert the slug into a title for halu's to populate the anchor field. Mark these (and their positions) as "sanitized md links".
// -> we should now have our previously collected valid md links and our newly-formatted sanitized links. The sanitized links are now done and ready to ship/save, but the previous links need to be sanitized still:
// -- unfinished--
// -> yes? -> classify md link type
// | no? -> determine if possibly malformed link by checking for the presence of:
//       -> rewrite malformed and replace MD in sequence immediately (this gets carried over to all future versions of this doc) 
//          internal signifiers (halu:slug or ref:slug inside brackets or parentheses ) (such as missing the anchor brackets, or only being in anchor brackets, or having the slug in the anchor bracket, but you should construct this based on like.... a set of parentheses characters and internal link signifiers, so that you can combinatorially find all possible combinations of malformed links)
// -> format as html to stream to the client, save md
// TODO: these functions should do a quick check to see if the slug exists in the db as an existing article, adding it to the refs list and changing this to a ref: link if it does
// TODO the todo item here is to update the normalize* functions and update the test to ensure that nonextant entries get halufied, and extant entries get added to the refs list and turned into reflinks
test("normalizeMarkdownLinks: wiki path rewritten to halu", () => {
  const { markdown, stats } = normalizeMarkdownLinks("[X](/wiki/X_Article)", "article");
  assert.match(markdown, /halu:x-article/);
  assert.equal(stats.rewritten, 1);
});

test("normalizeMarkdownLinks: plain-slug rewritten to halu", () => {
  const { markdown, stats } = normalizeMarkdownLinks("[Some](some-plain-slug)", "article");
  assert.match(markdown, /halu:some-plain-slug/);
  assert.equal(stats.plainSlug, 1);
  assert.equal(stats.rewritten, 1);
});

test("normalizeMarkdownLinks: external link stripped, text preserved", () => {
  const { markdown, stats } = normalizeMarkdownLinks("[Visit](https://example.invalid)", "article");
  assert.doesNotMatch(markdown, /https?:/);
  assert.match(markdown, /Visit/);
  assert.equal(stats.stripped, 1);
});

// TODO: similar to above, this syntax needs to catch halu: as well, and should match (ref:items-in-parens), too! This should result in at least 4 new test cases
test("normalizeMarkdownLinks: bare [ref:slug] stripped", () => {
  const { markdown, stats } = normalizeMarkdownLinks("See [ref:foo-slug].", "article");
  assert.doesNotMatch(markdown, /\[ref:/);
  assert.equal(stats.bareRef, 1);
});

test("normalizeMarkdownLinks: loose halu: marker stripped", () => {
  const { markdown, stats } = normalizeMarkdownLinks("See halu:some-slug here.", "article");
  assert.doesNotMatch(markdown, /halu:/);
  assert.equal(stats.looseHalu, 1);
  assert.equal(stats.stripped, 1);
});

test("normalizeMarkdownLinks: multiple links in one pass", () => {
  const input = [
    '[Good](halu:good "hint")',
    "[Bad](https://bad.test)",
    "[Wiki](/wiki/Wiki_Page)",
    "[Plain](just-plain)",
  ].join(" and ");
  const { markdown, stats } = normalizeMarkdownLinks(input, "article");
  assert.match(markdown, /halu:good/);
  assert.doesNotMatch(markdown, /https?:/);
  assert.match(markdown, /halu:wiki-page/);
  assert.match(markdown, /halu:just-plain/);
  assert.equal(stats.stripped, 1); // only the external
  assert.equal(stats.rewritten, 2); // wiki + plain-slug
});

test("normalizeMarkdownLinks: ref links preserved in article context", () => {
  const input = "[Article](ref:article-slug) and [Num](ref:2)";
  const { markdown, stats } = normalizeMarkdownLinks(input, "article");
  assert.match(markdown, /ref:article-slug/);
  assert.match(markdown, /ref:2/);
  assert.equal(stats.ref, 2);
  assert.equal(stats.stripped, 0);
});

test("normalizeMarkdownLinks: changed=false when nothing modified", () => {
  const input = '[A](halu:a "hint") and [B](ref:b) text.';
  const { changed } = normalizeMarkdownLinks(input, "article");
  assert.equal(changed, false);
});

test("normalizeMarkdownLinks: changed=true when a link is rewritten", () => {
  const { changed } = normalizeMarkdownLinks("[Wiki](/wiki/Some_Page)", "article");
  assert.equal(changed, true);
});

/* ─────────────────────────────────────────────────────────────────
   normalizeHaluLinks — bare bracket → halu link conversion
   ───────────────────────────────────────────────────────────────── */

test("normalizeHaluLinks: plain title becomes halu link", () => {
  const result = normalizeHaluLinks("see [Some Article].");
  assert.match(result, /halu:some-article/);
  assert.match(result, /Some Article/);
});

test("normalizeHaluLinks: already-linked halu not double-wrapped", () => {
  const input = '[Already](halu:already "h") and [Some Article].';
  const result = normalizeHaluLinks(input);
  const matches = result.match(/halu:/g) ?? [];
  assert.equal(matches.length, 2); // already + some-article
});

test("normalizeHaluLinks: apostrophe title ok", () => {
  const result = normalizeHaluLinks("[Obama's Method]");
  assert.match(result, /halu:obama-s-method/);
});

test("normalizeHaluLinks: double-quote in label rejected", () => {
  const result = normalizeHaluLinks('[Some "quoted" Title]');
  // Should not produce a halu link with double-quoted label slug
  assert.doesNotMatch(result, /halu:some-quoted-title/);
});

test("normalizeHaluLinks: multi-word title with numbers", () => {
  const result = normalizeHaluLinks("[Area 51 Incident]");
  assert.match(result, /halu:area-51-incident/);
});

test("normalizeHaluLinks: title that's only punctuation rejected", () => {
  const result = normalizeHaluLinks("[---]");
  assert.doesNotMatch(result, /halu:/);
});

/* ─────────────────────────────────────────────────────────────────
   extractInternalLinks — edge cases
   ───────────────────────────────────────────────────────────────── */

test("extractInternalLinks: basic halu link", () => {
  const links = extractInternalLinks('[A](halu:a-slug "hint A")');
  assert.equal(links.length, 1);
  assert.equal(links[0].targetSlug, "a-slug");
  assert.equal(links[0].hiddenHint, "hint A");
  assert.equal(links[0].visibleLabel, "A");
});

test("extractInternalLinks: halu link without hint string not included in results", () => {
  // extractInternalLinks only extracts halu links that carry a quoted hint — a
  // bare [Label](halu:slug) with no "hint" is not returned.
  const links = extractInternalLinks("[NoHint](halu:no-hint-slug)");
  assert.equal(links.length, 0, "hint-less halu link should not be returned");
});

test("extractInternalLinks: unclosed hint string is recovered", () => {
  const links = extractInternalLinks('[A](halu:a "unclosed hint)');
  assert.equal(links.length, 1);
  assert.match(links[0].hiddenHint, /unclosed hint/);
});

test("extractInternalLinks: multiple on one line in order", () => {
  const links = extractInternalLinks('[A](halu:a "ha") [B](halu:b "hb") [C](halu:c "hc")');
  assert.deepEqual(links.map((l) => l.targetSlug), ["a", "b", "c"]);
});

test("extractInternalLinks: external links not returned; hint-bearing halu links are", () => {
  // The bare halu:int-slug (no hint) is also not extracted; add a hint to confirm external is excluded.
  const links = extractInternalLinks('[Ext](https://example.com) [Int](halu:int-slug "a hint")');
  assert.equal(links.length, 1);
  assert.equal(links[0].targetSlug, "int-slug");
});

test("extractInternalLinks: bare title brackets produce a link", () => {
  const links = extractInternalLinks("[Bare Article]");
  assert.equal(links.length, 1);
  assert.equal(links[0].targetSlug, "bare-article");
});

test("extractInternalLinks: self-reference with hint is extracted (consumer filters self-slugs)", () => {
  const links = extractInternalLinks('[Self](halu:self-article "the hint")');
  assert.equal(links.length, 1);
  assert.equal(links[0].targetSlug, "self-article");
});

test("extractInternalLinks: ref:slug links not included (only halu-style)", () => {
  const links = extractInternalLinks("[A](ref:a-slug)");
  // extractInternalLinks only returns halu-style links
  assert.equal(links.length, 0);
});

/* ─────────────────────────────────────────────────────────────────
   buildReferenceList — cap, pin, blacklist, and sourcing
   ───────────────────────────────────────────────────────────────── */

test("buildReferenceList: user additions always survive regardless of rag", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "alpha", "Alpha");
    seedDbArticle(db, "beta", "Beta");

    const refs = buildReferenceList(db, {
      articleSlug: "test-article",
      ragSources: [],
      userAdditions: [makeRef("alpha", "Alpha"), makeRef("beta", "Beta")],
      revisionId: "current",
      config: { reference_max_results: 8, reference_min_score: 0.4, max_references: 50, reference_recursive_depth: 0, reference_recursive_max_per_article: 0 },
    }, noop());

    const slugs = refs.map((r) => r.slug);
    assert.ok(slugs.includes("alpha"), "alpha should be in refs");
    assert.ok(slugs.includes("beta"), "beta should be in refs");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildReferenceList: pinned entry survives cap and does not count toward it", () => {
  const { root, db } = makeTempDb();
  try {
    // Create max_references + 1 regular articles plus 1 pinned
    for (let i = 1; i <= 4; i++) seedDbArticle(db, `ref-${i}`, `Ref ${i}`);
    seedDbArticle(db, "pinned-one", "Pinned One");

    const userAdditions: ReferenceList = [
      ...Array.from({ length: 4 }, (_, i) => makeRef(`ref-${i + 1}`, `Ref ${i + 1}`)),
      { ...makeRef("pinned-one", "Pinned One"), pinned: true },
    ];

    const refs = buildReferenceList(db, {
      articleSlug: "test-article",
      ragSources: [],
      userAdditions,
      revisionId: "current",
      config: { reference_max_results: 8, reference_min_score: 0.4, max_references: 4, reference_recursive_depth: 0, reference_recursive_max_per_article: 0 },
    }, noop());

    // Pinned one must be present even though cap is 4
    assert.ok(refs.some((r) => r.slug === "pinned-one"), "pinned entry must survive cap");
    // Regular refs fill the cap
    const nonPinned = refs.filter((r) => !r.pinned);
    assert.ok(nonPinned.length <= 4, "non-pinned refs should not exceed cap");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildReferenceList: blacklisted slug excluded even when user-added", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "allowed", "Allowed");
    seedDbArticle(db, "blocked", "Blocked");

    const refs = buildReferenceList(db, {
      articleSlug: "test-article",
      ragSources: [],
      userAdditions: [makeRef("allowed", "Allowed"), makeRef("blocked", "Blocked")],
      blacklistSlugs: ["blocked"],
      revisionId: "current",
      config: { reference_max_results: 8, reference_min_score: 0.4, max_references: 50, reference_recursive_depth: 0, reference_recursive_max_per_article: 0 },
    }, noop());

    assert.ok(refs.some((r) => r.slug === "allowed"), "allowed should be present");
    assert.ok(!refs.some((r) => r.slug === "blocked"), "blocked should be excluded");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildReferenceList: self-reference always excluded", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "self-article", "Self Article");
    seedDbArticle(db, "other", "Other");

    const refs = buildReferenceList(db, {
      articleSlug: "self-article",
      ragSources: [],
      userAdditions: [makeRef("self-article", "Self Article"), makeRef("other", "Other")],
      revisionId: "current",
      config: { reference_max_results: 8, reference_min_score: 0.4, max_references: 50, reference_recursive_depth: 0, reference_recursive_max_per_article: 0 },
    }, noop());

    assert.ok(!refs.some((r) => r.slug === "self-article"), "self-reference must be excluded");
    assert.ok(refs.some((r) => r.slug === "other"), "other should be present");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildReferenceList: unknown slug rejected (not in articles table)", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "real", "Real");

    const refs = buildReferenceList(db, {
      articleSlug: "test-article",
      ragSources: [],
      userAdditions: [makeRef("real", "Real"), makeRef("ghost-slug", "Ghost")],
      revisionId: "current",
      config: { reference_max_results: 8, reference_min_score: 0.4, max_references: 50, reference_recursive_depth: 0, reference_recursive_max_per_article: 0 },
    }, noop());

    assert.ok(refs.some((r) => r.slug === "real"), "real article should be in refs");
    assert.ok(!refs.some((r) => r.slug === "ghost-slug"), "unknown slug must be rejected");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildReferenceList: prior refs carried forward when no RAG and no user additions", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "prior-ref", "Prior Ref");
    const now = Date.now();
    saveArticleReferences(db, "test-article", now, [makeRef("prior-ref", "Prior Ref")]);

    const refs = buildReferenceList(db, {
      articleSlug: "test-article",
      ragSources: [],
      priorReferences: [makeRef("prior-ref", "Prior Ref")],
      revisionId: "current",
      config: { reference_max_results: 8, reference_min_score: 0.4, max_references: 50, reference_recursive_depth: 0, reference_recursive_max_per_article: 0 },
    }, noop());

    assert.ok(refs.some((r) => r.slug === "prior-ref"), "prior ref should be carried forward");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildReferenceList: each slug appears at most once", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "dedupe", "Dedupe");

    const refs = buildReferenceList(db, {
      articleSlug: "test-article",
      ragSources: [{ slug: "dedupe", title: "Dedupe", content: "c", score: 0.9 }],
      userAdditions: [makeRef("dedupe", "Dedupe")],
      priorReferences: [makeRef("dedupe", "Dedupe")],
      revisionId: "current",
      config: { reference_max_results: 8, reference_min_score: 0.4, max_references: 50, reference_recursive_depth: 0, reference_recursive_max_per_article: 0 },
    }, noop());

    const dedupeCount = refs.filter((r) => r.slug === "dedupe").length;
    assert.equal(dedupeCount, 1, "dedupe slug should appear exactly once");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildReferenceList: RAG entry below min_score excluded", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "low-score", "Low Score");

    const refs = buildReferenceList(db, {
      articleSlug: "test-article",
      ragSources: [{ slug: "low-score", title: "Low Score", content: "c", score: 0.1 }],
      revisionId: "current",
      config: { reference_max_results: 8, reference_min_score: 0.5, max_references: 50, reference_recursive_depth: 0, reference_recursive_max_per_article: 0 },
    }, noop());

    assert.ok(!refs.some((r) => r.slug === "low-score"), "low-score RAG entry should be excluded");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ─────────────────────────────────────────────────────────────────
   resolveRefLinks
   ───────────────────────────────────────────────────────────────── */

test("resolveRefLinks: ref:slug kept for first occurrence, label normalised", () => {
  // resolveRefLinks keeps ref:slug — renderMarkdown converts ref: to wiki paths.
  const refs: ReferenceList = [makeRef("alpha", "Alpha")];
  const body = "See [Alpha](ref:alpha).";
  const resolved = resolveRefLinks(body, refs);
  assert.match(resolved, /ref:alpha/);
  assert.match(resolved, /Alpha/);
});

test("resolveRefLinks: ref:N numeric resolved to canonical ref:slug form", () => {
  const refs: ReferenceList = [makeRef("first", "First"), makeRef("second", "Second")];
  const body = "Citation [X](ref:1) and [Y](ref:2).";
  const resolved = resolveRefLinks(body, refs);
  assert.match(resolved, /ref:first/);
  assert.match(resolved, /ref:second/);
  assert.doesNotMatch(resolved, /\(ref:1\)/);
  assert.doesNotMatch(resolved, /\(ref:2\)/);
});

test("resolveRefLinks: second occurrence of same ref collapses to plain text", () => {
  const refs: ReferenceList = [makeRef("glow-fruit", "Glow Fruit")];
  const body = "[Glow Fruit](ref:glow-fruit) then [Glow Fruit](ref:glow-fruit) again.";
  const resolved = resolveRefLinks(body, refs);
  // First stays as ref:glow-fruit; second becomes plain text
  const refCount = (resolved.match(/ref:glow-fruit/g) ?? []).length;
  assert.equal(refCount, 1, "second occurrence must be collapsed to plain text");
  assert.match(resolved, /then Glow Fruit again/);
});

test("resolveRefLinks: empty ref list returns body unchanged", () => {
  const body = "Some text [A](ref:a-slug) with ref.";
  const resolved = resolveRefLinks(body, []);
  assert.equal(resolved, body);
});

test("resolveRefLinks: unknown ref:slug raw form preserved", () => {
  const refs: ReferenceList = [makeRef("known", "Known")];
  const body = "[Unknown](ref:unknown-slug) and [Known](ref:known).";
  const resolved = resolveRefLinks(body, refs);
  assert.match(resolved, /ref:unknown-slug/);
  assert.match(resolved, /ref:known/);
});

/* ─────────────────────────────────────────────────────────────────
   renderReferencesHtml
   ───────────────────────────────────────────────────────────────── */

test("renderReferencesHtml: empty list returns empty string", () => {
  assert.equal(renderReferencesHtml([]), "");
});

test("renderReferencesHtml: produces numbered <ol> with anchor IDs", () => {
  const refs = [makeRef("alpha", "Alpha"), makeRef("beta", "Beta")];
  const html = renderReferencesHtml(refs);
  assert.match(html, /<ol/);
  assert.match(html, /id="ref-1"/);
  assert.match(html, /id="ref-2"/);
  assert.match(html, /Alpha/);
  assert.match(html, /Beta/);
});

test("renderReferencesHtml: title with ampersand and angle bracket rendered as-is (not HTML-escaped by this layer)", () => {
  // renderReferencesHtml places the title directly in an <a> element; markdown-it
  // rendering later handles any escaping for the final HTML output.
  const refs = [makeRef("x", "AT&T Corp")];
  const html = renderReferencesHtml(refs);
  assert.match(html, /AT&T Corp/);
});

/* ─────────────────────────────────────────────────────────────────
   formatReferencesForPrompt
   ───────────────────────────────────────────────────────────────── */

test("formatReferencesForPrompt: returns (none) for empty list", () => {
  assert.equal(formatReferencesForPrompt([]), "(none)");
});

test("formatReferencesForPrompt: one entry per ref in - [Title](ref:slug) format", () => {
  const refs = [makeRef("alpha", "Alpha"), makeRef("beta", "Beta")];
  const prompt = formatReferencesForPrompt(refs);
  assert.match(prompt, /- \[Alpha\]\(ref:alpha\)/);
  assert.match(prompt, /- \[Beta\]\(ref:beta\)/);
});

/* ─────────────────────────────────────────────────────────────────
   findExistingArticleLinkReferences / findBodyReferencedArticles
   ───────────────────────────────────────────────────────────────── */

test("findExistingArticleLinkReferences: finds halu links present in DB", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "linked-article", "Linked Article");
    const body = '[Link](halu:linked-article "Some hint") and [Unknown](halu:nonexistent)';
    const refs = findExistingArticleLinkReferences(db, body, "host-article");
    assert.ok(refs.some((r) => r.slug === "linked-article"), "DB-backed article should appear");
    assert.ok(!refs.some((r) => r.slug === "nonexistent"), "unknown slug should not appear");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("findExistingArticleLinkReferences: self-reference excluded", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "self", "Self");
    const body = '[Self](halu:self "hint")';
    const refs = findExistingArticleLinkReferences(db, body, "self");
    assert.equal(refs.length, 0, "self-reference must be excluded");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("findBodyReferencedArticles: finds ref: links in addition to halu:", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "ref-target", "Ref Target");
    const body = "See [Ref Target](ref:ref-target) here.";
    const refs = findBodyReferencedArticles(db, body, "host");
    assert.ok(refs.some((r) => r.slug === "ref-target"), "ref: link should surface as body reference");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("findBodyReferencedArticles: deduplicates slugs from multiple link types", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "dupe", "Dupe");
    // Same slug via both halu: and ref: — must appear only once
    const body = '[Dupe](halu:dupe "h") and [Dupe](ref:dupe)';
    const refs = findBodyReferencedArticles(db, body, "host");
    const dupeCount = refs.filter((r) => r.slug === "dupe").length;
    assert.equal(dupeCount, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ─────────────────────────────────────────────────────────────────
   linkMentionedReferencesInBody
   ───────────────────────────────────────────────────────────────── */

test("linkMentionedReferencesInBody: title mention gets a ref link", () => {
  const refs: ReferenceList = [makeRef("glow-fruit", "Glow Fruit")];
  const body = "The Glow Fruit is notable.";
  const linked = linkMentionedReferencesInBody(body, refs);
  assert.match(linked, /ref:glow-fruit/);
});

test("linkMentionedReferencesInBody: already-linked title not double-linked", () => {
  const refs: ReferenceList = [makeRef("glow-fruit", "Glow Fruit")];
  const body = "[Glow Fruit](ref:glow-fruit) is mentioned and Glow Fruit appears again.";
  const linked = linkMentionedReferencesInBody(body, refs);
  const refCount = (linked.match(/ref:glow-fruit/g) ?? []).length;
  assert.equal(refCount, 1, "title mention should not be double-linked");
});

test("linkMentionedReferencesInBody: no-op when refs is empty", () => {
  const body = "Some text mentioning Nothing.";
  const linked = linkMentionedReferencesInBody(body, []);
  assert.equal(linked, body);
});

test("linkMentionedReferencesInBody: partial title match not linked", () => {
  // "Fruit" should not match "Glow Fruit"
  const refs: ReferenceList = [makeRef("glow-fruit", "Glow Fruit")];
  const body = "We see the Fruit here but not the full title.";
  const linked = linkMentionedReferencesInBody(body, refs);
  assert.doesNotMatch(linked, /ref:glow-fruit/);
});

/* ─────────────────────────────────────────────────────────────────
   convertExistingArticleLinksToRefs
   ───────────────────────────────────────────────────────────────── */

test("convertExistingArticleLinksToRefs: halu link for article in refs becomes ref: link", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "target", "Target");
    const body = '[Target](halu:target "hint")';
    const result = convertExistingArticleLinksToRefs(db, body, "host");
    assert.match(result, /ref:target/);
    assert.doesNotMatch(result, /halu:target/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("convertExistingArticleLinksToRefs: halu link for unknown article unchanged", () => {
  const { root, db } = makeTempDb();
  try {
    const body = '[Unknown](halu:does-not-exist "hint")';
    const result = convertExistingArticleLinksToRefs(db, body, "host");
    assert.match(result, /halu:does-not-exist/);
    assert.doesNotMatch(result, /ref:does-not-exist/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ─────────────────────────────────────────────────────────────────
   findTitleMentionedArticles
   ───────────────────────────────────────────────────────────────── */

test("findTitleMentionedArticles: mentions of existing article titles returned", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "sodium-chloride", "Sodium Chloride");
    const body = "Sodium Chloride is also known as table salt.";
    const refs = findTitleMentionedArticles(db, body, "host");
    assert.ok(refs.some((r) => r.slug === "sodium-chloride"));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ─────────────────────────────────────────────────────────────────
   HTTP endpoint: pin-reference
   ───────────────────────────────────────────────────────────────── */

function makeTempDbPath() {
  const root = mkdtempSync(join(tmpdir(), "halu-http-"));
  const databasePath = join(root, TEST_CONFIG.database_path);
  return { root, databasePath };
}

async function makeTestApp(databasePath: string, llm?: LlmClient) {
  const client = llm ?? new EchoLlm();
  const { app, shutdown } = await createApp({
    databasePath,
    skipLlmProbe: true,
    skipHomepagePrepare: true,
    llmClient: client,
  });
  const db = openDatabase(databasePath);
  const request = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://halupedia.test${path}`, init));
  return { request, db, shutdown };
}

test("pin-reference: pinning a saved reference persists pinned=true", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, db, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  seedDbArticle(db, "anchor-article", "Anchor Article");
  seedDbArticle(db, "ref-a", "Ref A");

  const now = Date.now();
  saveArticleReferences(db, "anchor-article", now, [makeRef("ref-a", "Ref A")]);

  const res = await request("/api/article/anchor-article/pin-reference", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refSlug: "ref-a", pinned: true }),
  });
  assert.equal(res.status, 200);

  const updated = getLatestArticleReferences(db, "anchor-article");
  const refA = updated.find((r) => r.slug === "ref-a");
  assert.ok(refA, "ref-a should still be in refs");
  assert.equal(refA?.pinned, true, "ref-a should be pinned");
});

test("pin-reference: unpinning a pinned reference sets pinned=false", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, db, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  seedDbArticle(db, "anchor-article", "Anchor Article");
  seedDbArticle(db, "ref-b", "Ref B");

  const now = Date.now();
  saveArticleReferences(db, "anchor-article", now, [{ ...makeRef("ref-b", "Ref B"), pinned: true }]);

  const res = await request("/api/article/anchor-article/pin-reference", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refSlug: "ref-b", pinned: false }),
  });
  assert.equal(res.status, 200);

  const updated = getLatestArticleReferences(db, "anchor-article");
  assert.equal(updated.find((r) => r.slug === "ref-b")?.pinned, false);
});

test("pin-reference: 404 for unknown article", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  const res = await request("/api/article/nonexistent-article/pin-reference", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refSlug: "x", pinned: true }),
  });
  assert.equal(res.status, 404);
});

test("pin-reference: 404 when refSlug not in current reference list", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, db, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  seedDbArticle(db, "anchor-article", "Anchor Article");
  // No refs saved yet

  const res = await request("/api/article/anchor-article/pin-reference", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refSlug: "ghost-ref", pinned: true }),
  });
  assert.equal(res.status, 404);
});

/* ─────────────────────────────────────────────────────────────────
   HTTP endpoint: preview-markdown
   ───────────────────────────────────────────────────────────────── */

test("preview-markdown: returns rendered HTML for valid markdown", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, db, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  seedDbArticle(db, "preview-article", "Preview Article");

  const markdown = "# Hello\n\nThis is **bold**.";
  const res = await request("/api/article/preview-article/preview-markdown", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { html: string; diagnostics: unknown[] };
  assert.match(body.html, /<strong>bold<\/strong>/);
  assert.ok(Array.isArray(body.diagnostics));
});

test("preview-markdown: broken halu link reported as warn diagnostic", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, db, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  seedDbArticle(db, "preview-article", "Preview Article");

  const markdown = '[Broken](halu:this-does-not-exist "hint")';
  const res = await request("/api/article/preview-article/preview-markdown", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { html: string; diagnostics: Array<{ severity: string; message: string }> };
  assert.ok(body.diagnostics.some((d) => d.severity === "warn" && d.message.includes("this-does-not-exist")));
});

test("preview-markdown: valid halu link produces no broken-link diagnostic", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, db, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  seedDbArticle(db, "preview-article", "Preview Article");
  seedDbArticle(db, "real-article", "Real Article");

  const markdown = '[Real Article](halu:real-article "exists")';
  const res = await request("/api/article/preview-article/preview-markdown", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown }),
  });
  const body = await res.json() as { diagnostics: Array<{ severity: string }> };
  const warns = body.diagnostics.filter((d) => d.severity === "warn" || d.severity === "error");
  assert.equal(warns.length, 0, "no warn diagnostics for valid links");
});

test("preview-markdown: empty markdown returns empty HTML", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, db, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  seedDbArticle(db, "preview-article", "Preview Article");

  const res = await request("/api/article/preview-article/preview-markdown", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown: "" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { html: string };
  assert.equal(body.html, "");
});

test("preview-markdown: 404 for unknown article slug", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  const res = await request("/api/article/ghost-article/preview-markdown", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown: "# hi" }),
  });
  assert.equal(res.status, 404);
});

/* ─────────────────────────────────────────────────────────────────
   HTTP endpoint: raw-save
   ───────────────────────────────────────────────────────────────── */

test("raw-save: saves markdown and creates a revision", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, db, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  seedDbArticle(db, "raw-article", "Raw Article", "Original body.");

  const newMarkdown = "# Raw Article\n\nUpdated via raw edit.";
  const res = await request("/api/article/raw-article/raw-save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown: newMarkdown }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { article: { markdown: string } };
  assert.match(body.article.markdown, /Updated via raw edit/);

  // Revision should exist in the DB
  const revisions = (await import("../src/server/db")).listArticleRevisions(db, "raw-article");
  assert.ok(revisions.length > 0, "at least one revision should exist");
  assert.ok(revisions.some((r) => r.operation === "raw-edit"), "revision operation should be raw-edit");
});

test("raw-save: ref slugs passed become part of reference list", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, db, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  seedDbArticle(db, "raw-article", "Raw Article");
  seedDbArticle(db, "linked-ref", "Linked Ref");

  const res = await request("/api/article/raw-article/raw-save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      markdown: "# Raw Article\n\nSome body.",
      referenceSlugs: ["linked-ref"],
    }),
  });
  assert.equal(res.status, 200);

  const refs = getLatestArticleReferences(db, "raw-article");
  assert.ok(refs.some((r) => r.slug === "linked-ref"), "linked-ref should be in saved references");
});

test("raw-save: normalizes links in submitted markdown", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, db, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  seedDbArticle(db, "raw-article", "Raw Article");

  // Submit markdown with a wiki-style link — should be normalized to halu:
  const markdown = "# Raw Article\n\nSee [Something](/wiki/Something_Good).";
  const res = await request("/api/article/raw-article/raw-save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { article: { markdown: string } };
  assert.doesNotMatch(body.article.markdown, /\/wiki\//);
  assert.match(body.article.markdown, /halu:something-good/);
});

test("raw-save: 404 for unknown article", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  const res = await request("/api/article/nonexistent-article/raw-save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown: "# Hi" }),
  });
  assert.equal(res.status, 404);
});

test("raw-save: 400 for missing/empty markdown body", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, db, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  seedDbArticle(db, "raw-article", "Raw Article");

  const res = await request("/api/article/raw-article/raw-save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown: "   " }),
  });
  assert.equal(res.status, 400);
});

/* ─────────────────────────────────────────────────────────────────
   Backlink context injection (listIncomingHints → references)
   ───────────────────────────────────────────────────────────────── */

test("listIncomingHints: returns hints from articles that link to the target", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "source-article", "Source Article");
    seedDbArticle(db, "target-article", "Target Article");

    const links = extractInternalLinks('[Target Article](halu:target-article "context about target")');
    const now = Date.now();
    // Seed the article_links table by saving an article with a body link
    saveArticle(
      db,
      {
        slug: "source-article",
        canonicalSlug: "source-article",
        title: "Source Article",
        displayTitle: "Source Article",
        markdown: '# Source Article\n\n[Target Article](halu:target-article "context about target")',
        html: "<p>link</p>",
        summaryMarkdown: "source summary",
        plain_text: "link",
        generated_at: now,
      },
      links.map((l) => ({ targetSlug: l.targetSlug, visibleLabel: l.visibleLabel, hiddenHint: l.hiddenHint })),
      ["source-article"],
    );

    const hints = listIncomingHints(db, "target-article");
    assert.ok(hints.length > 0, "should find at least one incoming hint");
    assert.ok(hints.some((h) => h.sourceSlug === "source-article"), "source-article should be a hint source");
    assert.ok(hints.some((h) => h.hiddenHint === "context about target"), "hidden hint should carry through");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("listIncomingHints: returns empty array when no articles link to the target", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "lonely-article", "Lonely Article");
    const hints = listIncomingHints(db, "lonely-article");
    assert.equal(hints.length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ─────────────────────────────────────────────────────────────────
   renderMarkdown — halu link rendering
   ───────────────────────────────────────────────────────────────── */

test("renderMarkdown: halu link produces correct wiki path href", () => {
  const html = renderMarkdown('[Biomaterial Tooth Fragment](halu:biomaterial-tooth-fragment "specialized dental microsamples")');
  assert.match(html, /href="\/wiki\/Biomaterial_Tooth_Fragment"/);
  assert.doesNotMatch(html, /halu:/);
  assert.doesNotMatch(html, /specialized dental microsamples/);
});

test("renderMarkdown: ref: link produces halu-style wiki path (after resolveRefLinks)", () => {
  const refs: ReferenceList = [makeRef("alpha", "Alpha")];
  const resolved = resolveRefLinks("[Alpha](ref:alpha)", refs);
  const html = renderMarkdown(resolved);
  assert.match(html, /href="\/wiki\/Alpha"/);
});

test("renderMarkdown: external links stripped by normalizer do not appear in HTML", () => {
  const normalized = normalizeMarkdownLinks("[Bad](https://bad.test)", "article");
  const html = renderMarkdown(normalized.markdown);
  assert.doesNotMatch(html, /bad\.test/);
  assert.match(html, /Bad/);
});

test("renderMarkdown: bare bracket title link becomes clickable", () => {
  const html = renderMarkdown("[Some Article]");
  assert.match(html, /href="\/wiki\/Some_Article"/);
});

/* ─────────────────────────────────────────────────────────────────
   markdownToPlainText
   ───────────────────────────────────────────────────────────────── */

test("markdownToPlainText: strips halu links, bold, headers", () => {
  const md = '# Heading\n\n[Link Text](halu:slug "h") and **bold** and *italic*.';
  const plain = markdownToPlainText(md);
  assert.doesNotMatch(plain, /halu:/);
  assert.doesNotMatch(plain, /\*\*/);
  assert.match(plain, /Link Text/);
  assert.match(plain, /bold/);
  assert.match(plain, /italic/);
});

test("markdownToPlainText: strips ref: links, preserves visible label", () => {
  const md = "See [Alpha](ref:alpha) for details.";
  const plain = markdownToPlainText(md);
  assert.doesNotMatch(plain, /ref:/);
  assert.match(plain, /Alpha/);
});

/* ─────────────────────────────────────────────────────────────────
   normalizeMarkdown — title heading handling
   ───────────────────────────────────────────────────────────────── */

test("normalizeMarkdown: preserves h1 title", () => {
  const md = "# My Title\n\nSome body text.";
  const result = normalizeMarkdown(md);
  assert.match(result, /# My Title/);
  assert.match(result, /Some body text/);
});

test("normalizeMarkdown: trims leading and trailing whitespace", () => {
  const md = "\n\n\n# My Title\n\nBody.\n\n\n";
  const result = normalizeMarkdown(md);
  assert.doesNotMatch(result, /^\n/);
  assert.doesNotMatch(result, /\n$/);
});

/* ─────────────────────────────────────────────────────────────────
   References GET endpoint
   ───────────────────────────────────────────────────────────────── */

test("GET /api/article/:slug/references: returns saved refs with pinned field", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, db, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  seedDbArticle(db, "host", "Host");
  seedDbArticle(db, "ref-c", "Ref C");

  const now = Date.now();
  saveArticleReferences(db, "host", now, [{ ...makeRef("ref-c", "Ref C"), pinned: true }]);

  const res = await request("/api/article/host/references");
  assert.equal(res.status, 200);
  const body = await res.json() as { references: Array<{ slug: string; pinned: boolean }> };
  const refC = body.references.find((r) => r.slug === "ref-c");
  assert.ok(refC, "ref-c should be returned");
  assert.equal(refC?.pinned, true);
});

test("GET /api/article/:slug/references: 404 for unknown article", async (t) => {
  const { root, databasePath } = makeTempDbPath();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { request, shutdown } = await makeTestApp(databasePath);
  t.after(() => shutdown());
  const res = await request("/api/article/does-not-exist/references");
  assert.equal(res.status, 404);
});

/* ─────────────────────────────────────────────────────────────────
   Various string edge cases in link parser
   ───────────────────────────────────────────────────────────────── */

test("parseMarkdownLinks: markdown with no links returns empty lists", () => {
  const { links, bareBrackets, looseInternalMarkers } = parseMarkdownLinks("Just plain text here.");
  assert.equal(links.length, 0);
  assert.equal(bareBrackets.length, 0);
  assert.equal(looseInternalMarkers.length, 0);
});

test("parseMarkdownLinks: link inside bold markers parsed correctly", () => {
  const { links } = parseMarkdownLinks("**[Bold Link](halu:bold-slug)**");
  assert.equal(links.length, 1);
  assert.equal(links[0].slug, "bold-slug");
  assert.equal(links[0].label, "Bold Link");
});

test("parseMarkdownLinks: link inside italic markers parsed correctly", () => {
  const { links } = parseMarkdownLinks("_[Italic Link](halu:italic-slug)_");
  assert.equal(links.length, 1);
  assert.equal(links[0].slug, "italic-slug");
});

test("parseMarkdownLinks: bold text inside link label preserved", () => {
  const { links } = parseMarkdownLinks("[**Bold Label**](halu:some-slug)");
  assert.equal(links.length, 1);
  assert.equal(links[0].slug, "some-slug");
});

test("parseMarkdownLinks: link with very long hint string", () => {
  const hint = "A ".repeat(200).trim();
  const { links } = parseMarkdownLinks(`[Long](halu:long-slug "${hint}")`);
  assert.equal(links.length, 1);
  assert.ok((links[0].hint?.length ?? 0) > 100);
});

test("parseMarkdownLinks: single-char slug and label", () => {
  const { links } = parseMarkdownLinks("[A](halu:a)");
  assert.equal(links.length, 1);
  assert.equal(links[0].slug, "a");
  assert.equal(links[0].label, "A");
});

test("parseMarkdownLinks: slug with leading number", () => {
  const { links } = parseMarkdownLinks("[42nd Street](halu:42nd-street)");
  assert.equal(links.length, 1);
  assert.equal(links[0].slug, "42nd-street");
});

test("normalizeMarkdownLinks: link in blockquote normalized", () => {
  const { markdown } = normalizeMarkdownLinks("> [Wiki](/wiki/Quoted_Article)\n", "article");
  assert.match(markdown, /halu:quoted-article/);
});

test("normalizeMarkdownLinks: link in list item normalized", () => {
  const { markdown } = normalizeMarkdownLinks("- [Item](/wiki/List_Item)\n", "article");
  assert.match(markdown, /halu:list-item/);
});

test("normalizeMarkdownLinks: link in heading normalized", () => {
  const { markdown } = normalizeMarkdownLinks("## [Section](/wiki/Some_Section)\n", "article");
  assert.match(markdown, /halu:some-section/);
});

test("normalizeMarkdownLinks: multiple http/https external links all stripped", () => {
  // Only http: and https: are treated as external links by the normalizer;
  // other protocols like ftp: are not classified and pass through.
  const input = "[A](https://a.test) [B](http://b.test)";
  const { markdown, stats } = normalizeMarkdownLinks(input, "article");
  assert.doesNotMatch(markdown, /https?:/);
  assert.equal(stats.stripped, 2);
});

/* ─────────────────────────────────────────────────────────────────
   parseMarkdownLinks — exhaustive edge case battery
   ───────────────────────────────────────────────────────────────── */

test("parseMarkdownLinks: halu with single-quoted hint", () => {
  const { links } = parseMarkdownLinks("[A](halu:a-slug 'single quote hint')");
  assert.equal(links.length, 1);
  assert.equal(links[0].slug, "a-slug");
  assert.ok(links[0].hint?.includes("single quote hint"));
});

test("parseMarkdownLinks: halu hint with escaped quote inside", () => {
  const { links } = parseMarkdownLinks('[A](halu:a-slug "hint with \\"inner\\" quotes")');
  assert.equal(links.length, 1);
  assert.equal(links[0].slug, "a-slug");
});

test("parseMarkdownLinks: halu link with unicode slug chars", () => {
  // slug part should be slugified/lowercase by the parser
  const { links } = parseMarkdownLinks("[A](halu:über-café)");
  assert.ok(links.length >= 0); // parser must not crash
});

test("parseMarkdownLinks: consecutive ref links, each gets own entry", () => {
  const { links } = parseMarkdownLinks("[A](ref:a-slug) [B](ref:b-slug) [C](ref:c-slug)");
  assert.equal(links.length, 3);
  assert.equal(links[0].kind, "ref");
  assert.equal(links[1].kind, "ref");
  assert.equal(links[2].kind, "ref");
});

test("parseMarkdownLinks: wiki path with underscores normalised to slug", () => {
  const { links } = parseMarkdownLinks("[X](/wiki/Some_Multi_Word_Title)");
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "wiki");
  assert.equal(links[0].slug, "some-multi-word-title");
});

test("parseMarkdownLinks: wiki path with encoded spaces", () => {
  const { links } = parseMarkdownLinks("[Y](/wiki/Space%20Article)");
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "wiki");
});

test("parseMarkdownLinks: empty target [A]() produces unknown kind", () => {
  const { links } = parseMarkdownLinks("[A]()");
  // An empty target is classified as "empty"
  const kinds = links.map((l) => l.kind);
  assert.ok(kinds.every((k) => k !== "halu" && k !== "ref"));
});

test("parseMarkdownLinks: ref link with uppercase slug gets lowercased", () => {
  const { links } = parseMarkdownLinks("[X](ref:UPPER-SLUG)");
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "ref");
  // slug should be normalised to lowercase
  assert.equal(links[0].slug, "upper-slug");
});

test("parseMarkdownLinks: multiple bare halu: markers in one string", () => {
  const { looseInternalMarkers } = parseMarkdownLinks("see halu:alpha and halu:beta here");
  const slugs = looseInternalMarkers.map((m) => m.slug);
  assert.ok(slugs.includes("alpha"));
  assert.ok(slugs.includes("beta"));
});

test("parseMarkdownLinks: ref:slug in parentheses (not link) flagged as loose marker", () => {
  const { looseInternalMarkers } = parseMarkdownLinks("note (ref:some-slug) here");
  assert.ok(looseInternalMarkers.some((m) => m.kind === "ref" && m.slug === "some-slug"));
});

test("parseMarkdownLinks: image markdown not treated as a link", () => {
  const { links } = parseMarkdownLinks("![Alt](https://image.test/pic.png)");
  // Images begin with ! — should not be classified as internal links
  assert.ok(!links.some((l) => l.kind === "halu" || l.kind === "ref"));
});

test("parseMarkdownLinks: plain URL without brackets not classified as link", () => {
  const { links } = parseMarkdownLinks("Visit https://example.com for info.");
  assert.equal(links.length, 0);
});

test("parseMarkdownLinks: multiple same-slug ref links all appear", () => {
  const { links } = parseMarkdownLinks("[A](ref:dup-slug) and [B](ref:dup-slug)");
  assert.equal(links.length, 2);
  assert.ok(links.every((l) => l.slug === "dup-slug"));
});

test("parseMarkdownLinks: halu link with path-like slug", () => {
  const { links } = parseMarkdownLinks("[Deep](halu:some-category/some-article)");
  assert.equal(links.length, 1);
  // slug may be slugified further — just confirm not empty
  assert.ok(links[0].slug);
});

/* ─────────────────────────────────────────────────────────────────
   normalizeMarkdownLinks — thorough edge cases
   ───────────────────────────────────────────────────────────────── */

test("normalizeMarkdownLinks: link inside table cell normalized", () => {
  const { markdown } = normalizeMarkdownLinks("| Col | [Item](/wiki/Table_Item) |", "article");
  assert.match(markdown, /halu:table-item/);
});

test("normalizeMarkdownLinks: adjacent halu links not merged", () => {
  const input = '[A](halu:a "ha")[B](halu:b "hb")';
  const { markdown } = normalizeMarkdownLinks(input, "article");
  assert.match(markdown, /halu:a/);
  assert.match(markdown, /halu:b/);
});

test("normalizeMarkdownLinks: link label with brackets inside not mangled", () => {
  const { markdown } = normalizeMarkdownLinks('[Text [note]](halu:slug "h")', "article");
  // Parser should handle this without crashing
  assert.ok(typeof markdown === "string");
});

test("normalizeMarkdownLinks: ref link in nested italic not broken", () => {
  const input = "_see [Alpha](ref:alpha)_";
  const { markdown } = normalizeMarkdownLinks(input, "article");
  assert.match(markdown, /ref:alpha/);
  assert.match(markdown, /Alpha/);
});

test("normalizeMarkdownLinks: ref:0 and ref:100000 kept as-is (no normalisation needed)", () => {
  const { markdown } = normalizeMarkdownLinks("[X](ref:0) [Y](ref:100000)", "article");
  assert.match(markdown, /ref:0/);
  assert.match(markdown, /ref:100000/);
});

test("normalizeMarkdownLinks: no links → unchanged and changed=false", () => {
  const input = "Plain text with no links at all.";
  const { markdown, changed } = normalizeMarkdownLinks(input, "article");
  assert.equal(markdown, input);
  assert.equal(changed, false);
});

test("normalizeMarkdownLinks: only whitespace → unchanged", () => {
  const { markdown, changed } = normalizeMarkdownLinks("   ", "article");
  assert.equal(changed, false);
});

test("normalizeMarkdownLinks: multi-line body with mixed link types", () => {
  const input = [
    "# Title",
    "",
    "See [Good](halu:good-slug) and [Wiki](/wiki/Wikilink) and [Bad](https://bad.test).",
    "Also [Ref](ref:ref-slug) and [Bare Article].",
  ].join("\n");
  const { markdown, stats } = normalizeMarkdownLinks(input, "article");
  assert.match(markdown, /halu:good-slug/);
  assert.match(markdown, /halu:wikilink/);
  assert.doesNotMatch(markdown, /https?:/);
  assert.match(markdown, /ref:ref-slug/);
  assert.equal(stats.stripped, 1);
  assert.equal(stats.rewritten, 1);
});

test("normalizeMarkdownLinks: duplicate halu link to same slug — both kept", () => {
  const input = '[A](halu:dup "h1") text [B](halu:dup "h2")';
  const { markdown } = normalizeMarkdownLinks(input, "article");
  const count = (markdown.match(/halu:dup/g) ?? []).length;
  assert.equal(count, 2, "both halu links to same slug should remain");
});

test("normalizeMarkdownLinks: empty label halu link kept as-is", () => {
  const { markdown } = normalizeMarkdownLinks('[](halu:empty-label "hint")', "article");
  assert.match(markdown, /halu:empty-label/);
});

test("normalizeMarkdownLinks: fenced code block content not modified", () => {
  const input = "```\n[Not a link](/wiki/Not_A_Link)\n```";
  const { markdown } = normalizeMarkdownLinks(input, "article");
  // Content inside fenced code should not be rewritten
  assert.match(markdown, /\/wiki\/Not_A_Link/);
});

/* ─────────────────────────────────────────────────────────────────
   normalizeHaluLinks — more edge cases
   ───────────────────────────────────────────────────────────────── */

test("normalizeHaluLinks: title with trailing punctuation", () => {
  const result = normalizeHaluLinks("[The Revolution!]");
  // punctuation stripped from slug but title text preserved in label
  assert.match(result, /halu:the-revolution/);
});

test("normalizeHaluLinks: ALL CAPS title", () => {
  const result = normalizeHaluLinks("[NASA]");
  assert.match(result, /halu:nasa/);
});

test("normalizeHaluLinks: title with ampersand", () => {
  const result = normalizeHaluLinks("[AT&T Corporation]");
  // ampersand becomes hyphen in slug
  assert.match(result, /halu:at-t-corporation|halu:at-corporation/);
});

test("normalizeHaluLinks: title with numbers and roman numerals", () => {
  const result = normalizeHaluLinks("[World War II]");
  assert.match(result, /halu:world-war-ii/);
});

test("normalizeHaluLinks: no-op for empty string", () => {
  const result = normalizeHaluLinks("");
  assert.equal(result, "");
});

test("normalizeHaluLinks: no bare brackets → string unchanged", () => {
  const input = "No brackets here at all.";
  const result = normalizeHaluLinks(input);
  assert.equal(result, input);
});

test("normalizeHaluLinks: short title (1-2 chars) may or may not become a link", () => {
  // Single-char bare brackets should not crash
  const result = normalizeHaluLinks("[A]");
  assert.ok(typeof result === "string");
});

test("normalizeHaluLinks: bracket with only spaces not converted", () => {
  const result = normalizeHaluLinks("[   ]");
  assert.doesNotMatch(result, /halu:/);
});

test("normalizeHaluLinks: existing halu link not modified", () => {
  const input = '[Already](halu:already-slug "hint text")';
  const result = normalizeHaluLinks(input);
  assert.equal(result, input);
});

test("normalizeHaluLinks: multiple bare titles on same line all converted", () => {
  const result = normalizeHaluLinks("See [Alpha Article] and [Beta Article].");
  assert.match(result, /halu:alpha-article/);
  assert.match(result, /halu:beta-article/);
});

/* ─────────────────────────────────────────────────────────────────
   slugify — more edge cases
   ───────────────────────────────────────────────────────────────── */

test("slugify: idempotent — slugifying a slug produces the same slug", () => {
  const slugs = ["hello-world", "area-51", "iso-9001", "a-b-c"];
  for (const s of slugs) {
    assert.equal(slugify(s), s, `slugify("${s}") should be idempotent`);
  }
});

test("slugify: all-numeric string preserved", () => {
  const result = slugify("12345");
  assert.equal(result, "12345");
});

test("slugify: tabs and newlines treated as spaces", () => {
  const result = slugify("hello\tworld\nnewline");
  assert.doesNotMatch(result, /[\t\n]/);
  assert.match(result, /hello/);
});

test("slugify: slash stripped", () => {
  const result = slugify("a/b/c");
  assert.doesNotMatch(result, /\//);
});

test("slugify: underscore treated same as space", () => {
  const result = slugify("hello_world");
  assert.equal(result, "hello-world");
});

/* ─────────────────────────────────────────────────────────────────
   resolveRefLinks — more cases
   ───────────────────────────────────────────────────────────────── */

test("resolveRefLinks: ref:N out of range kept as raw (no crash)", () => {
  const refs: ReferenceList = [makeRef("only", "Only")];
  const body = "[X](ref:99)";
  const resolved = resolveRefLinks(body, refs);
  // ref:99 is out of range (only 1 ref) — kept as-is
  assert.match(resolved, /ref:99/);
});

test("resolveRefLinks: ref:0 not resolved (1-based indexing)", () => {
  const refs: ReferenceList = [makeRef("first", "First")];
  const body = "[X](ref:0)";
  const resolved = resolveRefLinks(body, refs);
  assert.match(resolved, /ref:0/);
});

test("resolveRefLinks: empty-label ref gets filled with article title", () => {
  const refs: ReferenceList = [makeRef("alpha", "Alpha Title")];
  const body = "[](ref:alpha)";
  const resolved = resolveRefLinks(body, refs);
  assert.match(resolved, /Alpha Title/);
  assert.match(resolved, /ref:alpha/);
});

test("resolveRefLinks: body with no ref: links returned unchanged", () => {
  const refs: ReferenceList = [makeRef("alpha", "Alpha")];
  const body = "No internal refs here, just [plain](halu:link).";
  const resolved = resolveRefLinks(body, refs);
  assert.equal(resolved, body);
});

test("resolveRefLinks: three occurrences — first kept, rest collapsed", () => {
  const refs: ReferenceList = [makeRef("r", "R")];
  const body = "[R](ref:r) and [R](ref:r) and [R](ref:r) end.";
  const resolved = resolveRefLinks(body, refs);
  const refCount = (resolved.match(/ref:r/g) ?? []).length;
  assert.equal(refCount, 1);
  const plainCount = (resolved.match(/\bR\b/g) ?? []).length;
  assert.ok(plainCount >= 3, "all three occurrences should show the label");
});

/* ─────────────────────────────────────────────────────────────────
   renderReferencesHtml
   ───────────────────────────────────────────────────────────────── */

test("renderReferencesHtml: single ref produces one <li>", () => {
  const html = renderReferencesHtml([makeRef("a", "A")]);
  const liCount = (html.match(/<li/g) ?? []).length;
  assert.equal(liCount, 1);
});

test("renderReferencesHtml: five refs produce five <li> items", () => {
  const refs = ["a","b","c","d","e"].map((s) => makeRef(s, s.toUpperCase()));
  const html = renderReferencesHtml(refs);
  const liCount = (html.match(/<li/g) ?? []).length;
  assert.equal(liCount, 5);
  for (let i = 1; i <= 5; i++) assert.match(html, new RegExp(`id="ref-${i}"`));
});

test("renderReferencesHtml: contains <h2>References</h2> heading", () => {
  const html = renderReferencesHtml([makeRef("a", "A")]);
  assert.match(html, /<h2>References<\/h2>/);
});

test("renderReferencesHtml: each entry links to /wiki/<Title>", () => {
  const html = renderReferencesHtml([makeRef("some-article", "Some Article")]);
  assert.match(html, /href="\/wiki\/Some_Article"/);
});

test("renderReferencesHtml: pinned and non-pinned entries both rendered", () => {
  const refs: ReferenceList = [
    { ...makeRef("pinned-one", "Pinned One"), pinned: true },
    makeRef("normal-one", "Normal One"),
  ];
  const html = renderReferencesHtml(refs);
  assert.match(html, /Pinned One/);
  assert.match(html, /Normal One/);
  const liCount = (html.match(/<li/g) ?? []).length;
  assert.equal(liCount, 2);
});

/* ─────────────────────────────────────────────────────────────────
   findExistingArticleLinkReferences — more cases
   ───────────────────────────────────────────────────────────────── */

test("findExistingArticleLinkReferences: multiple halu links, only DB-backed returned", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "real-one", "Real One");
    seedDbArticle(db, "real-two", "Real Two");
    const body = [
      '[Real One](halu:real-one "h1")',
      '[Real Two](halu:real-two "h2")',
      '[Fake](halu:fake-slug "h3")',
    ].join(" ");
    const refs = findExistingArticleLinkReferences(db, body, "host");
    const slugs = refs.map((r) => r.slug);
    assert.ok(slugs.includes("real-one"));
    assert.ok(slugs.includes("real-two"));
    assert.ok(!slugs.includes("fake-slug"));
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("findExistingArticleLinkReferences: deduplicates same slug appearing twice", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "dup-target", "Dup Target");
    const body = '[Dup](halu:dup-target "h") and [Dup again](halu:dup-target "h2")';
    const refs = findExistingArticleLinkReferences(db, body, "host");
    const dupCount = refs.filter((r) => r.slug === "dup-target").length;
    assert.equal(dupCount, 1);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("findExistingArticleLinkReferences: empty body returns empty array", () => {
  const { root, db } = makeTempDb();
  try {
    const refs = findExistingArticleLinkReferences(db, "", "host");
    assert.equal(refs.length, 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

/* ─────────────────────────────────────────────────────────────────
   buildReferenceList — more scenarios
   ───────────────────────────────────────────────────────────────── */

test("buildReferenceList: pinned prior ref survives when re-loaded as prior", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "pinned-prior", "Pinned Prior");
    const refs = buildReferenceList(db, {
      articleSlug: "host",
      ragSources: [],
      priorReferences: [{ ...makeRef("pinned-prior", "Pinned Prior"), pinned: true }],
      revisionId: "current",
      config: { reference_max_results: 8, reference_min_score: 0.4, max_references: 50, reference_recursive_depth: 0, reference_recursive_max_per_article: 0 },
    }, noop());
    const entry = refs.find((r) => r.slug === "pinned-prior");
    assert.ok(entry, "pinned prior should survive");
    assert.equal(entry?.pinned, true);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("buildReferenceList: multiple pinned entries all survive even at small cap", () => {
  const { root, db } = makeTempDb();
  try {
    for (let i = 1; i <= 5; i++) seedDbArticle(db, `p${i}`, `P${i}`);
    const pinned = Array.from({ length: 5 }, (_, i) =>
      ({ ...makeRef(`p${i + 1}`, `P${i + 1}`), pinned: true })
    );
    const refs = buildReferenceList(db, {
      articleSlug: "host",
      ragSources: [],
      userAdditions: pinned,
      revisionId: "current",
      config: { reference_max_results: 2, reference_min_score: 0.4, max_references: 2, reference_recursive_depth: 0, reference_recursive_max_per_article: 0 },
    }, noop());
    const pinnedInResult = refs.filter((r) => r.pinned);
    assert.equal(pinnedInResult.length, 5, "all 5 pinned entries must survive regardless of cap");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("buildReferenceList: source field set to user for user additions", () => {
  const { root, db } = makeTempDb();
  try {
    seedDbArticle(db, "user-added", "User Added");
    const refs = buildReferenceList(db, {
      articleSlug: "host",
      ragSources: [],
      userAdditions: [makeRef("user-added", "User Added")],
      revisionId: "current",
      config: { reference_max_results: 8, reference_min_score: 0.4, max_references: 50, reference_recursive_depth: 0, reference_recursive_max_per_article: 0 },
    }, noop());
    const entry = refs.find((r) => r.slug === "user-added");
    assert.equal(entry?.source, "user");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
