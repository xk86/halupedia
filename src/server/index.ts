import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { loadConfig } from "./config";
import { deleteArticleBySlug, getAdminOverview, getArticleByLookup, getArticleRevision, getCanonicalSlugForTarget, listArticleRevisions, listArticles, listBacklinks, listIncomingHints, openDatabase, saveArticle, searchCorpus, wipeGeneratedCorpus } from "./db";
import { OpenAICompatClient, type LlmClient } from "./llm";
import { createConsoleLogger, type Logger } from "./logger";
import { articleSectionMarkdown, extractInternalLinks, extractTitle, listArticleSections, markdownToPlainText, normalizeMarkdown, renderMarkdown, replaceArticleSection, sectionSlice, stripFootnoteArtifacts, stripTopLevelSections, summaryMarkdownFromArticle } from "./markdown";
import { getPrompt, renderTemplate } from "./prompts";
import { indexArticleChunks, retrieveContext } from "./retrieval";
import { normalizeCanonicalTitle, slugToTitle, slugify, titleToWikiSegment, wikiSegmentToTitle } from "./slug";
import { normalizeSummaryMarkdown, summaryLooksLikeLeadCopy } from "./summary";
import type { LinkSelectionSuggestion, LinkSuggestion, SeeAlsoCandidate } from "./types";

const RESERVED_PATHS = new Set(["", "search", "all-entries", "admin", "api", "assets"]);
const LARGE_SELECTION_CHAR_THRESHOLD = 120;
const LARGE_SELECTION_WORD_THRESHOLD = 18;

function routeSlug(pathname: string) {
  if (pathname.startsWith("/wiki/")) {
    return slugify(decodeURIComponent(pathname.slice("/wiki/".length)));
  }
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  if (!trimmed || RESERVED_PATHS.has(trimmed) || trimmed.includes("/")) return null;
  if (trimmed.includes(".")) return null;
  return slugify(decodeURIComponent(trimmed));
}

export interface CreateAppOptions {
  databasePath?: string;
  distRoot?: string;
  skipLlmProbe?: boolean;
  logger?: Logger;
  llmClient?: LlmClient;
}

function titleMatchesRequested(title: string, requestedTitle: string, requestedSlug: string): boolean {
  return (
    slugify(title) === requestedSlug &&
    titleToWikiSegment(normalizeCanonicalTitle(title)) === titleToWikiSegment(normalizeCanonicalTitle(requestedTitle))
  );
}

type SubjectValidation = { status: "valid" | "invalid" | "pending"; message?: string };

function validateLeadSubject(markdown: string, requestedTitle: string, requestedSlug: string): SubjectValidation {
  const body = stripTopLevelSections(markdown.replace(/^#\s+.+?$/m, "").trim(), ["References", "See also"]);
  const firstParagraph = body
    .split(/\n{2,}/)
    .map((part) => part.replace(/^#+\s+/gm, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!firstParagraph) return { status: "pending" };

  const subjectMatch = firstParagraph.match(
    /^(.{1,120}?)\s+(?:refers?\s+to|is|are|was|were|describes|denotes|constitutes|represents)\b/i
  );
  const subject = subjectMatch?.[1]?.replace(/^the\s+/i, "").trim();
  if (!subject) return { status: "pending" };
  if (slugify(subject) === requestedSlug || slugify(subject) === slugify(requestedTitle)) return { status: "valid" };

  const words = subject.split(/\s+/).filter(Boolean);
  const looksLikeAlternateSubject =
    words.length >= 2 &&
    words.length <= 8 &&
    !/^(?:it|this|that|these|those|there)\b/i.test(subject) &&
    !/[.!?;:()[\]{}]/.test(subject);
  if (!looksLikeAlternateSubject) return { status: "valid" };

  return {
    status: "invalid",
    message: `article lead subject did not match requested title: requested=${JSON.stringify(requestedTitle)} got=${JSON.stringify(subject)}`,
  };
}

function validateArticleSubject(markdown: string, requestedTitle: string, requestedSlug: string): SubjectValidation {
  const resolvedTitle = extractTitle(markdown, requestedTitle);
  if (!titleMatchesRequested(resolvedTitle, requestedTitle, requestedSlug)) {
    return {
      status: "invalid",
      message: `article heading did not match requested title: requested=${JSON.stringify(requestedTitle)} got=${JSON.stringify(resolvedTitle)}`,
    };
  }
  return validateLeadSubject(markdown, requestedTitle, requestedSlug);
}

function articleSubjectMatchesRequested(markdown: string, requestedTitle: string, requestedSlug: string): boolean {
  return validateArticleSubject(markdown, requestedTitle, requestedSlug).status !== "invalid";
}

function assertArticleSubjectStillPossible(markdown: string, requestedTitle: string, requestedSlug: string) {
  const validation = validateArticleSubject(markdown, requestedTitle, requestedSlug);
  if (validation.status === "invalid") {
    throw new Error(validation.message ?? "article subject did not match requested title");
  }
}

type InternalArticleCandidate = {
  slug: string;
  title: string;
  hiddenHint: string;
};

function normalizeArticleSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

function buildInternalLinkLine(candidate: InternalArticleCandidate): string {
  const hint = candidate.hiddenHint.replace(/"/g, "'");
  return `- [${candidate.title}](halu:${candidate.slug} "${hint}")`;
}

function dedupeArticleCandidates(candidates: InternalArticleCandidate[]): InternalArticleCandidate[] {
  const seen = new Set<string>();
  const deduped: InternalArticleCandidate[] = [];
  for (const candidate of candidates) {
    const key = slugify(candidate.slug);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      slug: key,
      title: candidate.title,
      hiddenHint: candidate.hiddenHint.trim() || candidate.title,
    });
  }
  return deduped;
}

function hasFootnoteArtifacts(markdown: string): boolean {
  return /\$\{\}\^\d+\$/.test(markdown) || /\[\^[^\]]+\]/.test(markdown);
}

function sectionContainsNonLinkedBullets(section: string): boolean {
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*+]\s+/.test(line))
    .some((line) => !line.includes("(halu:"));
}

function cachedArticleNeedsRepair(markdown: string): boolean {
  if (hasFootnoteArtifacts(markdown)) return true;
  const bodyMarkdown = stripTopLevelSections(markdown, ["References", "See also"]);
  const bodyLinkSlugs = new Set(extractInternalLinks(bodyMarkdown).map((link) => link.targetSlug));
  const referencesSection = sectionSlice(markdown, "References");
  const seeAlsoSection = sectionSlice(markdown, "See also");
  if (referencesSection && sectionContainsNonLinkedBullets(referencesSection)) return true;
  if (seeAlsoSection) {
    const seeAlsoLinks = extractInternalLinks(seeAlsoSection);
    if (seeAlsoLinks.some((link) => bodyLinkSlugs.has(link.targetSlug))) return true;
  }
  return false;
}

function rewriteArticleTitleHeading(markdown: string, title: string): string {
  const normalizedTitle = normalizeCanonicalTitle(title);
  if (!normalizedTitle) return markdown;
  if (/^#\s+.+$/m.test(markdown)) {
    return markdown.replace(/^#\s+.+$/m, `# ${normalizedTitle}`);
  }
  return `# ${normalizedTitle}\n\n${markdown.trim()}`.trim();
}

function sanitizeGeneratedBody(markdown: string): string {
  return stripFootnoteArtifacts(stripTopLevelSections(markdown, ["References", "See also"]));
}

function normalizeSelectionText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

function shouldRefineSelection(text: string): boolean {
  const normalized = normalizeSelectionText(text);
  return normalized.length > LARGE_SELECTION_CHAR_THRESHOLD || normalized.split(/\s+/).filter(Boolean).length > LARGE_SELECTION_WORD_THRESHOLD;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9]/.test(char);
}

function collectExistingLinkRanges(markdown: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const pattern = /\[([^\]]+)\]\(halu:([^) "\t\r\n]+)(?:\s+"([^"]*)")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function overlapsExistingLink(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function findWrapRange(markdown: string, selectedText: string): { start: number; end: number; visibleLabel: string } | null {
  const normalizedSelection = normalizeSelectionText(selectedText);
  if (!normalizedSelection) return null;
  const linkRanges = collectExistingLinkRanges(markdown);
  const exact = new RegExp(escapeRegExp(normalizedSelection), "gi");
  let match: RegExpExecArray | null;

  while ((match = exact.exec(markdown)) !== null) {
    let start = match.index;
    let end = match.index + match[0].length;
    if (overlapsExistingLink(start, linkRanges)) continue;
    while (isWordChar(markdown[start - 1])) start -= 1;
    while (isWordChar(markdown[end])) end += 1;
    const visibleLabel = markdown.slice(start, end).trim();
    if (visibleLabel) return { start, end, visibleLabel };
  }

  const words = normalizedSelection.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    for (let size = words.length - 1; size >= 1; size--) {
      for (let offset = 0; offset + size <= words.length; offset++) {
        const phrase = words.slice(offset, offset + size).join(" ");
        const found = findWrapRange(markdown, phrase);
        if (found) return found;
      }
    }
  }

  return null;
}

function extractSelectionExcerpt(markdown: string, selectedText: string): string {
  const normalizedSelection = normalizeSelectionText(selectedText);
  const source = markdownToPlainText(markdown);
  const index = source.toLowerCase().indexOf(normalizedSelection.toLowerCase());
  if (index < 0) return source.slice(0, 400);
  const start = Math.max(0, index - 180);
  const end = Math.min(source.length, index + normalizedSelection.length + 180);
  return source.slice(start, end).trim();
}

function assembleArticleMarkdown(
  bodyMarkdown: string,
  references: InternalArticleCandidate[],
  seeAlso: InternalArticleCandidate[]
): string {
  const sections = [bodyMarkdown.trim()];
  if (references.length) {
    sections.push(`## References\n\n${references.map(buildInternalLinkLine).join("\n")}`);
  }
  if (seeAlso.length) {
    sections.push(`## See also\n\n${seeAlso.map(buildInternalLinkLine).join("\n")}`);
  }
  return sections.filter(Boolean).join("\n\n").trim();
}

async function generateSeeAlsoCandidates(
  llm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  requestedTitle: string,
  bodyMarkdown: string,
  ragContext: string,
  linkHints: string[],
  relatedTitles: string[]
): Promise<InternalArticleCandidate[]> {
  const prompt = getPrompt(promptConfig, "see_also");
  const raw = await llm.chat(
    prompt.system,
    renderTemplate(prompt.user, {
      slug: slugify(requestedTitle),
      requested_title: requestedTitle,
      article_excerpt: bodyMarkdown.slice(0, 6000),
      rag_context: ragContext || "(none)",
      link_hints: linkHints.length ? linkHints.map((hint) => `- ${hint}`).join("\n") : "(none yet)",
      related_titles: relatedTitles.length ? relatedTitles.map((title) => `- ${title}`).join("\n") : "(none)",
      parent_comment: "",
    })
  );
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  const parsed = JSON.parse(match[0]) as { items?: SeeAlsoCandidate[] };
  return dedupeArticleCandidates(
    (parsed.items ?? []).map((item) => ({
      slug: slugify(item.title ?? ""),
      title: (item.title ?? "").replace(/\s+/g, " ").trim(),
      hiddenHint: (item.hint ?? "").replace(/\s+/g, " ").trim(),
    }))
  );
}

async function generateArticleSummary(
  llm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  requestedTitle: string,
  articleMarkdown: string
): Promise<string> {
  const prompt = getPrompt(promptConfig, "article_summary");
  const currentArticle = stripTopLevelSections(articleMarkdown, ["References", "See also"]).slice(0, 12000);
  let previousSummary = "(none)";
  let summaryFeedback = "(none)";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await llm.chat(
      prompt.system,
      renderTemplate(prompt.user, {
        slug: slugify(requestedTitle),
        requested_title: requestedTitle,
        current_article: currentArticle,
        previous_summary: previousSummary,
        summary_feedback: summaryFeedback,
        article_excerpt: currentArticle,
        rag_context: "",
        link_hints: "",
        related_titles: "",
        parent_comment: "",
        selected_text: "",
        edit_instructions: "",
        full_article: articleMarkdown.slice(0, 12000),
      })
    );
    const summary = normalizeSummaryMarkdown(raw);
    if (summary && !summaryLooksLikeLeadCopy(summary, articleMarkdown)) {
      return summary;
    }
    previousSummary = summary || raw.replace(/\s+/g, " ").trim().slice(0, 360) || "(empty)";
    summaryFeedback = "too_similar_to_lead";
  }

  return summaryMarkdownFromArticle(articleMarkdown);
}

function buildLinkedPromptSystem(promptConfig: ReturnType<typeof loadConfig>["prompts"], key: string): string {
  const guide = getPrompt(promptConfig, "linking_guide");
  const prompt = getPrompt(promptConfig, key);
  return `${guide.system.trim()}\n\n${prompt.system.trim()}`;
}

async function generateLinkSelection(
  llm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  requestedTitle: string,
  selectedText: string,
  articleExcerpt: string,
  ragContext: string,
  relatedTitles: string[]
): Promise<string> {
  const prompt = getPrompt(promptConfig, "link_selection");
  const raw = await llm.chat(
    buildLinkedPromptSystem(promptConfig, "link_selection"),
    renderTemplate(prompt.user, {
      slug: slugify(requestedTitle),
      requested_title: requestedTitle,
      selected_text: selectedText,
      article_excerpt: articleExcerpt,
      rag_context: ragContext || "(none)",
      related_titles: relatedTitles.length ? relatedTitles.map((title) => `- ${title}`).join("\n") : "(none)",
      link_hints: "",
      parent_comment: "",
    })
  );
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("link selection returned invalid JSON");
  }
  const parsed = JSON.parse(match[0]) as Partial<LinkSelectionSuggestion>;
  const refined = normalizeSelectionText(parsed.selected_text ?? "");
  if (!refined) {
    throw new Error("link selection returned empty text");
  }
  return refined;
}

async function generateLinkSuggestion(
  llm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  requestedTitle: string,
  selectedText: string,
  articleExcerpt: string,
  ragContext: string,
  relatedTitles: string[]
): Promise<LinkSuggestion> {
  const prompt = getPrompt(promptConfig, "link_suggestion");
  const raw = await llm.chat(
    buildLinkedPromptSystem(promptConfig, "link_suggestion"),
    renderTemplate(prompt.user, {
      slug: slugify(requestedTitle),
      requested_title: requestedTitle,
      selected_text: selectedText,
      article_excerpt: articleExcerpt,
      rag_context: ragContext || "(none)",
      related_titles: relatedTitles.length ? relatedTitles.map((title) => `- ${title}`).join("\n") : "(none)",
      link_hints: "",
      parent_comment: "",
    })
  );
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("link suggestion returned invalid JSON");
  }
  const parsed = JSON.parse(match[0]) as Partial<LinkSuggestion>;
  const title = (parsed.title ?? "").replace(/\s+/g, " ").trim();
  const hint = (parsed.hint ?? "").replace(/\s+/g, " ").trim();
  if (!title || !hint) {
    throw new Error("link suggestion returned empty fields");
  }
  return { title, hint };
}

export async function createApp(options: CreateAppOptions = {}) {
  const logger = options.logger ?? createConsoleLogger();
  let runtime = loadConfig();
  if (options.databasePath) {
    runtime = {
      ...runtime,
      app: {
        ...runtime.app,
        storage: {
          ...runtime.app.storage,
          database_path: options.databasePath,
        },
      },
    };
  }
  const db = openDatabase(runtime.app.storage.database_path);
  let llm: LlmClient = options.llmClient ?? new OpenAICompatClient(runtime.llm.chat, runtime.llm.embeddings, logger);
  const app = new Hono();
  const distRoot = options.distRoot ? resolve(options.distRoot) : resolve(process.cwd(), "dist");

  async function reloadRuntime() {
    const nextRuntime = loadConfig();
    runtime = options.databasePath
      ? {
          ...nextRuntime,
          app: {
            ...nextRuntime.app,
            storage: {
              ...nextRuntime.app.storage,
              database_path: options.databasePath,
            },
          },
        }
      : nextRuntime;
    if (!options.llmClient) {
      llm = new OpenAICompatClient(runtime.llm.chat, runtime.llm.embeddings, logger);
    }
    logger.info("startup", {
      server: `http://${runtime.app.server.host}:${runtime.app.server.port}`,
      database: runtime.app.storage.database_path,
      chat_base_url: runtime.llm.chat.base_url,
      chat_model: runtime.llm.chat.model,
      embeddings_enabled: runtime.llm.embeddings.enabled,
      embeddings_base_url: runtime.llm.embeddings.base_url,
      embeddings_model: runtime.llm.embeddings.model,
      rag_enabled: runtime.app.rag.enabled,
    });
    if (!options.skipLlmProbe) {
      await llm.probeConnections();
    }
  }

  await reloadRuntime();

  function canonicalPathForArticle(article: { canonicalSlug: string; title: string }) {
    return `/wiki/${titleToWikiSegment(normalizeCanonicalTitle(article.title || slugToTitle(article.canonicalSlug)))}`;
  }

  function repairStoredArticleTitle(article: {
    slug: string;
    canonicalSlug: string;
    title: string;
    markdown: string;
    html: string;
    summaryMarkdown?: string;
    plain_text: string;
    generated_at: number;
  }) {
    const normalizedTitle = normalizeCanonicalTitle(article.title || slugToTitle(article.canonicalSlug));
    const normalizedMarkdown = rewriteArticleTitleHeading(article.markdown, normalizedTitle);
    if (normalizedTitle === article.title && normalizedMarkdown === article.markdown) return article;

    const links = extractInternalLinks(normalizedMarkdown);
    const repairedArticle = {
      ...article,
      title: normalizedTitle,
      markdown: normalizedMarkdown,
      plain_text: markdownToPlainText(normalizedMarkdown),
      html: rewriteArticleHtml(renderMarkdown(normalizedMarkdown), links),
      generated_at: Date.now(),
    };
    saveArticle(
      db,
      repairedArticle,
      links,
      Array.from(new Set([repairedArticle.slug, repairedArticle.canonicalSlug])),
      { operation: "repair", instructions: "Normalize lowercase-first canonical title." }
    );
    return repairedArticle;
  }

  function rewriteArticleHtml(articleHtml: string, links: Array<{ targetSlug: string }>) {
    let html = articleHtml;
    for (const link of links) {
      const targetCanonical = getCanonicalSlugForTarget(db, link.targetSlug);
      const currentPath = `/wiki/${titleToWikiSegment(slugToTitle(link.targetSlug))}`;
      const preferredPath = `/wiki/${titleToWikiSegment(slugToTitle(targetCanonical))}`;
      html = html.replaceAll(`href="${currentPath}"`, `href="${preferredPath}"`);
    }
    return html;
  }

  async function finalizeArticle(
    slug: string,
    requestedTitle: string,
    bodyMarkdown: string,
    retrieved: Awaited<ReturnType<typeof retrieveContext>>,
    hints: string[],
    revision: {
      operation?: string;
      instructions?: string;
      revertedFromRevisionId?: number | null;
    } = {}
  ) {
    const normalizedTitle = normalizeCanonicalTitle(requestedTitle);
    const normalizedBodyMarkdown = rewriteArticleTitleHeading(bodyMarkdown, normalizedTitle);
    const deterministicReferences = dedupeArticleCandidates(
      retrieved.sourceArticles.map((article) => ({
        slug: article.slug,
        title: article.title,
        hiddenHint: normalizeArticleSnippet(article.content) || article.title,
      }))
    );

    const bodyLinkSlugs = new Set(extractInternalLinks(normalizedBodyMarkdown).map((link) => link.targetSlug));
    const seeAlso = (await generateSeeAlsoCandidates(
      llm,
      runtime.prompts,
      normalizedTitle,
      normalizedBodyMarkdown,
      retrieved.context,
      hints,
      retrieved.relatedTitles
    ).catch(() => []))
      .filter((candidate) => candidate.slug !== slug && !bodyLinkSlugs.has(candidate.slug))
      .slice(0, 7);
    const markdown = assembleArticleMarkdown(normalizedBodyMarkdown, deterministicReferences, seeAlso);
    const summaryMarkdown = await generateArticleSummary(llm, runtime.prompts, normalizedTitle, markdown)
      .catch(() => summaryMarkdownFromArticle(markdown));

    const normalizedSlug = slugify(slug);
    const article = {
      slug: normalizedSlug,
      canonicalSlug: normalizedSlug,
      title: normalizedTitle,
      markdown,
      html: "",
      summaryMarkdown,
      plain_text: markdownToPlainText(markdown),
      generated_at: Date.now(),
    };
    const links = extractInternalLinks(markdown);
    article.html = rewriteArticleHtml(renderMarkdown(markdown), links);
    saveArticle(db, article, links, Array.from(new Set([normalizedSlug, article.canonicalSlug])), revision);
    await indexArticleChunks(
      db,
      llm,
      normalizedSlug,
      markdown,
      runtime.app.rag.enabled && runtime.llm.embeddings.enabled,
      runtime.app.rag.chunk_size,
      logger
    );
    return { article, links };
  }

  async function buildArticle(slug: string, requestedTitle: string, onProgress?: (html: string, markdown: string) => void) {
    logger.info("page.generation_start", { slug, requested_title: requestedTitle });
    const hints = listIncomingHints(db, slug);
    const retrieved = await retrieveContext(
      db,
      llm,
      slug,
      hints,
      runtime.app.rag.enabled,
      runtime.app.rag.max_results,
      runtime.app.rag.min_score,
      runtime.llm.embeddings.enabled,
      logger
    );

    const prompt = getPrompt(runtime.prompts, "article");
    const renderedUserPrompt = renderTemplate(prompt.user, {
      slug,
      requested_title: requestedTitle,
      link_hints: hints.length ? hints.map((hint) => `- ${hint}`).join("\n") : "(none yet)",
      rag_context: retrieved.context || "(none)",
      related_titles: retrieved.relatedTitles.length ? retrieved.relatedTitles.map((title) => `- ${title}`).join("\n") : "(none)",
      article_excerpt: "",
      parent_comment: "",
    });

    let rawMarkdown = "";
    if (onProgress) {
      await llm.streamChat(prompt.system, renderedUserPrompt, (_delta, accumulated) => {
        rawMarkdown = accumulated;
        const progressMarkdown = sanitizeGeneratedBody(normalizeMarkdown(accumulated));
        assertArticleSubjectStillPossible(progressMarkdown, requestedTitle, slug);
        onProgress(renderMarkdown(progressMarkdown), progressMarkdown);
      });
    } else {
      rawMarkdown = await llm.chat(prompt.system, renderedUserPrompt);
    }

    let markdown = sanitizeGeneratedBody(normalizeMarkdown(rawMarkdown));
    const resolvedTitle = extractTitle(markdown, requestedTitle);
    const uniqueLinkCount = extractInternalLinks(markdown).length;
    const titleOk = articleSubjectMatchesRequested(markdown, requestedTitle, slug);
    logger.info("page.generation_attempt", {
      slug,
      title: resolvedTitle,
      title_ok: titleOk,
      body_unique_links: uniqueLinkCount,
      retrieved_sources: retrieved.sourceArticles.length,
    });
    if (!titleOk) {
      throw new Error(`generated article subject did not match requested slug: requested=${JSON.stringify(requestedTitle)} got=${JSON.stringify(resolvedTitle)}`);
    }
    const { article, links } = await finalizeArticle(slug, requestedTitle, markdown, retrieved, hints, { operation: "generate" });
    logger.info("page.generation_done", {
      slug,
      title: article.title,
      links: links.length,
    });
    return article;
  }

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      model: runtime.llm.chat.model,
      database_path: runtime.app.storage.database_path,
    })
  );

  app.get("/api/page/:slug", async (c) => {
    const requestedSegment = c.req.param("slug");
    const requestedTitle = normalizeCanonicalTitle(wikiSegmentToTitle(requestedSegment));
    const lookupSlug = slugify(requestedTitle);
    if (!lookupSlug || !requestedTitle) return c.json({ error: "invalid slug" }, 400);
    const requestedPath = `/wiki/${requestedSegment}`;
    logger.info("page.request", {
      slug: lookupSlug,
      requested_title: requestedTitle,
      path: requestedPath,
    });

    let article = getArticleByLookup(db, lookupSlug);
    if (article) {
      article = repairStoredArticleTitle(article);
      const cachedLinks = extractInternalLinks(article.markdown).length;
      if (!cachedArticleNeedsRepair(article.markdown)) {
        const canonicalPath = canonicalPathForArticle(article);
        logger.info("page.cache_hit", {
          slug: article.slug,
          links: cachedLinks,
          canonical_path: canonicalPath,
        });
        return c.json({
          cached: true,
          redirectedFrom: canonicalPath !== requestedPath ? requestedPath : undefined,
          canonicalPath,
          article,
          sections: listArticleSections(article.markdown),
          backlinks: listBacklinks(db, article.slug),
        });
      }
      logger.warn("page.cache_repair", {
        slug: article.slug,
        links: cachedLinks,
        reason: "semantic_validation_failed",
      });
      article = null;
    }
    if (!article) {
      logger.info("page.cache_miss", { slug: lookupSlug });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: unknown) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        };
        try {
          send({ type: "start", slug: lookupSlug, cached: false });
          article = await buildArticle(lookupSlug, requestedTitle, (html, markdown) => {
            send({ type: "progress", html, markdown });
          });
          const canonicalPath = canonicalPathForArticle(article);
          send({
            type: "done",
            cached: false,
            redirectedFrom: canonicalPath !== requestedPath ? requestedPath : undefined,
            canonicalPath,
            article,
            sections: listArticleSections(article.markdown),
            backlinks: listBacklinks(db, article.slug),
          });
          controller.close();
        } catch (error) {
          logger.error("page.generation_failed", {
            slug: lookupSlug,
            error: error instanceof Error ? error.message : String(error),
          });
          send({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });

  app.post("/api/article/:slug/add-link", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);

    const body = (await c.req.json().catch(() => ({}))) as { selectedText?: string };
    const selectedText = normalizeSelectionText(body.selectedText ?? "");
    if (!selectedText) return c.json({ error: "missing selected text" }, 400);

    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);

    const hints = listIncomingHints(db, article.slug);
    const retrieved = await retrieveContext(
      db,
      llm,
      article.slug,
      hints,
      runtime.app.rag.enabled,
      runtime.app.rag.max_results,
      runtime.app.rag.min_score,
      runtime.llm.embeddings.enabled,
      logger
    );
    const excerpt = extractSelectionExcerpt(article.markdown, selectedText);
    const selectedPhrase = shouldRefineSelection(selectedText)
      ? await generateLinkSelection(
          llm,
          runtime.prompts,
          article.title,
          selectedText,
          excerpt,
          retrieved.context,
          retrieved.relatedTitles
        ).catch(() => selectedText)
      : selectedText;
    const wrapRange = findWrapRange(article.markdown, selectedPhrase);
    if (!wrapRange) {
      return c.json({ error: "could not find selectable text to wrap in the article markdown" }, 422);
    }
    const suggestion = await generateLinkSuggestion(
      llm,
      runtime.prompts,
      article.title,
      wrapRange.visibleLabel,
      excerpt,
      retrieved.context,
      retrieved.relatedTitles
    );

    const targetSlug = slugify(suggestion.title);
    if (!targetSlug) return c.json({ error: "link suggestion produced an invalid target" }, 500);

    const wrapped = `[${wrapRange.visibleLabel}](halu:${targetSlug} "${suggestion.hint.replace(/"/g, "'")}")`;
    const nextMarkdown =
      article.markdown.slice(0, wrapRange.start) +
      wrapped +
      article.markdown.slice(wrapRange.end);

    const nextArticle = {
      ...article,
      markdown: nextMarkdown,
      html: "",
      summaryMarkdown: article.summaryMarkdown || summaryMarkdownFromArticle(nextMarkdown),
      plain_text: markdownToPlainText(nextMarkdown),
      generated_at: Date.now(),
    };
    const links = extractInternalLinks(nextMarkdown);
    nextArticle.html = rewriteArticleHtml(renderMarkdown(nextMarkdown), links);
    saveArticle(db, nextArticle, links, Array.from(new Set([nextArticle.slug, nextArticle.canonicalSlug])), {
      operation: "add-link",
      instructions: `Linked selected text: ${selectedText}`,
    });
    await indexArticleChunks(
      db,
      llm,
      nextArticle.slug,
      nextMarkdown,
      runtime.app.rag.enabled && runtime.llm.embeddings.enabled,
      runtime.app.rag.chunk_size,
      logger
    );

    return c.json({
      cached: true,
      canonicalPath: canonicalPathForArticle(nextArticle),
      article: nextArticle,
      sections: listArticleSections(nextArticle.markdown),
      backlinks: listBacklinks(db, nextArticle.slug),
    });
  });

  app.post("/api/article/:slug/rewrite", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);

    const body = (await c.req.json().catch(() => ({}))) as { instructions?: string; sectionId?: string };
    const instructions = (body.instructions ?? "").replace(/\s+/g, " ").trim().slice(0, 2500);
    if (!instructions) return c.json({ error: "missing rewrite instructions" }, 400);

    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);
    const sectionId = (body.sectionId ?? "").trim();
    const selectedSection = sectionId ? articleSectionMarkdown(article.markdown, sectionId) : article.markdown;

    const hints = listIncomingHints(db, article.slug);
    const retrieved = await retrieveContext(
      db,
      llm,
      article.slug,
      hints,
      runtime.app.rag.enabled,
      runtime.app.rag.max_results,
      runtime.app.rag.min_score,
      runtime.llm.embeddings.enabled,
      logger
    );

    const prompt = getPrompt(runtime.prompts, "article_rewrite");
    const renderedRewritePrompt = renderTemplate(prompt.user, {
      slug: article.slug,
      requested_title: article.title,
      edit_instructions: instructions,
      current_article: selectedSection,
      full_article: article.markdown,
      link_hints: hints.length ? hints.map((hint) => `- ${hint}`).join("\n") : "(none yet)",
      rag_context: retrieved.context || "(none)",
      related_titles: retrieved.relatedTitles.length ? retrieved.relatedTitles.map((title) => `- ${title}`).join("\n") : "(none)",
      article_excerpt: "",
      parent_comment: "",
      selected_text: "",
    });

    const wantsStream = c.req.query("stream") === "1" || (c.req.header("accept") ?? "").includes("application/x-ndjson");
    const persistRewrite = async (raw: string) => {
      const rewrittenBody = sanitizeGeneratedBody(normalizeMarkdown(raw));
      const nextMarkdown = sectionId
        ? replaceArticleSection(article.markdown, sectionId, rewrittenBody)
        : rewrittenBody;
      if (!articleSubjectMatchesRequested(nextMarkdown, article.title, article.slug)) {
        const validation = validateArticleSubject(nextMarkdown, article.title, article.slug);
        throw new Error(validation.message ?? "rewrite changed the article subject unexpectedly");
      }

      const { article: updatedArticle } = await finalizeArticle(article.slug, article.title, nextMarkdown, retrieved, hints, {
        operation: sectionId ? "section-rewrite" : "rewrite",
        instructions,
      });
      return {
        cached: true,
        canonicalPath: canonicalPathForArticle(updatedArticle),
        article: updatedArticle,
        sections: listArticleSections(updatedArticle.markdown),
        backlinks: listBacklinks(db, updatedArticle.slug),
      };
    };

    if (wantsStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (payload: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
          try {
            send({ type: "start", slug: article.slug, cached: false });
            let raw = "";
            await llm.streamChat(prompt.system, renderedRewritePrompt, (_delta, accumulated) => {
              raw = accumulated;
              const progressMarkdown = sanitizeGeneratedBody(normalizeMarkdown(accumulated));
              const mergedMarkdown = sectionId
                ? replaceArticleSection(article.markdown, sectionId, progressMarkdown)
                : progressMarkdown;
              assertArticleSubjectStillPossible(mergedMarkdown, article.title, article.slug);
              send({ type: "progress", html: renderMarkdown(mergedMarkdown), markdown: mergedMarkdown });
            });
            const payload = await persistRewrite(raw);
            send({ type: "done", ...payload });
            controller.close();
          } catch (error) {
            send({ type: "error", message: error instanceof Error ? error.message : String(error) });
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    const raw = await llm.chat(prompt.system, renderedRewritePrompt);

    try {
      return c.json(await persistRewrite(raw));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 422);
    }
  });

  app.post("/api/article/:slug/refresh-context", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);

    const hints = listIncomingHints(db, article.slug);
    const retrieved = await retrieveContext(
      db,
      llm,
      article.slug,
      hints,
      runtime.app.rag.enabled,
      runtime.app.rag.max_results,
      runtime.app.rag.min_score,
      runtime.llm.embeddings.enabled,
      logger
    );
    const currentBodyMarkdown = stripTopLevelSections(article.markdown, ["References", "See also"]);
    let bodyMarkdown = currentBodyMarkdown;
    let operation = "refresh-context";
    let instructions = "Refreshed retrieved context and derived references.";
    if (retrieved.context || hints.length) {
      const prompt = getPrompt(runtime.prompts, "article_refresh");
      const raw = await llm.chat(
        prompt.system,
        renderTemplate(prompt.user, {
          slug: article.slug,
          requested_title: article.title,
          current_article: currentBodyMarkdown,
          link_hints: hints.length ? hints.map((hint) => `- ${hint}`).join("\n") : "(none yet)",
          rag_context: retrieved.context || "(none)",
          related_titles: retrieved.relatedTitles.length ? retrieved.relatedTitles.map((title) => `- ${title}`).join("\n") : "(none)",
          article_excerpt: "",
          parent_comment: "",
          selected_text: "",
          edit_instructions: "",
        })
      );
      bodyMarkdown = sanitizeGeneratedBody(normalizeMarkdown(raw));
      if (!articleSubjectMatchesRequested(bodyMarkdown, article.title, article.slug)) {
        return c.json({ error: "refresh changed the article subject unexpectedly" }, 422);
      }
      operation = "refresh-context-rewrite";
      instructions = "Refreshed article body from retrieved context.";
    }
    const { article: updatedArticle } = await finalizeArticle(article.slug, article.title, bodyMarkdown, retrieved, hints, {
      operation,
      instructions,
    });
    const refreshChanged = updatedArticle.markdown !== article.markdown;
    logger.info("page.refresh_context", {
      slug: updatedArticle.slug,
      changed: refreshChanged,
      retrieved_sources: retrieved.sourceArticles.length,
    });
    return c.json({
      cached: true,
      canonicalPath: canonicalPathForArticle(updatedArticle),
      article: updatedArticle,
      sections: listArticleSections(updatedArticle.markdown),
      backlinks: listBacklinks(db, updatedArticle.slug),
      refreshChanged,
    });
  });

  app.get("/api/article/:slug/history", (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);
    return c.json({ revisions: listArticleRevisions(db, article.slug) });
  });

  app.post("/api/article/:slug/revert", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { revisionId?: number };
    const revisionId = Math.max(0, Number(body.revisionId) || 0);
    if (!revisionId) return c.json({ error: "missing revision id" }, 400);
    const current = getArticleByLookup(db, lookupSlug);
    if (!current) return c.json({ error: "article not found" }, 404);
    const revision = getArticleRevision(db, revisionId);
    if (!revision || revision.articleSlug !== current.slug) return c.json({ error: "revision not found" }, 404);

    const nextArticle = {
      ...current,
      title: revision.title,
      markdown: revision.markdown,
      html: revision.html,
      summaryMarkdown: revision.summaryMarkdown,
      plain_text: revision.plain_text,
      generated_at: Date.now(),
    };
    const links = extractInternalLinks(nextArticle.markdown);
    nextArticle.html = rewriteArticleHtml(renderMarkdown(nextArticle.markdown), links);
    saveArticle(db, nextArticle, links, Array.from(new Set([nextArticle.slug, nextArticle.canonicalSlug])), {
      operation: "revert",
      instructions: `Reverted to revision ${revision.id}.`,
      revertedFromRevisionId: revision.id,
    });
    await indexArticleChunks(
      db,
      llm,
      nextArticle.slug,
      nextArticle.markdown,
      runtime.app.rag.enabled && runtime.llm.embeddings.enabled,
      runtime.app.rag.chunk_size,
      logger
    );
    return c.json({
      cached: true,
      canonicalPath: canonicalPathForArticle(nextArticle),
      article: nextArticle,
      sections: listArticleSections(nextArticle.markdown),
      backlinks: listBacklinks(db, nextArticle.slug),
    });
  });

  app.get("/api/index", (c) => {
    const offset = Math.max(parseInt(c.req.query("cursor") ?? "0", 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "200", 10) || 200, 1), 500);
    const page = listArticles(db, offset, limit);
    return c.json({
      items: page.items,
      cursor: page.nextOffset === null ? null : String(page.nextOffset),
      complete: page.nextOffset === null,
      total: page.total,
    });
  });

  app.get("/api/admin/overview", (c) => {
    return c.json({
      ...getAdminOverview(db),
      model: runtime.llm.chat.model,
      databasePath: runtime.app.storage.database_path,
      promptConfigPath: "config/prompts.toml",
    });
  });

  app.post("/api/admin/reload", async (c) => {
    await reloadRuntime();
    return c.json({ ok: true });
  });

  app.post("/api/admin/wipe", (c) => {
    wipeGeneratedCorpus(db);
    logger.warn("admin.wipe_generated_corpus");
    return c.json({ ok: true });
  });

  app.post("/api/admin/delete-article", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { slug?: string };
    const slug = slugify(body.slug ?? "");
    if (!slug) return c.json({ error: "missing slug" }, 400);
    const deleted = deleteArticleBySlug(db, slug);
    return c.json({ ok: deleted, slug });
  });

  app.get("/api/search", (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    if (!q) {
      return c.json({
        query: "",
        results: [],
        existing_count: 0,
        hallucinated_count: 0,
        rate_limited: false,
        retry_after: null,
      });
    }

    const results = searchCorpus(db, q, runtime.app.search.limit).map((item) => ({
      slug: item.canonicalSlug,
      title: item.title === item.slug ? slugToTitle(item.slug) : item.title,
      exists: Boolean(item.existsFlag),
    }));

    return c.json({
      query: q,
      results,
      existing_count: results.filter((item) => item.exists).length,
      hallucinated_count: results.filter((item) => !item.exists).length,
      rate_limited: false,
      retry_after: null,
    });
  });

  // Comments are intentionally disabled from the active application path for now.
  // Keep the implementation on disk, but do not mount the routes until the feature returns.
  app.use("/assets/*", serveStatic({ root: distRoot }));

  app.get("*", async (c) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/api/")) return c.notFound();

    const bareSlug = routeSlug(path);
    if (bareSlug && !path.startsWith("/wiki/")) {
      logger.info("page.redirect", {
        bare_slug: bareSlug,
        from: path,
        to: `/wiki/${bareSlug}`,
      });
      return c.redirect(`/wiki/${bareSlug}`, 302);
    }

    if (path === "/" || path === "/search" || path === "/all-entries" || path === "/admin" || routeSlug(path)) {
      return c.html(await readFile(resolve(distRoot, "index.html"), "utf8"));
    }

    const filePath = resolve(distRoot, path.slice(1));
    const ext = extname(filePath);
    if (!ext) return c.notFound();

    try {
      const file = await readFile(filePath);
      return new Response(file, {
        headers: {
          "content-type":
            ext === ".js"
              ? "application/javascript; charset=utf-8"
              : ext === ".css"
              ? "text/css; charset=utf-8"
              : "application/octet-stream",
        },
      });
    } catch {
      return c.notFound();
    }
  });

  return { app, runtime };
}

async function bootstrap() {
  const { app, runtime } = await createApp();
  const logger = createConsoleLogger();
  serve(
    {
      fetch: app.fetch,
      hostname: runtime.app.server.host,
      port: runtime.app.server.port,
    },
    (info) => {
      logger.info("server.listening", {
        address: String(info.address),
        port: info.port,
      });
    }
  );
}

const isEntrypoint = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isEntrypoint) {
  bootstrap().catch((error) => {
    createConsoleLogger().error("server.startup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
