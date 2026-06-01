// TODO: split api and shit out because jesus christ this file is way too long
// TODO: make sure that formatting text isn't being added into link replacement/strips.
import { jsonrepair } from "jsonrepair";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { readFile, stat as fsStat } from "node:fs/promises";
import { extname, resolve, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { loadConfig } from "./config";
import { listPromptFiles, readPromptFile, writePromptFile } from "./promptEditor";
import {
  deleteArticleBySlug,
  listImageBacklinks,
  getAdminOverview,
  getArticleByLookup,
  getArticleByTitle,
  getArticleByEquivalentLookup,
  getArticleRevision,
  getCanonicalSlugForTarget,
  getHomepageCache,
  listArticleRevisions,
  listArticles,
  listBacklinks,
  listHomepageHistory,
  type IncomingHint,
  listIncomingHints,
  openDatabase,
  renameArticleSlug,
  saveArticle,
  saveArticleReferences,
  saveArticleSeeAlso,
  getLatestArticleReferences,
  type ArticleReference,
  getRandomSuggestions,
  searchCorpus,
  updateArticleSummary,
  updateArticleInPlace,
  wipeGeneratedCorpus,
  searchSlugFuzzy,
  addSlugAlias,
  removeSlugAlias,
  listAliasesForSlug,
  archiveArticle,
  listArchivedArticles,
  getArchivedArticle,
  deleteArchivedArticle,
  listTopArticles,
  getGraphData,
  isArticleProtected,
  setArticleProtection,
  listProtectedSections,
  isArticleSectionProtected,
  setArticleSectionProtection,
  updateArticleTitle,
  recordPromptRevision,
  listPromptRevisions,
  reconstructPromptRevision,
  getPromptCurrent,
  setPromptCurrent,
  listAllPromptCurrents,
  getArticleHeadlineMedia,
  getArticleInfobox,
  setArticleInfobox,
  listSidebarRevisions,
  getSidebarRevision,
  upsertArticleHeadlineMedia,
  updateArticleMediaCaption,
  removeArticleMedia,
  type InfoboxData,
  type SidebarOperation,
} from "./db";
import { openMediaDatabase, getMediaById, getMediaBytesById, updateMediaDescription, updateMediaId, listMedia, listMediaRevisions } from "./mediaDb";
import { ingestImageFromUrl, ingestImageFromBuffer } from "./media";
import { captionImageWorkflow } from "./pipeline/workflows/captionImage";
import { renderInfoboxHtml } from "./articleRender";
import {
  findFuzzyTitleMatchesInEditText,
  findReferencedArticlesInEditText,
} from "./editReferences";
import { OpenAICompatRouter, type LlmRouter } from "./llm";
import { createConsoleLogger, type Logger } from "./logger";
import { formatIncomingHintsForPrompt } from "./linkHints";
import { MaintenanceScheduler } from "./maintenance";
import {
  articleSectionMarkdown,
  buildHaluLink,
  extractDisplayTitle,
  extractInternalLinks,
  extractTitle,
  fixSlugVisibleText,
  LINK_RE,
  listArticleSections,
  markdownToPlainText,
  normalizeMarkdown,
  renderMarkdown,
  renderInlineMarkdown,
  replaceArticleSection,
  sectionSlice,
  spliceProtectedSections,
  stripFootnoteArtifacts,
  stripSelfLinks,
  stripTopLevelSections,
  summaryMarkdownFromArticle,
} from "./markdown";
import { getPrompt, getSharedPrompt, renderTemplate, stripJsonFences } from "./prompts";
import {
  indexArticleChunks,
  flattenInfoboxForRag,
  mergeRetrievedContextPackets,
  retrieveContext,
  retrieveDirectArticleContext,
} from "./retrieval";
import {
  isSlugStyleWikiSegment,
  normalizeCanonicalTitle,
  slugToTitle,
  slugify,
  titleToWikiSegment,
  wikiSegmentToRequestedTitle,
  wikiSegmentToTitle,
} from "./slug";
import { normalizeSummaryMarkdown, summaryLooksLikeLeadCopy } from "./summary";
import { normalizeMarkdownLinks } from "./text/linkNormalize";
import type {
  ArticleRecord,
  HomepagePayload,
  LinkSuggestion,
  SeeAlsoCandidate,
} from "./types";
import {
  extractRefLinksAsInternalLinks,
  findExistingArticleLinkReferences,
  linkReferencesInline,
  loadPriorReferenceList,
} from "./referenceList";
import {
  loadArticle,
  articleToResponse,
  type ArticleResponse,
  type ReferenceStatus,
  type ReferenceStatusEntry,
} from "./article";
import {
  assembleArticleMarkdownForRender,
  renderArticleDisplayHtml,
  getCachedArticleHtml,
  rememberArticleHtml,
  invalidateArticleHtml,
} from "./articleRender";
import {
  normalizeSelectionText,
  findSelectionRangeInMarkdown,
  shouldRefineSelection,
  escapeRegExp,
  collectExistingLinkRanges,
  overlapsExistingLink,
  findWrapRange,
  extractSelectionExcerpt,
} from "./selectionUtils";
export { findSelectionRangeInMarkdown } from "./selectionUtils";
import { ensureDykHasSourceLink } from "./dyk";
export { ensureDykHasSourceLink } from "./dyk";
import {
  parseArticleFrameOutput,
  parsePartialArticleFrame,
} from "./articleFrame";
export { parseArticleFrameOutput, parsePartialArticleFrame } from "./articleFrame";
import { registerPipelineAdminRoutes } from "./pipeline/adminRoutes";
import { buildPromptRegistry } from "./pipeline/prompts/registry";
import { runWorkflow } from "./pipeline/runtime/graph";
import { getTraceRecorder } from "./pipeline/runtime/trace";
import { generateArticleWorkflow } from "./pipeline/workflows/generateArticle";
import { refreshArticleWorkflow } from "./pipeline/workflows/refreshArticle";
import { rewriteArticleWorkflow } from "./pipeline/workflows/rewriteArticle";
import { postProcessWorkflow } from "./pipeline/workflows/postProcess";
import {
  addLinkArticleWorkflow,
  rawSaveArticleWorkflow,
} from "./pipeline/workflows/deterministicArticleSave";
import { homepageRefreshWorkflow } from "./pipeline/workflows/homepageRefresh";
import { regenerateSummaryWorkflow } from "./pipeline/workflows/utilities";
import type { PipelineDeps } from "./pipeline/deps";
import { randomUUID } from "node:crypto";

const RESERVED_PATHS = new Set([
  "",
  "search",
  "all-entries",
  "admin",
  "random",
  "Random",
  "graph",
  "api",
  "assets",
]);
const HOMEPAGE_MAINTENANCE_TASK = "homepage.refresh";
const DB_BACKUP_TASK = "db.backup";
const DB_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DB_BACKUP_KEEP = 7; // keep last 7 compressed backups
const HOMEPAGE_PENDING_RETRY_MS = 1_000;
const HOMEPAGE_REFRESH_GRACE_MS = 250;

function routeSlug(pathname: string) {
  if (pathname.startsWith("/wiki/")) {
    return slugify(decodeURIComponent(pathname.slice("/wiki/".length)));
  }
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  if (!trimmed || RESERVED_PATHS.has(trimmed) || trimmed.includes("/"))
    return null;
  if (trimmed.includes(".")) return null;
  return slugify(decodeURIComponent(trimmed));
}

function articleLookupSlugFromInput(input: string): string {
  let raw = input.trim();
  const wikiIndex = raw.toLowerCase().indexOf("wiki/");
  if (wikiIndex >= 0) raw = raw.slice(wikiIndex + "wiki/".length);
  raw = raw.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "");
  if (!raw) return "";
  return slugify(wikiSegmentToTitle(decodeURIComponent(raw)));
}

export interface CreateAppOptions {
  databasePath?: string;
  mediaDatabasePath?: string;
  distRoot?: string;
  skipLlmProbe?: boolean;
  skipHomepagePrepare?: boolean;
  logger?: Logger;
  llmClient?: LlmRouter;
}


function titleMatchesRequested(
  title: string,
  _requestedTitle: string,
  requestedSlug: string,
): boolean {
  return slugify(title) === requestedSlug;
}

type SubjectValidation = {
  status: "valid" | "invalid" | "pending";
  message?: string;
};

function validateLeadSubject(
  markdown: string,
  requestedTitle: string,
  requestedSlug: string,
): SubjectValidation {
  const body = stripTopLevelSections(
    markdown.replace(/^#\s+.+?$/m, "").trim(),
    ["References", "See also"],
  );
  const firstParagraph = body
    .split(/\n{2,}/)
    .map((part) =>
      part
        .replace(/^#+\s+/gm, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find(Boolean);
  if (!firstParagraph) return { status: "pending" };

  const subjectMatch = firstParagraph.match(
    /^(.{1,120}?)\s+(?:refers?\s+to|is|are|was|were|describes|denotes|constitutes|represents)\b/i,
  );
  const subject = subjectMatch?.[1]?.replace(/^the\s+/i, "").trim();
  if (!subject) return { status: "pending" };
  if (
    slugify(subject) === requestedSlug ||
    slugify(subject) === slugify(requestedTitle)
  )
    return { status: "valid" };

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

function validateArticleSubject(
  markdown: string,
  requestedTitle: string,
  requestedSlug: string,
): SubjectValidation {
  const resolvedTitle = extractTitle(markdown, requestedTitle);
  if (!titleMatchesRequested(resolvedTitle, requestedTitle, requestedSlug)) {
    return {
      status: "invalid",
      message: `article heading did not match requested title: requested=${JSON.stringify(requestedTitle)} got=${JSON.stringify(resolvedTitle)}`,
    };
  }
  return validateLeadSubject(markdown, requestedTitle, requestedSlug);
}

function articleSubjectMatchesRequested(
  markdown: string,
  requestedTitle: string,
  requestedSlug: string,
): boolean {
  return (
    validateArticleSubject(markdown, requestedTitle, requestedSlug).status !==
    "invalid"
  );
}

type InternalArticleCandidate = {
  slug: string;
  title: string;
  hiddenHint: string;
};

function normalizeArticleSnippet(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 400) return normalized;
  return normalized.slice(0, 400).trim();
}

function dedupeRetrievedSourceArticles(
  articles: Array<{ slug: string; title: string; content: string }>,
) {
  const seen = new Set<string>();
  const unique: Array<{ slug: string; title: string; content: string }> = [];
  for (const article of articles) {
    const slug = slugify(article.slug);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    unique.push({ slug, title: article.title, content: article.content });
  }
  return unique;
}

export function summarizeRetrievedSource(article: {
  slug: string;
  title: string;
  content: string;
}): string {
  return normalizeArticleSnippet(article.content);
}

function hintsToSearchStrings(hints: IncomingHint[]): string[] {
  return hints.map((h) => h.hiddenHint);
}

function dedupeArticleCandidates(
  candidates: InternalArticleCandidate[],
): InternalArticleCandidate[] {
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
  const normalized = normalizeMarkdownLinks(markdown, "article");
  if (normalized.changed) return true;
  if (hasFootnoteArtifacts(markdown)) return true;
  const bodyMarkdown = stripTopLevelSections(markdown, [
    "References",
    "See also",
  ]);
  const bodyLinkSlugs = new Set(
    extractInternalLinks(bodyMarkdown).map((link) => link.targetSlug),
  );
  const referencesSection = sectionSlice(markdown, "References");
  const seeAlsoSection = sectionSlice(markdown, "See also");
  if (referencesSection && sectionContainsNonLinkedBullets(referencesSection))
    return true;
  if (seeAlsoSection) {
    const seeAlsoLinks = extractInternalLinks(seeAlsoSection);
    if (seeAlsoLinks.some((link) => bodyLinkSlugs.has(link.targetSlug)))
      return true;
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

/** Heading aliases the model uses for the used-refs section — strip them all. */
const USED_REFS_HEADING_ALIASES = [
  "References",
  "See also",
  "Used References",
  "Used Refs",
  "References Used",
  "Refs Used",
  "Reference List",
  "Sources",
  "Bibliography",
];

function sanitizeGeneratedBody(markdown: string): string {
  return fixSlugVisibleText(
    stripFootnoteArtifacts(
      stripTopLevelSections(markdown, USED_REFS_HEADING_ALIASES),
    ),
  );
}

function shouldPromoteResolvedTitle(
  requestedSlug: string,
  resolvedTitle: string,
): boolean {
  const resolvedSlug = slugify(resolvedTitle);
  if (!resolvedSlug || resolvedSlug === requestedSlug) return false;
  return (
    resolvedSlug.startsWith(`${requestedSlug}-`) &&
    /[^\x00-\x7F]/.test(resolvedSlug)
  );
}

function deriveArticleIdentity(
  bodyMarkdown: string,
  requestedTitle: string,
  requestedSlug: string,
) {
  const requestedCanonicalTitle = normalizeCanonicalTitle(requestedTitle);
  const rawDisplayTitle = extractDisplayTitle(bodyMarkdown);
  const resolvedTitle = normalizeCanonicalTitle(
    extractTitle(bodyMarkdown, requestedTitle),
  );
  const canonicalTitle = shouldPromoteResolvedTitle(
    requestedSlug,
    resolvedTitle,
  )
    ? resolvedTitle
    : requestedCanonicalTitle;
  const canonicalSlug = slugify(canonicalTitle) || requestedSlug;
  const rawDisplayPlainTitle = rawDisplayTitle
    ? normalizeCanonicalTitle(extractTitle(`# ${rawDisplayTitle}`, requestedTitle))
    : "";
  const displayTitle =
    rawDisplayTitle && rawDisplayPlainTitle === requestedCanonicalTitle
      ? rawDisplayTitle
      : undefined;
  return { canonicalTitle, canonicalSlug, displayTitle };
}


function replaceTopLevelTomlValue(
  source: string,
  key: "model" | "thinking",
  value: string,
): string {
  const line = `${key} = ${value}`;
  const pattern = new RegExp(`^${key}\\s*=.*$`, "m");
  if (pattern.test(source)) {
    return source.replace(pattern, line);
  }
  return `${line}\n${source}`;
}

function updateRunnablePromptConfig(
  promptKey: string,
  model: "heavy" | "light",
  thinking: boolean,
) {
  if (!/^[a-z0-9_]+$/i.test(promptKey)) {
    throw new Error("invalid prompt key");
  }
  const promptPath = resolve(process.cwd(), "config", "prompts", `${promptKey}.toml`);
  if (!existsSync(promptPath)) {
    throw new Error(`unknown prompt config: ${promptKey}`);
  }
  let next = readFileSync(promptPath, "utf8");
  next = replaceTopLevelTomlValue(next, "model", `"${model}"`);
  next = replaceTopLevelTomlValue(next, "thinking", thinking ? "true" : "false");
  writeFileSync(promptPath, next);
}

function formatRecentEditHistoryForPrompt(
  revisions: ReturnType<typeof listArticleRevisions>,
): string {
  const editableOperations = new Set([
    "rewrite",
    "section-rewrite",
    "selection-edit",
  ]);
  const recent = revisions
    .filter((revision) =>
      editableOperations.has(revision.operation) &&
      revision.instructions.trim().length > 0
    )
    .slice(0, 2)
    .reverse();
  return recent
    .map((revision, index) => {
      const timestamp = Number.isFinite(revision.createdAt)
        ? new Date(revision.createdAt).toISOString()
        : String(revision.createdAt);
      const instructions = revision.instructions.replace(/\s+/g, " ").trim();
      return `${index + 1}. ${timestamp} (${revision.operation}): ${instructions}`;
    })
    .join("\n");
}

async function generateArticleSummary(
  llm: LlmRouter,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  requestedTitle: string,
  articleMarkdown: string,
): Promise<string> {
  const prompt = getPrompt(promptConfig, "article_summary");
  const role = prompt.model ?? "heavy";
  const currentArticle = stripTopLevelSections(articleMarkdown, [
    "References",
    "See also",
  ]).slice(0, 12000);
  let previousSummary = "(none)";
  let summaryFeedback = "(none)";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await llm.chat(
      role,
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
        full_article: currentArticle,
      }),
      { thinking: prompt.thinking, jsonMode: prompt.json },
    );
    const summary = normalizeSummaryMarkdown(raw);
    if (summary && !summaryLooksLikeLeadCopy(summary, articleMarkdown)) {
      return summary;
    }
    previousSummary =
      summary || raw.replace(/\s+/g, " ").trim().slice(0, 360) || "(empty)";
    summaryFeedback = "too_similar_to_lead";
  }

  return summaryMarkdownFromArticle(articleMarkdown);
}


function normalizeRandomPageChoice(raw: string): { title: string; slug: string } {
  const cleaned = stripJsonFences(raw).trim();
  let title = "";
  let slug = "";
  try {
    const json = JSON.parse(cleaned) as { title?: unknown; slug?: unknown };
    title = normalizeCanonicalTitle(String(json.title ?? ""));
    slug = slugify(String(json.slug ?? ""));
  } catch {
    const wikiMatch = cleaned.match(/(?:^|[/\s"'])wiki\/([^\n"'<>#?]+)/i);
    const candidate = (wikiMatch?.[1] ?? cleaned.split(/\n/)[0] ?? "")
      .replace(/^["'`/]+|["'`/]+$/g, "")
      .replace(/[?#].*$/, "")
      .trim();
    title = normalizeCanonicalTitle(wikiSegmentToRequestedTitle(candidate));
    slug = slugify(title);
  }
  if (title && slug && slugify(title) === slug && isSlugStyleWikiSegment(title)) {
    title = wikiSegmentToRequestedTitle(title);
  }
  if (!title && slug) title = normalizeCanonicalTitle(slugToTitle(slug));
  if (!slug && title) slug = slugify(title);
  if (!title || !slug) throw new Error("random page prompt returned an empty title or slug");
  return { title, slug };
}

function sampleRandomInspirationArticles(
  db: ReturnType<typeof openDatabase>,
  count: number,
): Array<{ title: string; slug: string }> {
  const articles = db
    .prepare(
      `SELECT title, slug FROM articles
       WHERE is_disambiguation = 0
       ORDER BY RANDOM() LIMIT ?`,
    )
    .all(Math.max(0, count)) as Array<{ title: string; slug: string }>;

  return articles;
}

async function generateRandomPageChoice(
  llm: LlmRouter,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  inspiration: Array<{ title: string; slug: string }> = [],
): Promise<{ title: string; slug: string }> {
  const prompt = getPrompt(promptConfig, "random_page");
  const role = prompt.model ?? "heavy";
  const raw = await llm.chat(
    role,
    prompt.system,
    renderTemplate(prompt.user, {
      slug: "",
      requested_title: "",
      current_article: "",
      previous_summary: "",
      summary_feedback: "",
      article_excerpt: "",
      rag_context: "",
      link_hints: "",
      related_titles: "",
      parent_comment: "",
      selected_text: "",
      edit_instructions: "",
      full_article: "",
      dyk_articles: "",
      article_title: "",
      inspiration_titles: inspiration.length
        ? inspiration.map((a) => `- ${a.title} (${a.slug})`).join("\n")
        : "(none)",
    }),
    { thinking: prompt.thinking, jsonMode: prompt.json },
  );

  return normalizeRandomPageChoice(raw);
}

async function ensureHomepageCache(
  deps: PipelineDeps,
): Promise<HomepagePayload> {
  const recorder = getTraceRecorder(deps.runtime.app.pipeline.trace);
  const result = await runWorkflow(homepageRefreshWorkflow, {
    input: {
      requestId: randomUUID(),
      workflow: "homepage.refresh",
      slug: "homepage",
      instructions: "refresh homepage cache",
    },
    deps,
    recorder,
    logger: deps.logger,
  });
  if (result.status !== "ok") {
    throw result.error ?? new Error("homepage refresh workflow failed");
  }
  const payload = result.state.homepagePayload;
  if (!payload || typeof payload !== "object") {
    throw new Error("homepage refresh workflow returned no payload");
  }
  return payload as HomepagePayload;
}

function buildLinkedPromptSystem(
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  key: string,
): string {
  const guide = getSharedPrompt(promptConfig, "linking_guide");
  const prompt = getPrompt(promptConfig, key);
  return `${guide.system.trim()}\n\n${prompt.system.trim()}`;
}

function stripSelectionDecorators(text: string): string {
  return normalizeSelectionText(text)
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function linkableSelectionCandidates(selectedText: string): string[] {
  const normalized = normalizeSelectionText(selectedText);
  if (!normalized) return [];

  const candidates = [
    normalized,
    stripSelectionDecorators(normalized),
    stripSelectionDecorators(normalized.split(/[:.;!?]/u)[0] ?? ""),
    normalized.split(/[:.;!?]/u)[0] ?? "",
    normalized.split(/\s[-–—]\s/u)[0] ?? "",
  ]
    .map(normalizeSelectionText)
    .filter(Boolean);

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function findBestWrapRange(
  markdown: string,
  selectedText: string,
): { start: number; end: number; visibleLabel: string } | null {
  const candidates = linkableSelectionCandidates(selectedText);
  for (const candidate of candidates) {
    if (shouldRefineSelection(candidate)) continue;
    const range = findWrapRange(markdown, candidate);
    if (range) return range;
  }
  for (const candidate of candidates) {
    const range = findWrapRange(markdown, candidate);
    if (range && !shouldRefineSelection(range.visibleLabel)) return range;
  }
  return findWrapRange(markdown, selectedText);
}

function normalizeSuggestedTargetSlug(
  suggestedSlug: string,
  sourceSlug: string,
  visibleLabel: string,
): string {
  const normalized = slugify(suggestedSlug);
  const fallback = slugify(visibleLabel);
  if (!normalized || normalized === sourceSlug) return fallback;
  return normalized;
}

async function generateLinkSuggestion(
  llm: LlmRouter,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  requestedTitle: string,
  selectedText: string,
  articleExcerpt: string,
  ragContext: string,
  relatedTitles: string[],
): Promise<LinkSuggestion> {
  const prompt = getPrompt(promptConfig, "link_suggestion");
  const role = prompt.model ?? "heavy";
  const raw = await llm.chat(
    role,
    buildLinkedPromptSystem(promptConfig, "link_suggestion"),
    renderTemplate(prompt.user, {
      slug: slugify(requestedTitle),
      requested_title: requestedTitle,
      selected_text: selectedText,
      article_excerpt: articleExcerpt,
      rag_context: ragContext || "(none)",
      related_titles: relatedTitles.length
        ? relatedTitles.map((title) => `- ${title}`).join("\n")
        : "(none)",
      link_hints: "",
      parent_comment: "",
    }),
    { thinking: prompt.thinking, jsonMode: prompt.json },
  );
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`link suggestion returned invalid JSON. Raw response: “${raw.slice(0, 500)}”`);
  }
  let parsed: Partial<LinkSuggestion>;
  try {
    parsed = JSON.parse(jsonrepair(match[0]));
  } catch (jsonErr) {
    throw new Error(`link suggestion JSON parsing failed: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}. JSON: “${match[0]}”`);
  }
  const description = (parsed.description ?? "").replace(/\s+/g, " ").trim();
  const slug = slugify(parsed.slug ?? "");
  if (!description || !slug) {
    throw new Error(`link suggestion returned empty fields. Got: ${JSON.stringify(parsed)}. Need: { description: string; slug: string }`);
  }
  return { description, slug };
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
  const mediaDb = openMediaDatabase(options.mediaDatabasePath ?? runtime.app.images.media_database_path);

  // Startup sync: ingest any TOML edits made outside the UI into DB, and write
  // TOML for any DB-current entries whose files are missing.
  {
    const { runnable, shared } = listPromptFiles();
    const tomlKeys = new Set<string>();
    for (const { scope, key } of [
      ...runnable.map((p) => ({ scope: "runnable" as const, key: p.key })),
      ...shared.map((p) => ({ scope: "shared" as const, key: p.key })),
    ]) {
      tomlKeys.add(`${scope}:${key}`);
      const file = readPromptFile(scope, key);
      if (!file) continue;
      const dbCurrent = getPromptCurrent(db, scope, key);
      if (!dbCurrent) {
        // First time seeing this prompt — seed DB from TOML.
        setPromptCurrent(db, scope, key, file.system, file.user);
      } else if (dbCurrent.system !== file.system || dbCurrent.user !== file.user) {
        // TOML was edited directly — ingest into DB as a recorded change.
        recordPromptRevision(db, scope, key, dbCurrent.system, dbCurrent.user, file.system, file.user, "startup");
        setPromptCurrent(db, scope, key, file.system, file.user);
        logger.info("prompt.startup_ingest", { scope, key });
      }
    }
    // For DB entries whose TOML file is missing, recreate it.
    for (const { scope: rawScope, key, system, user } of listAllPromptCurrents(db)) {
      if (tomlKeys.has(`${rawScope}:${key}`)) continue;
      const scope = rawScope as "runnable" | "shared";
      const err = writePromptFile(scope, key, system, user);
      if (!err) logger.info("prompt.startup_restore_toml", { scope, key });
    }
  }

  let llm: LlmRouter =
    options.llmClient ??
    new OpenAICompatRouter(
      runtime.llm.chat,
      runtime.llm.light,
      runtime.llm.embeddings,
      logger,
      runtime.llm.images,
    );
  const app = new Hono();
  const distRoot = options.distRoot
    ? resolve(options.distRoot)
    : resolve(process.cwd(), "dist");

  const inFlightGenerations = new Set<Promise<unknown>>();
  interface GenerationQueueEntry {
    promise: Promise<ArticleRecord>;
    slug: string;
    title: string;
    seq: number;
    startedAt: number;
    waiting: number;
  }
  const slugGenerations = new Map<string, GenerationQueueEntry>();
  let generationSeq = 0;
  const inFlightEdits = new Set<string>(); // Track slugs with in-flight edits to prevent stale overwrites

  // Per-article sidecar push: clients subscribe via GET /api/article/:slug/live
  // and receive NDJSON events when post-process updates sidecar data.
  const articleListeners = new Map<string, Set<(e: unknown) => void>>();
  // Tracks slugs that have had an auto-post-process triggered this session
  // so we don't re-fire on every page load before the infobox is written.
  const autoPostProcessed = new Set<string>();
  function notifySidecar(slug: string, event: unknown) {
    const listeners = articleListeners.get(slug);
    if (!listeners) return;
    // Pre-render infobox values inline so the client receives HTML, not raw markdown.
    // Run linkReferencesInline first so bare title mentions become ref: links.
    const liveRefs = loadPriorReferenceList(db, slug) ?? [];
    let wire = event as Record<string, unknown>;
    if (wire.type === "infobox" && wire.infobox) {
      const raw = wire.infobox as { title?: string; subtitle?: string; groups?: Array<{ label: string; rows: Array<{ label: string; value: string }> }> };
      wire = {
        ...wire,
        infobox: {
          ...raw,
          subtitle: raw.subtitle
            ? renderInlineMarkdown(linkReferencesInline(raw.subtitle, liveRefs))
            : undefined,
          groups: (raw.groups ?? []).map((g) => ({
            label: g.label,
            rows: g.rows.map((r) => ({
              label: r.label,
              value: renderInlineMarkdown(linkReferencesInline(r.value, liveRefs)),
            })),
          })),
        },
      };
    } else if (wire.type === "caption" && typeof wire.caption === "string") {
      wire = { ...wire, caption: renderInlineMarkdown(linkReferencesInline(wire.caption, liveRefs)) };
    }
    for (const cb of listeners) { try { cb(wire); } catch {} }
  }

  const maintenance = new MaintenanceScheduler(logger);

  function trackGeneration<T>(promise: Promise<T>): Promise<T> {
    const id = Math.random().toString(36).slice(2, 8);
    inFlightGenerations.add(promise);
    logger.debug("generation.tracked", { id, in_flight: inFlightGenerations.size });
    promise.finally(() => {
      inFlightGenerations.delete(promise);
      logger.debug("generation.settled", { id, in_flight: inFlightGenerations.size });
    });
    return promise;
  }

  function reserveSlugGeneration(
    slug: string,
    title: string,
    generate: () => Promise<ArticleRecord>,
  ): { promise: Promise<ArticleRecord>; seq: number; joined: boolean; releaseWaiter: () => void } {
    const seq = ++generationSeq;
    const queueDepth = slugGenerations.size;
    const existing = slugGenerations.get(slug);
    if (existing) {
      existing.waiting += 1;
      logger.info("page.join", { slug, seq, origin_seq: existing.seq, waiting: existing.waiting });
      return {
        promise: existing.promise,
        seq,
        joined: true,
        releaseWaiter: () => {
          existing.waiting = Math.max(0, existing.waiting - 1);
        },
      };
    }
    logger.info("page.generate", { slug, seq });
    const promise = generate().finally(() => {
      if (slugGenerations.get(slug)?.seq === seq) {
        slugGenerations.delete(slug);
      }
    });
    slugGenerations.set(slug, {
      promise,
      slug,
      title,
      seq,
      startedAt: Date.now(),
      waiting: 0,
    });
    return { promise, seq, joined: false, releaseWaiter: () => {} };
  }

  function generationQueuePayload() {
    return {
      items: [...slugGenerations.values()]
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((entry) => ({
          slug: entry.slug,
          title: entry.title,
          seq: entry.seq,
          startedAt: entry.startedAt,
          waiting: entry.waiting,
        })),
    };
  }

  /**
   * Lightweight post-save hook: re-index RAG chunks and regenerate the summary.
   * Called after any operation that mutates an article without going through
   * the full postProcessArticle pipeline (e.g. add-link, revert).
   * Non-blocking — fires via trackGeneration and logs failures.
   */
  function afterArticleSaved(slug: string, title: string, markdown: string, generatedAt: number): void {
    trackGeneration(
      (async () => {
        const headlineMedia = getArticleHeadlineMedia(db, slug);
        const imageDescriptions: Array<{ id: string; description: string }> = [];
        if (headlineMedia) {
          const rec = getMediaById(mediaDb, headlineMedia.mediaId);
          if (rec?.description) imageDescriptions.push({ id: rec.id, description: rec.description });
        }
        await indexArticleChunks(
          db,
          llm,
          slug,
          markdown,
          runtime.app.rag.enabled && runtime.llm.embeddings.enabled,
          runtime.app.rag.chunk_size,
          logger,
          imageDescriptions,
        );
        const summaryMarkdown = await generateArticleSummary(
          llm,
          runtime.prompts,
          title,
          markdown,
        ).catch(() => summaryMarkdownFromArticle(markdown));
        updateArticleSummary(db, slug, summaryMarkdown, { updateRevisionGeneratedAt: generatedAt });
      })().catch((error) => {
        logger.warn("article.post_save_hook_failed", {
          slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  }

  async function shutdown() {
    await maintenance.shutdown();
    if (inFlightGenerations.size > 0) {
      logger.info("shutdown.draining", { in_flight: inFlightGenerations.size });
      const startTime = Date.now();
      await Promise.allSettled([...inFlightGenerations]);
      const elapsed = Date.now() - startTime;
      logger.info("shutdown.drained", { elapsed_ms: elapsed });
    }
    logger.info("shutdown.closing_database");
    db.close();
    mediaDb.close();
    logger.info("shutdown.complete");
  }

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
      llm = new OpenAICompatRouter(
        runtime.llm.chat,
        runtime.llm.light,
        runtime.llm.embeddings,
        logger,
        runtime.llm.images,
      );
    }
    logger.info("startup", {
      server: `http://${runtime.app.server.host}:${runtime.app.server.port}`,
      database: runtime.app.storage.database_path,
      heavy_base_url: runtime.llm.chat.base_url,
      heavy_model: runtime.llm.chat.model,
      light_base_url: runtime.llm.light.base_url,
      light_model: runtime.llm.light.model,
      images_base_url: runtime.llm.images?.base_url ?? "(none)",
      images_model: runtime.llm.images?.model ?? "(none)",
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

  function canonicalPathForArticle(article: {
    canonicalSlug: string;
    title: string;
  }) {
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
    const normalizedTitle = normalizeCanonicalTitle(
      article.title || slugToTitle(article.canonicalSlug),
    );
    const normalizedMarkdown = rewriteArticleTitleHeading(
      article.markdown,
      normalizedTitle,
    );
    if (
      normalizedTitle === article.title &&
      normalizedMarkdown === article.markdown
    )
      return article;

    const links = extractAllBodyLinks(normalizedMarkdown, article.slug);
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
      Array.from(
        new Set([repairedArticle.slug, repairedArticle.canonicalSlug]),
      ),
      {
        operation: "repair",
        instructions: "Normalize lowercase-first canonical title.",
        skipRevision: true,
      },
    );
    return repairedArticle;
  }

  function repairStoredArticleIdentity(
    article: {
      slug: string;
      canonicalSlug: string;
      title: string;
      markdown: string;
      html: string;
      summaryMarkdown?: string;
      plain_text: string;
      generated_at: number;
    },
    requestedSlug: string,
  ) {
    let repaired = repairStoredArticleTitle(article);
    const titleDerivedSlug = slugify(
      repaired.title || slugToTitle(repaired.canonicalSlug),
    );
    if (
      requestedSlug &&
      requestedSlug !== repaired.slug &&
      titleDerivedSlug === requestedSlug
    ) {
      const renamed = renameArticleSlug(db, repaired.slug, requestedSlug);
      if (renamed) {
        logger.info("page.slug_repair", { slug: requestedSlug, from: repaired.slug });
        const fresh = getArticleByLookup(db, requestedSlug);
        if (fresh) repaired = fresh;
      }
    }
    return repaired;
  }

  function repairCachedArticle(article: ArticleRecord): ArticleRecord {
    const normalizedTitle = normalizeCanonicalTitle(
      article.title || slugToTitle(article.canonicalSlug),
    );
    const parsed = normalizeMarkdownLinks(article.markdown, "article");
    logger.info("text.db_repair", {
      slug: article.slug,
      changed: parsed.changed,
      links: parsed.stats.total,
      halu: parsed.stats.halu,
      ref: parsed.stats.ref,
      bare_ref: parsed.stats.bareRef,
      bare_halu: parsed.stats.bareHalu,
      loose_ref: parsed.stats.looseRef,
      loose_halu: parsed.stats.looseHalu,
      wiki: parsed.stats.wiki,
      plain_slug: parsed.stats.plainSlug,
      external: parsed.stats.external,
      diagnostics: parsed.stats.diagnostics,
    });
    const bodyMarkdown = sanitizeGeneratedBody(parsed.markdown);
    const markdown = rewriteArticleTitleHeading(bodyMarkdown, normalizedTitle);
    if (markdown === article.markdown && normalizedTitle === article.title) {
      return article;
    }
    const links = extractAllBodyLinks(markdown, article.slug);
    const repairedArticle: ArticleRecord = {
      ...article,
      title: normalizedTitle,
      markdown,
      html: rewriteArticleHtml(renderMarkdown(markdown), links),
      summaryMarkdown:
        article.summaryMarkdown?.trim() || summaryMarkdownFromArticle(markdown),
      plain_text: markdownToPlainText(markdown),
      generated_at: Date.now(),
    };
    saveArticle(
      db,
      repairedArticle,
      links,
      Array.from(
        new Set([repairedArticle.slug, repairedArticle.canonicalSlug]),
      ),
      {
        operation: "repair",
        instructions: "Repair cached article artifacts.",
        skipRevision: true,
      },
    );
    return getArticleByLookup(db, repairedArticle.slug) ?? repairedArticle;
  }

  // Build the canonical ArticleResponse for a slug. Hydrates sidecar metadata
  // (references + see-also), renders combined HTML (body + sidecar refs +
  // sidecar see-also), caches the render. Returns null on unknown slug.
  function buildArticleResponseFor(slug: string): ArticleResponse | null {
    const record = getArticleByLookup(db, slug);
    if (!record) return null;
    const article = loadArticle(db, slug);
    if (!article) return null;
    const combined = assembleArticleMarkdownForRender(article);
    const cached = getCachedArticleHtml(article.slug, article.generatedAt);
    let html: string;
    if (cached) {
      html = cached;
    } else {
      const rendered = renderArticleDisplayHtml(article);
      const links = extractInternalLinks(combined);
      html = rewriteArticleHtml(rendered, links);
      rememberArticleHtml(article.slug, article.generatedAt, html);
    }
    // `combined` is the legacy markdown projection: body with ref links
    // resolved, while references and see-also stay in sidecar metadata.
    return articleToResponse(article, html, combined);
  }

  function buildReferenceStatus(
    response: ArticleResponse,
    rawMarkdown: string,
  ): ReferenceStatus {
    const listed = new Set(
      response.metadata.references.map((ref) => slugify(ref.slug)),
    );
    // Strip baked-in metadata sections before scanning so old-style articles
    // with embedded References/See also don't produce spurious status flags.
    const bodyForScan = stripTopLevelSections(response.body, [
      "References",
      "See also",
    ]);
    // missing: only explicit ref:slug links in body that aren't in sidecar.
    // Plain halu links to existing articles are NOT counted — they are just
    // internal wiki links, not explicit citations.
    const missing: ReferenceStatusEntry[] = [];
    if (bodyForScan.includes("ref:")) {
      const seen = new Set<string>();
      const selfSlug = slugify(response.slug);
      const refPattern = /\[([^\]]*)\]\(ref:([^)]+)\)/g;
      let m: RegExpExecArray | null;
      while ((m = refPattern.exec(bodyForScan)) !== null) {
        const slug = slugify(m[2]);
        if (!slug || slug === selfSlug || seen.has(slug)) continue;
        seen.add(slug);
        if (listed.has(slug)) continue;
        const article = getArticleByLookup(db, slug);
        if (article) missing.push({ slug: article.slug, title: article.title });
      }
    }
    // unformatted: halu links to articles that ARE in sidecar — these should
    // be converted to ref: links for proper footnote rendering.
    const legacyHaluRefs = findExistingArticleLinkReferences(
      db,
      bodyForScan,
      response.slug,
    );
    return {
      missing,
      unformatted: legacyHaluRefs
        .filter((ref) => listed.has(ref.slug))
        .map((ref) => ({ slug: ref.slug, title: ref.title })),
      // sectionSlice returns "" when not found, never null — use !== ""
      hasReferencesSection: sectionSlice(rawMarkdown, "References") !== "",
    };
  }

  // Build the full /api/page-style payload around an ArticleResponse.
  // Centralises the sections + backlinks fields so every article-returning
  // endpoint produces the same envelope.
  function buildPageResponse(
    response: ArticleResponse,
    opts: {
      cached: boolean;
      requestedPath?: string;
      canonicalPath?: string;
      statusMessage?: string;
      refreshChanged?: boolean;
    },
  ) {
    const rawRecord = getArticleByLookup(db, response.slug);
    // Infobox sidecar — loaded fresh so sidebar always reflects latest pipeline output.
    const rawInfobox = getArticleInfobox(db, response.slug);
    // Load refs so we can link title mentions in infobox values and caption.
    const sidebarRefs = loadPriorReferenceList(db, response.slug) ?? [];
    // Pre-render infobox values as inline HTML so the client gets bold/italic/ref-links.
    // Run linkReferencesInline first so bare title mentions become ref: links before rendering.
    const infobox = rawInfobox
      ? {
          ...rawInfobox,
          subtitle: rawInfobox.subtitle
            ? renderInlineMarkdown(linkReferencesInline(rawInfobox.subtitle, sidebarRefs))
            : undefined,
          groups: rawInfobox.groups.map((g) => ({
            label: g.label,
            rows: g.rows.map((r) => ({
              label: r.label,
              value: renderInlineMarkdown(linkReferencesInline(r.value, sidebarRefs)),
            })),
          })),
        }
      : null;
    const headlineMediaRow = getArticleHeadlineMedia(db, response.slug);
    const headlineMedia = headlineMediaRow
      ? {
          mediaId: headlineMediaRow.mediaId,
          caption: headlineMediaRow.caption
            ? renderInlineMarkdown(linkReferencesInline(headlineMediaRow.caption, sidebarRefs))
            : "",
          description: getMediaById(mediaDb, headlineMediaRow.mediaId)?.description ?? "",
        }
      : null;
    return {
      cached: opts.cached,
      referenceStatus: buildReferenceStatus(
        response,
        rawRecord?.markdown ?? response.body,
      ),
      redirectedFrom:
        opts.canonicalPath && opts.requestedPath &&
        opts.canonicalPath !== opts.requestedPath
          ? opts.requestedPath
          : undefined,
      canonicalPath: opts.canonicalPath,
      article: response,
      infobox,
      headlineMedia,
      // Sections list is derived from the rendered body, not metadata.
      sections: listArticleSections(response.body),
      backlinks: listBacklinks(db, response.slug),
      isProtected: isArticleProtected(db, response.slug),
      protectedSections: listProtectedSections(db, response.slug).map((s) => s.sectionId),
      ...(opts.statusMessage ? { statusMessage: opts.statusMessage } : {}),
      ...(opts.refreshChanged !== undefined
        ? { refreshChanged: opts.refreshChanged }
        : {}),
    };
  }

  function rewriteArticleHtml(
    articleHtml: string,
    links: Array<{ targetSlug: string }>,
  ) {
    let html = articleHtml;
    for (const link of links) {
      const targetCanonical = getCanonicalSlugForTarget(db, link.targetSlug);
      const currentPath = `/wiki/${titleToWikiSegment(slugToTitle(link.targetSlug))}`;
      const preferredPath = `/wiki/${titleToWikiSegment(slugToTitle(targetCanonical))}`;
      html = html.replaceAll(
        `href="${currentPath}"`,
        `href="${preferredPath}"`,
      );
    }
    return html;
  }

  /**
   * Extract all internal links from article body markdown for article_links storage.
   *
   * Combines halu: links (articles that may not exist yet, seeds for new pages)
   * with ref:slug links (converted from halu links to existing articles).
   * Both are stored in article_links so that:
   *   - listBacklinks() shows all articles that link to a given target
   *   - listIncomingHints() can provide RAG context during generation of the
   *     target article (using the visible_label and hidden_hint columns)
   *
   * This matters because convertExistingArticleLinksToRefs() converts halu links
   * to ref: links — without this combined extraction, ref-linked articles would
   * silently disappear from the knowledge graph.
   */
  function extractAllBodyLinks(
    markdown: string,
    selfSlug: string,
  ): import("./types").ParsedInternalLink[] {
    const haluLinks = extractInternalLinks(markdown);
    const haluSlugs = new Set(haluLinks.map((l) => l.targetSlug));
    const refLinks = extractRefLinksAsInternalLinks(db, markdown, selfSlug).filter(
      (l) => !haluSlugs.has(l.targetSlug),
    );
    return [...haluLinks, ...refLinks];
  }

  function buildPipelineDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
    return {
      db,
      mediaDb,
      llm,
      prompts: buildPromptRegistry(runtime.prompts),
      logger,
      runtime,
      onSidecarUpdate: notifySidecar,
      ...overrides,
    };
  }

  async function buildArticle(
    slug: string,
    requestedTitle: string,
    onProgress?: (html: string, markdown: string) => void,
    onStatus?: (message: string) => void,
  ) {
    onStatus?.("Writing...");
    const recorder = getTraceRecorder(runtime.app.pipeline.trace);
    const result = await runWorkflow(generateArticleWorkflow, {
      input: {
        requestId: randomUUID(),
        workflow: "article.generate",
        slug,
        requestedTitle,
      },
      deps: buildPipelineDeps({ onProgress }),
      recorder,
      logger,
    });
    if (result.status === "error") throw result.error ?? new Error("article generation failed");

    const canonicalSlug = result.state.canonicalSlug ?? slug;
    const persistedAt = result.state.persistedAt;
    logger.info("page.generated", {
      slug: canonicalSlug,
      duration_ms: result.durationMs,
      nodes: result.nodesExecuted,
    });

    // Post-process async: link repair, see-also, summary, RAG indexing.
    trackGeneration(
      runWorkflow(postProcessWorkflow, {
        input: {
          requestId: randomUUID(),
          workflow: "article.post_process",
          slug: canonicalSlug,
          requestedTitle,
        },
        deps: buildPipelineDeps({
          ...(persistedAt ? { onProgress: undefined } : {}),
        }),
        recorder,
        logger,
      }).catch(() => {}),
    );

    const article = getArticleByLookup(db, canonicalSlug);
    if (!article) throw new Error(`article not found after generation: ${canonicalSlug}`);
    return article;
  }

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      model: runtime.llm.chat.model,
      database_path: runtime.app.storage.database_path,
    }),
  );

  const HOMEPAGE_TTL_MS = runtime.app.homepage.rotation_hours * 60 * 60 * 1000;
  if (!options.skipHomepagePrepare) {
    maintenance.register({
      name: HOMEPAGE_MAINTENANCE_TASK,
      nextDelayMs: () => {
        const cached = getHomepageCache(db);
        if (!cached) return 0;
        return (
          cached.generatedAt +
          HOMEPAGE_TTL_MS -
          Date.now() +
          HOMEPAGE_REFRESH_GRACE_MS
        );
      },
      run: async () => {
        const cached = getHomepageCache(db);
        const now = Date.now();
        const reason = !cached
          ? "missing"
          : cached.generatedAt + HOMEPAGE_TTL_MS <= now
            ? "expired"
            : "scheduled";
        logger.info("homepage.refresh_start", {
          reason,
          age_ms: cached ? now - cached.generatedAt : 0,
          ttl_ms: HOMEPAGE_TTL_MS,
        });
        try {
          await reloadRuntime();
          const payload = await ensureHomepageCache(buildPipelineDeps());
          logger.info("homepage.refresh_done", {
            facts: payload.didYouKnow.length,
            featured: payload.featured?.slug ?? "",
            generated_at: payload.generatedAt,
            expires_at: payload.expiresAt,
          });
        } catch (error) {
          logger.error("homepage.refresh_failed", {
            reason,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    });
  }

  // ── Periodic database backup ────────────────────────────────────────────────
  maintenance.register({
    name: DB_BACKUP_TASK,
    nextDelayMs: () => DB_BACKUP_INTERVAL_MS,
    run: async () => {
      const dbPath = resolve(process.cwd(), runtime.app.storage.database_path);
      if (!existsSync(dbPath)) return;
      const backupDir = dirname(dbPath);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const rawPath = `${dbPath}.backup-${ts}`;
      const gzPath = `${rawPath}.gz`;

      // VACUUM INTO produces a consistent, defragmented copy even under load.
      db.exec(`VACUUM INTO '${rawPath.replace(/'/g, "''")}'`);

      // Compress and delete the raw copy.
      await pipeline(
        (await import("node:fs")).createReadStream(rawPath),
        createGzip({ level: 6 }),
        createWriteStream(gzPath),
      );
      rmSync(rawPath);

      const { size } = await fsStat(gzPath);
      logger.info("db.backup_done", {
        path: gzPath,
        size_kb: Math.round(size / 1024),
      });

      // Prune old backups — keep the most recent DB_BACKUP_KEEP files.
      const prefix = basename(dbPath) + ".backup-";
      const existing = readdirSync(backupDir)
        .filter((f) => f.startsWith(prefix) && f.endsWith(".gz"))
        .sort()
        .reverse();
      for (const old of existing.slice(DB_BACKUP_KEEP)) {
        rmSync(resolve(backupDir, old));
        logger.info("db.backup_pruned", { file: old });
      }
    },
  });

  app.get("/api/homepage", (c) => {
    const cached = getHomepageCache(db);
    const now = Date.now();
    if (cached && cached.generatedAt + HOMEPAGE_TTL_MS > now) {
      return c.json({
        ...cached,
        expiresAt: cached.generatedAt + HOMEPAGE_TTL_MS,
      });
    }

    maintenance.trigger(
      HOMEPAGE_MAINTENANCE_TASK,
      cached ? "expired_cache_request" : "missing_cache_request",
    );
    if (cached) {
      return c.json({
        ...cached,
        expiresAt: now + HOMEPAGE_PENDING_RETRY_MS,
      });
    }
    return c.json({
      featured: null,
      didYouKnow: [],
      generatedAt: now,
      expiresAt: now + HOMEPAGE_PENDING_RETRY_MS,
    });
  });

  // Returns up to 50 prior homepage snapshots, newest first.
  app.get("/api/homepage/history", (c) => {
    const history = listHomepageHistory(db, 50);
    return c.json({ history });
  });

  app.get("/api/top-articles", (c) => {
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? "10")));
    return c.json({ articles: listTopArticles(db, limit) });
  });

  app.get("/api/graph", (c) => {
    return c.json(getGraphData(db));
  });

  app.get("/api/random-page", async (c) => {
    try {
      await reloadRuntime();
      const inspiration = sampleRandomInspirationArticles(
        db,
        runtime.app.random_page.inspiration_count,
      );
      logger.info("random_page.request", {
        "random article inspiration titles": inspiration.map((a) => `${a.title} (${a.slug})`).join(", "),
      });
      const choice = await generateRandomPageChoice(
        llm,
        runtime.prompts,
        inspiration,
      );
      logger.info("random_page.done", { slug: choice.slug, title: choice.title });
      const wikiSegment = titleToWikiSegment(slugToTitle(choice.slug));
      return c.json({
        path: `/wiki/${wikiSegment}`,
        slug: choice.slug,
        title: choice.title,
      });
    } catch (error) {
      logger.error("random_page.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  });

  app.get("/api/page/:slug", async (c) => {
    const requestedSegment = c.req.param("slug");
    const segmentTitle = normalizeCanonicalTitle(
      wikiSegmentToRequestedTitle(requestedSegment),
    );
    const requestedTitle = normalizeCanonicalTitle(
      c.req.query("title") || segmentTitle,
    );
    const lookupSlug = slugify(segmentTitle);
    if (!lookupSlug || !requestedTitle)
      return c.json({ error: "invalid slug" }, 400);
    const requestedPath = `/wiki/${requestedSegment}`;

    // Check if there's an in-flight edit for this article
    const hasInFlightEdit = inFlightEdits.has(lookupSlug);
    if (hasInFlightEdit) {
      logger.info("page.in_flight_edit", { slug: lookupSlug });
    }

    // Resolve the canonical record (slug lookup, then title fallback, then
    // any cache repair needed). All article shaping happens in
    // buildArticleResponseFor/buildPageResponse so the wire format stays
    // single-sourced.
    let record = getArticleByLookup(db, lookupSlug);
    if (!record) {
      const titleMatch = getArticleByTitle(db, requestedTitle);
      if (titleMatch) record = repairStoredArticleIdentity(titleMatch, lookupSlug);
    }
    if (!record) {
      const equivalentMatch = getArticleByEquivalentLookup(db, lookupSlug);
      if (equivalentMatch) {
        logger.info("page.equivalent_hit", {
          slug: lookupSlug,
          canonical_slug: equivalentMatch.slug,
        });
        record = equivalentMatch;
      }
    }
    if (record) {
      record = repairStoredArticleIdentity(record, lookupSlug);
      if (cachedArticleNeedsRepair(record.markdown)) {
        logger.warn("page.cache_repair", { slug: record.slug, in_flight_edit: hasInFlightEdit });
        record = repairCachedArticle(record);
        invalidateArticleHtml(record.slug);
      }
      const response = buildArticleResponseFor(record.slug);
      if (response) {
        const canonicalPath = canonicalPathForArticle(record);
        logger.info("page.hit", { slug: lookupSlug, in_flight_edit: hasInFlightEdit });

        // Auto-sidebar: fire post-process in the background on first view if
        // the article has no infobox yet (e.g. imported or created before
        // post-process ran). Tracked so it only fires once per server session.
        if (!getArticleInfobox(db, record.slug) && !autoPostProcessed.has(record.slug)) {
          autoPostProcessed.add(record.slug);
          logger.info("page.auto_post_process", { slug: record.slug });
          trackGeneration(
            runWorkflow(postProcessWorkflow, {
              input: {
                requestId: randomUUID(),
                workflow: "article.post_process",
                slug: record.slug,
                requestedTitle: record.title,
              },
              deps: buildPipelineDeps(),
              recorder: getTraceRecorder(runtime.app.pipeline.trace),
              logger,
            }).catch(() => {}),
          );
        }

        return c.json(
          buildPageResponse(response, {
            cached: true,
            requestedPath,
            canonicalPath,
          }),
        );
      }
    }
    logger.info("page.miss", { slug: lookupSlug });

    const encoder = new TextEncoder();
    const existingGeneration = slugGenerations.get(lookupSlug);
    if (existingGeneration) {
      const joinSeq = ++generationSeq;
      logger.info("page.join_await", {
        slug: lookupSlug,
        seq: joinSeq,
        origin_seq: existingGeneration.seq,
      });
      if (c.req.query("wait") === "0") {
        return c.json(
          {
            generating: true,
            slug: lookupSlug,
            title: existingGeneration.title,
            seq: existingGeneration.seq,
            waiting: existingGeneration.waiting,
          },
          202,
        );
      }
      let streamOpen = true;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: unknown) => {
            if (!streamOpen) return;
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
            } catch {
              streamOpen = false;
            }
          };
          const close = () => {
            if (!streamOpen) return;
            streamOpen = false;
            try {
              controller.close();
            } catch {}
          };

          send({ type: "start", slug: lookupSlug, cached: false, seq: joinSeq, joined: true });
          send({ type: "status", message: "Waiting and contemplating..." });
          close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    }

    let streamOpen = true;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (payload: unknown) => {
          if (!streamOpen) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
          } catch {
            streamOpen = false;
          }
        };
        const close = () => {
          if (!streamOpen) return;
          streamOpen = false;
          try {
            controller.close();
          } catch {}
        };

        const {
          promise: generation,
          seq,
          joined,
          releaseWaiter,
        } = reserveSlugGeneration(lookupSlug, requestedTitle, () =>
          buildArticle(
            lookupSlug,
            requestedTitle,
            (html, markdown) => {
              send({ type: "progress", html, markdown });
            },
            (message) => {
              send({ type: "status", message });
            },
          ),
        );

        send({ type: "start", slug: lookupSlug, cached: false, seq, joined });
        send({ type: "status", message: "Waiting and contemplating..." });

        generation
          .then((result) => {
            const canonicalPath = canonicalPathForArticle(result);
            logger.info("page.stream_done", { slug: lookupSlug, seq });
            // Re-hydrate via buildArticleResponseFor so the streamed payload
            // ships the same shape as cache hits (body+metadata sidecar).
            const response = buildArticleResponseFor(result.slug);
            if (response) {
              send({
                type: "done",
                ...buildPageResponse(response, {
                  cached: false,
                  requestedPath,
                  canonicalPath,
                }),
              });
            }
            close();
            releaseWaiter();
            return result;
          })
          .catch((error) => {
            logger.error("page.stream_error", { slug: lookupSlug, seq, error: error instanceof Error ? error.message : String(error) });
            send({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
            close();
            releaseWaiter();
          });

        trackGeneration(generation.catch(() => {}));
      },
      cancel() {
        streamOpen = false;
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });

  // Returns the most-recent set of reference articles saved alongside the article.
  app.get("/api/article/:slug/references", (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);
    const seen = new Set<string>();
    const references = getLatestArticleReferences(db, article.slug).filter((r) => {
      if (seen.has(r.slug)) return false;
      seen.add(r.slug);
      return true;
    });
    return c.json({ references });
  });

  // Toggle the pinned flag on a saved reference without triggering a full rewrite.
  app.post("/api/article/:slug/pin-reference", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { refSlug?: string; pinned?: boolean };
    const refSlug = slugify(body.refSlug ?? "");
    if (!refSlug) return c.json({ error: "missing refSlug" }, 400);
    const pinned = Boolean(body.pinned);
    const current = getLatestArticleReferences(db, article.slug);
    if (!current.some((r) => r.slug === refSlug)) {
      return c.json({ error: "reference not found in current list" }, 404);
    }
    const latestSavedAt = db
      .prepare(
        `SELECT COALESCE(MAX(saved_at), 0) AS savedAt
         FROM article_references
         WHERE article_slug = ?`,
      )
      .get(article.slug) as { savedAt: number };
    const updated = current.map((r) => (r.slug === refSlug ? { ...r, pinned } : r));
    saveArticleReferences(db, article.slug, Math.max(Date.now(), latestSavedAt.savedAt + 1), updated);
    logger.info("references.pin_toggled", { slug: article.slug, ref_slug: refSlug, pinned });
    return c.json({ ok: true });
  });

  // Raw markdown save — no LLM, just versioned storage. The markdown is
  // normalised and run through the standard link/reference pipeline but
  // never passed to a language model.
  app.post("/api/article/:slug/raw-save", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      markdown?: string;
      referenceSlugs?: string[];
      pinnedSlugs?: string[];
    };

    const rawMarkdown = (body.markdown ?? "").trim();
    if (!rawMarkdown) return c.json({ error: "missing markdown" }, 400);

    const userSlugs = (body.referenceSlugs ?? []).map((s) => slugify(s)).filter(Boolean);
    const pinnedSet = new Set((body.pinnedSlugs ?? []).map((s) => slugify(s)).filter(Boolean));

    try {
      const recorder = getTraceRecorder(runtime.app.pipeline.trace);
      const result = await runWorkflow(rawSaveArticleWorkflow, {
        input: {
          requestId: randomUUID(),
          workflow: "article.raw_save",
          slug: article.slug,
          requestedTitle: article.title,
          rawMarkdown,
          userReferenceSlugs: userSlugs,
          pinnedSlugs: [...pinnedSet],
          instructions: "raw-edit",
        },
        deps: buildPipelineDeps(),
        recorder,
        logger,
      });
      if (result.status === "error") {
        throw result.error ?? new Error("raw save workflow failed");
      }
      const savedSlug = result.state.canonicalSlug ?? article.slug;
      invalidateArticleHtml(savedSlug);
      logger.info("raw_edit.saved", { slug: savedSlug });
      const response = buildArticleResponseFor(savedSlug);
      if (!response) return c.json({ error: "article not found after save" }, 500);
      return c.json({ article: response });
    } catch (err) {
      logger.warn("raw_edit.failed", {
        slug: lookupSlug,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: err instanceof Error ? err.message : "save failed" }, 500);
    }
  });

  // Render a markdown preview without saving. Returns HTML + any link/parser diagnostics.
  app.post("/api/article/:slug/preview-markdown", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { markdown?: string };
    const rawMarkdown = (body.markdown ?? "").trim();
    if (!rawMarkdown) return c.json({ html: "", diagnostics: [] });

    const normalized = normalizeMarkdownLinks(rawMarkdown, "article");
    const brokenLinks: Array<{ slug: string; reason: string }> = [];
    const checkedSlugs = new Set<string>();
    for (const link of normalized.links) {
      if (link.slug && link.slug !== lookupSlug && !checkedSlugs.has(link.slug)) {
        checkedSlugs.add(link.slug);
        const exists = getArticleByLookup(db, link.slug);
        if (!exists) {
          brokenLinks.push({ slug: link.slug, reason: `no article with slug "${link.slug}"` });
        }
      }
    }
    const html = renderMarkdown(normalized.markdown);
    const diagnostics = [
      ...normalized.diagnostics
        .filter((d) => d.severity === "warn" || d.severity === "error")
        .map((d) => ({ severity: d.severity, message: d.message })),
      ...brokenLinks.map((b) => ({ severity: "warn" as const, message: `Broken link to "${b.slug}": ${b.reason}` })),
    ];
    return c.json({ html, diagnostics });
  });

  /**
   * Find articles to use as references during editing.
   * Accepts two independent search modes:
   *   fuzzyTitles – comma-separated titles/slugs/wiki paths (uses existing parser logic)
   *   ragQuery    – freeform text sent to the retrieval pipeline for vector/lexical search
   * Both may be provided in the same request; results are deduped.
   */
  app.post("/api/article/:slug/find-references", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      fuzzyTitles?: string;
      ragQuery?: string;
    };

    const seen = new Set<string>();
    const articles: ArticleReference[] = [];
    const addArticle = (a: { slug: string; title: string; summaryMarkdown?: string }) => {
      const s = slugify(a.slug);
      if (!s || s === article.slug || seen.has(s)) return;
      seen.add(s);
      articles.push({ slug: s, title: a.title, summaryMarkdown: a.summaryMarkdown ?? "" });
    };

    if (body.fuzzyTitles?.trim()) {
      const { articles: matched } = findReferencedArticlesInEditText(db, body.fuzzyTitles, article.slug, 10);
      for (const a of matched) addArticle({ ...a, summaryMarkdown: a.summaryMarkdown ?? "" });

      const fuzzy = findFuzzyTitleMatchesInEditText(
        db, body.fuzzyTitles, article.slug, 10, matched.map((a) => a.slug),
      );
      for (const a of fuzzy) addArticle({ ...a, summaryMarkdown: a.summaryMarkdown ?? "" });
    }

    if (body.ragQuery?.trim()) {
      const retrieved = await retrieveContext(
        db, llm, article.slug, [body.ragQuery.trim()],
        runtime.app.rag.enabled, runtime.app.rag.mode, runtime.app.rag.max_results,
        runtime.app.rag.min_score, runtime.llm.embeddings.enabled, logger,
        body.ragQuery.trim(),
      );
      for (const src of retrieved.sourceArticles) {
        addArticle({ slug: src.slug, title: src.title, summaryMarkdown: src.content?.slice(0, 360) ?? "" });
      }
    }

    return c.json({ articles });
  });

  app.post("/api/article/:slug/add-link", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);

    const body = (await c.req.json().catch(() => ({}))) as {
      selectedText?: string;
    };
    const selectedText = normalizeSelectionText(body.selectedText ?? "");
    if (!selectedText) return c.json({ error: "missing selected text" }, 400);

    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);

    const hints = listIncomingHints(db, article.slug);
    const retrieved = await retrieveContext(
      db,
      llm,
      article.slug,
      hintsToSearchStrings(hints),
      runtime.app.rag.enabled,
      runtime.app.rag.mode,
      runtime.app.rag.max_results,
      runtime.app.rag.min_score,
      runtime.llm.embeddings.enabled,
      logger,
    );
    const excerpt = extractSelectionExcerpt(article.markdown, selectedText);
    const wrapRange = findBestWrapRange(article.markdown, selectedText);
    if (!wrapRange) {
      logger.debug("add_link.wrap_range_not_found", {
        slug: article.slug,
        selected_phrase: selectedText,
      });
      return c.json(
        {
          error:
            "could not find selectable text to wrap in the article markdown",
        },
        422,
      );
    }
    // ── Fast path: visible label resolves to an existing article in the DB ──
    // Try slug-form first, then equivalent-key lookup (handles "The Foo" → "foo").
    const labelSlug = slugify(wrapRange.visibleLabel);
    const existingArticle = labelSlug
      ? (getArticleByLookup(db, labelSlug) ?? getArticleByEquivalentLookup(db, labelSlug))
      : null;
    if (existingArticle && existingArticle.slug !== article.slug) {
      const refLink = `[${wrapRange.visibleLabel}](ref:${existingArticle.slug})`;
      const nextMarkdown = stripSelfLinks(
        article.markdown.slice(0, wrapRange.start) + refLink + article.markdown.slice(wrapRange.end),
        article.slug,
      );
      const recorder = getTraceRecorder(runtime.app.pipeline.trace);
      const result = await runWorkflow(addLinkArticleWorkflow, {
        input: {
          requestId: randomUUID(),
          workflow: "article.add_link",
          slug: article.slug,
          requestedTitle: article.title,
          rawMarkdown: nextMarkdown,
          instructions: `Linked selected text to existing article: ${existingArticle.slug}`,
          userReferenceSlugs: [existingArticle.slug],
        },
        deps: buildPipelineDeps(),
        recorder,
        logger,
      });
      if (result.status === "error") {
        throw result.error ?? new Error("add-link workflow failed");
      }
      const savedSlug = result.state.canonicalSlug ?? article.slug;
      const saved = getArticleByLookup(db, savedSlug);
      if (saved) {
        afterArticleSaved(saved.slug, saved.title, saved.markdown, saved.generated_at);
      }
      logger.info("add_link.resolved_existing", {
        slug: article.slug,
        target_slug: existingArticle.slug,
        visible_label: wrapRange.visibleLabel,
      });
      const response = buildArticleResponseFor(savedSlug);
      if (!response) return c.json({ error: "failed to hydrate response" }, 500);
      return c.json(buildPageResponse(response, { cached: true, canonicalPath: canonicalPathForArticle(response) }));
    }

    // ── Slow path: ask the LLM to suggest a link target ───────────────────────
    logger.debug("add_link.dispatching_llm", {
      slug: article.slug,
      prompt: "link_suggestion",
      reason: "generate link target for selected text",
      visible_label: wrapRange.visibleLabel,
    });
    let suggestion: LinkSuggestion;
    try {
      suggestion = await generateLinkSuggestion(
        llm,
        runtime.prompts,
        article.title,
        wrapRange.visibleLabel,
        excerpt,
        retrieved.context,
        retrieved.relatedTitles,
      );
      logger.debug("add_link.suggestion_received", {
        slug: article.slug,
        target_slug: suggestion.slug,
        description_length: suggestion.description.length,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn("add_link.suggestion_failed", {
        slug: article.slug,
        error: errorMsg,
      });
      return c.json(
        { error: `link suggestion failed: ${errorMsg}` },
        500,
      );
    }

    const targetSlug = normalizeSuggestedTargetSlug(
      suggestion.slug,
      article.slug,
      wrapRange.visibleLabel,
    );
    if (!targetSlug)
      return c.json(
        { error: "link suggestion produced an invalid target" },
        500,
      );

    const wrapped = buildHaluLink(
      wrapRange.visibleLabel,
      targetSlug,
      suggestion.description,
    );
    const nextMarkdown = stripSelfLinks(
      article.markdown.slice(0, wrapRange.start) +
        wrapped +
        article.markdown.slice(wrapRange.end),
      article.slug,
    );

    const recorder = getTraceRecorder(runtime.app.pipeline.trace);
    const result = await runWorkflow(addLinkArticleWorkflow, {
      input: {
        requestId: randomUUID(),
        workflow: "article.add_link",
        slug: article.slug,
        requestedTitle: article.title,
        rawMarkdown: nextMarkdown,
        instructions: `Linked selected text: ${selectedText}`,
      },
      deps: buildPipelineDeps(),
      recorder,
      logger,
    });
    if (result.status === "error") {
      throw result.error ?? new Error("add-link workflow failed");
    }
    const savedSlug = result.state.canonicalSlug ?? article.slug;
    const saved = getArticleByLookup(db, savedSlug);
    if (saved) {
      afterArticleSaved(saved.slug, saved.title, saved.markdown, saved.generated_at);
    }

    invalidateArticleHtml(savedSlug);
    const response = buildArticleResponseFor(savedSlug);
    if (!response) return c.json({ error: "failed to hydrate response" }, 500);
    return c.json(
      buildPageResponse(response, {
        cached: true,
        canonicalPath: canonicalPathForArticle(response),
      }),
    );
  });

  // ── Article protection ───────────────────────────────────────────────────

  app.post("/api/article/:slug/protect", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { isProtected?: boolean };
    const newValue = body.isProtected ?? !isArticleProtected(db, article.slug);
    setArticleProtection(db, article.slug, newValue);
    logger.info("article.protection_changed", { slug: article.slug, isProtected: newValue });
    return c.json({ ok: true, slug: article.slug, isProtected: newValue });
  });

  app.post("/api/article/:slug/protect-section", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { sectionId?: string; heading?: string; isProtected?: boolean };
    const sectionId = body.sectionId ?? "";
    if (!sectionId) return c.json({ error: "missing sectionId" }, 400);
    const heading = body.heading ?? sectionId;
    const newValue = body.isProtected ?? !isArticleSectionProtected(db, article.slug, sectionId);
    setArticleSectionProtection(db, article.slug, sectionId, heading, newValue);
    logger.info("article.section_protection_changed", { slug: article.slug, sectionId, isProtected: newValue });
    const sections = listProtectedSections(db, article.slug);
    return c.json({ ok: true, slug: article.slug, sectionId, isProtected: newValue, protectedSections: sections });
  });

  app.patch("/api/article/:slug/update-title", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { title?: string };
    const newTitle = (body.title ?? "").replace(/\[.*?\]\(.*?\)/g, "").trim(); // strip links
    if (!newTitle) return c.json({ error: "title cannot be empty" }, 400);
    const updated = updateArticleTitle(db, article.slug, newTitle);
    if (!updated) return c.json({ error: "article not found" }, 404);
    // Rebuild HTML with new title in heading
    const newMarkdown = updated.markdown.replace(/^#\s+.+?$/m, `# ${newTitle}`);
    const links = extractInternalLinks(newMarkdown);
    const newHtml = renderMarkdown(newMarkdown);
    db.prepare(`UPDATE articles SET markdown = ?, html = ?, plain_text = ?, display_title = '' WHERE slug = ?`)
      .run(newMarkdown, newHtml, markdownToPlainText(newMarkdown), article.slug);
    // Save revision
    db.prepare(
      `INSERT INTO article_revisions (article_slug, title, markdown, html, summary_markdown, plain_text, generated_at, created_at, operation, instructions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(article.slug, newTitle, newMarkdown, newHtml, updated.summaryMarkdown ?? "", markdownToPlainText(newMarkdown), article.generated_at, Date.now(), "title-edit", `Title changed to: ${newTitle}`);
    invalidateArticleHtml(article.slug);
    // Fire post-processing hooks for reindex + summary update
    afterArticleSaved(article.slug, newTitle, newMarkdown, article.generated_at);
    logger.info("article.title_updated", { slug: article.slug, newTitle });
    const response = buildArticleResponseFor(article.slug);
    if (!response) return c.json({ error: "failed to hydrate response" }, 500);
    return c.json(buildPageResponse(response, { cached: true, canonicalPath: canonicalPathForArticle(updated) }));
  });

  app.post("/api/article/:slug/rewrite", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);

    const body = (await c.req.json().catch(() => ({}))) as {
      instructions?: string;
      sectionId?: string;
      selectedText?: string;
      ragEnabled?: boolean;
      ragQuery?: string;
      rewriteMode?: string;
      // Slugs the user has selected in the editor UI. These survive pruning.
      referenceSlugs?: string[];
      // Subset of referenceSlugs that the user has pinned. Pinned refs are free
      // (don't count toward max_references) and survive all future pruning.
      pinnedSlugs?: string[];
      // Slugs the user has explicitly removed. Excluded from the result even
      // if they would otherwise score well enough to be included.
      blacklistSlugs?: string[];
      includeRecentEditHistory?: boolean;
      /** When true, bypass article-level protection (user is explicitly editing). */
      isManualEdit?: boolean;
    };
    const instructions = (body.instructions ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2500);
    if (!instructions)
      return c.json({ error: "missing rewrite instructions" }, 400);

    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);

    // ── Protection check ──────────────────────────────────────────────────────
    const isManualEdit = body.isManualEdit === true;
    const articleIsProtected = !isManualEdit && !body.sectionId && !body.selectedText && isArticleProtected(db, article.slug);
    if (articleIsProtected) {
      // Skip LLM entirely; record that the rewrite was blocked and return current content.
      const links = extractInternalLinks(article.markdown);
      db.prepare(
        `INSERT INTO article_revisions (article_slug, title, markdown, html, summary_markdown, plain_text, generated_at, created_at, operation, instructions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(article.slug, article.title, article.markdown, article.html, article.summaryMarkdown ?? "", article.plain_text, article.generated_at, Date.now(), "rewrite-skipped-protected", instructions);
      logger.info("article.rewrite_blocked_protection", { slug: article.slug });
      const response = buildArticleResponseFor(article.slug);
      if (!response) return c.json({ error: "failed to hydrate response" }, 500);
      return c.json(buildPageResponse(response, { cached: true, canonicalPath: canonicalPathForArticle(article) }));
    }

    const selectedText = (body.selectedText ?? "").trim();
    let selectionRange: { start: number; end: number } | null = null;
    if (selectedText) {
      // Use the position-mapped finder so formatted selections (bold, links, etc.)
      // are located correctly even when the plain-text does not appear verbatim.
      selectionRange = findSelectionRangeInMarkdown(article.markdown, selectedText);
      if (!selectionRange)
        return c.json({ error: "selected text not found in article" }, 422);
    }

    const sectionId = (body.sectionId ?? "").trim();
    // Send the actual markdown slice (not the client plain text) so the LLM
    // sees proper markdown syntax and can return well-formed replacement markdown.
    const articleBodyOnly = stripTopLevelSections(article.markdown, [
      "References",
      "See also",
    ]);
    const selectedSection = selectionRange
      ? article.markdown.slice(selectionRange.start, selectionRange.end)
      : sectionId
        ? articleSectionMarkdown(article.markdown, sectionId)
        : articleBodyOnly;

    const ragEnabled = body.ragEnabled === true;
    const ragQuery = (body.ragQuery ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
    // Explicit reference slugs from the new UI — survive pruning for this build.
    const explicitSlugs = (body.referenceSlugs ?? [])
      .map((s) => slugify(s))
      .filter(Boolean);
    // Which of those refs the user has pinned — pinned refs don't count toward cap.
    const pinnedSlugsSet = new Set(
      (body.pinnedSlugs ?? []).map((s) => slugify(s)).filter(Boolean),
    );
    // Slugs the user removed — excluded even if RAG would otherwise pick them.
    const blacklistSlugs = (body.blacklistSlugs ?? [])
      .map((s) => slugify(s))
      .filter(Boolean);
    const partialEdit = Boolean(selectionRange || sectionId);
    const priorReferenceList = loadPriorReferenceList(db, article.slug) ?? [];
    const priorReferenceSlugs = priorReferenceList.map((ref) => ref.slug);
    const priorReferenceSlugSet = new Set(priorReferenceSlugs);
    const newExplicitSlugs = explicitSlugs.filter((slug) => !priorReferenceSlugSet.has(slug));
    const effectiveExplicitSlugs = partialEdit
      ? Array.from(new Set([...priorReferenceSlugs, ...newExplicitSlugs]))
      : explicitSlugs;
    const effectiveUserAdditionSlugs = partialEdit ? newExplicitSlugs : explicitSlugs;
    const effectiveBlacklistSlugs = partialEdit ? [] : blacklistSlugs;

    const rewriteReason = selectionRange ? "selection_edit" : sectionId ? "section_edit" : "full_rewrite";
    logger.debug("rewrite.starting", {
      slug: lookupSlug,
      reason: rewriteReason,
      references_mode: effectiveExplicitSlugs.length > 0 ? "explicit" : ragEnabled ? "rag_query" : "automatic",
      explicit_refs: effectiveExplicitSlugs.length,
      new_explicit_refs: newExplicitSlugs.length,
      preserved_prior_refs: partialEdit ? priorReferenceSlugs.length : 0,
      rag_query_length: ragQuery.length,
      instructions_length: instructions.length,
    });

    const hints = listIncomingHints(db, article.slug);
    let retrieved: Awaited<ReturnType<typeof retrieveContext>>;

    // todo: make prints prettier instead of json
    if (effectiveExplicitSlugs.length > 0) {
      // User explicitly selected references — use them directly, skip automatic RAG.
      // Also include saved prior-session references for continuity.
      logger.debug("rewrite.using_explicit_references", { slug: lookupSlug, count: effectiveExplicitSlugs.length });
      const savedRefSlugs = priorReferenceSlugs;
      const allDirectSlugs = Array.from(new Set([...effectiveExplicitSlugs, ...savedRefSlugs]));
      const direct = retrieveDirectArticleContext(
        db,
        article.slug,
        allDirectSlugs,
        runtime.app.rag.mode,
        runtime.app.rag.max_results,
        logger,
      );
      logger.info("rag.explicit_references", {
        slug: article.slug,
        explicit_count: effectiveExplicitSlugs.length,
        explicit: effectiveExplicitSlugs.join(", "),
        saved_extra: savedRefSlugs.filter((s) => !effectiveExplicitSlugs.includes(s)).join(", ") || "(none)",
        total_direct_slugs: allDirectSlugs.length,
        all_direct: allDirectSlugs.join(", "),
      });
      logger.debug("rag.explicit_references_detail", {
        slug: article.slug,
        explicit_slugs: JSON.stringify(effectiveExplicitSlugs),
        all_direct_slugs: JSON.stringify(allDirectSlugs),
        direct_context_sources: JSON.stringify(
          direct.sourceArticles.map((a) => ({ slug: a.slug, title: a.title })),
        ),
      });
      retrieved = direct;
    } else if (ragEnabled) {
      const hintStrings = hintsToSearchStrings(hints);
      const userSearchText = ragQuery || instructions;
      const articleRetrieved = await retrieveContext(
        db,
        llm,
        article.slug,
        userSearchText ? [userSearchText] : hintStrings,
        runtime.app.rag.enabled,
        runtime.app.rag.mode,
        runtime.app.rag.max_results,
        runtime.app.rag.min_score,
        runtime.llm.embeddings.enabled,
        logger,
        userSearchText || undefined,
      );
      const editReferences = findReferencedArticlesInEditText(
        db,
        `${ragQuery} ${instructions}`,
        article.slug,
      );
      const fuzzyTitleMatches = findFuzzyTitleMatchesInEditText(
        db,
        `${userSearchText} ${instructions}`,
        article.slug,
        runtime.app.rag.max_results,
        editReferences.articles.map((a) => a.slug),
      );
      const savedRefSlugs = priorReferenceSlugs;
      const allDirectSlugs = Array.from(
        new Set([
          ...savedRefSlugs,
          ...[...editReferences.articles, ...fuzzyTitleMatches].map((a) => a.slug),
        ]),
      );
      const editRetrieved = retrieveDirectArticleContext(
        db,
        article.slug,
        allDirectSlugs,
        runtime.app.rag.mode,
        runtime.app.rag.max_results,
        logger,
      );
      logger.info("rag.edit_references", {
        slug: article.slug,
        ragQuery,
        requested: editReferences.requested.length,
        resolved: editReferences.articles.length,
        fuzzy_resolved: fuzzyTitleMatches.length,
        missing: editReferences.missing.length,
        resolved_slugs:
          [...editReferences.articles, ...fuzzyTitleMatches]
            .map((a) => a.slug)
            .join(", ") || "(none)",
      });
      retrieved = mergeRetrievedContextPackets(editRetrieved, articleRetrieved);
    } else {
      retrieved = { context: "", relatedTitles: [], sourceArticles: [] };
    }

    const requestedMode = (body.rewriteMode ?? "aggressive").toLowerCase();
    const modeConfig =
      runtime.prompts.rewriteModes[requestedMode] ??
      runtime.prompts.rewriteModes.aggressive;
    const modePrompt = modeConfig?.prompt ?? "";

    const prompt = getPrompt(runtime.prompts, "article_rewrite");
    const renderedSystemPrompt = renderTemplate(prompt.system, {
      rewrite_mode: modePrompt,
      link_hints: formatIncomingHintsForPrompt(hints, article.slug),
    });
    const wantsStream =
      c.req.query("stream") === "1" ||
      (c.req.header("accept") ?? "").includes("application/x-ndjson");

    const recorder = getTraceRecorder(runtime.app.pipeline.trace);
    const rewriteInput = {
      requestId: randomUUID(),
      workflow: "article.rewrite",
      slug: article.slug,
      requestedTitle: article.title,
      instructions,
      pinnedSlugs: Array.from(pinnedSlugsSet),
      userReferenceSlugs: explicitSlugs,
      blacklistSlugs: effectiveBlacklistSlugs,
      selectedText: selectedText || undefined,
      targetSectionId: sectionId || undefined,
      ragEnabled: ragEnabled || undefined,
      ragQuery: ragQuery || undefined,
      rewriteModeName: (body.rewriteMode ?? "") || undefined,
      isManualEdit: body.isManualEdit === true || undefined,
      includeRecentEditHistory: body.includeRecentEditHistory === true || undefined,
    };

    const runRewrite = async (send?: (payload: unknown) => void) => {
      inFlightEdits.add(article.slug);
      try {
        const onProgress = send
          ? (html: string, markdown: string) => send({ type: "progress", html, markdown })
          : undefined;
        const result = await runWorkflow(rewriteArticleWorkflow, {
          input: rewriteInput,
          deps: buildPipelineDeps({ onProgress }),
          recorder,
          logger,
        });
        if (result.status === "error") throw result.error ?? new Error("rewrite failed");

        const updatedSlug = result.state.canonicalSlug ?? article.slug;
        invalidateArticleHtml(updatedSlug);

        trackGeneration(
          runWorkflow(postProcessWorkflow, {
            input: {
              requestId: randomUUID(),
              workflow: "article.post_process",
              slug: updatedSlug,
              requestedTitle: article.title,
              blacklistSlugs: effectiveBlacklistSlugs,
            },
            deps: buildPipelineDeps(),
            recorder,
            logger,
          }).catch(() => {}),
        );

        const updatedRecord = getArticleByLookup(db, updatedSlug);
        const response = buildArticleResponseFor(updatedSlug);
        if (!response) throw new Error(`failed to hydrate response for ${updatedSlug}`);
        return buildPageResponse(response, {
          cached: true,
          canonicalPath: updatedRecord ? canonicalPathForArticle(updatedRecord) : `/wiki/${updatedSlug}`,
        });
      } finally {
        inFlightEdits.delete(article.slug);
      }
    };

    if (wantsStream) {
      const encoder = new TextEncoder();
      let rewriteStreamOpen = true;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: unknown) => {
            if (!rewriteStreamOpen) return;
            try { controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`)); }
            catch { rewriteStreamOpen = false; }
          };
          const close = () => {
            if (!rewriteStreamOpen) return;
            rewriteStreamOpen = false;
            try { controller.close(); } catch {}
          };
          send({ type: "start", slug: article.slug, cached: false });
          trackGeneration(
            runRewrite(send).then((payload) => {
              send({ type: "done", ...payload });
              close();
            }).catch((error) => {
              send({ type: "error", message: error instanceof Error ? error.message : String(error) });
              close();
            }),
          );
        },
        cancel() { rewriteStreamOpen = false; },
      });
      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
      });
    }

    try {
      return c.json(await runRewrite());
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 422);
    }
  });

  app.post("/api/article/:slug/refresh-context", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);
    const wantsStream =
      c.req.query("stream") === "1" ||
      /\bapplication\/x-ndjson\b/i.test(c.req.header("accept") ?? "");

    const runRefresh = async (
      send?: (event: Record<string, unknown>) => void,
    ) => {
      send?.({ type: "status", message: "Retrieving context..." });
      const recorder = getTraceRecorder(runtime.app.pipeline.trace);

      const onProgress = send
        ? (html: string, markdown: string) => send({ type: "progress", html, markdown })
        : undefined;

      const result = await runWorkflow(refreshArticleWorkflow, {
        input: {
          requestId: randomUUID(),
          workflow: "article.refresh",
          slug: article.slug,
          requestedTitle: article.title,
          instructions: "article.refresh",
        },
        deps: buildPipelineDeps({ onProgress }),
        recorder,
        logger,
      });
      if (result.status === "error") throw result.error ?? new Error("refresh failed");

      const updatedSlug = result.state.canonicalSlug ?? article.slug;
      const persistedAt = result.state.persistedAt;
      const updatedRecord = getArticleByLookup(db, updatedSlug);
      const refreshChanged = !!updatedRecord && updatedRecord.markdown !== article.markdown;
      logger.info("page.refresh", { slug: updatedSlug, changed: refreshChanged });
      invalidateArticleHtml(updatedSlug);

      trackGeneration(
        runWorkflow(postProcessWorkflow, {
          input: {
            requestId: randomUUID(),
            workflow: "article.post_process",
            slug: updatedSlug,
            requestedTitle: article.title,
          },
          deps: buildPipelineDeps(),
          recorder,
          logger,
        }).catch(() => {}),
      );

      const response = buildArticleResponseFor(updatedSlug);
      if (!response) throw new Error("failed to hydrate response");
      return buildPageResponse(response, {
        cached: true,
        canonicalPath: updatedRecord ? canonicalPathForArticle(updatedRecord) : `/wiki/${updatedSlug}`,
        refreshChanged,
      });
      void persistedAt;
    };

    if (wantsStream) {
      let streamOpen = true;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const send = (event: Record<string, unknown>) => {
            if (!streamOpen) return;
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          };
          send({ type: "start", slug: article.slug, cached: true });
          const safeClose = () => {
            if (!streamOpen) return;
            streamOpen = false;
            try { controller.close(); } catch { /* client already disconnected */ }
          };
          const refresh = (async () => {
            const payload = await runRefresh(send);
            send({ type: "done", ...payload });
            safeClose();
          })().catch((error) => {
            send({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
            safeClose();
          });
          trackGeneration(refresh);
        },
        cancel() {
          streamOpen = false;
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    try {
      return c.json(await runRefresh());
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
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
    const body = (await c.req.json().catch(() => ({}))) as {
      revisionId?: number;
    };
    const revisionId = Math.max(0, Number(body.revisionId) || 0);
    if (!revisionId) return c.json({ error: "missing revision id" }, 400);
    const current = getArticleByLookup(db, lookupSlug);
    if (!current) return c.json({ error: "article not found" }, 404);
    const revision = getArticleRevision(db, revisionId);
    if (!revision || revision.articleSlug !== current.slug)
      return c.json({ error: "revision not found" }, 404);

    const nextArticle = {
      ...current,
      title: revision.title,
      markdown: revision.markdown,
      html: revision.html,
      summaryMarkdown: revision.summaryMarkdown,
      plain_text: revision.plain_text,
      generated_at: Date.now(),
    };
    const links = extractAllBodyLinks(nextArticle.markdown, nextArticle.slug);
    nextArticle.html = rewriteArticleHtml(
      renderMarkdown(nextArticle.markdown),
      links,
    );
    saveArticle(
      db,
      nextArticle,
      links,
      Array.from(new Set([nextArticle.slug, nextArticle.canonicalSlug])),
      {
        operation: "revert",
        instructions: `Reverted to revision ${revision.id}.`,
        revertedFromRevisionId: revision.id,
      },
    );
    afterArticleSaved(nextArticle.slug, nextArticle.title, nextArticle.markdown, nextArticle.generated_at);
    invalidateArticleHtml(nextArticle.slug);
    const response = buildArticleResponseFor(nextArticle.slug);
    if (!response) return c.json({ error: "failed to hydrate response" }, 500);
    return c.json(
      buildPageResponse(response, {
        cached: true,
        canonicalPath: canonicalPathForArticle(nextArticle),
      }),
    );
  });

  app.get("/api/index", (c) => {
    const offset = Math.max(parseInt(c.req.query("cursor") ?? "0", 10) || 0, 0);
    const all = c.req.query("all") === "1";
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") ?? (all ? "10000" : "200"), 10) || 200, 1),
      all ? 10000 : 500,
    );
    const page = listArticles(db, offset, limit);
    return c.json({
      items: page.items,
      cursor: page.nextOffset === null ? null : String(page.nextOffset),
      complete: page.nextOffset === null,
      total: page.total,
    });
  });

  registerPipelineAdminRoutes(app, () => runtime.app.pipeline.trace, () => ({
    db,
    llm,
    prompts: buildPromptRegistry(runtime.prompts),
    logger,
    runtime,
  }));

  app.get("/api/admin/overview", (c) => {
    const modelConfigs = {
      heavy: {
        model: runtime.llm.chat.model,
        baseUrl: runtime.llm.chat.base_url,
      },
      light: {
        model: runtime.llm.light.model,
        baseUrl: runtime.llm.light.base_url,
      },
    };
    return c.json({
      ...getAdminOverview(db),
      model: runtime.llm.chat.model,
      databasePath: runtime.app.storage.database_path,
      promptConfigPath: "config/prompts",
      ragMode: runtime.app.rag.mode,
      modelConfigs,
      promptModelAssociations: Object.keys(runtime.prompts.prompts)
        .sort()
        .map((key) => {
          const prompt = getPrompt(runtime.prompts, key);
          const modelRole = prompt.model;
          const modelConfig = modelConfigs[modelRole];
          return {
            key,
            model: modelRole,
            modelName: modelConfig.model,
            baseUrl: modelConfig.baseUrl,
            thinking: prompt.thinking,
          };
        }),
    });
  });

  app.get("/api/admin/generation-queue", (c) => {
    return c.json(generationQueuePayload());
  });

  app.post("/api/admin/reload", async (c) => {
    await reloadRuntime();
    return c.json({ ok: true });
  });

  app.post("/api/admin/prompt-model", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      key?: string;
      model?: string;
      thinking?: unknown;
    };
    const key = String(body.key ?? "");
    const model = body.model === "light" ? "light" : body.model === "heavy" ? "heavy" : null;
    if (!key || !Object.hasOwn(runtime.prompts.prompts, key)) {
      return c.json({ error: "unknown runnable prompt" }, 400);
    }
    if (!model) {
      return c.json({ error: "model must be heavy or light" }, 400);
    }
    const thinking = body.thinking === true;
    try {
      updateRunnablePromptConfig(key, model, thinking);
      await reloadRuntime();
      const prompt = getPrompt(runtime.prompts, key);
      return c.json({
        ok: true,
        key,
        model: prompt.model,
        thinking: prompt.thinking,
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  });

  app.post("/api/admin/wipe", (c) => {
    const dbPath = resolve(process.cwd(), runtime.app.storage.database_path);
    if (existsSync(dbPath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${dbPath}.backup-${ts}`;
      try {
        copyFileSync(dbPath, backupPath);
        logger.info("admin.backup_before_wipe", { backup: backupPath });
      } catch (err) {
        logger.error("admin.backup_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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

  app.post("/api/admin/regenerate-summary", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { slug?: string };
    const lookupSlug = articleLookupSlugFromInput(body.slug ?? "");
    if (!lookupSlug) return c.json({ error: "missing slug" }, 400);

    try {
      await reloadRuntime();
      const recorder = getTraceRecorder(runtime.app.pipeline.trace);
      const result = await runWorkflow(regenerateSummaryWorkflow, {
        input: { requestId: randomUUID(), workflow: "regenerate.summary", slug: lookupSlug },
        deps: buildPipelineDeps(),
        recorder,
        logger,
      });

      if (result.status === "error") throw result.error ?? new Error("regenerate-summary failed");

      const loadedArticle = (result.state as any).loadedArticle;
      const updated = getArticleByLookup(db, loadedArticle?.slug);
      if (!updated) return c.json({ error: "article not found" }, 404);

      return c.json({
        ok: true,
        slug: updated.slug,
        canonicalPath: canonicalPathForArticle(updated),
        article: updated,
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  });

  // ── Alias / redirect management ─────────────────────────────────────────

  app.get("/api/admin/slug-search", (c) => {
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json({ results: [] });
    const results = searchSlugFuzzy(db, q.trim());
    return c.json({ results });
  });

  app.get("/api/admin/slug-aliases/:slug", (c) => {
    const slug = c.req.param("slug");
    const aliases = listAliasesForSlug(db, slug);
    const article = getArticleByLookup(db, slug);
    return c.json({ slug, articleExists: !!article, aliases });
  });

  app.post("/api/admin/slug-aliases", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { aliasSlug?: string; articleSlug?: string };
    const aliasSlug = slugify(body.aliasSlug ?? "");
    const articleSlug = slugify(body.articleSlug ?? "");
    if (!aliasSlug || !articleSlug) return c.json({ error: "missing aliasSlug or articleSlug" }, 400);
    if (aliasSlug === articleSlug) return c.json({ error: "alias and canonical slug must differ" }, 400);
    const canonical = getArticleByLookup(db, articleSlug);
    if (!canonical) return c.json({ error: "canonical article not found" }, 404);
    addSlugAlias(db, aliasSlug, articleSlug);
    logger.info("admin.alias_added", { aliasSlug, articleSlug });
    return c.json({ ok: true, aliasSlug, articleSlug });
  });

  app.delete("/api/admin/slug-aliases/:aliasSlug", (c) => {
    const aliasSlug = c.req.param("aliasSlug");
    removeSlugAlias(db, aliasSlug);
    logger.info("admin.alias_removed", { aliasSlug });
    return c.json({ ok: true });
  });

  // Canonical redirect: make sourceSlug redirect to canonicalSlug,
  // archiving any existing article at sourceSlug.
  app.post("/api/admin/slug-redirect", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      sourceSlug?: string;
      canonicalSlug?: string;
      confirm?: boolean;
    };
    const sourceSlug = slugify(body.sourceSlug ?? "");
    const canonicalSlug = slugify(body.canonicalSlug ?? "");
    if (!sourceSlug || !canonicalSlug) return c.json({ error: "missing sourceSlug or canonicalSlug" }, 400);
    if (sourceSlug === canonicalSlug) return c.json({ error: "source and canonical slugs must differ" }, 400);

    const canonical = getArticleByLookup(db, canonicalSlug);
    if (!canonical) return c.json({ error: "canonical article not found" }, 404);

    const displaced = getArticleByLookup(db, sourceSlug);
    if (displaced && !body.confirm) {
      return c.json({
        requiresConfirm: true,
        displacedSlug: displaced.slug,
        displacedTitle: displaced.title,
        message: `Article "${displaced.title}" at ${displaced.slug} will be archived. Send confirm:true to proceed.`,
      });
    }

    if (displaced) {
      archiveArticle(db, displaced, `displaced by canonical redirect → ${canonicalSlug}`);
      deleteArticleBySlug(db, displaced.slug);
      logger.info("admin.article_archived", { slug: displaced.slug, reason: "canonical_redirect", canonicalSlug });
    }

    addSlugAlias(db, sourceSlug, canonicalSlug);
    logger.info("admin.redirect_added", { sourceSlug, canonicalSlug, displaced: displaced?.slug ?? null });
    return c.json({ ok: true, sourceSlug, canonicalSlug, archived: displaced ? displaced.slug : null });
  });

  // ── Database backup download ──────────────────────────────────────────────

  app.get("/api/admin/db-backup/latest", async (c) => {
    const dbPath = resolve(process.cwd(), runtime.app.storage.database_path);
    const backupDir = dirname(dbPath);
    const prefix = basename(dbPath) + ".backup-";
    if (!existsSync(backupDir)) return c.json({ error: "no backups found" }, 404);
    const latest = readdirSync(backupDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".gz"))
      .sort()
      .reverse()[0];
    if (!latest) return c.json({ error: "no backups found" }, 404);
    const latestPath = resolve(backupDir, latest);
    const { size } = await fsStat(latestPath);
    const stream = (await import("node:fs")).createReadStream(latestPath);
    return new Response(stream as any, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${latest}"`,
        "Content-Length": String(size),
      },
    });
  });

  // ── Archived articles ─────────────────────────────────────────────────────

  app.get("/api/admin/archived", (c) => {
    return c.json({ archived: listArchivedArticles(db) });
  });

  app.post("/api/admin/archived/:slug/restore", async (c) => {
    const slug = c.req.param("slug");
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: boolean };
    const archived = getArchivedArticle(db, slug);
    if (!archived) return c.json({ error: "archived article not found" }, 404);

    const existing = getArticleByLookup(db, slug);
    if (existing && !body.confirm) {
      return c.json({
        requiresConfirm: true,
        message: `An article already exists at ${slug}. Send confirm:true to overwrite it with the archived version.`,
      });
    }

    const links = extractInternalLinks(archived.markdown);
    saveArticle(
      db,
      {
        slug: archived.slug,
        canonicalSlug: archived.canonicalSlug,
        title: archived.title,
        markdown: archived.markdown,
        html: archived.html,
        plain_text: archived.plain_text,
        generated_at: archived.generated_at,
      },
      links,
      [archived.slug],
    );
    deleteArchivedArticle(db, slug);
    removeSlugAlias(db, slug);
    logger.info("admin.article_restored", { slug });
    return c.json({ ok: true, slug });
  });

  app.get("/api/admin/prompts", (c) => {
    return c.json(listPromptFiles());
  });

  app.get("/api/admin/prompt/:scope/:key", (c) => {
    const scope = c.req.param("scope");
    if (scope !== "runnable" && scope !== "shared") {
      return c.json({ error: "scope must be runnable or shared" }, 400);
    }
    const key = c.req.param("key");
    const meta = readPromptFile(scope, key);
    if (!meta) return c.json({ error: "prompt not found" }, 404);
    // DB is authoritative for content; TOML file provides metadata (model, thinking, etc.)
    const dbCurrent = getPromptCurrent(db, scope, key);
    return c.json({ ...meta, ...(dbCurrent ?? {}) });
  });

  app.put("/api/admin/prompt/:scope/:key", async (c) => {
    const scope = c.req.param("scope");
    if (scope !== "runnable" && scope !== "shared") {
      return c.json({ error: "scope must be runnable or shared" }, 400);
    }
    const key = c.req.param("key");
    const body = await c.req.json().catch(() => ({})) as { system?: unknown; user?: unknown };
    if (typeof body.system !== "string" || typeof body.user !== "string") {
      return c.json({ error: "system and user must be strings" }, 400);
    }
    const existing = getPromptCurrent(db, scope, key) ?? readPromptFile(scope, key);
    // Write TOML first so writePromptFile can verify the file exists.
    const err = writePromptFile(scope, key, body.system, body.user);
    if (err) return c.json(err, 400);
    if (existing) {
      recordPromptRevision(db, scope, key, existing.system, existing.user, body.system, body.user, "save");
    }
    setPromptCurrent(db, scope, key, body.system, body.user);
    await reloadRuntime();
    const meta = readPromptFile(scope, key);
    return c.json({ ok: true, prompt: meta ? { ...meta, system: body.system, user: body.user } : null });
  });

  app.get("/api/admin/prompt/:scope/:key/revisions", (c) => {
    const scope = c.req.param("scope");
    if (scope !== "runnable" && scope !== "shared") {
      return c.json({ error: "scope must be runnable or shared" }, 400);
    }
    const key = c.req.param("key");
    return c.json({ revisions: listPromptRevisions(db, scope, key) });
  });

  app.get("/api/admin/prompt/:scope/:key/revisions/:id", (c) => {
    const scope = c.req.param("scope");
    if (scope !== "runnable" && scope !== "shared") {
      return c.json({ error: "scope must be runnable or shared" }, 400);
    }
    const key = c.req.param("key");
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const current = getPromptCurrent(db, scope, key) ?? readPromptFile(scope, key);
    if (!current) return c.json({ error: "prompt not found" }, 404);
    const result = reconstructPromptRevision(db, scope, key, id, current.system, current.user);
    if (!result) return c.json({ error: "revision not found or patch failed" }, 404);
    return c.json({ id, system: result.system, user: result.user });
  });

  app.post("/api/admin/prompt/:scope/:key/revisions/:id/revert", async (c) => {
    const scope = c.req.param("scope");
    if (scope !== "runnable" && scope !== "shared") {
      return c.json({ error: "scope must be runnable or shared" }, 400);
    }
    const key = c.req.param("key");
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const current = getPromptCurrent(db, scope, key) ?? readPromptFile(scope, key);
    if (!current) return c.json({ error: "prompt not found" }, 404);
    const target = reconstructPromptRevision(db, scope, key, id, current.system, current.user);
    if (!target) return c.json({ error: "revision not found or patch failed" }, 404);
    const err = writePromptFile(scope, key, target.system, target.user);
    if (err) return c.json(err, 400);
    recordPromptRevision(db, scope, key, current.system, current.user, target.system, target.user, "revert", id);
    setPromptCurrent(db, scope, key, target.system, target.user);
    await reloadRuntime();
    const meta = readPromptFile(scope, key);
    return c.json({ ok: true, prompt: meta ? { ...meta, system: target.system, user: target.user } : null });
  });

  app.post("/api/disambiguation", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      entries?: Array<{ title: string; description: string }>;
    };
    const title = (body.title ?? "").replace(/\s+/g, " ").trim();
    if (!title) return c.json({ error: "missing title" }, 400);
    const entries = (body.entries ?? []).filter(
      (e) => e.title?.trim() && e.description?.trim(),
    );
    if (entries.length < 2)
      return c.json({ error: "at least 2 entries required" }, 400);

    const normalizedTitle = normalizeCanonicalTitle(title);
    const slug = slugify(normalizedTitle);
    if (!slug) return c.json({ error: "invalid title" }, 400);

    const lines = [
      `# ${normalizedTitle} (disambiguation)`,
      "",
      `**${normalizedTitle}** may refer to:`,
      "",
    ];
    for (const entry of entries) {
      const entrySlug = slugify(entry.title.trim());
      const hint = entry.description.trim();
      lines.push(
        `- ${buildHaluLink(entry.title.trim(), entrySlug, hint)} — ${hint.replace(/"/g, "'")}`,
      );
    }
    const markdown = lines.join("\n");
    const links = extractAllBodyLinks(markdown, slug);
    const article: ArticleRecord = {
      slug,
      canonicalSlug: slug,
      title: `${normalizedTitle} (disambiguation)`,
      markdown,
      html: rewriteArticleHtml(renderMarkdown(markdown), links),
      summaryMarkdown: `Disambiguation page for ${normalizedTitle}.`,
      plain_text: markdownToPlainText(markdown),
      generated_at: Date.now(),
      isDisambiguation: true,
    };
    saveArticle(db, article, links, [slug], {
      operation: "create-disambiguation",
      instructions: `Created disambiguation page for ${normalizedTitle}.`,
    });

    invalidateArticleHtml(article.slug);
    const dabResponse = buildArticleResponseFor(article.slug);
    if (!dabResponse) return c.json({ error: "failed to hydrate response" }, 500);
    return c.json(
      buildPageResponse(dabResponse, {
        cached: true,
        canonicalPath: canonicalPathForArticle(article),
      }),
    );
  });

  app.get("/api/disambiguation/:slug", (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article || !article.isDisambiguation)
      return c.json({ error: "not a disambiguation page" }, 404);
    const response = buildArticleResponseFor(article.slug);
    if (!response) return c.json({ error: "failed to hydrate response" }, 500);
    return c.json(
      buildPageResponse(response, {
        cached: true,
        canonicalPath: canonicalPathForArticle(article),
      }),
    );
  });

  app.get("/api/search", (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10) || 0);
    if (!q) {
      const random = getRandomSuggestions(db, 5).map((r) => ({
        slug: r.slug,
        title: r.title,
        summary: r.summaryMarkdown?.trim() || summaryMarkdownFromArticle(r.markdown),
      }));
      return c.json({
        query: "",
        results: [],
        suggestions: random,
        existing_count: 0,
        hallucinated_count: 0,
        rate_limited: false,
        retry_after: null,
        has_more: false,
      });
    }

    const { results: rawResults, hasMore } = searchCorpus(db, q, runtime.app.search.limit, offset);
    const results = rawResults.map((item) => ({
      slug: item.canonicalSlug,
      title: item.title === item.slug ? slugToTitle(item.slug) : item.title,
      summary: item.summary,
      exists: Boolean(item.existsFlag),
    }));

    const resultSlugs = results.map((r) => r.slug);
    const random = offset === 0
      ? getRandomSuggestions(db, 5, resultSlugs).map((r) => ({
          slug: r.slug,
          title: r.title,
          summary: r.summaryMarkdown?.trim() || summaryMarkdownFromArticle(r.markdown),
        }))
      : [];

    return c.json({
      query: q,
      results,
      suggestions: random,
      existing_count: results.filter((item) => item.exists).length,
      hallucinated_count: results.filter((item) => !item.exists).length,
      rate_limited: false,
      retry_after: null,
      has_more: hasMore,
    });
  });

  // ── Media routes ─────────────────────────────────────────────────────────────
  // These must be registered BEFORE the app.get("*") SPA catch-all because
  // that wildcard intercepts all GET requests that aren't matched first.

  app.get("/api/media/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const result = getMediaBytesById(mediaDb, id);
    if (!result) return c.notFound();
    return new Response(result.bytes as unknown as BodyInit, {
      headers: {
        "content-type": result.mime,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });

  app.get("/api/media/:id/info", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const record = getMediaById(mediaDb, id);
    if (!record) return c.json({ error: "not found" }, 404);
    const { model_b64: _b64, ...safe } = record as any;
    return c.json(safe);
  });

  app.patch("/api/media/:id/description", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const body = await c.req.json().catch(() => ({})) as { description?: string };
    const description = typeof body.description === "string" ? body.description.trim() : null;
    if (description === null) return c.json({ error: "description required" }, 400);
    const record = getMediaById(mediaDb, id);
    if (!record) return c.json({ error: "not found" }, 404);
    updateMediaDescription(mediaDb, id, description, "user-edit");
    return c.json({ ok: true });
  });

  app.get("/api/media/:id/history", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const record = getMediaById(mediaDb, id);
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json({ history: listMediaRevisions(mediaDb, id) });
  });

  app.get("/api/media", (c) => {
    const q = c.req.query("q") ?? "";
    const records = listMedia(mediaDb, q || undefined);
    const safe = records.map(({ model_b64: _b64, ...r }) => r);
    return c.json({ media: safe });
  });

  app.get("/api/media/:id/backlinks", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    return c.json({ backlinks: listImageBacklinks(db, id) });
  });

  // Regenerate image description via LLM. Accepts optional instructions that
  // are forwarded to the image_description prompt.
  app.post("/api/media/:id/describe", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const record = getMediaById(mediaDb, id);
    if (!record) return c.json({ error: "not found" }, 404);

    const body = await c.req.json().catch(() => ({})) as { instructions?: string; articleSlug?: string };
    const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
    const articleSlug = typeof body.articleSlug === "string" ? slugify(body.articleSlug) : "";

    const recorder = getTraceRecorder(runtime.app.pipeline.trace);
    const result = await runWorkflow(captionImageWorkflow, {
      input: {
        requestId: randomUUID(),
        workflow: "image.caption",
        slug: articleSlug || undefined,
        requestedTitle: (articleSlug ? getArticleByLookup(db, articleSlug)?.title : undefined) ?? id,
        imageId: id,
        instructions: instructions || undefined,
      },
      deps: buildPipelineDeps(),
      recorder,
      logger,
    });

    if (result.status !== "ok") {
      return c.json({ error: result.error?.message ?? "description generation failed" }, 500);
    }

    // Reload the record to get the updated description. ID never changes on regeneration.
    const updated = getMediaById(mediaDb, id);
    if (!updated) return c.json({ error: "media record missing after describe" }, 500);

    const { model_b64: _b64, ...safe } = updated as any;
    return c.json({ ok: true, media: safe });
  });

  // ── Sidebar (infobox) edit / history / restore endpoints ───────────────────

  /** Re-index RAG chunks for a slug including its current infobox. */
  async function reindexSidebarRag(slug: string): Promise<void> {
    const article = getArticleByLookup(db, slug);
    if (!article) return;
    const rag = runtime.app.rag;
    const useEmbeddings = rag.enabled && runtime.llm.embeddings?.enabled;
    const headlineMedia = getArticleHeadlineMedia(db, slug);
    const imageDescriptions: Array<{ id: string; description: string }> = [];
    if (headlineMedia) {
      const rec = getMediaById(mediaDb, headlineMedia.mediaId);
      if (rec?.description) imageDescriptions.push({ id: rec.id, description: rec.description });
    }
    const infobox = getArticleInfobox(db, slug);
    const infoboxText = infobox ? flattenInfoboxForRag(slug, infobox) : undefined;
    await indexArticleChunks(db, llm, slug, article.markdown, useEmbeddings, rag.chunk_size, logger, imageDescriptions, infoboxText);
  }

  /** Build the pre-rendered sidebar payload for a slug (same shape as page payload). */
  function buildSidebarPayload(slug: string) {
    const rawInfobox = getArticleInfobox(db, slug);
    const sidebarRefs = loadPriorReferenceList(db, slug) ?? [];
    const infobox = rawInfobox
      ? {
          ...rawInfobox,
          subtitle: rawInfobox.subtitle
            ? renderInlineMarkdown(linkReferencesInline(rawInfobox.subtitle, sidebarRefs))
            : undefined,
          groups: rawInfobox.groups.map((g) => ({
            label: g.label,
            rows: g.rows.map((r) => ({
              label: r.label,
              value: renderInlineMarkdown(linkReferencesInline(r.value, sidebarRefs)),
            })),
          })),
        }
      : null;
    const headlineMediaRow = getArticleHeadlineMedia(db, slug);
    const caption = headlineMediaRow?.caption
      ? renderInlineMarkdown(linkReferencesInline(headlineMediaRow.caption, sidebarRefs))
      : "";
    return { infobox, caption };
  }

  // GET /api/article/:slug/infobox — raw (unrendered) infobox data for the editor.
  app.get("/api/article/:slug/infobox", (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const rawInfobox = getArticleInfobox(db, slug);
    const headlineMediaRow = getArticleHeadlineMedia(db, slug);
    return c.json({
      infobox: rawInfobox,
      caption: headlineMediaRow?.caption ?? "",
    });
  });

  // PATCH /api/article/:slug/infobox — raw save of infobox JSON + optional caption.
  app.patch("/api/article/:slug/infobox", async (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, slug);
    if (!article) return c.json({ error: "not found" }, 404);

    const body = await c.req.json().catch(() => ({})) as { infobox?: InfoboxData; caption?: string };
    if (!body.infobox || typeof body.infobox !== "object") return c.json({ error: "infobox required" }, 400);
    const { title, groups } = body.infobox;
    if (!title || !Array.isArray(groups)) return c.json({ error: "invalid infobox shape" }, 400);

    setArticleInfobox(db, slug, body.infobox, "user-edit");
    if (typeof body.caption === "string") {
      updateArticleMediaCaption(db, slug, 1, body.caption.trim(), "user-edit");
    }

    await reindexSidebarRag(slug);
    const payload = buildSidebarPayload(slug);
    notifySidecar(slug, { type: "infobox", infobox: body.infobox });
    if (typeof body.caption === "string") {
      const headlineMedia = getArticleHeadlineMedia(db, slug);
      if (headlineMedia) notifySidecar(slug, { type: "caption", caption: body.caption.trim(), mediaId: headlineMedia.mediaId });
    }

    return c.json({ ok: true, ...payload });
  });

  // POST /api/article/:slug/infobox/regenerate — AI re-generation with optional instructions.
  app.post("/api/article/:slug/infobox/regenerate", async (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, slug);
    if (!article) return c.json({ error: "not found" }, 404);

    const body = await c.req.json().catch(() => ({})) as { instructions?: string };
    const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";

    const prompt = getPrompt(runtime.prompts, "infobox");
    const excerpt = stripTopLevelSections(article.markdown, ["References", "See also"]).slice(0, 6000);
    const instructionsBlock = instructions ? `Additional instructions: ${instructions}\n` : "";

    let raw: string;
    try {
      raw = await llm.chat(
        prompt.model ?? "heavy",
        prompt.system,
        renderTemplate(prompt.user, {
          requested_title: article.title,
          article_excerpt: excerpt,
          instructions: instructionsBlock,
        }),
        { jsonMode: true, thinking: prompt.thinking },
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "LLM error" }, 500);
    }

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return c.json({ error: "no JSON in response" }, 500);
    let parsed: InfoboxData;
    try {
      parsed = JSON.parse(match[0]) as InfoboxData;
      if (!parsed.title || !Array.isArray(parsed.groups)) throw new Error("invalid infobox shape");
    } catch {
      return c.json({ error: "invalid infobox JSON" }, 500);
    }

    setArticleInfobox(db, slug, parsed, "ai-edit");
    await reindexSidebarRag(slug);
    const payload = buildSidebarPayload(slug);
    notifySidecar(slug, { type: "infobox", infobox: parsed });

    return c.json({ ok: true, ...payload });
  });

  // GET /api/article/:slug/infobox/history — list sidebar revisions.
  app.get("/api/article/:slug/infobox/history", (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const revisions = listSidebarRevisions(db, slug);
    return c.json({ revisions });
  });

  // POST /api/article/:slug/infobox/restore — restore a prior sidebar revision.
  app.post("/api/article/:slug/infobox/restore", async (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, slug);
    if (!article) return c.json({ error: "not found" }, 404);

    const body = await c.req.json().catch(() => ({})) as { revisionId?: number };
    if (typeof body.revisionId !== "number") return c.json({ error: "revisionId required" }, 400);
    const rev = getSidebarRevision(db, body.revisionId);
    if (!rev || rev.articleSlug !== slug) return c.json({ error: "revision not found" }, 404);

    if (rev.infoboxJson) {
      let infoboxData: InfoboxData;
      try {
        infoboxData = JSON.parse(rev.infoboxJson) as InfoboxData;
        if (!infoboxData.title || !Array.isArray(infoboxData.groups)) throw new Error("invalid shape");
      } catch {
        return c.json({ error: "stored revision has invalid infobox JSON" }, 500);
      }
      setArticleInfobox(db, slug, infoboxData, "restore");
    }
    if (rev.caption) {
      updateArticleMediaCaption(db, slug, 1, rev.caption, "restore");
    }

    await reindexSidebarRag(slug);
    const payload = buildSidebarPayload(slug);
    const rawInfobox = getArticleInfobox(db, slug);
    if (rawInfobox) notifySidecar(slug, { type: "infobox", infobox: rawInfobox });
    if (rev.caption) {
      const headlineMedia = getArticleHeadlineMedia(db, slug);
      if (headlineMedia) notifySidecar(slug, { type: "caption", caption: rev.caption, mediaId: headlineMedia.mediaId });
    }

    return c.json({ ok: true, ...payload });
  });

  // Live sidecar stream — NDJSON events pushed when post-process updates
  // infobox, caption, or article body for this slug. Clients subscribe on
  // page load and receive updates without polling.
  app.get("/api/article/:slug/live", (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const enc = new TextEncoder();
    let open = true;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (payload: unknown) => {
          if (!open) return;
          try { controller.enqueue(enc.encode(`${JSON.stringify(payload)}\n`)); } catch { open = false; }
        };
        const cb = (e: unknown) => send(e);
        if (!articleListeners.has(slug)) articleListeners.set(slug, new Set());
        articleListeners.get(slug)!.add(cb);
        // Send a heartbeat so the client knows the stream is open.
        send({ type: "ready", slug });
        return () => {
          open = false;
          articleListeners.get(slug)?.delete(cb);
          if (articleListeners.get(slug)?.size === 0) articleListeners.delete(slug);
          try { controller.close(); } catch {}
        };
      },
      cancel() {
        open = false;
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  });

  app.get("/api/article/:slug/image", (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    const headlineMedia = getArticleHeadlineMedia(db, slug);
    if (!headlineMedia) return c.json({ image: null });
    const record = getMediaById(mediaDb, headlineMedia.mediaId);
    if (!record) return c.json({ image: null });
    const { model_b64: _b64, ...safe } = record as any;
    return c.json({
      image: {
        ...safe,
        caption: headlineMedia.caption || record.description,
        articleCaption: headlineMedia.caption,
      },
    });
  });

  /** Shared helper: attach a just-ingested image, fire caption pipeline async. */
  function attachAndCaption(
    articleSlug: string,
    mediaId: string,
    isNew: boolean,
    width: number,
    height: number,
  ) {
    // ── Strip any existing inline media images from the article body ──────────
    // Articles should never have headline images inline; they live in the sidebar.
    const article = getArticleByLookup(db, articleSlug);
    if (article) {
      const cleaned = article.markdown.replace(/!\[[^\]]*\]\(media:[^)]+\)\n?/g, "").trimEnd();
      if (cleaned !== article.markdown) {
        const links = extractInternalLinks(cleaned);
        saveArticle(
          db,
          { ...article, markdown: cleaned, html: renderMarkdown(cleaned), plain_text: markdownToPlainText(cleaned), generated_at: Date.now() },
          links,
          [],
          { operation: "strip-inline-media" },
        );
        invalidateArticleHtml(articleSlug);
      }
    }

    upsertArticleHeadlineMedia(db, articleSlug, mediaId, "");
    invalidateArticleHtml(articleSlug);

    // ── Hash-check: skip pipeline if same image is already captioned ──────────
    const newRecord = getMediaById(mediaDb, mediaId);
    const currentHeadline = getArticleHeadlineMedia(db, articleSlug);
    if (currentHeadline && currentHeadline.caption && newRecord) {
      const currentRecord = getMediaById(mediaDb, currentHeadline.mediaId);
      if (currentRecord && currentRecord.sha256 === newRecord.sha256) {
        logger.info("image.caption_skipped_same_hash", { slug: articleSlug, mediaId, sha256: newRecord.sha256 });
        return { mediaId, isNew, width, height };
      }
    }

    // ── Fire caption + post-process pipeline ──────────────────────────────────
    trackGeneration(
      runWorkflow(captionImageWorkflow, {
        input: {
          requestId: randomUUID(),
          workflow: "image.caption",
          slug: articleSlug,
          requestedTitle: getArticleByLookup(db, articleSlug)?.title ?? articleSlug,
          imageId: mediaId,
        },
        deps: buildPipelineDeps(),
        recorder: getTraceRecorder(runtime.app.pipeline.trace),
        logger,
      })
        .then((result) => {
          if (result.status === "ok") {
            // Rename the temp id (img-xxxx) to the title_slug from the description
            // pipeline. Only at ingest — never during regeneration.
            const titleSlug = result.state.imageCaptionResult?.titleSlug;
            if (titleSlug && titleSlug !== mediaId) {
              const renamed = updateMediaId(mediaDb, mediaId, titleSlug);
              if (renamed) {
                upsertArticleHeadlineMedia(db, articleSlug, titleSlug, "");
                logger.info("media.renamed_after_ingest", { from: mediaId, to: titleSlug });
              }
            }
            invalidateArticleHtml(articleSlug);
            // Fire post-process so the infobox regenerates with the new image context.
            const finalSlug = titleSlug && titleSlug !== mediaId ? titleSlug : mediaId;
            trackGeneration(
              runWorkflow(postProcessWorkflow, {
                input: {
                  requestId: randomUUID(),
                  workflow: "article.post_process",
                  slug: articleSlug,
                  requestedTitle: getArticleByLookup(db, articleSlug)?.title ?? articleSlug,
                },
                deps: buildPipelineDeps(),
                recorder: getTraceRecorder(runtime.app.pipeline.trace),
                logger,
              }).then(() => {
                logger.info("image.post_process_done", { slug: articleSlug, mediaId: finalSlug });
              }).catch(() => {}),
            );
          } else {
            logger.warn("image.caption_workflow_failed", {
              slug: articleSlug,
              mediaId,
              error: result.error?.message ?? "unknown",
            });
          }
        })
        .catch(() => {}),
    );

    return { mediaId, isNew, width, height };
  }

  app.post("/api/article/:slug/image", async (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const body = await c.req.json().catch(() => ({})) as { url?: string; mediaId?: string };

    // Attach an existing media record by ID (search-existing flow)
    if (typeof body.mediaId === "string" && body.mediaId.trim()) {
      const mediaId = body.mediaId.trim();
      const existing = getMediaById(mediaDb, mediaId);
      if (!existing) return c.json({ error: "media not found" }, 404);
      const attached = attachAndCaption(slug, mediaId, false, existing.width, existing.height);
      const response = buildArticleResponseFor(slug);
      if (!response) return c.json({ error: "article not found" }, 404);
      return c.json({ ...attached, article: response });
    }

    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) return c.json({ error: "url or mediaId required" }, 400);
    let result: Awaited<ReturnType<typeof ingestImageFromUrl>>;
    try {
      result = await ingestImageFromUrl(url, { mediaDb, config: runtime.app.images, logger });
    } catch (err: any) {
      return c.json({ error: err?.message || "Image ingestion failed" }, 400);
    }
    const attached = attachAndCaption(slug, result.mediaId, result.isNew, result.width, result.height);
    const response = buildArticleResponseFor(slug);
    if (!response) return c.json({ error: "article not found" }, 404);
    return c.json({ ...attached, article: response });
  });

  app.post("/api/article/:slug/image/upload", async (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    let bytes: Buffer;
    let mime: string;
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData().catch(() => null);
      const file = form?.get("image") as File | null;
      if (!file) return c.json({ error: "no image field in form" }, 400);
      bytes = Buffer.from(await file.arrayBuffer());
      mime = file.type || "image/jpeg";
    } else if (contentType.startsWith("image/")) {
      bytes = Buffer.from(await c.req.arrayBuffer());
      mime = contentType.split(";")[0].trim();
    } else {
      return c.json({ error: "send multipart/form-data with an 'image' field, or raw bytes with an image/* content-type" }, 400);
    }
    let result: Awaited<ReturnType<typeof ingestImageFromBuffer>>;
    try {
      result = await ingestImageFromBuffer(bytes, mime, { mediaDb, config: runtime.app.images, logger });
    } catch (err: any) {
      return c.json({ error: err?.message || "Image processing failed" }, 400);
    }
    const attached = attachAndCaption(slug, result.mediaId, result.isNew, result.width, result.height);
    const response = buildArticleResponseFor(slug);
    if (!response) return c.json({ error: "article not found" }, 404);
    return c.json({ ...attached, article: response });
  });

  app.delete("/api/article/:slug/image", (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    removeArticleMedia(db, slug, 1);
    invalidateArticleHtml(slug);
    const response = buildArticleResponseFor(slug);
    if (!response) return c.json({ error: "article not found" }, 404);
    return c.json({ article: response });
  });

  app.patch("/api/article/:slug/image/caption", async (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const body = await c.req.json().catch(() => ({})) as { caption?: string };
    const caption = typeof body.caption === "string" ? body.caption : null;
    if (caption === null) return c.json({ error: "caption required" }, 400);
    updateArticleMediaCaption(db, slug, 1, caption);
    invalidateArticleHtml(slug);
    return c.json({ ok: true });
  });

  // Comments are intentionally disabled from the active application path for now.
  // Keep the implementation on disk, but do not mount the routes until the feature returns.
  app.use("/assets/*", serveStatic({ root: distRoot }));

  app.get("*", async (c) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/api/")) return c.notFound();

    const bareSlug = routeSlug(path);
    if (path.startsWith("/wiki/")) {
      const requestedSegment = path.slice("/wiki/".length);
      const canonicalPath = `/wiki/${titleToWikiSegment(
        wikiSegmentToRequestedTitle(requestedSegment),
      )}`;
      if (isSlugStyleWikiSegment(requestedSegment) && canonicalPath !== path) {
        logger.info("page.redirect", { slug: bareSlug, from: path });
        return c.redirect(canonicalPath, 302);
      }
    }
    if (bareSlug && !path.startsWith("/wiki/")) {
      logger.info("page.redirect", { slug: bareSlug, from: path });
      return c.redirect(`/wiki/${bareSlug}`, 302);
    }

    if (
      path === "/" ||
      path === "/Random" ||
      path === "/random" ||
      path === "/search" ||
      path === "/all-entries" ||
      path === "/admin" ||
      path === "/graph" ||
      path.startsWith("/media/") ||
      routeSlug(path)
    ) {
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

  app.post("/api/maintenance/trigger", async (c) => {
    const { taskName, reason } = await c.req.json().catch(() => ({}));
    if (!taskName || typeof taskName !== "string") {
      return c.json({ error: "taskName is required and must be a string" }, 400);
    }
    const reasonText = typeof reason === "string" ? reason : "Manual trigger via API";
    maintenance.trigger(taskName, reasonText);
    return c.json({ status: "triggered", taskName, reason: reasonText });
  });

  app.notFound((c) => {
    logger.warn("http.not_found", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
    });
    return c.text("404 Not Found", 404);
  });

  return { app, runtime, shutdown };
}

async function bootstrap() {
  const { app, runtime, shutdown } = await createApp();
  const logger = createConsoleLogger();
  const server = serve(
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
    },
  );

  let shuttingDown = false;
  const gracefulShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown.signal_received");
    server.close();
    await shutdown();
    process.exit(0);
  };

  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  bootstrap().catch((error) => {
    createConsoleLogger().error("server.startup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
