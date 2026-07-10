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
  isArticleProtected,
  setArticleProtection,
  listProtectedSections,
  isArticleSectionProtected,
  setArticleSectionProtection,
  listTopArticles,
  getHeadlineMediaForSlugs,
  upsertArticleHeadlineMedia,
  getGraphData,
  prepared,
} from "../src/server/db";
import { loadConfig } from "../src/server/config";
import {
  extractDisplayTitle,
  extractInternalLinks,
  extractTitle,
  ensureLeadingTitleHeading,
  leadBoldsTitle,
  markdownToPlainText,
  normalizeHaluLinks,
  buildHaluLink,
  renderInlineMarkdown,
  renderMarkdown,
  normalizeMarkdown,
  summaryMarkdownFromArticle,
  stripSelfLinks,
  stripTopLevelSections,
  stripFootnoteArtifacts,
  spliceProtectedSections,
} from "../src/server/markdown";
import { formatLogLine } from "../src/server/logger";
import { formatIncomingHintsForPrompt } from "../src/server/linkHints";
import { getPrompt, getSharedPrompt, parseJsonLoose, stripJsonFences } from "../src/server/prompts";
import { replaceTomlTripleQuoted } from "../src/server/promptEditor";
import { parse as parseToml } from "smol-toml";
import {
  recordPromptRevision,
  listPromptRevisions,
  reconstructPromptRevision,
} from "../src/server/db";
import {
  slugify,
  slugToTitle,
  titleToWikiSegment,
  wikiSegmentToRequestedTitle,
  wikiSegmentToTitle,
  normalizeCanonicalTitle,
} from "../src/server/slug";
import { LLM_DISPATCHER_OPTIONS, OpenAICompatRouter, setLlmFetchForTests, type LlmRouter } from "../src/server/llm";
import { makeRouter } from "./helpers/router";
import type { Logger, LogFields } from "../src/server/logger";
import { formatRagContextForPrompt, formatRelatedTitlesForPrompt } from "../src/server/retrieval";
import { indexRagChunksNode } from "../src/server/pipeline/nodes/postProcess";
import type { PipelineDeps } from "../src/server/pipeline/deps";
import {
  normalizeSummaryMarkdown,
  summaryLooksLikeLeadCopy,
} from "../src/server/summary";
import { summarizeRetrievedSource, parseArticleFrameOutput, parsePartialArticleFrame } from "../src/server/index";
import {
  buildReferenceList,
  convertExistingArticleLinksToRefs,
  extractAllBodyLinks,
  findExistingArticleLinkReferences,
  findTitleMentionedArticles,
  formatReferencesForPrompt,
  linkMentionedReferencesInBody,
  linkReferences,
  renderReferencesHtml,
  resolveArticleBodyLinks,
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

class NoopLlmClient implements LlmRouter {
  async chat(): Promise<string> {
    throw new Error("chat should not be called in retrieval unit tests");
  }

  async streamChat(): Promise<{ content: string; finishReason: string }> {
    throw new Error("streamChat should not be called in retrieval unit tests");
  }

  async embed(): Promise<number[][]> {
    return [];
  }

  supportsVision(): boolean { return false; }
  async probeConnections(): Promise<void> {}
}

class FailingEmbedLlmClient extends NoopLlmClient {
  async embed(): Promise<number[][]> {
    throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
  }
}

class UnexpectedEmbedLlmClient extends NoopLlmClient {
  embedCalls = 0;

  async embed(): Promise<number[][]> {
    this.embedCalls += 1;
    throw new Error("embed should not be called");
  }
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

test("LLM dispatcher disables Undici headers/body timers", () => {
  assert.equal(LLM_DISPATCHER_OPTIONS.headersTimeout, 0);
  assert.equal(LLM_DISPATCHER_OPTIONS.bodyTimeout, 0);
});

test("OpenAI-compatible LLM logs use explicit roles for heavy, light, and embeddings", async (t) => {
  const logger = new CaptureLogger();
  const chatBodies: unknown[] = [];
  t.after(() => setLlmFetchForTests(null));

  setLlmFetchForTests(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/chat")) {
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
  });

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
  const router = makeRouter(chatConfig, { ...chatConfig, max_tokens: 3000 }, embeddingsConfig, logger);

  await router.chat("heavy", "system", "user");
  await router.chat("light", "system", "user", { thinking: true });
  await router.chat("heavy", "system", "user", { jsonMode: true });
  await router.chat("heavy", "system", "user", {
    jsonMode: true,
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: { presetKey: { type: "string", enum: ["photo"] } },
      required: ["presetKey"],
    },
  });
  await router.embed(["article chunk"]);

  assert.equal(logger.entries.find((entry) => entry.event === "llm.chat_request")?.fields.role, "heavy");
  assert.equal(logger.entries.find((entry) => entry.event === "llm.chat_response")?.fields.role, "heavy");
  assert.ok(logger.entries.some((entry) => entry.event === "llm.chat_request" && entry.fields.role === "light"));
  assert.ok(logger.entries.some((entry) => entry.event === "llm.embed_request" && entry.fields.role === "embeddings"));
  assert.ok(logger.entries.some((entry) => entry.event === "llm.embed_response" && entry.fields.role === "embeddings"));
  assert.ok(!logger.entries.some((entry) => entry.fields.role === "chat"));
  assert.equal((chatBodies[0] as { think?: boolean }).think, false);
  assert.equal((chatBodies[1] as { think?: boolean }).think, true);
  assert.equal((chatBodies[2] as { format?: string }).format, "json");
  assert.deepEqual((chatBodies[3] as { format?: unknown }).format, {
    type: "object",
    additionalProperties: false,
    properties: { presetKey: { type: "string", enum: ["photo"] } },
    required: ["presetKey"],
  });
});

test("configured Ollama generation params are sent; unset ones are omitted", async (t) => {
  let body: any = null;
  t.after(() => setLlmFetchForTests(null));
  setLlmFetchForTests(async (_input, init) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { total_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const heavy = {
    base_url: "http://llm.test/v1", api_key: "k", model: "gemma4", temperature: 1, max_tokens: 100,
    num_ctx: 32768, repeat_last_n: -1, repeat_penalty: 1.1, seed: 42, draft_num_predict: 4,
    top_k: 10, top_p: 0.85,
  };
  const light = { base_url: "http://llm.test/v1", api_key: "k", model: "gemma4", temperature: 1, max_tokens: 100 };
  const router = makeRouter(heavy, light, { enabled: false, base_url: "", api_key: "", model: "" });

  await router.chat("heavy", "s", "u");
  assert.equal(body.options.num_ctx, 32768);
  assert.equal(body.options.repeat_last_n, -1);
  assert.equal(body.options.repeat_penalty, 1.1);
  assert.equal(body.options.seed, 42);
  assert.equal(body.options.draft_num_predict, 4);
  assert.equal(body.options.top_k, 10);
  assert.equal(body.options.top_p, 0.85);
  assert.equal("min_p" in body.options, false, "unset min_p must be omitted entirely");

  await router.chat("light", "s", "u");
  assert.equal("num_ctx" in body.options, false);
  assert.equal("repeat_last_n" in body.options, false);
  assert.equal("repeat_penalty" in body.options, false);
  assert.equal("seed" in body.options, false);
  assert.equal("draft_num_predict" in body.options, false);
  assert.equal("top_k" in body.options, false, "light set none -> no sampler keys");
  assert.equal("top_p" in body.options, false);
});

test("chat surfaces the underlying transport cause, not a bare 'fetch failed'", async (t) => {
  const logger = new CaptureLogger();
  t.after(() => setLlmFetchForTests(null));

  setLlmFetchForTests(async () => {
    // Mirror how Node's undici reports a dropped connection.
    throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
  });

  const chatConfig = { base_url: "http://llm.test/v1", api_key: "local", model: "gemma4", temperature: 1, max_tokens: 9001 };
  const router = makeRouter(chatConfig, chatConfig, { enabled: false, base_url: "", api_key: "", model: "" }, logger);

  await assert.rejects(
    router.chat("heavy", "system", "user"),
    (err: Error) => {
      assert.match(err.message, /ECONNRESET/, "error must name the real cause");
      assert.doesNotMatch(err.message, /^fetch failed$/);
      return true;
    },
  );
  const failure = logger.entries.find((e) => e.event === "llm.chat_request_failed");
  assert.ok(failure, "a chat_request_failed entry must be logged");
  assert.equal(failure!.fields.code, "ECONNRESET");
});

test("chat retries a failed host on another eligible configured host", async (t) => {
  const logger = new CaptureLogger();
  const requestedUrls: string[] = [];
  t.after(() => setLlmFetchForTests(null));

  setLlmFetchForTests(async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.startsWith("http://desktop.test")) {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    }
    return new Response(
      JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "laptop generated news" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const router = new OpenAICompatRouter({
    hosts: {
      desktop: {
        id: "desktop",
        base_url: "http://desktop.test/v1",
        api_key: "local",
        max_in_flight: 1,
        pref: 0,
        blacklist: [],
      },
      laptop: {
        id: "laptop",
        base_url: "http://laptop.test/v1",
        api_key: "local",
        max_in_flight: 1,
        pref: 1,
        blacklist: [],
      },
    },
    chat: {
      hosts: ["desktop"],
      base_url: "http://desktop.test/v1",
      api_key: "local",
      model: "gemma4",
      temperature: 1,
      max_tokens: 100,
      request_timeout_ms: 1000,
    },
    light: {
      hosts: ["desktop"],
      base_url: "http://desktop.test/v1",
      api_key: "local",
      model: "gemma4",
      temperature: 1,
      max_tokens: 100,
      request_timeout_ms: 1000,
    },
    embeddings: {
      enabled: false,
      hosts: ["desktop"],
      base_url: "http://desktop.test/v1",
      api_key: "local",
      model: "nomic",
      request_timeout_ms: 1000,
    },
  }, logger);

  const result = await router.chat("heavy", "system", "user");

  assert.equal(result, "laptop generated news");
  assert.deepEqual(requestedUrls, [
    "http://desktop.test/api/chat",
    "http://laptop.test/api/chat",
  ]);
  assert.ok(logger.entries.some((entry) =>
    entry.event === "llm.host_failover" &&
    entry.fields.failed_host === "desktop" &&
    entry.fields.remaining === 1
  ));
});

test("streamChat reports an interrupted stream with partial content and progress", async (t) => {
  const logger = new CaptureLogger();
  t.after(() => setLlmFetchForTests(null));

  const encoder = new TextEncoder();
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " } }] })}\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "world" } }] })}\n`,
  ];
  setLlmFetchForTests(async () => {
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < sse.length) {
          controller.enqueue(encoder.encode(sse[i++]));
        } else {
          // Socket drops mid-stream after some tokens arrived.
          controller.error(Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }));
        }
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });

  const chatConfig = { base_url: "http://llm.test/v1", api_key: "local", model: "gemma4", temperature: 1, max_tokens: 9001 };
  const router = makeRouter(chatConfig, chatConfig, { enabled: false, base_url: "", api_key: "", model: "" }, logger);

  const seen: string[] = [];
  await assert.rejects(
    router.streamChat("heavy", "system", "user", (d) => seen.push(d)),
    (err: Error & { partialContent?: string }) => {
      assert.match(err.message, /interrupted after 2 chunks/);
      assert.match(err.message, /UND_ERR_SOCKET|other side closed/);
      assert.equal(err.partialContent, "Hello world", "partial output is attached to the error");
      return true;
    },
  );
  // The deltas reached the consumer before the drop…
  assert.deepEqual(seen, ["Hello ", "world"]);
  // …and the interruption is logged with how far it got.
  const interrupted = logger.entries.find((e) => e.event === "llm.stream_interrupted");
  assert.ok(interrupted, "an llm.stream_interrupted entry must be logged");
  assert.equal(interrupted!.fields.chunks, 2);
  assert.equal(interrupted!.fields.content_chars, 11);
  assert.ok(logger.entries.some((e) => e.event === "llm.stream_first_token"), "first-token latency is logged");
});

test("embed surfaces the transport cause and times out instead of hanging", async (t) => {
  const logger = new CaptureLogger();
  t.after(() => setLlmFetchForTests(null));

  setLlmFetchForTests(async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
  });

  const chatConfig = { base_url: "http://llm.test/v1", api_key: "local", model: "gemma4", temperature: 1, max_tokens: 100, request_timeout_ms: 5000 };
  const embeddingsConfig = { enabled: true, base_url: "http://llm.test/v1", api_key: "local", model: "nomic", request_timeout_ms: 5000 };
  const router = makeRouter(chatConfig, chatConfig, embeddingsConfig, logger);

  await assert.rejects(
    router.embed(["a chunk"]),
    (err: Error) => {
      assert.match(err.message, /ECONNREFUSED/);
      return true;
    },
  );
  assert.ok(logger.entries.some((e) => e.event === "llm.embed_request_failed" && e.fields.code === "ECONNREFUSED"));
});

test("startup probes log the underlying transport cause", async (t) => {
  const logger = new CaptureLogger();
  t.after(() => setLlmFetchForTests(null));

  setLlmFetchForTests(async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
  });

  const chatConfig = { base_url: "http://llm.test/v1", api_key: "local", model: "gemma4", temperature: 1, max_tokens: 100, request_timeout_ms: 5000 };
  const embeddingsConfig = { enabled: false, base_url: "http://llm.test/v1", api_key: "local", model: "nomic", request_timeout_ms: 5000 };
  const router = makeRouter(chatConfig, chatConfig, embeddingsConfig, logger);

  await router.probeConnections();

  assert.ok(logger.entries.some((e) => e.event === "llm.models_probe_error" && e.fields.code === "ECONNRESET"));
});

test("heavy and light OpenAI-compatible requests are sent independently", async (t) => {
  const logger = new CaptureLogger();
  const heavyGate = Promise.withResolvers<void>();
  const completed: string[] = [];
  t.after(() => setLlmFetchForTests(null));

  setLlmFetchForTests(async (input) => {
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
  });

  const embeddingsConfig = {
    enabled: false,
    base_url: "http://embed.test/v1",
    api_key: "local",
    model: "nomic",
  };
  const router = makeRouter(
    { base_url: "http://heavy.test/v1", api_key: "local", model: "heavy-model", temperature: 1, max_tokens: 9001 },
    { base_url: "http://light.test/v1", api_key: "local", model: "light-model", temperature: 1, max_tokens: 3000 },
    embeddingsConfig,
    logger,
  );

  const heavyRequest = router.chat("heavy", "system", "user");
  const lightResult = await router.chat("light", "system", "user");

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

test("halu hints with escaped closing quotes are repaired, normalized, and render as links", () => {
  // The model escapes its own closing quote: `"the brain\")` — per CommonMark
  // that leaves the title unterminated, so markdown-it refuses the link and
  // the raw markdown leaks into the page.
  const markdown =
    'Career centered on [neurological plasticity](halu:neurological-plasticity "the brain\\") topics.';

  const links = extractInternalLinks(markdown);
  assert.deepEqual(links, [
    {
      targetSlug: "neurological-plasticity",
      visibleLabel: "neurological plasticity",
      hiddenHint: "the brain",
    },
  ]);

  // Normalization re-emits a valid CommonMark title (no backslash survives),
  // which also makes cachedArticleNeedsRepair self-heal stored articles.
  const normalized = normalizeHaluLinks(markdown);
  assert.match(normalized, /\(halu:neurological-plasticity "the brain"\)/);
  assert.doesNotMatch(normalized, /\\/);

  const html = renderMarkdown(normalized);
  assert.match(html, /href="\/wiki\/Neurological_plasticity"/i);
  assert.doesNotMatch(html, /halu:/);
});

test("buildHaluLink can never emit a hint that breaks the CommonMark title", () => {
  const link = buildHaluLink("Label", "some-slug", 'tricky \\ hint "quoted" [x] (y)');
  assert.equal(link, '[Label](halu:some-slug "tricky hint \'quoted\' x y")');
  // Round-trip: the emitted link must parse back with the same slug.
  const links = extractInternalLinks(`See ${link}.`);
  assert.equal(links.length, 1);
  assert.equal(links[0].targetSlug, "some-slug");
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

test("formatIncomingHintsForPrompt dedupes repeated hints before applying cap", () => {
  const promptText = formatIncomingHintsForPrompt(
    [
      {
        sourceSlug: "source-a",
        sourceTitle: "Source A",
        visibleLabel: "Shared Label",
        hiddenHint: "same target context",
      },
      {
        sourceSlug: "source-b",
        sourceTitle: "Source B",
        visibleLabel: "Shared Label",
        hiddenHint: "same target context",
      },
      {
        sourceSlug: "source-c",
        sourceTitle: "Source C",
        visibleLabel: "Other Label",
        hiddenHint: "different target context",
      },
    ],
    "actual-target",
    2,
  );

  assert.equal(promptText.match(/halu:actual-target/g)?.length, 2);
  assert.equal(promptText.match(/Shared Label/g)?.length, 1);
  assert.match(promptText, /Other Label/);
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

test("renderMarkdown rewrites halu links to wiki paths using the halu target", () => {
  const html = renderMarkdown(
    'Visit [Glow Fruit](halu:glow-fruit "hidden hint") for details.',
  );
  assert.match(html, /href="\/wiki\/Glow_Fruit"/);
  assert.doesNotMatch(html, /hidden hint/);
});

test("renderMarkdown does not route halu aliases through their visible label", () => {
  const html = renderMarkdown(
    'Visit [The T-O Test](halu:oscillation-test-of-significance "hidden hint") for details.',
  );
  assert.match(html, /href="\/wiki\/Oscillation_test_of_significance"/);
  assert.doesNotMatch(html, /href="\/wiki\/The_T-O_Test"/);
  assert.doesNotMatch(html, /hidden hint/);
});

test("renderInlineMarkdown stringifies invalid sidecar values instead of throwing", () => {
  assert.equal(renderInlineMarkdown(null), "");
  const html = renderInlineMarkdown({ value: "bad infobox row" } as unknown);
  assert.match(html, /bad infobox row/);
  assert.doesNotMatch(html, /href=/);
});

test("renderInlineMarkdown preserves Markdown emphasis around Chinese text", () => {
  assert.equal(renderInlineMarkdown("**女***作品*"), "<strong>女</strong><em>作品</em>");
});

test("ensureLeadingTitleHeading compares bold title restatements with Unicode letters", () => {
  assert.equal(
    ensureLeadingTitleHeading("**女**\n\nBody.", "女"),
    "# 女\n\nBody.",
  );
  assert.equal(
    ensureLeadingTitleHeading("**男**\n\nBody.", "女"),
    "# 女\n\n**男**\n\nBody.",
  );
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
  assert.equal(articlePrompt.thinking, true);
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

test("formatRagContextForPrompt skips empty/title-only and duplicate headings, keeps real content", () => {
  const out = formatRagContextForPrompt(
    [
      { title: "Alpha", content: "# Alpha", slug: "alpha" }, // title-only → dropped
      { title: "Alpha", content: "Real prose about the alpha topic.", slug: "alpha" },
      { title: "Alpha", content: "A second alpha chunk that should not add a heading.", slug: "alpha" }, // dup title → dropped
      { title: "Beta", content: "Distinct content about beta.", slug: "beta" },
    ],
    10_000,
  );
  assert.equal(out.match(/^## \[Alpha\]\(ref:alpha\)$/gm)?.length, 1, "Alpha heading appears exactly once as a ref link");
  assert.match(out, /Real prose about the alpha topic\./);
  assert.match(out, /^## \[Beta\]\(ref:beta\)$/m);
  assert.doesNotMatch(out, /\(ref:alpha\)\n# Alpha/, "title-only entry must not be emitted");
});

test("formatRelatedTitlesForPrompt appends a one-line summary when available", () => {
  const out = formatRelatedTitlesForPrompt(
    ["Ababa test", "Beta"],
    [
      { title: "Ababa test", slug: "ababa-test", summary: "A recurring diagnostic naming exercise." },
      { title: "Beta", slug: "beta" }, // no summary -> plain bullet, no dangling dash
    ],
  );
  assert.match(out, /^- \[Ababa test\]\(ref:ababa-test\) — A recurring diagnostic naming exercise\.$/m);
  assert.match(out, /^- \[Beta\]\(ref:beta\)$/m);
});

test("formatRelatedTitlesForPrompt falls back to a plain bullet with no matching source", () => {
  const out = formatRelatedTitlesForPrompt(["Unknown Topic"], []);
  assert.equal(out, "- Unknown Topic");
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
  // Capitalized hyphenated titles keep their hyphen as a named token now —
  // the slug "β-carotene" still reaches the article via its legacy alias.
  assert.equal(slugify("β-Carotene"), "β-dash-carotene");
  assert.equal(slugify("Ölgemälde"), "ölgemälde");
  assert.equal(slugify("naïve"), "naïve");
  assert.equal(slugify("café"), "café");
});

test("slugify decomposes emoji into their CLDR name + 'emoji' instead of dropping them", () => {
  // Slugs stay plain-alpha, but distinct emoji shouldn't collide on the same
  // slug just because they'd otherwise both be stripped to nothing. The
  // trailing "emoji" word marks where a symbol stood.
  assert.equal(slugify("Banana 🍌"), "banana-banana-emoji");
  assert.equal(slugify("Banana 🍍"), "banana-pineapple-emoji");
  assert.equal(slugify("Test: PPx🍌"), "test-colon-ppx-banana-emoji");
  // ASCII punctuation is decomposed the same way emoji are (robust slugs);
  // the legacy form remains reachable via legacySlugify-based aliases.
  assert.equal(slugify("Cost: $5"), "cost-colon-dollar-5");
});

test("titleToWikiSegment preserves emoji so the URL round-trips to the same slug", () => {
  // The bug: stripping the emoji turned "Chiquita 🍌" into "/wiki/Chiquita_",
  // which slugified back to a *different* article ("chiquita"). Emoji must
  // survive in the segment, and the segment must re-derive the same slug.
  const seg = titleToWikiSegment("Chiquita 🍌");
  assert.equal(seg, "Chiquita_🍌");
  assert.equal(slugify("Chiquita 🍌"), "chiquita-banana-emoji");
  assert.equal(
    slugify(normalizeCanonicalTitle(wikiSegmentToRequestedTitle(seg))),
    slugify("Chiquita 🍌"),
    "segment must re-derive the same slug it came from",
  );
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

test("stripSelfLinks also strips ref:self-slug links, not just halu:", () => {
  const markdown = "See [Glow Fruit](ref:glow-fruit) and [the orchard](ref:crater-orchard).";
  const result = stripSelfLinks(markdown, "glow-fruit");
  // Self ref: link becomes plain text
  assert.doesNotMatch(result, /ref:glow-fruit/);
  assert.match(result, /See Glow Fruit and/);
  // Other ref: link is untouched
  assert.match(result, /\(ref:crater-orchard\)/);
});

test("linkReferences filters self-article from refs before linking mentions", () => {
  const mkRef = (slug: string, title: string) => ({
    slug, title, content: "", kind: "summary" as const, pinned: false, revisionId: "current" as const,
  });
  const refs: ReferenceList = [
    mkRef("glow-fruit", "Glow Fruit"),
    mkRef("crater-orchard", "Crater Orchard"),
  ];
  // When selfSlug is passed, mentions of "Glow Fruit" must NOT be linked
  // because it would be a self-link.
  const body = "Glow Fruit grows in Crater Orchard.";
  const result = linkReferences(body, refs, "glow-fruit");
  assert.doesNotMatch(result, /ref:glow-fruit/, "self-article must not be linked");
  assert.match(result, /\[Crater Orchard\]\(ref:crater-orchard\)/, "other refs must still be linked");
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

test("stripJsonFences strips an opening fence even when the closing fence is missing", () => {
  // Truncated model output: opening ```json survives, no closing fence.
  const truncated = '```json\n{"relations":[{"subject":"A"';
  assert.equal(stripJsonFences(truncated), '{"relations":[{"subject":"A"');
});

/* -------------------------------------------------------------------------- */
/*  parseJsonLoose                                                             */
/* -------------------------------------------------------------------------- */

test("parseJsonLoose parses clean JSON", () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
});

test("parseJsonLoose repairs and salvages a truncated array", () => {
  // finish_reason=length mid-array: the two complete objects must survive.
  const truncated =
    '```json\n{"relations":[{"subject":"A","predicate":"related_to","object":"B"},' +
    '{"subject":"A","predicate":"related_to","object":"C"},{"subject":"A","predi';
  const parsed = parseJsonLoose(truncated) as { relations: unknown[] };
  assert.ok(parsed && Array.isArray(parsed.relations));
  assert.ok(parsed.relations.length >= 2, "keeps the complete leading entries");
  assert.deepEqual(parsed.relations[0], { subject: "A", predicate: "related_to", object: "B" });
});

test("parseJsonLoose returns null for empty input", () => {
  assert.equal(parseJsonLoose(""), null);
  assert.equal(parseJsonLoose("   \n  "), null);
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

test("extractDisplayTitle keeps italics but strips bold from titles", () => {
  // Italics are meaningful (e.g. scientific names) — kept.
  assert.equal(
    extractDisplayTitle("# *De Rerum Natura*\n\nBody."),
    "*De Rerum Natura*",
  );
  // Bold-only titles render identically to the plain canonical title once the
  // bold is stripped, so there's no separate display title to keep.
  assert.equal(extractDisplayTitle("# **Bold Title**\n\nBody."), undefined);
  // Mixed: bold stripped, italics retained.
  assert.equal(
    extractDisplayTitle("# **Pee**: *A* Test\n\nBody."),
    "Pee: *A* Test",
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

test("extractAllBodyLinks stores halu and ref graph links through one helper", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-all-body-links-"));
  t.after(() => {
    db.close();
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
      summaryMarkdown: "Known source summary.",
      plain_text: markdownToPlainText(markdown),
      generated_at: 1,
    },
    [],
    ["source-entry"],
  );

  const links = extractAllBodyLinks(
    db,
    [
      '[new topic](halu:missing-entry "missing source")',
      "[known source](ref:source-entry)",
      "[self reference](ref:current-entry)",
    ].join(" and "),
    "current-entry",
  );

  assert.deepEqual(
    links.map((link) => [link.targetSlug, link.visibleLabel, link.hiddenHint]),
    [
      ["missing-entry", "new topic", "missing source"],
      ["source-entry", "known source", "Known source summary."],
    ],
  );
});

test("resolveArticleBodyLinks normalizes, resolves refs, converts existing halu links, and strips self-links", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-resolve-body-links-"));
  t.after(() => {
    db.close();
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
      summaryMarkdown: "Known source summary.",
      plain_text: markdownToPlainText(markdown),
      generated_at: 1,
    },
    [],
    ["source-entry"],
  );

  const resolved = resolveArticleBodyLinks(
    db,
    [
      "[known material](halu:source-entry \"known source\")",
      "mentions Source Entry",
      "[self](ref:current-entry)",
      "[future topic](halu:future-topic \"future hint\")",
    ].join(" and "),
    [{
      slug: "source-entry",
      title: "Source Entry",
      content: "Known source summary.",
      kind: "summary",
      pinned: false,
      revisionId: "current",
    }],
    "current-entry",
  );

  assert.equal(
    resolved,
    '[known material](ref:source-entry) and mentions [Source Entry](ref:source-entry) and self and [future topic](halu:future-topic "future hint")',
  );

  assert.equal(
    resolveArticleBodyLinks(
      db,
      "An [invented source](ref:invented-source) appears beside [Source Entry](ref:source-entry).",
      [],
      "current-entry",
    ),
    'An [invented source](halu:invented-source "invented source") appears beside [Source Entry](ref:source-entry).',
    "missing refs become halu links while existing refs remain canonical",
  );
});

test("convertExistingArticleLinksToRefs resolves bad dash targets through the visible title before keeping halu", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-dash-ref-"));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const db = openDatabase(join(root, TEST_CONFIG.database_path));
  const markdown = "# Signal Relay\n\nKnown source.";
  saveArticle(
    db,
    {
      slug: "signal-relay",
      canonicalSlug: "signal-relay",
      title: "Signal Relay",
      markdown,
      html: renderMarkdown(markdown),
      summaryMarkdown: "Known source.",
      plain_text: markdownToPlainText(markdown),
      generated_at: 1,
    },
    [],
    ["signal-relay"],
  );

  const body = '[Signal-relay](halu:signal-dash-relay "bad generated target") appears inline.';
  assert.deepEqual(
    findExistingArticleLinkReferences(db, body, "current-entry").map((r) => r.slug),
    ["signal-relay"],
  );
  assert.equal(
    convertExistingArticleLinksToRefs(db, body, "current-entry"),
    "[Signal-relay](ref:signal-relay) appears inline.",
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

test("stripTopLevelSections strips 'Used References' / 'None' pattern the model emits", () => {
  const markdown = [
    "# Article",
    "",
    "Body content here.",
    "",
    "## Used References",
    "",
    "None",
  ].join("\n");

  const headings = ["References", "See also", "Used References", "Used Refs", "References Used", "Refs Used", "Reference List", "Sources", "Bibliography"];
  assert.equal(stripTopLevelSections(markdown, headings), "# Article\n\nBody content here.");
});

test("stripTopLevelSections strips 'Sources' and 'Bibliography' sections", () => {
  const markdown = "# Article\n\nBody.\n\n## Sources\n\n- [1] Something\n\n## Bibliography\n\n- Something else";
  const headings = ["References", "See also", "Used References", "Used Refs", "References Used", "Refs Used", "Reference List", "Sources", "Bibliography"];
  const result = stripTopLevelSections(markdown, headings);
  assert.doesNotMatch(result, /Sources/);
  assert.doesNotMatch(result, /Bibliography/);
  assert.match(result, /Body\./);
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

test("buildReferenceList reranks prior refs against RAG within the score budget", (t) => {
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
        reference_cull_min_score: 0,
        reference_cull_top_k: 0,
      },
    },
    logger,
  );

  // Body refs supplied this build are protected. The two scoreless priors are
  // reranked (they fall to the score floor) and must compete with RAG for the
  // 2-slot score budget; both higher-scoring RAG refs win, so the priors are
  // discarded rather than carried forward unconditionally.
  assert.deepEqual(
    refs.map((ref) => ref.slug),
    [
      "body-ref-a",
      "body-ref-b",
      "rag-ref-a",
      "rag-ref-b",
    ],
  );
  assert.deepEqual(
    refs.map((ref) => ref.source),
    ["body", "body", "rag", "rag"],
  );
  const built = logger.entries.find((entry) => entry.event === "references.built");
  assert.equal(built?.fields.body, 2, "body ref count in log");
  assert.equal(built?.fields.user, 0, "user-added ref count in log");
  // refs field contains formatted entries; body refs appear as slug[body]
  assert.match(String(built?.fields.refs ?? ""), /\[body\]/);
});

test("buildReferenceList keeps a high-scoring prior over a low-scoring RAG ref", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-ref-rerank-"));
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
    ["strong-prior", "Strong Prior"],
    ["pinned-prior", "Pinned Prior"],
    ["weak-rag", "Weak Rag"],
  ] as const) {
    saveRefArticle(slug, title);
  }

  const refs = buildReferenceList(db, {
    articleSlug: "current-entry",
    userAdditions: [],
    priorReferences: [
      // A previously-RAG-scored prior that out-scores the new weak RAG hit.
      { slug: "strong-prior", title: "Strong Prior", content: "", kind: "summary", pinned: false, revisionId: "initial", source: "rag", score: 0.95 },
      // Pinned priors always survive regardless of score or budget.
      { slug: "pinned-prior", title: "Pinned Prior", content: "", kind: "summary", pinned: true, revisionId: "initial", source: "pinned" },
    ],
    ragSources: [{ slug: "weak-rag", title: "Weak Rag", content: "", score: 0.55 }],
    revisionId: "current",
    config: {
      reference_max_results: 1,
      reference_min_score: 0.4,
      max_references: 10,
      reference_recursive_depth: 0,
      reference_recursive_max_per_article: 0,
      reference_cull_min_score: 0,
      reference_cull_top_k: 0,
    },
  });

  // Only one score-budget slot: the strong prior (0.95) beats the weak RAG ref
  // (0.55). The pinned prior is free and always present.
  assert.deepEqual(refs.map((r) => r.slug).sort(), ["pinned-prior", "strong-prior"]);
  assert.equal(refs.find((r) => r.slug === "weak-rag"), undefined, "weak RAG ref loses to the higher-scoring prior");
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
        reference_cull_min_score: 0,
        reference_cull_top_k: 0,
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
  // The body seed has no vector score, so its recursive descendants fall to the
  // reference_min_score floor (0.4) — NOT the children's own stored relevance
  // (which would surface as an unrelated 1.000).
  assert.deepEqual(
    refs.map((ref) => ref.score),
    [undefined, 0.4, 0.4],
  );
  const built = logger.entries.find((entry) => entry.event === "references.built");
  assert.equal(built?.fields.recursive_candidates, 2, "recursive candidate count");
  assert.equal(built?.fields.recursive_max_per_article, 1, "recursive max per article config");
});

test("buildReferenceList recursive refs inherit the parent RAG score, not their own", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-recursive-score-"));
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
  saveRefArticle("rag-parent", "Rag Parent", 1);
  saveRefArticle("recursive-child", "Recursive Child", 2);
  // The child's OWN sidecar relevance is a perfect 1.0 — this must NOT leak
  // through onto the recursive entry's score.
  saveArticleReferences(db, "rag-parent", 1, [
    {
      slug: "recursive-child",
      title: "Recursive Child",
      content: "Child summary.",
      kind: "summary",
      pinned: false,
      revisionId: "initial",
      source: "rag",
      score: 1.0,
    },
  ]);

  const refs = buildReferenceList(db, {
    articleSlug: "current-entry",
    userAdditions: [],
    priorReferences: [],
    ragSources: [{ slug: "rag-parent", title: "Rag Parent", content: "", score: 0.62 }],
    revisionId: "current",
    config: {
      reference_max_results: 8,
      reference_min_score: 0.4,
      max_references: 10,
      reference_recursive_depth: 1,
      reference_recursive_max_per_article: 1,
      reference_cull_min_score: 0,
      reference_cull_top_k: 0,
    },
  });

  const child = refs.find((r) => r.slug === "recursive-child");
  assert.ok(child, "recursive child is included");
  assert.equal(child!.source, "recursive");
  // Impacted by the parent's RAG score (0.62), not the child's own 1.0.
  assert.equal(child!.score, 0.62, "recursive score inherits the parent, never the child's own 1.0");
});

test("buildReferenceList caps recursive admissions at reference_recursive_article_limit, keeping the highest-scoring", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-recursive-limit-"));
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

  const parents = [
    { slug: "parent-a", title: "Parent A", score: 0.9 },
    { slug: "parent-b", title: "Parent B", score: 0.7 },
    { slug: "parent-c", title: "Parent C", score: 0.5 },
    { slug: "parent-d", title: "Parent D", score: 0.3 },
  ];
  let gen = 1;
  for (const p of parents) {
    saveRefArticle(p.slug, p.title, gen++);
    const childSlug = `child-of-${p.slug}`;
    saveRefArticle(childSlug, `Child of ${p.title}`, gen++);
    saveArticleReferences(db, p.slug, gen++, [
      {
        slug: childSlug,
        title: `Child of ${p.title}`,
        content: `${p.title} child summary.`,
        kind: "summary",
        pinned: false,
        revisionId: "initial",
      },
    ]);
  }

  const refs = buildReferenceList(db, {
    articleSlug: "current-entry",
    userAdditions: [],
    priorReferences: [],
    ragSources: parents.map((p) => ({ slug: p.slug, title: p.title, content: "", score: p.score })),
    revisionId: "current",
    config: {
      reference_max_results: 10,
      reference_min_score: 0.1,
      max_references: 50,
      reference_recursive_depth: 1,
      reference_recursive_max_per_article: 1,
      reference_recursive_article_limit: 2,
      reference_cull_min_score: 0,
      reference_cull_top_k: 0,
    },
  });

  const recursiveSlugs = refs.filter((r) => r.source === "recursive").map((r) => r.slug).sort();
  // Only the two highest-scoring parents' children survive the recursive cap;
  // the parents themselves (rag source) are unaffected by the recursive cap.
  assert.deepEqual(recursiveSlugs, ["child-of-parent-a", "child-of-parent-b"]);
  assert.deepEqual(
    refs.filter((r) => r.source === "rag").map((r) => r.slug).sort(),
    ["parent-a", "parent-b", "parent-c", "parent-d"],
  );
});

test("buildReferenceList discovers backlinks (articles that link TO the seed), not just its own sidecar refs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-backlink-ref-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const db = openDatabase(join(root, TEST_CONFIG.database_path));

  const saveRefArticle = (
    slug: string,
    title: string,
    generatedAt: number,
    links: Array<{ targetSlug: string; visibleLabel: string; hiddenHint: string }> = [],
  ) => {
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
      links,
      [slug],
    );
  };

  saveRefArticle("root-ref", "Root Reference", 1);
  // "backlinker" has NO sidecar reference to root-ref, but its body links TO
  // root-ref — only discoverable via the backward direction.
  saveRefArticle("backlinker", "Backlinker", 2, [
    { targetSlug: "root-ref", visibleLabel: "Root Reference", hiddenHint: "" },
  ]);
  // A second, unrelated article that does NOT link to root-ref must not surface.
  saveRefArticle("unrelated", "Unrelated", 3);

  const refs = buildReferenceList(db, {
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
      reference_recursive_depth: 1,
      reference_recursive_max_per_article: 5,
      reference_cull_min_score: 0,
      reference_cull_top_k: 0,
    },
  });

  assert.deepEqual(refs.map((r) => r.slug).sort(), ["backlinker", "root-ref"]);
  const backlinkEntry = refs.find((r) => r.slug === "backlinker");
  assert.equal(backlinkEntry?.source, "backlink");
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

  const result = linkMentionedReferencesInBody(body, refs);
  // "source entry" bare mention gets linked
  assert.match(result, /\[source entry\]\(ref:source-entry\) is mentioned plainly/);
  // Code span content is protected
  assert.match(result, /`Source Entry`/);
  // "Already Linked" already inside a link — must not be double-wrapped
  assert.doesNotMatch(result, /\[\[Already Linked\]/);
  // The text "already linked" (free text, matches case-insensitively) gets linked per new behavior
  assert.match(result, /is \[already linked\]\(ref:already-linked\)/)
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

test("resolveRefLinks: both occurrences of same ref stay as anchor links", () => {
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
  // Both numeric refs resolve to slug and remain as anchor links.
  assert.equal(resolved, "See [the grove](ref:glow-fruit) here and [Glow Fruit](ref:glow-fruit) there.");
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
  // Renders as a normal wiki link — no special class, no footnote. The wiki URL
  // is built from the visible title (which round-trips to the slug), so its
  // casing is preserved verbatim rather than reconstructed from the slug.
  assert.match(html, /href="\/wiki\/Glow_Fruit"/);
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
  assert.match(html, /href="\/wiki\/Night_Bloom"/);
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
   resolveRefLinks: bolded occurrences both stay linked
   ───────────────────────────────────────────────────────────────── */

test("resolveRefLinks: both bolded occurrences of same ref stay as anchor links", () => {
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
  // Both occurrences must remain as ref anchor links.
  const refCount = (resolved.match(/ref:glow-fruit/g) ?? []).length;
  assert.equal(refCount, 2);
  assert.match(resolved, /Later, \[\*\*Glow Fruit\*\*\]\(ref:glow-fruit\) reappears/);
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
  assert.match(result, /halu:obama-apostrophe-s-method/);
});

// Halu slug normalization (wiki-format → kebab-case)

test("normalizeHaluLinks: wiki-format slug with underscores is slugified to kebab-case", () => {
  const input = `[The American Trade Bloc](halu:The_American_Trade_Bloc "hint")`;
  const result = normalizeHaluLinks(input);
  assert.match(result, /halu:the-american-trade-bloc/);
  assert.doesNotMatch(result, /The_American_Trade_Bloc/);
});

test("normalizeHaluLinks: mixed-case slug is lowercased and underscores become dashes", () => {
  const input = `[Foo Bar](halu:Foo_Bar "some hint")`;
  const result = normalizeHaluLinks(input);
  assert.match(result, /halu:foo-bar/);
});

test("normalizeMarkdownLinks: ref link with wiki-format slug is slugified", () => {
  const result = normalizeMarkdownLinks(`[Title](ref:The_American_Trade_Bloc)`, "article");
  assert.match(result.markdown, /ref:the-american-trade-bloc/);
  assert.doesNotMatch(result.markdown, /The_American_Trade_Bloc/);
});

test("normalizeMarkdownLinks: already-canonical ref slug is unchanged", () => {
  const result = normalizeMarkdownLinks(`[Title](ref:the-american-trade-bloc)`, "article");
  assert.match(result.markdown, /ref:the-american-trade-bloc/);
});

test("normalizeMarkdownLinks: ref link whose label is a ref-slug is rewritten to a human title", () => {
  // [ref:public-transport](ref:public-transport) — label is a raw ref marker, not a title.
  // slugToTitle / normalizeCanonicalTitle uppercases only the first letter of the string.
  const result = normalizeMarkdownLinks(`[ref:public-transport](ref:public-transport)`, "article");
  assert.equal(result.markdown, `[Public transport](ref:public-transport)`);
});

test("normalizeMarkdownLinks: ref link whose label is a plain slug is rewritten to a human title", () => {
  // [public-transport](ref:public-transport) — label is a raw slug, not a title.
  // slugToTitle / normalizeCanonicalTitle uppercases only the first letter of the string.
  const result = normalizeMarkdownLinks(`[public-transport](ref:public-transport)`, "article");
  assert.equal(result.markdown, `[Public transport](ref:public-transport)`);
});

// Slug metadata leakage stripping

test("stripFootnoteArtifacts: strips Slug: metadata line from article body", () => {
  const md = "# Article\n\nSlug: The_American_Trade_Bloc\n\nBody text.";
  const result = stripFootnoteArtifacts(md);
  assert.doesNotMatch(result, /Slug:/);
  assert.match(result, /Body text/);
});

test("stripFootnoteArtifacts: strips Title: and Category: metadata lines", () => {
  const md = "# Article\n\nTitle: Some Title\nCategory: Politics\n\nBody.";
  const result = stripFootnoteArtifacts(md);
  assert.doesNotMatch(result, /Title:/);
  assert.doesNotMatch(result, /Category:/);
  assert.match(result, /Body\./);
});

test("stripFootnoteArtifacts: does not strip Slug in normal prose sentences", () => {
  // "Slug" appearing inside a sentence should NOT be stripped
  const md = "The slug for this article is important.";
  const result = stripFootnoteArtifacts(md);
  assert.match(result, /slug for this article/);
});

test("stripFootnoteArtifacts: strips ---used-refs leak from body", () => {
  const md = "# Article\n\nBody text.\n\n---used-refs [\"ford-fistula\",\"ford-motors\"]\n\nMore text.";
  const result = stripFootnoteArtifacts(md);
  assert.doesNotMatch(result, /used-refs/);
  assert.match(result, /Body text/);
  assert.match(result, /More text/);
});

test("stripFootnoteArtifacts: strips bare used-refs (no dashes) from body", () => {
  const md = "# Article\n\nBody text.\n\nused-refs []\n\nMore text.";
  const result = stripFootnoteArtifacts(md);
  assert.doesNotMatch(result, /used-refs/);
  assert.match(result, /Body text/);
});

test("stripFootnoteArtifacts: strips ===used-refs from body", () => {
  const md = "# Article\n\nBody.\n\n===used-refs [\"slug-one\",\"slug-two\"]";
  const result = stripFootnoteArtifacts(md);
  assert.doesNotMatch(result, /used-refs/);
  assert.doesNotMatch(result, /slug-one/);
});

test("stripFootnoteArtifacts: strips prompt placeholder lines copied verbatim", () => {
  const md = "# Article\n\n(write the full Markdown article here — the # heading, body paragraphs, and inline links)\n\nReal body.";
  const result = stripFootnoteArtifacts(md);
  assert.doesNotMatch(result, /write the full/);
  assert.match(result, /Real body/);
});

test("stripFootnoteArtifacts: does not strip normal prose containing 'used'", () => {
  const md = "Energy storage is used widely in modern infrastructure.";
  const result = stripFootnoteArtifacts(md);
  assert.match(result, /used widely/);
});

// parseArticleFrameOutput / parsePartialArticleFrame

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
  const result = parseArticleFrameOutput(raw);
  assert.equal(result.body, "# Test Article\n\nBody text.");
});

test("parseArticleFrameOutput: no sections → treat whole raw as body", () => {
  const raw = "# Plain article\n\nNo section markers at all.";
  const result = parseArticleFrameOutput(raw);
  assert.equal(result.body, raw);
});

test("parseArticleFrameOutput: legacy used-refs sections are ignored", () => {
  const raw = [
    "---halu-body",
    "# Test Article",
    "",
    "Body content.",
    '-halu-used-refs ["slug-a","slug-b"]',
  ].join("\n");
  const result = parseArticleFrameOutput(raw);
  assert.doesNotMatch(result.body, /halu-used-refs/);
  assert.doesNotMatch(result.body, /slug-a/);
});

test("parseArticleFrameOutput: two-dash --halu-body is recognized", () => {
  const raw = ["--halu-body", "# Two Dash", "", "Content."].join("\n");
  const result = parseArticleFrameOutput(raw);
  assert.equal(result.body, "# Two Dash\n\nContent.");
});

test("parseArticleFrameOutput: single-dash -halu-used-refs with trailing JSON on same line", () => {
  // Reproduces the exact leakage pattern from production logs
  const raw = [
    "---halu-body",
    "# Ford Fistula",
    "",
    "Article body here.",
    '-halu-used-refs ["slug-a","slug-b","slug-c"]',
  ].join("\n");
  const result = parseArticleFrameOutput(raw);
  assert.doesNotMatch(result.body, /halu-used-refs/);
  assert.doesNotMatch(result.body, /slug-a/);
});

test("parseArticleFrameOutput: equals-sign prefix ===used-refs is recognized", () => {
  // Reproduces production log: ===halu-used-refs [...]
  const raw = [
    "---halu-body",
    "# Archive Notice",
    "",
    "Body text.",
    '===halu-used-refs ["slug-a","slug-b"]',
  ].join("\n");
  const result = parseArticleFrameOutput(raw);
  assert.doesNotMatch(result.body, /===halu-used-refs/);
});

test("parseArticleFrameOutput: underscore-prefix ___body is recognized", () => {
  const raw = ["___body", "# Underscore Body", "", "Content."].join("\n");
  const result = parseArticleFrameOutput(raw);
  assert.equal(result.body, "# Underscore Body\n\nContent.");
});

test("parseArticleFrameOutput: underscore-separated used-refs marker is ignored", () => {
  const raw = [
    "---halu-body",
    "# Test",
    "Body.",
    '---halu_used_refs ["slug-a"]',
  ].join("\n");
  const result = parseArticleFrameOutput(raw);
  assert.equal(result.body, "# Test\nBody.");
});

test("parseArticleFrameOutput: canonical body marker ignores used-refs", () => {
  const raw = [
    "---body",
    "# New Format Article",
    "",
    "Article content.",
    "---used-refs",
    '["slug-a","slug-b"]',
  ].join("\n");
  const result = parseArticleFrameOutput(raw);
  assert.equal(result.body, "# New Format Article\n\nArticle content.");
});

test("parseArticleFrameOutput: missing body section falls back to raw output", () => {
  const raw = ["---halu-meta", '{"title":"Test"}', "---halu-used-refs", '["slug-a"]'].join("\n");
  const result = parseArticleFrameOutput(raw);
  assert.match(result.body, /"title":"Test"/);
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
  const result = parseArticleFrameOutput(raw);
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
  const result = parseArticleFrameOutput(raw);
  assert.match(result.body, /# Test Article/);
  assert.match(result.body, /Body after inline meta/);
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
  const result = parseArticleFrameOutput(raw);
  assert.match(result.body, /# No Markers Article/);
  assert.match(result.body, /Content before any marker/);
});

test("parseArticleFrameOutput: section order may vary", () => {
  const raw = [
    "---halu-used-refs", '["slug-a"]',
    "---halu-meta", '{"title":"Test"}',
    "---halu-body", "# Test\n\nBody.",
  ].join("\n");
  const result = parseArticleFrameOutput(raw);
  assert.equal(result.body, "# Test\n\nBody.");
});

test("parseArticleFrameOutput: tolerant alias ---body is recognized", () => {
  const raw = ["---body", "# Alt Marker", "", "Body content."].join("\n");
  const result = parseArticleFrameOutput(raw);
  assert.equal(result.body, "# Alt Marker\n\nBody content.");
});

test("parseArticleFrameOutput: tolerant alias ## Body is recognized (case-insensitive)", () => {
  const raw = ["## body", "# Alt Marker", "", "Body content."].join("\n");
  const result = parseArticleFrameOutput(raw);
  assert.equal(result.body, "# Alt Marker\n\nBody content.");
});

test("parseArticleFrameOutput: tolerant used-refs heading stops body extraction", () => {
  const raw = ["---halu-body", "Body.", "## Used Refs", '["slug-b"]'].join("\n");
  const result = parseArticleFrameOutput(raw);
  assert.equal(result.body, "Body.");
});

test("parseArticleFrameOutput: body does not bleed into other sections", () => {
  const raw = [
    "---halu-body", "# Article", "", "Body text here.",
    "---halu-used-refs", '["slug-a"]',
    "---halu-meta", '{"title":"Article"}',
  ].join("\n");
  const result = parseArticleFrameOutput(raw);
  assert.doesNotMatch(result.body, /slug-a/);
  assert.doesNotMatch(result.body, /halu-used-refs/);
});

test("parseArticleFrameOutput: body prose containing braces is fine", () => {
  const raw = ["---halu-body", "Some {nested} text here."].join("\n");
  const result = parseArticleFrameOutput(raw);
  assert.equal(result.body, "Some {nested} text here.");
});

test("parseArticleFrameOutput: double-quoted halu hints in body are preserved as-is", () => {
  const raw = ['---halu-body', '# Title', '', 'A [Copper Link](halu:copper-link "quoted hint") stays valid.'].join("\n");
  const result = parseArticleFrameOutput(raw);
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

// ── Protection: DB functions ─────────────────────────────────────────────────

test("isArticleProtected returns false for new articles", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-protect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));
  const md = "# Sentinel\n\nBody.";
  saveArticle(db, { slug: "sentinel", canonicalSlug: "sentinel", title: "Sentinel", markdown: md, html: renderMarkdown(md), plain_text: md, generated_at: 1 }, [], ["sentinel"]);
  // import isArticleProtected lazily to avoid circular dep issues
  assert.equal(isArticleProtected(db, "sentinel"), false);
});

test("setArticleProtection / isArticleProtected round-trip", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-protect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));
  const md = "# Sentinel\n\nBody.";
  saveArticle(db, { slug: "sentinel", canonicalSlug: "sentinel", title: "Sentinel", markdown: md, html: renderMarkdown(md), plain_text: md, generated_at: 1 }, [], ["sentinel"]);
  assert.equal(isArticleProtected(db, "sentinel"), false);
  setArticleProtection(db, "sentinel", true);
  assert.equal(isArticleProtected(db, "sentinel"), true);
  setArticleProtection(db, "sentinel", false);
  assert.equal(isArticleProtected(db, "sentinel"), false);
});

test("listProtectedSections / setArticleSectionProtection round-trip", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-protect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));
  const md = "# Article\n\n## Section A\n\nContent A.\n\n## Section B\n\nContent B.";
  saveArticle(db, { slug: "article", canonicalSlug: "article", title: "Article", markdown: md, html: renderMarkdown(md), plain_text: md, generated_at: 1 }, [], ["article"]);
  assert.deepEqual(listProtectedSections(db, "article"), []);
  setArticleSectionProtection(db, "article", "section-a", "Section A", true);
  assert.equal(isArticleSectionProtected(db, "article", "section-a"), true);
  assert.equal(isArticleSectionProtected(db, "article", "section-b"), false);
  const sections = listProtectedSections(db, "article");
  assert.equal(sections.length, 1);
  assert.equal(sections[0].sectionId, "section-a");
  // Toggle off
  setArticleSectionProtection(db, "article", "section-a", "Section A", false);
  assert.equal(isArticleSectionProtected(db, "article", "section-a"), false);
});

// ── Protection: spliceProtectedSections ──────────────────────────────────────

test("spliceProtectedSections: no protected sections → returns new body unchanged", () => {
  const orig = "# Article\n\n## Intro\n\nOld intro.\n\n## Details\n\nOld details.";
  const newBody = "# Article\n\n## Intro\n\nNew intro.\n\n## Details\n\nNew details.";
  assert.equal(spliceProtectedSections(newBody, [], orig), newBody);
});

test("spliceProtectedSections: protected section keeps original content", () => {
  const orig = "# Article\n\n## Intro\n\nOriginal intro text.\n\n## Details\n\nOriginal details.";
  const newBody = "# Article\n\n## Intro\n\nLLM rewrote this.\n\n## Details\n\nLLM rewrote this too.";
  const result = spliceProtectedSections(newBody, ["intro"], orig);
  assert.match(result, /Original intro text/);
  assert.match(result, /LLM rewrote this too/);
  assert.doesNotMatch(result, /LLM rewrote this\./);
});

test("spliceProtectedSections: multiple protected sections all preserved", () => {
  const orig = "# Article\n\n## Alpha\n\nOriginal alpha.\n\n## Beta\n\nOriginal beta.\n\n## Gamma\n\nOriginal gamma.";
  const newBody = "# Article\n\n## Alpha\n\nNew alpha.\n\n## Beta\n\nNew beta.\n\n## Gamma\n\nNew gamma.";
  const result = spliceProtectedSections(newBody, ["alpha", "gamma"], orig);
  assert.match(result, /Original alpha/);
  assert.match(result, /New beta/);
  assert.match(result, /Original gamma/);
});

test("spliceProtectedSections: protected section missing from new body → section appended", () => {
  const orig = "# Article\n\n## Old Section\n\nImportant protected content.";
  const newBody = "# Article\n\n## New Section\n\nNew content.";
  const result = spliceProtectedSections(newBody, ["old-section"], orig);
  assert.match(result, /Important protected content/);
});

// ── listTopArticles ────────────────────────────────────────────────────────

test("listTopArticles returns written articles ranked by inbound halu-link count", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-top-articles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));

  const save = (slug: string, title: string, links: Array<{ targetSlug: string; visibleLabel: string; hiddenHint: string }>) => {
    const md = `# ${title}\n\nBody.`;
    saveArticle(db, { slug, canonicalSlug: slug, title, markdown: md, html: renderMarkdown(md), plain_text: markdownToPlainText(md), generated_at: Date.now(), summaryMarkdown: "" }, links, [slug], { operation: "generate" });
  };

  save("alpha", "Alpha", []);
  save("beta",  "Beta",  [{ targetSlug: "alpha", visibleLabel: "Alpha", hiddenHint: "hint" }]);
  save("gamma", "Gamma", [{ targetSlug: "alpha", visibleLabel: "Alpha", hiddenHint: "hint" }, { targetSlug: "beta", visibleLabel: "Beta", hiddenHint: "hint" }]);

  const top = listTopArticles(db, 10);

  // alpha is referenced by beta + gamma = 2; beta by gamma = 1
  assert.equal(top[0].slug, "alpha");
  assert.equal(top[0].title, "Alpha");
  assert.equal(top[0].inboundCount, 2);
  assert.equal(top[1].slug, "beta");
  assert.equal(top[1].inboundCount, 1);
});

test("listTopArticles excludes unwritten (halu-only) targets", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-top-unwritten-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));

  const md = "# Source\n\nBody.";
  // source links to "ghost" which is never written
  saveArticle(db, { slug: "source", canonicalSlug: "source", title: "Source", markdown: md, html: renderMarkdown(md), plain_text: markdownToPlainText(md), generated_at: Date.now(), summaryMarkdown: "" },
    [{ targetSlug: "ghost", visibleLabel: "Ghost", hiddenHint: "hint" }], ["source"], { operation: "generate" });

  const top = listTopArticles(db, 10);
  assert.equal(top.length, 0, "unwritten target must not appear");
});

test("listTopArticles respects the limit parameter", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-top-limit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));

  const save = (slug: string) => {
    const md = `# ${slug}\n\nBody.`;
    saveArticle(db, { slug, canonicalSlug: slug, title: slug, markdown: md, html: renderMarkdown(md), plain_text: markdownToPlainText(md), generated_at: Date.now(), summaryMarkdown: "" }, [], [slug], { operation: "generate" });
  };
  const targets = ["t1","t2","t3","t4","t5"];
  targets.forEach(save);

  // source links to all five targets
  const srcMd = "# Src\n\nBody.";
  saveArticle(db, { slug: "src", canonicalSlug: "src", title: "Src", markdown: srcMd, html: renderMarkdown(srcMd), plain_text: markdownToPlainText(srcMd), generated_at: Date.now(), summaryMarkdown: "" },
    targets.map(s => ({ targetSlug: s, visibleLabel: s, hiddenHint: "h" })), ["src"], { operation: "generate" });

  assert.equal(listTopArticles(db, 3).length, 3);
  assert.equal(listTopArticles(db, 10).length, 5);
});

// ── getHeadlineMediaForSlugs ───────────────────────────────────────────────

test("getHeadlineMediaForSlugs returns a slug -> {mediaId, caption} map for slugs with a headline image", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-headline-media-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));

  const save = (slug: string, title: string) => {
    const md = `# ${title}\n\nBody.`;
    saveArticle(db, { slug, canonicalSlug: slug, title, markdown: md, html: renderMarkdown(md), plain_text: markdownToPlainText(md), generated_at: Date.now(), summaryMarkdown: "" }, [], [slug], { operation: "generate" });
  };
  save("alpha", "Alpha");
  save("beta", "Beta");
  save("gamma", "Gamma");
  upsertArticleHeadlineMedia(db, "alpha", "img-alpha", "A glowing orchard at dusk.");
  upsertArticleHeadlineMedia(db, "gamma", "img-gamma", "");

  const media = getHeadlineMediaForSlugs(db, ["alpha", "beta", "gamma"]);
  assert.deepEqual(media.get("alpha"), { mediaId: "img-alpha", caption: "A glowing orchard at dusk." });
  assert.deepEqual(media.get("gamma"), { mediaId: "img-gamma", caption: "" });
  assert.equal(media.has("beta"), false, "beta has no headline image");
});

test("getHeadlineMediaForSlugs returns an empty map for an empty slug list", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-headline-media-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));

  const media = getHeadlineMediaForSlugs(db, []);
  assert.equal(media.size, 0);
});

// ── getGraphData ───────────────────────────────────────────────────────────

test("getGraphData returns nodes for all written articles and their halu targets", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-graph-data-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));

  const md = "# Written\n\nBody.";
  saveArticle(db, { slug: "written", canonicalSlug: "written", title: "Written", markdown: md, html: renderMarkdown(md), plain_text: markdownToPlainText(md), generated_at: Date.now(), summaryMarkdown: "" },
    [{ targetSlug: "unwritten", visibleLabel: "Unwritten", hiddenHint: "hint" }], ["written"], { operation: "generate" });

  const { nodes, links } = getGraphData(db);

  const slugs = nodes.map(n => n.slug);
  assert.ok(slugs.includes("written"), "written article must be a node");
  assert.ok(slugs.includes("unwritten"), "halu target must be a node");

  const written = nodes.find(n => n.slug === "written")!;
  const ghost   = nodes.find(n => n.slug === "unwritten")!;
  assert.equal(written.exists, true);
  assert.equal(ghost.exists, false);

  assert.equal(links.length, 1);
  assert.equal(links[0].source, "written");
  assert.equal(links[0].target, "unwritten");
});

test("getGraphData deduplicates links", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-graph-dedup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));

  const save = (slug: string, links: Array<{ targetSlug: string; visibleLabel: string; hiddenHint: string }>) => {
    const md = `# ${slug}\n\nBody.`;
    saveArticle(db, { slug, canonicalSlug: slug, title: slug, markdown: md, html: renderMarkdown(md), plain_text: markdownToPlainText(md), generated_at: Date.now(), summaryMarkdown: "" }, links, [slug], { operation: "generate" });
  };

  save("a", [{ targetSlug: "b", visibleLabel: "B", hiddenHint: "h" }]);
  save("b", [{ targetSlug: "a", visibleLabel: "A", hiddenHint: "h" }]);

  const { links } = getGraphData(db);
  // a→b and b→a are distinct directed edges; no duplicates
  assert.equal(links.length, 2);
  const pairs = links.map(l => `${l.source}→${l.target}`).sort();
  assert.deepEqual(pairs, ["a→b", "b→a"]);
});

test("replaceTomlTripleQuoted replaces existing block, preserving others", () => {
  const source = `model = "heavy"\nsystem = """\nold content\n"""\nuser = """\nold user\n"""\n`;
  const result = replaceTomlTripleQuoted(source, "system", "new content");
  const parsed = parseToml(result) as Record<string, string>;
  assert.equal(parsed.system.trimEnd(), "new content");
  assert.equal(parsed.user.trimEnd(), "old user", "user block should be untouched");
  assert.equal(parsed.model, "heavy", "scalars should be preserved");
});

test("replaceTomlTripleQuoted appends key when absent", () => {
  const source = `model = "heavy"\n`;
  const result = replaceTomlTripleQuoted(source, "system", "appended content");
  const parsed = parseToml(result) as Record<string, string>;
  assert.equal(parsed.system.trimEnd(), "appended content");
  assert.equal(parsed.model, "heavy");
});

// Prompts are plain text: backslashes, underscores, quotes and JSON must
// survive verbatim, and the output must always be valid TOML.
test("replaceTomlTripleQuoted round-trips text with escapes and quotes", () => {
  for (const value of [
    'Return JSON: {"presetKey":"one_allowed_key"}',
    "a back\\slash and a regex \\d+ and _under_scores_",
    'embedded """ triple quote run',
    "",
  ]) {
    const result = replaceTomlTripleQuoted(`system = """\nold\n"""\n`, "system", value);
    const parsed = parseToml(result) as Record<string, string>;
    assert.equal(parsed.system.trimEnd(), value.trimEnd(), `value: ${JSON.stringify(value)}`);
  }
});

// ── Prompt revisions ─────────────────────────────────────────────────────────

test("prompt revisions: save twice, list, reconstruct both prior states", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-prompt-rev-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));

  const v0System = "You are a helpful assistant.";
  const v0User = "Write a summary.";
  const v1System = "You are an expert editor.";
  const v1User = "Write a detailed summary.";
  const v2System = "You are an expert editor. Be concise.";
  const v2User = "Write a one-sentence summary.";

  // First save: v0 → v1
  const id1 = recordPromptRevision(db, "runnable", "article", v0System, v0User, v1System, v1User, "save");
  assert.ok(id1 !== null, "first save should produce a revision id");

  // Second save: v1 → v2
  const id2 = recordPromptRevision(db, "runnable", "article", v1System, v1User, v2System, v2User, "save");
  assert.ok(id2 !== null, "second save should produce a revision id");

  const revisions = listPromptRevisions(db, "runnable", "article");
  assert.equal(revisions.length, 2, "two revision rows");
  assert.equal(revisions[0].source, "save");
  assert.equal(revisions[1].source, "save");

  // Reconstruct: disk is v2; revision id2 → pre-id2 state = v1
  const atId2 = reconstructPromptRevision(db, "runnable", "article", id2!, v2System, v2User);
  assert.ok(atId2 !== null);
  assert.equal(atId2!.system, v1System, "reconstruct id2 should yield v1 system");
  assert.equal(atId2!.user, v1User, "reconstruct id2 should yield v1 user");

  // Reconstruct: revision id1 → pre-id1 state = v0
  const atId1 = reconstructPromptRevision(db, "runnable", "article", id1!, v2System, v2User);
  assert.ok(atId1 !== null);
  assert.equal(atId1!.system, v0System, "reconstruct id1 should yield v0 system");
  assert.equal(atId1!.user, v0User, "reconstruct id1 should yield v0 user");
});

test("prompt revisions: revert is recorded as its own revision and is itself undoable", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-prompt-revert-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));

  const v0System = "Original system.";
  const v0User = "Original user.";
  const v1System = "Edited system.";
  const v1User = "Edited user.";

  // Save v0 → v1
  const id1 = recordPromptRevision(db, "runnable", "article", v0System, v0User, v1System, v1User, "save");
  assert.ok(id1 !== null);

  // Revert: apply reverse patches to get v0, write to disk (simulate), then record revert row (v1 → v0)
  const reverted = reconstructPromptRevision(db, "runnable", "article", id1!, v1System, v1User);
  assert.ok(reverted !== null);
  assert.equal(reverted!.system, v0System);

  const id2 = recordPromptRevision(db, "runnable", "article", v1System, v1User, reverted!.system, reverted!.user, "revert", id1!);
  assert.ok(id2 !== null);

  const revisions = listPromptRevisions(db, "runnable", "article");
  assert.equal(revisions.length, 2, "two revision rows after revert");
  assert.equal(revisions[0].source, "revert", "newest row is the revert");
  assert.equal(revisions[0].sourceRevisionId, id1, "revert row references original revision");

  // The revert itself should be undoable: reconstruct id2 (pre-revert state = v1)
  const undoneRevert = reconstructPromptRevision(db, "runnable", "article", id2!, v0System, v0User);
  assert.ok(undoneRevert !== null);
  assert.equal(undoneRevert!.system, v1System, "undoing the revert yields v1 system");
  assert.equal(undoneRevert!.user, v1User, "undoing the revert yields v1 user");
});

test("prompt revisions: no-op save is skipped", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-prompt-noop-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));

  const id = recordPromptRevision(db, "runnable", "article", "same", "same", "same", "same", "save");
  assert.equal(id, null, "no-op save should return null and not insert a row");
  assert.equal(listPromptRevisions(db, "runnable", "article").length, 0);
});

// ─── Vision / image caption tests ────────────────────────────────────────────

/** Minimal 4×4 BMP: a yellow (#FFFF00) square on a white background. */
// A minimal 1×1 PNG (same fixture as tests/media.test.ts TINY_PNG — proven
// valid there). Vision models commonly reject BMP input ("invalid image
// input"); PNG is the format already known to work against the local model.
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeTinyPng(): Buffer {
  return Buffer.from(TINY_PNG_B64, "base64");
}

test("wrapLlmDeps proxy preserves supportsVision through the prompt-capture wrapper", () => {
  // Simulate what wrapLlmDeps does at runtime: verify that prototype methods
  // (like supportsVision) survive the Proxy used to intercept chat/streamChat.
  const embeddingsConfig = { enabled: false, base_url: "http://x/v1", api_key: "x", model: "x" };
  const chatCfg = { base_url: "http://x/v1", api_key: "x", model: "x", temperature: 1, max_tokens: 100 };
  const router = makeRouter(chatCfg, chatCfg, embeddingsConfig);

  // Manually apply the same Proxy logic used in wrapLlmDeps.
  const origLlm = router as unknown as Record<string, (...a: unknown[]) => unknown>;
  const wrapped = new Proxy(origLlm, {
    get(target, prop) {
      if (prop === "chat" || prop === "streamChat") {
        return (...args: unknown[]) => (target[prop as string] as (...a: unknown[]) => unknown)(...args);
      }
      const val = Reflect.get(target, prop, target);
      return typeof val === "function" ? val.bind(target) : val;
    },
  }) as unknown as typeof router;

  // supportsVision is a prototype method — must survive the proxy.
  assert.equal(typeof wrapped.supportsVision, "function", "supportsVision must be callable after wrapLlmDeps");
  assert.equal(wrapped.supportsVision("heavy"), false); // not probed, defaults to false
});

test("images model returns a non-empty text description for a tiny PNG", { timeout: 30_000 }, async (t) => {
  const liveConfig = TEST_CONFIG;
  const chatConfig = {
    base_url: liveConfig.llm_base_url,
    api_key: liveConfig.llm_api_key,
    model: liveConfig.llm_model,
    temperature: 1,
    max_tokens: 256,
    request_timeout_ms: 30_000,
  };
  const embeddingsConfig = {
    enabled: false,
    base_url: liveConfig.llm_base_url,
    api_key: liveConfig.llm_api_key,
    model: "none",
    request_timeout_ms: 5_000,
  };
  const router = makeRouter(
    chatConfig,
    chatConfig,
    embeddingsConfig,
  );
  try {
    await router.probeConnections();
  } catch {
    t.skip("LLM not reachable at test URL, skipping real vision generation test");
    return;
  }
  if (!router.supportsVision("light")) {
    t.skip("test LLM model does not report vision support, skipping real vision generation test");
    return;
  }

  const png = makeTinyPng();
  const result = await router.chat(
    "images",
    "Describe what you see in the image in one sentence.",
    "What is in this image?",
    { images: [{ b64: png.toString("base64"), mime: "image/png" }] },
  );

  assert.ok(typeof result === "string" && result.trim().length > 0, "model must return a non-empty description");
});

// ── perf plumbing: indexes, prepared-statement memoizer, media pagination ────

test("hot-path indexes exist after openDatabase", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-perf-idx-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));
  const indexes = (db.prepare(`PRAGMA index_list(articles)`).all() as Array<{ name: string }>).map((r) => r.name);
  assert.ok(indexes.includes("idx_articles_title_nocase"), `missing title index, have: ${indexes.join(", ")}`);
  // The All Pages query must be served by the index, not a scan+sort.
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN SELECT slug FROM articles WHERE is_disambiguation = 0 ORDER BY title COLLATE NOCASE ASC`)
    .all() as Array<{ detail: string }>;
  assert.ok(
    plan.some((row) => row.detail.includes("idx_articles_title_nocase")),
    `query plan does not use the index: ${JSON.stringify(plan)}`,
  );
});

test("prepared() memoizes statements per connection", (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-perf-stmt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(join(root, TEST_CONFIG.database_path));
  const a = prepared(db, `SELECT COUNT(*) AS c FROM articles`);
  const b = prepared(db, `SELECT COUNT(*) AS c FROM articles`);
  assert.equal(a, b, "same SQL on same connection must return the same statement");
  const other = openDatabase(join(root, "other.db"));
  const c = prepared(other, `SELECT COUNT(*) AS c FROM articles`);
  assert.notEqual(a, c, "different connections must not share statements");
});
