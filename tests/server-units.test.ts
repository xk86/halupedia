import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, saveArticle } from "../src/server/db";
import { extractInternalLinks, markdownToPlainText, renderMarkdown, normalizeMarkdown } from "../src/server/markdown";
import { slugify, slugToTitle, titleToWikiSegment, wikiSegmentToTitle, normalizeCanonicalTitle } from "../src/server/slug";
import type { LlmClient } from "../src/server/llm";
import { indexArticleChunks, retrieveContext } from "../src/server/retrieval";
import { normalizeSummaryMarkdown, summaryLooksLikeLeadCopy } from "../src/server/summary";

class NoopLlmClient implements LlmClient {
  async chat(): Promise<string> {
    throw new Error("chat should not be called in retrieval unit tests");
  }

  async streamChat(): Promise<{ content: string; finishReason: string }> {
    throw new Error("streamChat should not be called in retrieval unit tests");
  }

  async embed(): Promise<number[][]> {
    return [];
  }

  async probeConnections(): Promise<void> {}
}

test("extractInternalLinks dedupes targets and ignores invalid links", () => {
  const links = extractInternalLinks([
    'A [Valid Link](halu:glow-fruit "Sweet and bright") appears once.',
    'A duplicate target [Glow](halu:glow-fruit "Different label") should be ignored.',
    'A missing hint [Ignored](halu:ignored) should be skipped.',
    'A second valid [Night Bloom](halu:night-bloom "Used at dusk").',
  ].join("\n"));

  assert.deepEqual(links, [
    {
      targetSlug: "glow-fruit",
      visibleLabel: "Valid Link",
      hiddenHint: "Sweet and bright",
    },
    {
      targetSlug: "night-bloom",
      visibleLabel: "Night Bloom",
      hiddenHint: "Used at dusk",
    },
  ]);
});

test("renderMarkdown rewrites halu links to wiki paths", () => {
  const html = renderMarkdown('Visit [Glow Fruit](halu:glow-fruit "hidden hint") for details.');
  assert.match(html, /href="\/wiki\/Glow_fruit"/);
  assert.doesNotMatch(html, /hidden hint/);
});

test("summary helpers normalize single-paragraph summaries and detect copied leads", () => {
  const articleMarkdown = [
    "# Coal futures markets",
    "",
    "Coal futures markets are complex, highly volatile financial instruments dedicated to pricing the future delivery of subterranean combustive resources.",
    "",
    "They also rely on ceremonial pit clerks and delayed ash ledgers.",
  ].join("\n");

  assert.equal(
    normalizeSummaryMarkdown("## Summary\n\nCoal futures markets turn buried fuel contracts into a ritualized pricing system."),
    "Coal futures markets turn buried fuel contracts into a ritualized pricing system."
  );
  assert.equal(
    summaryLooksLikeLeadCopy(
      "Coal futures markets are complex, highly volatile financial instruments dedicated to pricing the future delivery of subterranean combustive resources.",
      articleMarkdown
    ),
    true
  );
  assert.equal(
    summaryLooksLikeLeadCopy(
      "Coal futures markets recast buried fuel trading as a ceremonial bureaucracy built around ash ledgers and future delivery rites.",
      articleMarkdown
    ),
    false
  );
});

test("retrieveContext returns matching lexical context from indexed article chunks", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-retrieval-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const db = openDatabase(join(root, "halupedia.sqlite"));
  const llm = new NoopLlmClient();
  const generatedAt = 1_715_000_000_000;

  const sourceMarkdown = [
    "# Archive Entry",
    "",
    "Glow fruit grows in the crater orchard near the observatory.",
    "",
    "Keep a lantern nearby when harvesting glow fruit at dusk.",
  ].join("\n");
  saveArticle(
    db,
    {
      slug: "archive-entry",
      canonicalSlug: "archive-entry",
      title: "Archive Entry",
      markdown: sourceMarkdown,
      html: renderMarkdown(sourceMarkdown),
      plain_text: markdownToPlainText(sourceMarkdown),
      generated_at: generatedAt,
    },
    [],
    ["archive-entry"]
  );
  await indexArticleChunks(db, llm, "archive-entry", sourceMarkdown, false, 120);

  const currentMarkdown = [
    "# Test Article",
    "",
    'A note points toward [Archive Entry](halu:archive-entry "Glow fruit orchard notes").',
  ].join("\n");
  saveArticle(
    db,
    {
      slug: "test-article",
      canonicalSlug: "test-article",
      title: "Test Article",
      markdown: currentMarkdown,
      html: renderMarkdown(currentMarkdown),
      plain_text: markdownToPlainText(currentMarkdown),
      generated_at: generatedAt + 1,
    },
    [
      {
        targetSlug: "archive-entry",
        visibleLabel: "Archive Entry",
        hiddenHint: "Glow fruit orchard notes",
      },
    ],
    ["test-article"]
  );

  const packet = await retrieveContext(
    db,
    llm,
    "test-article",
    ["Glow fruit orchard notes"],
    true,
    3,
    0.2,
    false
  );

  assert.equal(packet.relatedTitles[0], "Archive Entry");
  assert.equal(packet.sourceArticles[0].slug, "archive-entry");
  assert.match(packet.context, /Glow fruit grows in the crater orchard/);
});

/* -------------------------------------------------------------------------- */
/*  Link stability: slug ↔ title ↔ wikiSegment round-trips                   */
/* -------------------------------------------------------------------------- */

test("slugify is idempotent", () => {
  const inputs = ["Glow Fruit", "glow-fruit", "  Glow  Fruit  ", "GLOW_FRUIT"];
  for (const input of inputs) {
    const slug = slugify(input);
    assert.equal(slugify(slug), slug, `slugify not idempotent for "${input}"`);
  }
});

test("slug → title → wikiSegment → title round-trips are stable", () => {
  const slugs = ["glow-fruit", "cultural-dissipation-factor", "san-francisco", "clock-orchard"];
  for (const slug of slugs) {
    const title = slugToTitle(slug);
    const segment = titleToWikiSegment(title);
    const backToTitle = wikiSegmentToTitle(segment);
    assert.equal(backToTitle, title, `round-trip failed for slug "${slug}": "${title}" → "${segment}" → "${backToTitle}"`);
  }
});

test("normalizeCanonicalTitle capitalizes first letter only when no mixed case", () => {
  assert.equal(normalizeCanonicalTitle("delaware"), "Delaware");
  assert.equal(normalizeCanonicalTitle("iPhone"), "iPhone");
  assert.equal(normalizeCanonicalTitle("mcDonald"), "mcDonald");
  assert.equal(normalizeCanonicalTitle("San Francisco"), "San Francisco");
});

test("halu links render to stable wiki paths", () => {
  const markdown = [
    '[Delaware](halu:delaware "A mid-Atlantic administrative zone")',
    '[Cultural Dissipation Factor](halu:cultural-dissipation-factor "measure of energetic exchange")',
    '[San Francisco](halu:san-francisco "fog registry district")',
  ].join("\n\n");
  const html = renderMarkdown(markdown);
  assert.match(html, /href="\/wiki\/Delaware"/);
  assert.match(html, /href="\/wiki\/Cultural_dissipation_factor"/);
  assert.match(html, /href="\/wiki\/San_francisco"/);
  assert.doesNotMatch(html, /halu:/);
  assert.doesNotMatch(html, /hidden context/i);
});

test("halu links inside bold/italic render correctly", () => {
  const html = renderMarkdown('The **[Dover Ash Bureau](halu:dover-ash-bureau "municipal ash authority")** governs all deposits.');
  assert.match(html, /href="\/wiki\/Dover_ash_bureau"/);
  assert.match(html, /<strong>/);
});

test("hidden hints are stripped from rendered output", () => {
  const html = renderMarkdown('[Cornelius Blackpenny](halu:cornelius-blackpenny "Chief Registrar of the Dover Ash Bureau")');
  assert.match(html, /href="\/wiki\/Cornelius_blackpenny"/);
  assert.doesNotMatch(html, /Chief Registrar/);
  assert.doesNotMatch(html, /title="/);
});

/* -------------------------------------------------------------------------- */
/*  KaTeX: inline and block                                                   */
/* -------------------------------------------------------------------------- */

test("inline TeX inside article text renders math-inline spans", () => {
  const html = renderMarkdown("The coefficient $\\alpha$ governs drift.");
  assert.match(html, /class="[^"]*math-inline/);
  assert.doesNotMatch(html, /\$\\alpha\$/);
});

test("block TeX renders as math-block div", () => {
  const html = renderMarkdown([
    "The formula is:",
    "",
    "$$",
    "E = mc^2",
    "$$",
    "",
    "This is important.",
  ].join("\n"));
  assert.match(html, /class="[^"]*math-block/);
  assert.match(html, /class="[^"]*katex/);
  assert.doesNotMatch(html, /\$\$/);
  assert.match(html, /This is important/);
});

test("single-line block TeX renders correctly", () => {
  const html = renderMarkdown("$$E = mc^2$$");
  assert.match(html, /class="[^"]*math-block/);
});

test("blockquote markdown renders correctly for attributed quotes", () => {
  const html = renderMarkdown([
    '> "The ledger does not forgive."',
    '>',
    '> — [Cornelius Blackpenny](halu:cornelius-blackpenny "Chief Registrar")',
  ].join("\n"));
  assert.match(html, /<blockquote>/);
  assert.match(html, /href="\/wiki\/Cornelius_blackpenny"/);
  assert.doesNotMatch(html, /Chief Registrar/);
});
