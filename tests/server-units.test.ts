import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, saveArticle } from "../src/server/db";
import { loadConfig } from "../src/server/config";
import {
  extractDisplayTitle,
  extractInternalLinks,
  extractTitle,
  leadBoldsTitle,
  markdownToPlainText,
  renderMarkdown,
  normalizeMarkdown,
  stripSelfLinks,
} from "../src/server/markdown";
import { formatLogLine } from "../src/server/logger";
import { getPrompt, stripJsonFences } from "../src/server/prompts";
import {
  slugify,
  slugToTitle,
  titleToWikiSegment,
  wikiSegmentToTitle,
  normalizeCanonicalTitle,
} from "../src/server/slug";
import type { LlmClient } from "../src/server/llm";
import { indexArticleChunks, retrieveContext } from "../src/server/retrieval";
import {
  normalizeSummaryMarkdown,
  summaryLooksLikeLeadCopy,
} from "../src/server/summary";
import { summarizeRetrievedSource } from "../src/server/index";

const TEST_CONFIG = loadConfig().app.tests;

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
  const links = extractInternalLinks(
    [
      'A [Valid Link](halu:glow-fruit "Sweet and bright") appears once.',
      'A duplicate target [Glow](halu:glow-fruit "Different label") should be ignored.',
      "A missing hint [Ignored](halu:ignored) should be skipped.",
      'A second valid [Night Bloom](halu:night-bloom "Used at dusk").',
    ].join("\n"),
  );

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

test("renderMarkdown rewrites halu links to wiki paths using visible text", () => {
  const html = renderMarkdown(
    'Visit [Glow Fruit](halu:glow-fruit "hidden hint") for details.',
  );
  assert.match(html, /href="\/wiki\/Glow_Fruit"/);
  assert.doesNotMatch(html, /hidden hint/);
});

test("loadConfig populates a dedicated summary LLM config section", () => {
  const { llm } = loadConfig();
  assert.equal(llm.summary.model, llm.chat.model);
  assert.ok(llm.summary.base_url);
  assert.equal(llm.summary.max_tokens, 3000);
});

test("rag_source_summary prompt is configured and resolves correctly", () => {
  const prompt = getPrompt(loadConfig().prompts, "rag_source_summary");
  assert.match(prompt.system, /retrieved article excerpt/i);
  assert.match(prompt.user, /Article excerpt:/);
});

class SummaryLlmClient implements LlmClient {
  async chat(): Promise<string> {
    return "A concise retrieved article summary.";
  }

  async streamChat(): Promise<{ content: string; finishReason: string }> {
    throw new Error("streamChat should not be called in this test");
  }

  async embed(): Promise<number[][]> {
    return [];
  }

  async probeConnections(): Promise<void> {}
}

test("summarizeRetrievedSource uses the summary prompt and normalizes output", async () => {
  const summary = await summarizeRetrievedSource(
    new SummaryLlmClient(),
    loadConfig().prompts,
    {
      slug: "test-article",
      title: "Test Article",
      content: "This is a test retrieved excerpt to summarize.",
    },
  );
  assert.equal(summary, "A concise retrieved article summary.");
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
    normalizeSummaryMarkdown(
      "## Summary\n\nCoal futures markets turn buried fuel contracts into a ritualized pricing system.",
    ),
    "Coal futures markets turn buried fuel contracts into a ritualized pricing system.",
  );
  assert.equal(
    summaryLooksLikeLeadCopy(
      "Coal futures markets are complex, highly volatile financial instruments dedicated to pricing the future delivery of subterranean combustive resources.",
      articleMarkdown,
    ),
    true,
  );
  assert.equal(
    summaryLooksLikeLeadCopy(
      "Coal futures markets recast buried fuel trading as a ceremonial bureaucracy built around ash ledgers and future delivery rites.",
      articleMarkdown,
    ),
    false,
  );
});

test("retrieveContext returns matching lexical context from indexed article chunks", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-retrieval-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const db = openDatabase(join(root, TEST_CONFIG.database_path));
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
    ["archive-entry"],
  );
  await indexArticleChunks(
    db,
    llm,
    "archive-entry",
    sourceMarkdown,
    false,
    120,
  );

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
    ["test-article"],
  );

  const packet = await retrieveContext(
    db,
    llm,
    "test-article",
    ["Glow fruit orchard notes"],
    true,
    "full",
    3,
    0.2,
    false,
  );

  assert.equal(packet.relatedTitles[0], "Archive Entry");
  assert.equal(packet.sourceArticles[0].slug, "archive-entry");
  assert.match(packet.context, /Glow fruit grows in the crater orchard/);
});

test("retrieveContext summary mode produces abbreviated retrieved context", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-retrieval-summary-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const db = openDatabase(join(root, TEST_CONFIG.database_path));
  const llm = new NoopLlmClient();
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
      generated_at: 1_715_000_000_000,
    },
    [],
    ["archive-entry"],
  );
  await indexArticleChunks(db, llm, "archive-entry", sourceMarkdown, false, 120);

  const packetFull = await retrieveContext(
    db,
    llm,
    "test-article",
    ["Glow fruit orchard notes"],
    true,
    "full",
    1,
    0.2,
    false,
  );
  const packetSummary = await retrieveContext(
    db,
    llm,
    "test-article",
    ["Glow fruit orchard notes"],
    true,
    "summary",
    1,
    0.2,
    false,
  );

  assert(packetSummary.context.length < packetFull.context.length);
  assert.match(packetSummary.context, /Glow fruit grows in the crater orchard/);
});

test("test config exposes isolated database filename and live LLM target", () => {
  assert.equal(TEST_CONFIG.database_path, "halupedia.sqlite");
  assert.equal(TEST_CONFIG.llm_base_url, "http://localhost:11434/v1");
  assert.equal(TEST_CONFIG.llm_api_key, "ollama");
  assert.equal(TEST_CONFIG.llm_model, "gemma4");
});

/* -------------------------------------------------------------------------- */
/*  Link stability: slug ↔ title ↔ wikiSegment round-trips                   */
/* -------------------------------------------------------------------------- */

test("slugify is idempotent", () => {
  const inputs = [
    "Glow Fruit",
    "glow-fruit",
    "  Glow  Fruit  ",
    "GLOW_FRUIT",
    "eBay",
    "β-Carotene",
    "San Francisco",
  ];
  for (const input of inputs) {
    const slug = slugify(input);
    assert.equal(slugify(slug), slug, `slugify not idempotent for "${input}"`);
  }
});

test("slugify preserves unicode letters and digits", () => {
  assert.equal(slugify("β-Carotene"), "β-carotene");
  assert.equal(slugify("Ölgemälde"), "ölgemälde");
  assert.equal(slugify("naïve"), "naïve");
  assert.equal(slugify("café"), "café");
});

test("slug → title → wikiSegment → title round-trips are stable", () => {
  const slugs = [
    "glow-fruit",
    "cultural-dissipation-factor",
    "san-francisco",
    "clock-orchard",
  ];
  for (const slug of slugs) {
    const title = slugToTitle(slug);
    const segment = titleToWikiSegment(title);
    const backToTitle = wikiSegmentToTitle(segment);
    assert.equal(
      backToTitle,
      title,
      `round-trip failed for slug "${slug}": "${title}" → "${segment}" → "${backToTitle}"`,
    );
  }
});

test("titleToWikiSegment preserves casing from title", () => {
  assert.equal(titleToWikiSegment("San Francisco"), "San_Francisco");
  assert.equal(
    titleToWikiSegment("Cultural Dissipation Factor"),
    "Cultural_Dissipation_Factor",
  );
  assert.equal(titleToWikiSegment("eBay"), "EBay");
  assert.equal(titleToWikiSegment("pH"), "PH");
  assert.equal(titleToWikiSegment("β-Carotene"), "Β-Carotene");
});

test("wikiSegmentToTitle preserves casing", () => {
  assert.equal(wikiSegmentToTitle("San_Francisco"), "San Francisco");
  assert.equal(
    wikiSegmentToTitle("Cultural_Dissipation_Factor"),
    "Cultural Dissipation Factor",
  );
  assert.equal(wikiSegmentToTitle("EBay"), "EBay");
});

test("normalizeCanonicalTitle capitalizes first letter only when no mixed case", () => {
  assert.equal(normalizeCanonicalTitle("delaware"), "Delaware");
  assert.equal(normalizeCanonicalTitle("iPhone"), "iPhone");
  assert.equal(normalizeCanonicalTitle("mcDonald"), "mcDonald");
  assert.equal(normalizeCanonicalTitle("San Francisco"), "San Francisco");
});

test("halu links render wiki paths from visible text, preserving casing", () => {
  const markdown = [
    '[Delaware](halu:delaware "A mid-Atlantic administrative zone")',
    '[Cultural Dissipation Factor](halu:cultural-dissipation-factor "measure of energetic exchange")',
    '[San Francisco](halu:san-francisco "fog registry district")',
  ].join("\n\n");
  const html = renderMarkdown(markdown);
  assert.match(html, /href="\/wiki\/Delaware"/);
  assert.match(html, /href="\/wiki\/Cultural_Dissipation_Factor"/);
  assert.match(html, /href="\/wiki\/San_Francisco"/);
  assert.doesNotMatch(html, /halu:/);
  assert.doesNotMatch(html, /hidden context/i);
});

test("halu links inside bold/italic render correctly", () => {
  const html = renderMarkdown(
    'The **[Dover Ash Bureau](halu:dover-ash-bureau "municipal ash authority")** governs all deposits.',
  );
  assert.match(html, /href="\/wiki\/Dover_Ash_Bureau"/);
  assert.match(html, /<strong>/);
});

test("hidden hints are stripped from rendered output", () => {
  const html = renderMarkdown(
    '[Cornelius Blackpenny](halu:cornelius-blackpenny "Chief Registrar of the Dover Ash Bureau")',
  );
  assert.match(html, /href="\/wiki\/Cornelius_Blackpenny"/);
  assert.doesNotMatch(html, /Chief Registrar/);
  assert.doesNotMatch(html, /title="/);
});

/* -------------------------------------------------------------------------- */
/*  KaTeX: inline and block                                                   */
/* -------------------------------------------------------------------------- */

test("inline TeX inside article text renders math-inline spans", () => {
  const html = renderMarkdown("The coefficient $\\alpha$ governs drift.");
  assert.match(html, /class="[^\"]*math-inline/);
  assert.doesNotMatch(html, /\$\\alpha\$/);
});

test("block TeX renders as math-block div", () => {
  const html = renderMarkdown(
    [
      "The formula is:",
      "",
      "$$",
      "E = mc^2",
      "$$",
      "",
      "This is important.",
    ].join("\n"),
  );
  assert.match(html, /class="[^\"]*math-block/);
  assert.match(html, /class="[^\"]*katex/);
  assert.doesNotMatch(html, /\$\$/);
  assert.match(html, /This is important/);
});

test("single-line block TeX renders correctly", () => {
  const html = renderMarkdown("$$E = mc^2$$");
  assert.match(html, /class="[^\"]*math-block/);
});

test("blockquote markdown renders correctly for attributed quotes", () => {
  const html = renderMarkdown(
    [
      '> "The ledger does not forgive."',
      ">",
      '> — [Cornelius Blackpenny](halu:cornelius-blackpenny "Chief Registrar")',
    ].join("\n"),
  );
  assert.match(html, /<blockquote>/);
  assert.match(html, /href="\/wiki\/Cornelius_Blackpenny"/);
  assert.doesNotMatch(html, /Chief Registrar/);
});

test("stripSelfLinks removes links whose target matches the article slug", () => {
  const markdown = [
    "# Glow Fruit",
    "",
    '**Glow Fruit**, also known as [luminous berry](halu:luminous-berry "a variant name"), is a [Glow Fruit](halu:glow-fruit "self-referential link") that grows in the [Crater Orchard](halu:crater-orchard "location of the orchard").',
  ].join("\n");
  const result = stripSelfLinks(markdown, "glow-fruit");
  assert.doesNotMatch(result, /\(halu:glow-fruit/);
  assert.match(result, /is a Glow Fruit that grows/);
  assert.match(result, /\(halu:luminous-berry/);
  assert.match(result, /\(halu:crater-orchard/);
});

test("stripSelfLinks is a no-op when no self-links exist", () => {
  const markdown =
    'Visit [Other Place](halu:other-place "a place") for details.';
  assert.equal(stripSelfLinks(markdown, "glow-fruit"), markdown);
});

test("leadBoldsTitle detects bolded title in lead paragraph", () => {
  const markdown = [
    "# Glow Fruit",
    "",
    "**Glow Fruit** is a bioluminescent orchard product grown in the southern craters.",
  ].join("\n");
  assert.equal(leadBoldsTitle(markdown, "Glow Fruit"), true);
});

test("leadBoldsTitle detects bolded alternate title", () => {
  const markdown = [
    "# Glow Fruit",
    "",
    "**Glow Fruit**, also known as **luminous berry**, is grown in craters.",
  ].join("\n");
  assert.equal(leadBoldsTitle(markdown, "Glow Fruit"), true);
});

test("leadBoldsTitle returns false when title is not bolded", () => {
  const markdown = [
    "# Glow Fruit",
    "",
    "Glow Fruit is a bioluminescent orchard product grown in the southern craters.",
  ].join("\n");
  assert.equal(leadBoldsTitle(markdown, "Glow Fruit"), false);
});

test("formatLogLine includes timestamp, level, event, and fields", () => {
  const line = formatLogLine("info", "page.request", { slug: "test" });
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(stripped, /^\d{2}:\d{2}:\d{2}/);
  assert.match(stripped, /INF/);
  assert.match(stripped, /page\.request/);
  assert.match(stripped, /slug="test"/);
});

test("formatLogLine includes level with consistent format", () => {
  const infoLine = formatLogLine("info", "test.event");
  const errorLine = formatLogLine("error", "test.event");
  const warnLine = formatLogLine("warn", "test.event");
  assert.match(infoLine, /INF/);
  assert.match(errorLine, /ERR/);
  assert.match(warnLine, /WRN/);
});

/* -------------------------------------------------------------------------- */
/*  stripJsonFences                                                           */
/* -------------------------------------------------------------------------- */

test("stripJsonFences removes ```json fences", () => {
  const wrapped = '```json\n{"items":[{"fact":"the sky is plaid"}]}\n```';
  assert.equal(
    stripJsonFences(wrapped),
    '{"items":[{"fact":"the sky is plaid"}]}',
  );
});

test("stripJsonFences removes bare ``` fences", () => {
  const wrapped = '```\n{"items":[]}\n```';
  assert.equal(stripJsonFences(wrapped), '{"items":[]}');
});

test("stripJsonFences passes through plain JSON unchanged", () => {
  const plain = '{"items":[]}';
  assert.equal(stripJsonFences(plain), plain);
});

test("stripJsonFences handles leading/trailing whitespace around fences", () => {
  const wrapped = '  \n```json\n{"ok":true}\n```\n  ';
  assert.equal(stripJsonFences(wrapped), '{"ok":true}');
});

/* -------------------------------------------------------------------------- */
/*  Title extraction and display titles                                       */
/* -------------------------------------------------------------------------- */

test("extractTitle strips markdown formatting from titles", () => {
  assert.equal(
    extractTitle("# *De Rerum Natura*\n\nBody.", "fallback"),
    "De Rerum Natura",
  );
  assert.equal(
    extractTitle("# San Francisco\n\nBody.", "fallback"),
    "San Francisco",
  );
  assert.equal(extractTitle("# eBay\n\nBody.", "fallback"), "eBay");
  assert.equal(extractTitle("No heading here.", "fallback"), "fallback");
});

test("extractDisplayTitle returns formatted title when markdown formatting present", () => {
  assert.equal(
    extractDisplayTitle("# *De Rerum Natura*\n\nBody."),
    "*De Rerum Natura*",
  );
  assert.equal(
    extractDisplayTitle("# **Bold Title**\n\nBody."),
    "**Bold Title**",
  );
  assert.equal(extractDisplayTitle("# San Francisco\n\nBody."), undefined);
  assert.equal(extractDisplayTitle("No heading."), undefined);
});

test("halu links with unicode visible text render correct wiki paths", () => {
  const html = renderMarkdown(
    '[β-Carotene](halu:β-carotene "orange pigment compound")',
  );
  assert.match(html, /href="\/wiki\/Β-Carotene"/);
  assert.doesNotMatch(html, /orange pigment/);
});
