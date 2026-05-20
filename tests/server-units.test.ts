import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getArticle,
  listArticles,
  listArticleRevisions,
  openDatabase,
  saveArticle,
  saveArticleReferences,
  getLatestArticleReferences,
  deleteArticleBySlug,
  getArticleByLookup,
  isSlugDeleted,
  updateArticleSummary,
} from "../src/server/db";
import { loadConfig } from "../src/server/config";
import {
  extractDisplayTitle,
  extractInternalLinks,
  extractTitle,
  leadBoldsTitle,
  markdownToPlainText,
  normalizeHaluLinks,
  renderMarkdown,
  normalizeMarkdown,
  summaryMarkdownFromArticle,
  stripSelfLinks,
  stripTopLevelSections,
} from "../src/server/markdown";
import { formatLogLine } from "../src/server/logger";
import { formatIncomingHintsForPrompt } from "../src/server/linkHints";
import { getPrompt, getSharedPrompt, stripJsonFences } from "../src/server/prompts";
import {
  slugify,
  slugToTitle,
  titleToWikiSegment,
  wikiSegmentToRequestedTitle,
  wikiSegmentToTitle,
  normalizeCanonicalTitle,
} from "../src/server/slug";
import { OpenAICompatClient, type LlmClient } from "../src/server/llm";
import type { Logger, LogFields } from "../src/server/logger";
import { indexArticleChunks, retrieveContext } from "../src/server/retrieval";
import {
  normalizeSummaryMarkdown,
  summaryLooksLikeLeadCopy,
} from "../src/server/summary";
import { summarizeRetrievedSource, parseArticleFrameOutput, parsePartialArticleFrame } from "../src/server/index";
import {
  buildReferenceList,
  convertExistingArticleLinksToRefs,
  findExistingArticleLinkReferences,
  findTitleMentionedArticles,
  formatReferencesForPrompt,
  linkMentionedReferencesInBody,
  renderReferencesHtml,
  resolveRefLinks,
} from "../src/server/referenceList";
import { parseMarkdownLinks } from "../src/server/text/markdownLinkParser";
import { normalizeMarkdownLinks } from "../src/server/text/linkNormalize";
import {
  assembleArticleMarkdownForRender,
  renderArticleDisplayHtml,
} from "../src/server/articleRender";
import {
  stripBodyMetadataSections,
  articleRecordToArticle,
} from "../src/server/article";
import type { Article, ArticleMetadata } from "../src/server/article";
import type { ArticleRecord } from "../src/server/types";
import type { ReferenceList } from "../src/server/types";

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

class CaptureLogger implements Logger {
  entries: Array<{ level: string; event: string; fields: LogFields }> = [];

  debug(event: string, fields: LogFields = {}) {
    this.entries.push({ level: "debug", event, fields });
  }

  info(event: string, fields: LogFields = {}) {
    this.entries.push({ level: "info", event, fields });
  }

  warn(event: string, fields: LogFields = {}) {
    this.entries.push({ level: "warn", event, fields });
  }

  error(event: string, fields: LogFields = {}) {
    this.entries.push({ level: "error", event, fields });
  }
}

test("OpenAI-compatible LLM logs use explicit roles for heavy, light, and embeddings", async (t) => {
  const logger = new CaptureLogger();
  const originalFetch = globalThis.fetch;
  const chatBodies: unknown[] = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/chat/completions")) {
      chatBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "A logged response." } }],
          usage: { total_tokens: 12 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/embeddings")) {
      return new Response(
        JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  };

  const chatConfig = {
    base_url: "http://llm.test/v1",
    api_key: "local",
    model: "gemma4",
    temperature: 1,
    max_tokens: 9001,
  };
  const embeddingsConfig = {
    enabled: true,
    base_url: "http://llm.test/v1",
    api_key: "local",
    model: "nomic",
  };
  const heavy = new OpenAICompatClient(chatConfig, embeddingsConfig, logger, "heavy");
  const light = new OpenAICompatClient({ ...chatConfig, max_tokens: 3000 }, embeddingsConfig, logger, "light");

  await heavy.chat("system", "user");
  await light.chat("system", "user", { thinking: true });
  await heavy.chat("system", "user", { jsonMode: true });
  await heavy.embed(["article chunk"]);

  assert.equal(logger.entries.find((entry) => entry.event === "llm.chat_request")?.fields.role, "heavy");
  assert.equal(logger.entries.find((entry) => entry.event === "llm.chat_response")?.fields.role, "heavy");
  assert.ok(logger.entries.some((entry) => entry.event === "llm.chat_request" && entry.fields.role === "light"));
  assert.ok(logger.entries.some((entry) => entry.event === "llm.embed_request" && entry.fields.role === "embeddings"));
  assert.ok(logger.entries.some((entry) => entry.event === "llm.embed_response" && entry.fields.role === "embeddings"));
  assert.ok(!logger.entries.some((entry) => entry.fields.role === "chat"));
  assert.equal((chatBodies[0] as { think?: boolean }).think, false);
  assert.equal((chatBodies[1] as { think?: boolean }).think, true);
  assert.equal((chatBodies[2] as { format?: string }).format, "json");
  assert.deepEqual((chatBodies[2] as { response_format?: unknown }).response_format, { type: "json_object" });
});

test("heavy and light OpenAI-compatible requests are sent independently", async (t) => {
  const logger = new CaptureLogger();
  const originalFetch = globalThis.fetch;
  const heavyGate = Promise.withResolvers<void>();
  const completed: string[] = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("http://heavy.test")) {
      await heavyGate.promise;
      completed.push("heavy");
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "heavy done" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("http://light.test")) {
      completed.push("light");
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "light done" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  };

  const embeddingsConfig = {
    enabled: false,
    base_url: "http://embed.test/v1",
    api_key: "local",
    model: "nomic",
  };
  const heavy = new OpenAICompatClient(
    {
      base_url: "http://heavy.test/v1",
      api_key: "local",
      model: "heavy-model",
      temperature: 1,
      max_tokens: 9001,
    },
    embeddingsConfig,
    logger,
    "heavy",
  );
  const light = new OpenAICompatClient(
    {
      base_url: "http://light.test/v1",
      api_key: "local",
      model: "light-model",
      temperature: 1,
      max_tokens: 3000,
    },
    embeddingsConfig,
    logger,
    "light",
  );

  const heavyRequest = heavy.chat("system", "user");
  const lightResult = await light.chat("system", "user");

  assert.equal(lightResult, "light done");
  assert.deepEqual(completed, ["light"]);

  heavyGate.resolve();
  assert.equal(await heavyRequest, "heavy done");
  assert.deepEqual(completed, ["light", "heavy"]);
});

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

test("extractInternalLinks accepts halu links with unterminated quoted hints", () => {
  const links = extractInternalLinks(
    'The page cites [Sample Link](halu:sample-link "a short unclosed hint).',
  );

  assert.deepEqual(links, [
    {
      targetSlug: "sample-link",
      visibleLabel: "Sample Link",
      hiddenHint: "a short unclosed hint",
    },
  ]);
});

test("formatIncomingHintsForPrompt preserves the requested target slug for mismatched labels", () => {
  const promptText = formatIncomingHintsForPrompt(
    [
      {
        sourceSlug: "source-article",
        sourceTitle: "Source Article",
        visibleLabel: "Mismatched Visible Label",
        hiddenHint: "context for the target article",
      },
    ],
    "actual-target",
  );

  assert.equal(
    promptText,
    '- [Mismatched Visible Label](halu:actual-target "context for the target article")',
  );
  assert.doesNotMatch(promptText, /halu:mismatched-visible-label/);
});

test("malformed halu links render and extract when the hidden hint quote is left open", () => {
  const markdown = [
    'Primarily engineered by [The Boring Company](halu:the-boring-company "subterranean infrastructure and tunneling enterprise),',
    'the system deploys [Hyperloop Commuter Pod](halu:hyperloop-commuter-pod "capsule system for vacuum-sealed transportation) units.',
  ].join(" ");

  const links = extractInternalLinks(markdown);
  const html = renderMarkdown(markdown);

  assert.deepEqual(links, [
    {
      targetSlug: "the-boring-company",
      visibleLabel: "The Boring Company",
      hiddenHint: "subterranean infrastructure and tunneling enterprise",
    },
    {
      targetSlug: "hyperloop-commuter-pod",
      visibleLabel: "Hyperloop Commuter Pod",
      hiddenHint: "capsule system for vacuum-sealed transportation",
    },
  ]);
  assert.match(html, /href="\/wiki\/The_Boring_Company"/);
  assert.match(html, /href="\/wiki\/Hyperloop_Commuter_Pod"/);
  assert.doesNotMatch(html, /halu:/);
  assert.doesNotMatch(html, /subterranean infrastructure/);
});

test("bare bracketed article titles become internal halu links", () => {
  const markdown = "The archive cites [Text Like This]'s municipal ledger.";
  const links = extractInternalLinks(markdown);
  const html = renderMarkdown(markdown);

  assert.deepEqual(links, [
    {
      targetSlug: "text-like-this",
      visibleLabel: "Text Like This",
      hiddenHint: "Text Like This",
    },
  ]);
  assert.match(html, /href="\/wiki\/Text_Like_This"/);
  assert.match(html, /<\/a>'s municipal ledger/);
  assert.doesNotMatch(html, /\[Text Like This\]/);
});

test("renderMarkdown rewrites halu links to wiki paths using visible text", () => {
  const html = renderMarkdown(
    'Visit [Glow Fruit](halu:glow-fruit "hidden hint") for details.',
  );
  assert.match(html, /href="\/wiki\/Glow_Fruit"/);
  assert.doesNotMatch(html, /hidden hint/);
});

test("parseMarkdownLinks classifies supported and fallback internal links in one pass", () => {
  const parsed = parseMarkdownLinks(
    [
      '[Halu](halu:halu-target "hint")',
      "[Ref](ref:ref-target)",
      "[Wiki](/wiki/Wiki_Target)",
      "[Slug](plain-slug-target)",
      "[External](https://example.invalid)",
    ].join(" "),
  );

  assert.deepEqual(
    parsed.links.map((link) => [link.label, link.kind, link.slug]),
    [
      ["Halu", "halu", "halu-target"],
      ["Ref", "ref", "ref-target"],
      ["Wiki", "wiki", "wiki-target"],
      ["Slug", "plain-slug", "plain-slug-target"],
      ["External", "external", undefined],
    ],
  );
  assert.ok(parsed.diagnostics.some((diag) => diag.code === "external-link"));
});

test("parseMarkdownLinks reports halu/ref markers outside valid markdown links without deleting text", () => {
  const markdown = "Keep this emoticon :) and malformed halu:loose-target plus [open](ref:missing";
  const parsed = parseMarkdownLinks(markdown);

  assert.deepEqual(parsed.links, []);
  assert.ok(parsed.looseInternalMarkers.some((marker) => marker.kind === "halu" && marker.slug === "loose-target"));
  assert.ok(parsed.looseInternalMarkers.some((marker) => marker.kind === "ref" && marker.slug === "missing"));
  assert.ok(parsed.diagnostics.some((diag) => diag.code === "loose-internal-marker"));
  assert.ok(parsed.diagnostics.some((diag) => diag.code === "unclosed-target"));
});

test("normalizeMarkdownLinks rewrites wiki and plain-slug fallbacks while stripping external links", () => {
  const normalized = normalizeMarkdownLinks(
    "See [Wiki](/wiki/Wiki_Target), [Slug](plain-slug-target), and [Bad](https://example.invalid).",
    "article",
  );

  assert.equal(
    normalized.markdown,
    'See [Wiki](halu:wiki-target "Wiki"), [Slug](halu:plain-slug-target "Slug"), and Bad.',
  );
  assert.equal(normalized.stats.wiki, 1);
  assert.equal(normalized.stats.plainSlug, 1);
  assert.equal(normalized.stats.external, 1);
  assert.equal(normalized.stats.rewritten, 2);
  assert.equal(normalized.stats.stripped, 1);
});

test("normalizeMarkdownLinks strips bare and loose ref artifacts without creating halu ref links", () => {
  const normalized = normalizeMarkdownLinks(
    "See *[Advertising streams](ref:advertising-streams)* [ref:advertising-streams] (ref:2).",
    "article",
  );

  assert.equal(
    normalized.markdown,
    "See *[Advertising streams](ref:advertising-streams)*.",
  );
  assert.equal(normalized.stats.ref, 1);
  assert.equal(normalized.stats.bareRef, 1);
  assert.equal(normalized.stats.looseRef, 1);
  assert.equal(normalized.stats.stripped, 2);
  assert.doesNotMatch(normalized.markdown, /halu:ref-/);
});

test("normalizeMarkdownLinks strips parenthesized ref marker after an existing same-slug link", () => {
  const normalized = normalizeMarkdownLinks(
    "The theory is detailed in *[The Feelings Illegalization Act of 1993](ref:the-feelings-illegalization-act-of-1993)* (ref:the-feelings-illegalization-act-of-1993).",
    "article",
  );

  assert.equal(
    normalized.markdown,
    "The theory is detailed in *[The Feelings Illegalization Act of 1993](ref:the-feelings-illegalization-act-of-1993)*.",
  );
  assert.equal(normalized.stats.ref, 1);
  assert.equal(normalized.stats.looseRef, 1);
  assert.equal(normalized.stats.stripped, 1);
});

test("normalizeMarkdownLinks attaches dangling ref and halu markers to nearby title text", () => {
  const normalized = normalizeMarkdownLinks(
    [
      "Individual entropy rises quickly (ref:individual-entropy).",
      'The handbook is *The Communist Manifesto*halu:the-communist-manifesto "a handbook entry".',
    ].join("\n\n"),
    "article",
  );

  assert.match(normalized.markdown, /\[Individual entropy\]\(ref:individual-entropy\) rises quickly\./);
  assert.match(
    normalized.markdown,
    /\*\[The Communist Manifesto\]\(halu:the-communist-manifesto "a handbook entry"\)\*/,
  );
  assert.doesNotMatch(normalized.markdown, / \((?:ref|halu):individual-entropy\)/);
  assert.doesNotMatch(normalized.markdown, /Manifesto\*halu:/);
});

test("parseMarkdownLinks reports bare and loose internal markers as structured artifacts", () => {
  const parsed = parseMarkdownLinks("[ref:source-entry] and (ref:2) plus [Bare Topic]");

  assert.deepEqual(
    parsed.bareBrackets.map((token) => [token.label, token.kind, token.slug]),
    [
      ["ref:source-entry", "ref-marker", "source-entry"],
      ["Bare Topic", "title-seed", "bare-topic"],
    ],
  );
  assert.deepEqual(
    parsed.looseInternalMarkers.map((token) => [token.kind, token.slug]),
    [["ref", "2"]],
  );
  assert.ok(parsed.diagnostics.some((diag) => diag.code === "bare-internal-marker"));
  assert.ok(parsed.diagnostics.some((diag) => diag.code === "loose-internal-marker"));
});

test("loadConfig populates a dedicated light LLM config section", () => {
  const { llm } = loadConfig();
  assert.ok(llm.light.model);
  assert.ok(llm.light.base_url);
  assert.ok(typeof llm.light.max_tokens === "number" && llm.light.max_tokens > 0);
});

test("loadConfig resolves prompt manifest file references", () => {
  const { prompts } = loadConfig();
  
  // Verify article prompt is loaded
  assert.ok(prompts.prompts.article);
  assert.ok(prompts.prompts.article.system);
  assert.ok(prompts.prompts.article.user);
  
  assert.ok(prompts.shared.shared_article_rules);
  assert.ok(prompts.shared.shared_article_rules.system);
  assert.equal(prompts.shared.shared_article_rules.model, undefined);
  assert.equal(prompts.shared.shared_article_rules.thinking, undefined);
  assert.equal(prompts.prompts.shared_article_rules, undefined);
  assert.equal(prompts.prompts.linking_guide, undefined);

  const articlePrompt = getPrompt(prompts, "article");
  assert.match(articlePrompt.system, /shared_article_rules|formatting|article/i);
  assert.equal(articlePrompt.model, "heavy");
  assert.equal(articlePrompt.thinking, false);
  assert.doesNotMatch(articlePrompt.system, /\{\{shared_article_rules\}\}/);

  const linkingGuide = getSharedPrompt(prompts, "linking_guide");
  assert.match(linkingGuide.system, /Shared linking rules/);
});

test("summarizeRetrievedSource returns truncated chunk content directly", () => {
  const summary = summarizeRetrievedSource({
    slug: "test-article",
    title: "Test Article",
    content: "This is a test retrieved excerpt used as a reference hint.",
  });
  assert.equal(summary, "This is a test retrieved excerpt used as a reference hint.");
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

test("summary helpers preserve complete long paragraphs", () => {
  const longSummary = [
    "The concept of a pickle-like object is defined by rigid geometry, color, and institutional handling rather than edibility.",
    "Its taxonomy spans preserved vegetables, mineral formations, and manufactured cylinders that only resemble food under disputed laboratory conditions.",
    "The article also distinguishes ordinary culinary classification from the administrative registers used by municipal brine offices.",
  ].join(" ");
  const articleMarkdown = ["# Pickle like object", "", longSummary].join("\n");

  assert.equal(normalizeSummaryMarkdown(longSummary), longSummary);
  assert.equal(summaryMarkdownFromArticle(articleMarkdown), longSummary);
});

test("updateArticleSummary is pipeline-only and updates the active revision without creating history", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-summary-revision-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const db = openDatabase(join(root, TEST_CONFIG.database_path));
  const firstMarkdown = "# Revision Boundary\n\nOriginal body.";
  const secondMarkdown = "# Revision Boundary\n\nUser-edited body.";

  saveArticle(
    db,
    {
      slug: "revision-boundary",
      canonicalSlug: "revision-boundary",
      title: "Revision Boundary",
      markdown: firstMarkdown,
      html: renderMarkdown(firstMarkdown),
      plain_text: markdownToPlainText(firstMarkdown),
      generated_at: 100,
      summaryMarkdown: "Original summary.",
    },
    [],
    ["revision-boundary"],
    { operation: "generate" },
  );
  saveArticle(
    db,
    {
      slug: "revision-boundary",
      canonicalSlug: "revision-boundary",
      title: "Revision Boundary",
      markdown: secondMarkdown,
      html: renderMarkdown(secondMarkdown),
      plain_text: markdownToPlainText(secondMarkdown),
      generated_at: 200,
      summaryMarkdown: "Edit summary.",
    },
    [],
    ["revision-boundary"],
    { operation: "raw-edit", instructions: "User changed body." },
  );

  const beforeArticle = getArticle(db, "revision-boundary");
  const beforeRevisions = listArticleRevisions(db, "revision-boundary");
  assert.ok(beforeArticle);
  assert.equal(beforeRevisions.length, 2);

  const staleUpdated = updateArticleSummary(db, "revision-boundary", "Stale summary refresh.", {
    updateRevisionGeneratedAt: 100,
  });
  const afterStaleArticle = getArticle(db, "revision-boundary");
  const afterStaleRevisions = listArticleRevisions(db, "revision-boundary");
  assert.equal(staleUpdated?.summaryMarkdown, "Edit summary.");
  assert.equal(afterStaleArticle?.summaryMarkdown, "Edit summary.");
  assert.equal(afterStaleRevisions.length, beforeRevisions.length);
  assert.equal(afterStaleRevisions[0].summaryMarkdown, "Edit summary.");
  assert.equal(afterStaleRevisions[1].summaryMarkdown, "Stale summary refresh.");

  const updated = updateArticleSummary(db, "revision-boundary", "Pipeline summary refresh.", {
    updateRevisionGeneratedAt: 200,
  });
  const afterArticle = getArticle(db, "revision-boundary");
  const afterRevisions = listArticleRevisions(db, "revision-boundary");
  db.close();

  assert.equal(updated?.summaryMarkdown, "Pipeline summary refresh.");
  assert.equal(afterArticle?.summaryMarkdown, "Pipeline summary refresh.");
  assert.equal(afterArticle?.markdown, beforeArticle.markdown);
  assert.equal(afterArticle?.html, beforeArticle.html);
  assert.equal(afterArticle?.plain_text, beforeArticle.plain_text);
  assert.equal(afterArticle?.generated_at, beforeArticle.generated_at);
  assert.equal(afterRevisions.length, beforeRevisions.length);
  assert.equal(afterRevisions[0].operation, "raw-edit");
  assert.equal(afterRevisions[0].summaryMarkdown, "Pipeline summary refresh.");
  assert.equal(afterRevisions[0].markdown, beforeRevisions[0].markdown);
  assert.equal(afterRevisions[1].summaryMarkdown, "Stale summary refresh.");
});

test("saveArticle skipRevision updates pipeline artifacts without adding a revision", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-skip-revision-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const db = openDatabase(join(root, TEST_CONFIG.database_path));
  const originalMarkdown = "# Pipeline Repair\n\nOriginal body.";
  const repairedMarkdown = "# Pipeline Repair\n\nOriginal body.";

  saveArticle(
    db,
    {
      slug: "pipeline-repair",
      canonicalSlug: "pipeline-repair",
      title: "Pipeline Repair",
      markdown: originalMarkdown,
      html: renderMarkdown(originalMarkdown),
      plain_text: markdownToPlainText(originalMarkdown),
      generated_at: 100,
      summaryMarkdown: "Original summary.",
    },
    [],
    ["pipeline-repair"],
    { operation: "generate" },
  );
  const beforeRevisions = listArticleRevisions(db, "pipeline-repair");

  saveArticle(
    db,
    {
      slug: "pipeline-repair",
      canonicalSlug: "pipeline-repair",
      title: "Pipeline Repair",
      markdown: repairedMarkdown,
      html: renderMarkdown(repairedMarkdown),
      plain_text: markdownToPlainText(repairedMarkdown),
      generated_at: 200,
      summaryMarkdown: "Pipeline-updated summary.",
    },
    [],
    ["pipeline-repair"],
    { operation: "repair", instructions: "Pipeline artifact update.", skipRevision: true },
  );

  const article = getArticle(db, "pipeline-repair");
  const afterRevisions = listArticleRevisions(db, "pipeline-repair");
  db.close();

  assert.equal(article?.summaryMarkdown, "Pipeline-updated summary.");
  assert.equal(afterRevisions.length, beforeRevisions.length);
  assert.deepEqual(
    afterRevisions.map((revision) => revision.operation),
    beforeRevisions.map((revision) => revision.operation),
  );
});

test("listArticles only returns real article entries", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-index-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const db = openDatabase(join(root, TEST_CONFIG.database_path));
  const articleMarkdown = "# Ledger Entry\n\nA real index entry.";
  const disambiguationMarkdown = "# Ambiguous Entry\n\nA disambiguation entry.";

  saveArticle(
    db,
    {
      slug: "ledger-entry",
      canonicalSlug: "ledger-entry",
      title: "Ledger Entry",
      markdown: articleMarkdown,
      html: renderMarkdown(articleMarkdown),
      plain_text: markdownToPlainText(articleMarkdown),
      generated_at: 1,
    },
    [],
    ["ledger-entry"],
  );
  saveArticle(
    db,
    {
      slug: "ambiguous-entry",
      canonicalSlug: "ambiguous-entry",
      title: "Ambiguous Entry",
      markdown: disambiguationMarkdown,
      html: renderMarkdown(disambiguationMarkdown),
      plain_text: markdownToPlainText(disambiguationMarkdown),
      generated_at: 2,
      isDisambiguation: true,
    },
    [],
    ["ambiguous-entry"],
  );

  const page = listArticles(db, 0, 50);
  db.close();

  assert.deepEqual(page.items.map((item) => item.slug), ["ledger-entry"]);
  assert.equal(page.total, 1);
  assert.equal(page.nextOffset, null);
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

test("retrieveContext summary mode caps chunk content at 360 chars", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-retrieval-summary-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const db = openDatabase(join(root, TEST_CONFIG.database_path));
  const llm = new NoopLlmClient();
  const longParagraph = "Glow fruit grows in the crater orchard near the observatory. ".repeat(10).trim();
  const sourceMarkdown = `# Archive Entry\n\n${longParagraph}`;
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
  await indexArticleChunks(db, llm, "archive-entry", sourceMarkdown, false, 800);

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
  assert.equal(TEST_CONFIG.database_path, "halupedia-testing.sqlite");
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

test("wikiSegmentToRequestedTitle treats slug-style wiki segments as titles", () => {
  assert.equal(
    wikiSegmentToRequestedTitle("cultural-dissipation-factor"),
    "Cultural dissipation factor",
  );
  assert.equal(wikiSegmentToRequestedTitle("Beta-Carotene"), "Beta-Carotene");
  assert.equal(wikiSegmentToRequestedTitle("fresh_page"), "fresh page");
  assert.equal(
    titleToWikiSegment(wikiSegmentToRequestedTitle("archive-rotation-mechanics-protocol")),
    "Archive_rotation_mechanics_protocol",
  );
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

test("reference links render as plain wiki links, not footnotes", () => {
  const refs: ReferenceList = [
    {
      slug: "source-entry",
      title: "Source Entry",
      content: "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
    },
  ];
  const body = resolveRefLinks(
    '[cited passage](ref:1) and [new topic](halu:new-topic "seed hint").',
    refs,
  );

  assert.equal(
    body,
    '[cited passage](ref:source-entry) and [new topic](halu:new-topic "seed hint").',
  );
  const html = renderMarkdown(body);
  // ref: links render as normal wiki links — no special class, no [N] superscript
  assert.doesNotMatch(html, /class="ref-link"/);
  assert.doesNotMatch(html, /class="ref-num"/);
  assert.match(html, /href="\/wiki\/Source_entry"/);
  assert.match(html, /href="\/wiki\/New_topic"/);
});

test("existing halu links are scraped and converted to reference links", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-ref-scrape-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const db = openDatabase(join(root, TEST_CONFIG.database_path));
  const markdown = "# Source Entry\n\nKnown source.";
  saveArticle(
    db,
    {
      slug: "source-entry",
      canonicalSlug: "source-entry",
      title: "Source Entry",
      markdown,
      html: renderMarkdown(markdown),
      summaryMarkdown: "Known source.",
      plain_text: markdownToPlainText(markdown),
      generated_at: 1,
    },
    [],
    ["source-entry"],
  );

  const body =
    '[known material](halu:source-entry "known source") and [unknown material](halu:missing-entry "missing source").';
  const refs = findExistingArticleLinkReferences(db, body, "current-entry");
  assert.deepEqual(refs.map((r) => r.slug), ["source-entry"]);
  assert.equal(
    convertExistingArticleLinksToRefs(db, body, "current-entry"),
    '[known material](ref:source-entry) and [unknown material](halu:missing-entry "missing source").',
  );
});

test("exact title mentions are scraped as body references without fuzzy matching", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-title-ref-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const db = openDatabase(join(root, TEST_CONFIG.database_path));

  const saveRefArticle = (slug: string, title: string) => {
    const markdown = `# ${title}\n\nKnown source.`;
    saveArticle(
      db,
      {
        slug,
        canonicalSlug: slug,
        title,
        markdown,
        html: renderMarkdown(markdown),
        summaryMarkdown: "Known source.",
        plain_text: markdownToPlainText(markdown),
        generated_at: 1,
      },
      [],
      [slug],
    );
  };

  saveRefArticle("regional-study", "Regional Study: A Field Guide");
  saveRefArticle("regional-study-archive", "Regional Study Archive");

  const body = [
    "# Current Entry",
    "",
    "The article discusses Regional Study A Field Guide in passing.",
    "It does not cite the archive title.",
  ].join("\n");

  assert.deepEqual(
    findTitleMentionedArticles(db, body, "current-entry").map((ref) => ref.slug),
    ["regional-study"],
  );
});

test("stripTopLevelSections removes model-emitted metadata headings at any level", () => {
  const markdown = [
    "# Article",
    "",
    "Body stays.",
    "",
    "### See also",
    "",
    "- Spurious related entry",
    "",
    "## References:",
    "",
    "- Spurious source",
  ].join("\n");

  assert.equal(stripTopLevelSections(markdown, ["References", "See also"]), "# Article\n\nBody stays.");
});

test("references render as ordered footnote targets, not markdown bullets", () => {
  const refs: ReferenceList = [
    {
      slug: "source-entry",
      title: "Source Entry",
      content: "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
    },
  ];
  const html = renderReferencesHtml(refs);
  assert.match(html, /<section class="article-references">/);
  assert.match(html, /<ol>/);
  assert.match(html, /<li id="ref-1">/);
  assert.doesNotMatch(html, /<ul>/);
});

test("buildReferenceList preserves carried refs before applying RAG cap", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-ref-cap-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const db = openDatabase(join(root, TEST_CONFIG.database_path));

  const saveRefArticle = (slug: string, title: string) => {
    const markdown = `# ${title}\n\nReference body.`;
    saveArticle(
      db,
      {
        slug,
        canonicalSlug: slug,
        title,
        markdown,
        html: renderMarkdown(markdown),
        summaryMarkdown: `${title} summary.`,
        plain_text: markdownToPlainText(markdown),
        generated_at: 1,
      },
      [],
      [slug],
    );
  };

  for (const [slug, title] of [
    ["body-ref-a", "Body Ref A"],
    ["body-ref-b", "Body Ref B"],
    ["prior-ref-a", "Prior Ref A"],
    ["prior-ref-b", "Prior Ref B"],
    ["rag-ref-a", "Rag Ref A"],
    ["rag-ref-b", "Rag Ref B"],
    ["rag-ref-c", "Rag Ref C"],
  ] as const) {
    saveRefArticle(slug, title);
  }

  const logger = new CaptureLogger();
  const refs = buildReferenceList(
    db,
    {
      articleSlug: "current-entry",
      userAdditions: [
        {
          slug: "body-ref-a",
          title: "Body Ref A",
          content: "",
          kind: "summary",
          pinned: false,
          revisionId: "current",
          source: "body",
        },
        {
          slug: "body-ref-b",
          title: "Body Ref B",
          content: "",
          kind: "summary",
          pinned: false,
          revisionId: "current",
          source: "body",
        },
      ],
      priorReferences: [
        {
          slug: "prior-ref-a",
          title: "Prior Ref A",
          content: "",
          kind: "summary",
          pinned: false,
          revisionId: "initial",
        },
        {
          slug: "prior-ref-b",
          title: "Prior Ref B",
          content: "",
          kind: "summary",
          pinned: false,
          revisionId: "initial",
        },
      ],
      ragSources: [
        { slug: "rag-ref-a", title: "Rag Ref A", content: "", score: 0.99 },
        { slug: "rag-ref-b", title: "Rag Ref B", content: "", score: 0.98 },
        { slug: "rag-ref-c", title: "Rag Ref C", content: "", score: 0.97 },
      ],
      revisionId: "current",
      config: {
        reference_max_results: 2,
        reference_min_score: 0.4,
        max_references: 10,
        reference_recursive_depth: 0,
        reference_recursive_max_per_article: 3,
      },
    },
    logger,
  );

  assert.deepEqual(
    refs.map((ref) => ref.slug),
    [
      "body-ref-a",
      "body-ref-b",
      "prior-ref-a",
      "prior-ref-b",
      "rag-ref-a",
      "rag-ref-b",
    ],
  );
  assert.deepEqual(
    refs.map((ref) => ref.source),
    ["body", "body", "prior", "prior", "rag", "rag"],
  );
  const built = logger.entries.find((entry) => entry.event === "references.built");
  assert.equal(built?.fields.body_reference_count, 2);
  assert.equal(built?.fields.user_added_count, 0);
  const detail = logger.entries.find((entry) => entry.event === "references.built_detail");
  assert.match(String(detail?.fields.entries ?? ""), /"source":"body"/);
});

test("buildReferenceList adds recursive sidecar refs within configured depth", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-recursive-ref-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const db = openDatabase(join(root, TEST_CONFIG.database_path));

  const saveRefArticle = (slug: string, title: string, generatedAt: number) => {
    const markdown = `# ${title}\n\nReference body.`;
    saveArticle(
      db,
      {
        slug,
        canonicalSlug: slug,
        title,
        markdown,
        html: renderMarkdown(markdown),
        summaryMarkdown: `${title} summary.`,
        plain_text: markdownToPlainText(markdown),
        generated_at: generatedAt,
      },
      [],
      [slug],
    );
  };

  saveRefArticle("root-ref", "Root Reference", 1);
  saveRefArticle("child-ref-a", "Child Reference A", 2);
  saveRefArticle("child-ref-b", "Child Reference B", 3);
  saveRefArticle("grandchild-ref", "Grandchild Reference", 4);
  saveArticleReferences(db, "root-ref", 1, [
    {
      slug: "child-ref-a",
      title: "Child Reference A",
      content: "Child A summary.",
      kind: "summary",
      pinned: false,
      revisionId: "initial",
    },
    {
      slug: "child-ref-b",
      title: "Child Reference B",
      content: "Child B summary.",
      kind: "summary",
      pinned: false,
      revisionId: "initial",
    },
  ]);
  saveArticleReferences(db, "child-ref-a", 2, [
    {
      slug: "grandchild-ref",
      title: "Grandchild Reference",
      content: "Grandchild summary.",
      kind: "summary",
      pinned: false,
      revisionId: "initial",
    },
  ]);

  const logger = new CaptureLogger();
  const refs = buildReferenceList(
    db,
    {
      articleSlug: "current-entry",
      userAdditions: [
        {
          slug: "root-ref",
          title: "Root Reference",
          content: "",
          kind: "summary",
          pinned: false,
          revisionId: "current",
          source: "body",
        },
      ],
      priorReferences: [],
      ragSources: [],
      revisionId: "current",
      config: {
        reference_max_results: 8,
        reference_min_score: 0.4,
        max_references: 10,
        reference_recursive_depth: 2,
        reference_recursive_max_per_article: 1,
      },
    },
    logger,
  );

  assert.deepEqual(
    refs.map((ref) => ref.slug),
    ["root-ref", "child-ref-a", "grandchild-ref"],
  );
  assert.deepEqual(
    refs.map((ref) => ref.source),
    ["body", "recursive", "recursive"],
  );
  const built = logger.entries.find((entry) => entry.event === "references.built");
  assert.equal(built?.fields.recursive_candidate_count, 2);
  assert.equal(built?.fields.recursive_max_per_article, 1);
});

test("linkMentionedReferencesInBody wraps exact unlinked reference title mentions", () => {
  const refs: ReferenceList = [
    {
      slug: "source-entry",
      title: "Source Entry",
      content: "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
    },
    {
      slug: "already-linked",
      title: "Already Linked",
      content: "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
    },
  ];
  const body = [
    "# Current Entry",
    "",
    "source entry is mentioned plainly.",
    "[Already Linked](ref:already-linked) is already linked.",
    "Do not alter `Source Entry` inside code.",
  ].join("\n");

  assert.equal(
    linkMentionedReferencesInBody(body, refs),
    [
      "# Current Entry",
      "",
      "[source entry](ref:source-entry) is mentioned plainly.",
      "[Already Linked](ref:already-linked) is already linked.",
      "Do not alter `Source Entry` inside code.",
    ].join("\n"),
  );
});

test("see-also metadata renders for display but is not baked into article markdown", () => {
  const article: Article = {
    slug: "current-entry",
    canonicalSlug: "current-entry",
    title: "Current Entry",
    path: "/wiki/Current_Entry",
    body: "# Current Entry\n\nCurrent body.",
    summary: "Current body.",
    plainText: "Current body.",
    generatedAt: 1,
    isDisambiguation: false,
    metadata: {
      references: [],
      seeAlso: [
        {
          slug: "related-entry",
          title: "Related Entry",
          hint: "related context",
        },
      ],
    },
  };

  const markdown = assembleArticleMarkdownForRender(article);
  assert.doesNotMatch(markdown, /## See also/);
  assert.doesNotMatch(markdown, /related-entry/);

  const html = renderArticleDisplayHtml(article);
  assert.match(html, /<h2>See also<\/h2>/);
  assert.match(html, /Related Entry/);
});

/* ─────────────────────────────────────────────────────────────────
   ref: link rendering
   ───────────────────────────────────────────────────────────────── */

test("resolveRefLinks: [](ref:N) fills in article title on first occurrence", () => {
  const refs: ReferenceList = [
    {
      slug: "glow-fruit",
      title: "Glow Fruit",
      content: "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
    },
  ];
  const body = "See [](ref:1) for details.";
  const resolved = resolveRefLinks(body, refs);
  assert.equal(resolved, "See [Glow Fruit](ref:glow-fruit) for details.");
});

test("resolveRefLinks: second occurrence of same ref becomes plain text", () => {
  const refs: ReferenceList = [
    {
      slug: "glow-fruit",
      title: "Glow Fruit",
      content: "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
    },
  ];
  const body = "See [the grove](ref:1) here and [](ref:1) there.";
  const resolved = resolveRefLinks(body, refs);
  // First: linked with bracket text. Second: plain title, no link.
  assert.equal(resolved, "See [the grove](ref:glow-fruit) here and Glow Fruit there.");
});

test("resolveRefLinks: ref:slug input is canonical and ref:N still resolves", () => {
  const refs: ReferenceList = [
    {
      slug: "glow-fruit",
      title: "Glow Fruit",
      content: "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
    },
    {
      slug: "night-bloom",
      title: "Night Bloom",
      content: "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
    },
  ];
  // Mixed input: numeric and slug forms both reach the same canonical output
  const body = "First [a](ref:glow-fruit) then [b](ref:2).";
  assert.equal(
    resolveRefLinks(body, refs),
    "First [a](ref:glow-fruit) then [b](ref:night-bloom).",
  );
});

test("formatReferencesForPrompt lists slug and title for each ref", () => {
  const refs: ReferenceList = [
    {
      slug: "glow-fruit",
      title: "Glow Fruit",
      content: "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
    },
    {
      slug: "night-bloom",
      title: "Night Bloom",
      content: "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
    },
  ];
  const rendered = formatReferencesForPrompt(refs);
  assert.match(rendered, /- \[Glow Fruit\]\(ref:glow-fruit\)/);
  assert.match(rendered, /- \[Night Bloom\]\(ref:night-bloom\)/);
});

test("formatReferencesForPrompt returns (none) when the list is empty", () => {
  assert.equal(formatReferencesForPrompt([]), "(none)");
});

test("resolveRefLinks: [brief label](ref:N) keeps provided label", () => {
  const refs: ReferenceList = [
    {
      slug: "glow-fruit",
      title: "Glow Fruit",
      content: "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
    },
  ];
  const body = "As noted by [the grove](ref:1), this is relevant.";
  const resolved = resolveRefLinks(body, refs);
  assert.equal(resolved, "As noted by [the grove](ref:glow-fruit), this is relevant.");
});

test("renderMarkdown: ref:slug link renders as plain wiki link", () => {
  const html = renderMarkdown("[Glow Fruit](ref:glow-fruit)");
  // Renders as a normal wiki link — no special class, no footnote
  assert.match(html, /href="\/wiki\/Glow_fruit"/);
  assert.doesNotMatch(html, /class="ref-link"/);
  assert.doesNotMatch(html, /class="ref-num"/);
});

test("renderMarkdown: [](ref:slug) with empty label renders article title as link", () => {
  const refs: ReferenceList = [
    {
      slug: "night-bloom",
      title: "Night Bloom",
      content: "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
    },
  ];
  const body = resolveRefLinks("[](ref:1)", refs);
  assert.equal(body, "[Night Bloom](ref:night-bloom)");
  const html = renderMarkdown(body);
  assert.match(html, /Night Bloom/);
  assert.match(html, /href="\/wiki\/Night_bloom"/);
});

/* ─────────────────────────────────────────────────────────────────
   articleRecordToArticle does not strip DB records
   ───────────────────────────────────────────────────────────────── */

test("articleRecordToArticle preserves baked-in See also section from old DB records", () => {
  const markdown = [
    "# Old Article",
    "",
    "**Old Article** is a legacy entry.",
    "",
    "## See also",
    "",
    "- [Related Thing](halu:related-thing \"related context\")",
  ].join("\n");

  const emptyMetadata: ArticleMetadata = { references: [], seeAlso: [] };
  const record: ArticleRecord = {
    slug: "old-article",
    canonicalSlug: "old-article",
    title: "Old Article",
    markdown,
    html: "",
    plain_text: "",
    generated_at: Date.now(),
  };
  const article = articleRecordToArticle(record, emptyMetadata);

  // Body should include the baked-in See also (not stripped)
  assert.match(article.body, /## See also/);
  assert.match(article.body, /related-thing/);
});

test("stripBodyMetadataSections removes References and See also headings and their content", () => {
  const markdown = [
    "# Article",
    "",
    "**Article** is a thing.",
    "",
    "## References",
    "",
    "- Something",
    "",
    "## See also",
    "",
    "- Other thing",
  ].join("\n");

  const stripped = stripBodyMetadataSections(markdown);
  assert.doesNotMatch(stripped, /## References/);
  assert.doesNotMatch(stripped, /## See also/);
  assert.match(stripped, /is a thing/);
});

/* ─────────────────────────────────────────────────────────────────
   Deleted-article tombstone tests
   ───────────────────────────────────────────────────────────────── */

function makeTempDb() {
  const root = mkdtempSync(join(tmpdir(), "halupedia-del-"));
  const databasePath = join(root, "test.sqlite");
  const db = openDatabase(databasePath);
  return { root, db, databasePath };
}

function seedDbArticle(
  db: ReturnType<typeof openDatabase>,
  slug: string,
  title: string,
) {
  const md = `# ${title}\n\n**${title}** is a test article.`;
  saveArticle(
    db,
    {
      slug,
      canonicalSlug: slug,
      title,
      markdown: md,
      html: `<h1>${title}</h1>`,
      plain_text: `${title} is a test article.`,
      generated_at: Date.now(),
    },
    [],
    [slug],
  );
}

test("deleteArticleBySlug: slug is tombstoned in deleted_articles table", (t) => {
  const { root, db } = makeTempDb();
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  seedDbArticle(db, "alpha-article", "Alpha Article");
  assert.ok(!isSlugDeleted(db, "alpha-article"), "should not be deleted before delete");

  const deleted = deleteArticleBySlug(db, "alpha-article");
  assert.ok(deleted, "deleteArticleBySlug should return true");
  assert.ok(isSlugDeleted(db, "alpha-article"), "slug must be in deleted_articles after deletion");
});

test("deleteArticleBySlug: article is no longer findable via getArticleByLookup", (t) => {
  const { root, db } = makeTempDb();
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  seedDbArticle(db, "beta-article", "Beta Article");
  assert.ok(getArticleByLookup(db, "beta-article"), "should exist before deletion");

  deleteArticleBySlug(db, "beta-article");
  assert.equal(
    getArticleByLookup(db, "beta-article"),
    null,
    "deleted article must not be findable by lookup",
  );
});

test("deleteArticleBySlug: removes referenced_slug from other articles' reference lists", (t) => {
  const { root, db } = makeTempDb();
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  seedDbArticle(db, "source-article", "Source Article");
  seedDbArticle(db, "target-article", "Target Article");

  const now = Date.now();
  saveArticleReferences(db, "source-article", now, [
    { slug: "target-article", title: "Target Article", summaryMarkdown: "A target." },
  ]);

  // Verify reference exists before deletion
  const before = getLatestArticleReferences(db, "source-article");
  assert.ok(
    before.some((r) => r.slug === "target-article"),
    "reference to target-article should exist before deletion",
  );

  deleteArticleBySlug(db, "target-article");

  const after = getLatestArticleReferences(db, "source-article");
  assert.ok(
    !after.some((r) => r.slug === "target-article"),
    "reference to deleted article must be removed from other articles' ref lists",
  );
});

test("isSlugDeleted: returns false for articles that were never deleted", (t) => {
  const { root, db } = makeTempDb();
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  seedDbArticle(db, "gamma-article", "Gamma Article");
  assert.ok(!isSlugDeleted(db, "gamma-article"), "live article should not be marked deleted");
  assert.ok(!isSlugDeleted(db, "nonexistent-slug"), "nonexistent slug should not be marked deleted");
});

test("deleteArticleBySlug: returns false and leaves no tombstone for unknown slug", (t) => {
  const { root, db } = makeTempDb();
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  const result = deleteArticleBySlug(db, "totally-unknown-slug");
  assert.ok(!result, "should return false for unknown slug");
  assert.ok(!isSlugDeleted(db, "totally-unknown-slug"), "no tombstone for unknown slug");
});

/* ─────────────────────────────────────────────────────────────────
   resolveRefLinks: bolded duplicate collapse
   ───────────────────────────────────────────────────────────────── */

test("resolveRefLinks: bold markers stripped from collapsed duplicate ref", () => {
  const refs: ReferenceList = [
    {
      slug: "glow-fruit",
      title: "Glow Fruit",
      content: "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
    },
  ];
  const body = "The [**Glow Fruit**](ref:glow-fruit) is notable. Later, [**Glow Fruit**](ref:glow-fruit) reappears.";
  const resolved = resolveRefLinks(body, refs);
  // First occurrence kept as-is (bold inside the link is fine).
  assert.match(resolved, /\[\*\*Glow Fruit\*\*\]\(ref:glow-fruit\)/);
  // Second occurrence must NOT carry bold markers.
  assert.doesNotMatch(resolved, /Later.*\*\*Glow Fruit\*\*/);
  assert.match(resolved, /Later, Glow Fruit reappears/);
});

/* ─────────────────────────────────────────────────────────────────
   normalizeHaluLinks: slug+hint bare brackets stripped cleanly
   ───────────────────────────────────────────────────────────────── */

test('normalizeHaluLinks: bare [slug "hint"] with double-quote is not converted to halu link', () => {
  // Labels with " are rejected by isBareBracketLinkLabel to avoid garbled links.
  // The [ is emitted literally and the content follows as text.
  const input = `the memoir The Smooth Passage [obama-method-of-drainage "hint"].`;
  const result = normalizeHaluLinks(input);
  // Must NOT produce a halu link that uses the slug+hint string as visible text
  assert.doesNotMatch(result, /\(halu:obama-method-of-drainage.*obama-method-of-drainage/);
  // The Smooth Passage plain text must survive
  assert.match(result, /The Smooth Passage/);
});

test("normalizeHaluLinks: bare [Title without quotes] still becomes a halu link", () => {
  const input = `cemented his standing [Some Article].`;
  const result = normalizeHaluLinks(input);
  assert.match(result, /\(halu:some-article/);
  assert.match(result, /Some Article/);
  assert.match(result, /cemented his standing/);
});

test("normalizeHaluLinks: title with apostrophe like [Obama's Method] becomes a halu link", () => {
  const input = `discussed in [Obama's Method].`;
  const result = normalizeHaluLinks(input);
  // Apostrophe in title is fine — only double-quote is rejected
  assert.match(result, /halu:obama-s-method/);
});

// parseArticleFrameOutput / parsePartialArticleFrame

const PROVIDED = new Set(["slug-a", "slug-b", "slug-c"]);
const NO_PINNED = new Set<string>();
const PINNED = new Set(["slug-a"]);

test("parseArticleFrameOutput: canonical sections parsed correctly", () => {
  const raw = [
    "---halu-meta",
    '{"title":"Test Article","slug":"test-article"}',
    "---halu-body",
    "# Test Article",
    "",
    "Body text.",
    "---halu-used-refs",
    '["slug-a","slug-b"]',
  ].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.equal(result.body, "# Test Article\n\nBody text.");
  assert.deepEqual(result.refsUsed, ["slug-a", "slug-b"]);
});

test("parseArticleFrameOutput: refs filtered to provided slugs only", () => {
  const raw = ["---halu-body", "Body.", "---halu-used-refs", '["slug-a","unknown-slug","slug-c"]'].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.deepEqual(result.refsUsed, ["slug-a", "slug-c"]);
});

test("parseArticleFrameOutput: refs derived from body ref links when section missing", () => {
  const raw = ["---halu-body", "Body cites [B](ref:slug-b) and [C](ref:slug-c)."].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.deepEqual(result.refsUsed, ["slug-b", "slug-c"]);
});

test("parseArticleFrameOutput: refs merged from section and body links", () => {
  const raw = ["---halu-body", "Body cites [B](ref:slug-b).", "---halu-used-refs", '["slug-a"]'].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.deepEqual(result.refsUsed, ["slug-a", "slug-b"]);
});

test("parseArticleFrameOutput: missing pinned ref returns ok=false", () => {
  const raw = ["---halu-body", "Body.", "---halu-used-refs", '["slug-b"]'].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, PINNED);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingPinned, ["slug-a"]);
  assert.equal(result.body, "Body.");
});

test("parseArticleFrameOutput: all pinned refs present returns ok=true", () => {
  const raw = ["---halu-body", "Body.", "---halu-used-refs", '["slug-a","slug-b"]'].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, PINNED);
  assert.equal(result.ok, true);
});

test("parseArticleFrameOutput: no sections → treat whole raw as body", () => {
  const raw = "# Plain article\n\nNo section markers at all.";
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.equal(result.body, raw);
});

test("parseArticleFrameOutput: missing body section with other sections → missing-body", () => {
  // Only meta JSON + usedRefs, no heading to extract body from
  const raw = ["---halu-meta", '{"title":"Test"}', "---halu-used-refs", '["slug-a"]'].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing-body");
});

test("parseArticleFrameOutput: body absorbed into meta section is recovered via heading scan", () => {
  // Model emitted ---halu-meta but skipped ---halu-body; body lands in meta section
  const raw = [
    "---halu-meta",
    '{"title":"Test Article","slug":"test-article"}',
    "",
    "# Test Article",
    "",
    "Body content absorbed into meta.",
    "---halu-used-refs",
    '["slug-a"]',
  ].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.match(result.body, /# Test Article/);
  assert.match(result.body, /Body content absorbed into meta/);
  assert.doesNotMatch(result.body, /"title"/);
});

test("parseArticleFrameOutput: inline meta marker (---halu-meta {...}) is recognized and body extracted", () => {
  // Model puts JSON on the same line as the meta marker, then body without ---halu-body
  const raw = [
    '---halu-meta {"title":"Test Article","slug":"test-article"}',
    "",
    "# Test Article",
    "",
    "Body after inline meta.",
    "---halu-used-refs",
    '["slug-b"]',
  ].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.match(result.body, /# Test Article/);
  assert.match(result.body, /Body after inline meta/);
  assert.deepEqual(result.refsUsed, ["slug-b"]);
});

test("parseArticleFrameOutput: body content before first marker is recovered as pre-body", () => {
  // Model outputs article without any markers first, then appends usedRefs
  const raw = [
    "# No Markers Article",
    "",
    "Content before any marker.",
    "---halu-used-refs",
    '["slug-c"]',
  ].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.match(result.body, /# No Markers Article/);
  assert.match(result.body, /Content before any marker/);
  assert.deepEqual(result.refsUsed, ["slug-c"]);
});

test("parseArticleFrameOutput: malformed usedRefs JSON falls back to body link scan", () => {
  const raw = ["---halu-body", "Body cites [A](ref:slug-a).", "---halu-used-refs", "not valid json"].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.deepEqual(result.refsUsed, ["slug-a"]);
});

test("parseArticleFrameOutput: section order may vary", () => {
  const raw = [
    "---halu-used-refs", '["slug-a"]',
    "---halu-meta", '{"title":"Test"}',
    "---halu-body", "# Test\n\nBody.",
  ].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.equal(result.body, "# Test\n\nBody.");
  assert.deepEqual(result.refsUsed, ["slug-a"]);
});

test("parseArticleFrameOutput: tolerant alias ---body is recognized", () => {
  const raw = ["---body", "# Alt Marker", "", "Body content."].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.equal(result.body, "# Alt Marker\n\nBody content.");
});

test("parseArticleFrameOutput: tolerant alias ## Body is recognized (case-insensitive)", () => {
  const raw = ["## body", "# Alt Marker", "", "Body content."].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.equal(result.body, "# Alt Marker\n\nBody content.");
});

test("parseArticleFrameOutput: tolerant alias ## Used Refs is recognized", () => {
  const raw = ["---halu-body", "Body.", "## Used Refs", '["slug-b"]'].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.deepEqual(result.refsUsed, ["slug-b"]);
});

test("parseArticleFrameOutput: body does not bleed into other sections", () => {
  const raw = [
    "---halu-body", "# Article", "", "Body text here.",
    "---halu-used-refs", '["slug-a"]',
    "---halu-meta", '{"title":"Article"}',
  ].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.body, /slug-a/);
  assert.doesNotMatch(result.body, /halu-used-refs/);
});

test("parseArticleFrameOutput: body prose containing braces is fine", () => {
  const raw = ["---halu-body", "Some {nested} text here."].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.equal(result.body, "Some {nested} text here.");
});

test("parseArticleFrameOutput: double-quoted halu hints in body are preserved as-is", () => {
  const raw = ['---halu-body', '# Title', '', 'A [Copper Link](halu:copper-link "quoted hint") stays valid.'].join("\n");
  const result = parseArticleFrameOutput(raw, PROVIDED, NO_PINNED);
  assert.equal(result.ok, true);
  assert.match(result.body, /halu:copper-link "quoted hint"/);
});

test("parsePartialArticleFrame: returns body content when body marker present", () => {
  const accumulated = "---halu-body\n# Title\n\nPartial body";
  assert.equal(parsePartialArticleFrame(accumulated), "# Title\n\nPartial body");
});

test("parsePartialArticleFrame: returns null before body marker is seen", () => {
  const accumulated = "---halu-meta\n{}\n";
  assert.equal(parsePartialArticleFrame(accumulated), null);
});

test("parsePartialArticleFrame: stops at the next section marker", () => {
  const accumulated = "---halu-body\n# Title\n\nBody text.\n---halu-used-refs\n[\"slug-a\"]";
  assert.equal(parsePartialArticleFrame(accumulated), "# Title\n\nBody text.");
});

test("parsePartialArticleFrame: works with tolerant alias ---body", () => {
  const accumulated = "---body\n# Alt Title\n\nContent";
  assert.equal(parsePartialArticleFrame(accumulated), "# Alt Title\n\nContent");
});

test("parsePartialArticleFrame: returns null when body marker seen but no content yet", () => {
  // Empty body section = nothing worth showing; caller guards on !partialBody
  const accumulated = "---halu-body\n";
  assert.equal(parsePartialArticleFrame(accumulated), null);
});

test("parsePartialArticleFrame: pre-body content with heading streams before body marker", () => {
  // Model skipped ---halu-body and wrote article directly
  const accumulated = "# Direct Article\n\nStreaming content here.";
  assert.equal(parsePartialArticleFrame(accumulated), "# Direct Article\n\nStreaming content here.");
});

test("parsePartialArticleFrame: pre-body without heading does not stream (avoids metadata noise)", () => {
  // JSON or marker text before a heading should not be streamed
  const accumulated = '---halu-meta {"title":"Test"}\n';
  assert.equal(parsePartialArticleFrame(accumulated), null);
});

test("parsePartialArticleFrame: meta-absorbed body streams from first heading", () => {
  // Model emitted ---halu-meta then body without ---halu-body
  const accumulated = "---halu-meta\n{\"title\":\"Test\"}\n\n# Test Article\n\nBody so far.";
  const result = parsePartialArticleFrame(accumulated);
  assert.ok(result?.includes("# Test Article"));
  assert.ok(result?.includes("Body so far."));
});

test("normalizeMarkdownLinks: dangling markdown link tail is not converted into a title seed", () => {
  const raw = "Body ends with [Spring (Cat)](";
  const result = normalizeMarkdownLinks(raw, "article");
  assert.equal(result.markdown, raw);
  assert.equal(result.stats.rewritten, 0);
});
