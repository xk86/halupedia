// TODO: split API routes into focused modules.
// TODO: make sure that formatting text isn't being added into link replacement/strips.
import { jsonrepair } from "jsonrepair";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { readFile, stat as fsStat } from "node:fs/promises";
import { extname, resolve, dirname, basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { loadConfig } from "./config";
import { createArticleImagePresetFile, deleteArticleImagePresetFile, listArticleImagePresetFiles, listPromptFiles, readArticleImagePresetFile, readPromptFile, writeArticleImagePresetFile, writePromptFile } from "./promptEditor";
import { listArticleImageAspectRatios, normalizeArticleImageAspectRatioKey, resolveArticleImageAspectRatio } from "./imageAspectRatios";
import {
  deleteArticleBySlug,
  listImageBacklinks,
  getAdminOverview,
  getArticleByLookup,
  getArticleByTitle,
  getArticleByEquivalentLookup,
  getArticleRevision,
  getCanonicalSlugForTarget,
  countArticles,
  getHomepageCache,
  invalidateHomepageCache,
  listArticleRevisions,
  listArticles,
  listBacklinks,
  listHomepageHistory,
  type IncomingHint,
  listIncomingHints,
  openDatabase,
  renameArticleSlug,
  enqueueRagIndexJob,
  countPendingRagJobs,
  saveArticle,
  saveArticleReferences,
  saveArticleSeeAlso,
  getLatestArticleReferences,
  listArticleBlacklistSlugs,
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
  getArticle,
  archiveArticle,
  listArchivedArticles,
  getArchivedArticle,
  deleteArchivedArticle,
  listTopArticles,
  getHeadlineMediaForSlugs,
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
  getArticleVibe,
  setArticleVibe,
  listArticleVibeRevisions,
  reconstructArticleVibeRevision,
  getArticleHeadlineMedia,
  getArticleInfobox,
  setArticleInfobox,
  listSidebarRevisions,
  getSidebarRevision,
  insertArticleRevisionSnapshot,
  upsertArticleHeadlineMedia,
  updateArticleMediaCaption,
  updateLatestArticleRevisionMediaSnapshot,
  removeArticleMedia,
  type InfoboxData,
  type SidebarOperation,
} from "./db";
import { openMediaDatabase, getMediaById, getMediaBytesById, updateMediaDescription, updateMediaGenerationMetadata, updateMediaId, listMedia, listMediaRevisions } from "./mediaDb";
import { createRagRuntime, registerRagAdminRoutes, buildEvidenceContext, toPromptSourceArticles, DEFAULT_PROFILES, type RagRuntime } from "./rag";
import { ensureArticleOntologyFresh, isArticleOntologyStale, listArticleEntityFacts, getArticleEntityId, updateArticleEntityType, addCuratedFact, deleteCuratedFact, suppressFact, updateFact, getVocabularyReviewStats, sanitizePredicateAddition, sanitizePredicateRemoval, appendPredicates, removePredicates, deleteOntologySuggestions, listOntologySuggestions, normalizeLabel, buildOntologyGraphPayload, type ArticleOntologyFact, type PredicateAdditionProposal } from "./ontology";
import { makeVersionedCache } from "./responseCache";
import { applyReferenceOnlyEdit, hasReferenceEditFields, persistBlacklistForEdit } from "./referenceEdits";
import { ingestImageFromUrl, ingestImageFromBuffer } from "./media";
import { generateArticleImage } from "./imageGeneration";
import { captionImageWorkflow } from "./pipeline/workflows/captionImage";
import { findFuzzyTitleMatchesInEditText, findReferencedArticlesInEditText } from "./editReferences";
import { OpenAICompatRouter, fetchHostModels, type LlmRouter } from "./llm";
import type { ChatConfig, ImageGenerationConfig } from "./types";
import { addTomlTable, removeTomlTableKey, setTomlTableValue } from "./tomlEdit";
import { createConsoleLogger, type Logger } from "./logger";
import { MaintenanceScheduler } from "./maintenance";
import { OPTIONAL_OLLAMA_PARAMETER_KEYS, type OptionalOllamaParameterKey } from "../ollamaOptions";
import { articleSectionMarkdown, buildHaluLink, extractDisplayTitle, extractInternalLinks, extractTitle, fixSlugVisibleText, LINK_RE, listArticleSections, markdownToPlainText, normalizeMarkdown, renderMarkdown, renderInlineMarkdown, renderOntologyValueHtml, replaceArticleSection, sectionSlice, spliceProtectedSections, stripFootnoteArtifacts, stripSelfLinks, stripTopLevelSections, summaryMarkdownFromArticle } from "./markdown";
import { getPrompt, getSharedPrompt, renderTemplate } from "./prompts";
import { formatRagContextForPrompt } from "./retrieval";
import { isSlugForm, isSlugStyleWikiSegment, legacySlugify, normalizeCanonicalTitle, slugToTitle, slugify, titleToWikiSegment, wikiSegmentToRequestedTitle, wikiSegmentToTitle } from "./slug";
import { normalizeSummaryMarkdown, summaryLooksLikeLeadCopy } from "./summary";
import { normalizeMarkdownLinks } from "./text/linkNormalize";
import { parseMarkdownLinks } from "./text/markdownLinkParser";
import { formatIncomingHintsForPrompt } from "./linkHints";
import type { ArticleRecord, HomepagePayload, LinkSuggestion, SeeAlsoCandidate } from "./types";
import { extractAllBodyLinks, findExistingArticleLinkReferences, linkReferencesInline, loadPriorReferenceList } from "./referenceList";
import { loadArticle, articleToResponse, type ArticleResponse, type ReferenceStatus, type ReferenceStatusEntry } from "./article";
import { hasCurrentOrNoHomepageNews, isCurrentHomepageNews } from "./todaysNews";
import { assembleArticleMarkdownForRender, renderArticleDisplayHtml, getCachedArticleHtml, rememberArticleHtml, invalidateArticleHtml } from "./articleRender";
import { normalizeSelectionText, findSelectionRangeInMarkdown, shouldRefineSelection, escapeRegExp, collectExistingLinkRanges, overlapsExistingLink, findWrapRange, extractSelectionExcerpt } from "./selectionUtils";
export { findSelectionRangeInMarkdown } from "./selectionUtils";
import { ensureDykHasSourceLink } from "./dyk";
export { ensureDykHasSourceLink } from "./dyk";
import { parseArticleFrameOutput, parsePartialArticleFrame } from "./articleFrame";
export { parseArticleFrameOutput, parsePartialArticleFrame } from "./articleFrame";
import { registerPipelineAdminRoutes } from "./pipeline/adminRoutes";
import { buildPromptRegistry } from "./pipeline/prompts/registry";
import { queueWorkflow } from "./pipeline/runtime/graph";
import { getTraceRecorder } from "./pipeline/runtime/trace";
import { getLiveRunRegistry } from "./pipeline/runtime/liveRegistry";
import { generateArticleWorkflow } from "./pipeline/workflows/generateArticle";
import { refreshArticleWorkflow } from "./pipeline/workflows/refreshArticle";
import { rewriteArticleWorkflow } from "./pipeline/workflows/rewriteArticle";
import { postProcessWorkflow } from "./pipeline/workflows/postProcess";
import { addLinkArticleWorkflow, rawSaveArticleWorkflow } from "./pipeline/workflows/deterministicArticleSave";
import { homepageRefreshWorkflow } from "./pipeline/workflows/homepageRefresh";
import { regenerateSummaryWorkflow } from "./pipeline/workflows/utilities";
import { randomPageWorkflow } from "./pipeline/workflows/randomPage";
import { ontologyInferWorkflow, ontologySuggestionsAppendWorkflow, ontologySuggestionsMergeWorkflow } from "./pipeline/workflows/ontologyInfer";
import { registerAgentRoutes } from "./agent/routes";
import { articleImageGenerationWorkflow } from "./pipeline/workflows/articleImageGeneration";
import type { LiveLlmUpdate, PipelineDeps } from "./pipeline/deps";
import { randomUUID } from "node:crypto";

const RESERVED_PATHS = new Set(["", "search", "all-entries", "admin", "settings", "random", "Random", "graph", "media", "api", "assets"]);
const HOMEPAGE_MAINTENANCE_TASK = "homepage.refresh";
const DB_BACKUP_TASK = "db.backup";
const DB_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DB_BACKUP_KEEP = 7; // keep last 7 compressed backups
const HOMEPAGE_PENDING_RETRY_MS = 5_000;
const HOMEPAGE_REQUEST_TRIGGER_COOLDOWN_MS = 60_000;
const HOMEPAGE_REFRESH_FAILURE_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000] as const;
const HOMEPAGE_REFRESH_GRACE_MS = 250;

function homepageRefreshFailureBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return HOMEPAGE_REFRESH_FAILURE_BACKOFF_MS[Math.min(failures - 1, HOMEPAGE_REFRESH_FAILURE_BACKOFF_MS.length - 1)];
}

function routeSlug(pathname: string) {
  if (pathname.startsWith("/wiki/")) {
    return slugify(decodeURIComponent(pathname.slice("/wiki/".length)));
  }
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  if (!trimmed || RESERVED_PATHS.has(trimmed) || trimmed.includes("/")) return null;
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
  /** Override the LanceDB directory. Tests use this to isolate RAG state. */
  ragPath?: string;
  distRoot?: string;
  skipLlmProbe?: boolean;
  skipHomepagePrepare?: boolean;
  logger?: Logger;
  llmClient?: LlmRouter;
  imageGenerationConfig?: Partial<ImageGenerationConfig>;
}

function titleMatchesRequested(title: string, _requestedTitle: string, requestedSlug: string): boolean {
  return slugify(title) === requestedSlug;
}

type SubjectValidation = {
  status: "valid" | "invalid" | "pending";
  message?: string;
};

function validateLeadSubject(markdown: string, requestedTitle: string, requestedSlug: string): SubjectValidation {
  const body = stripTopLevelSections(markdown.replace(/^#\s+.+?$/m, "").trim(), ["References", "See also"]);
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

  const subjectMatch = firstParagraph.match(/^(.{1,120}?)\s+(?:refers?\s+to|is|are|was|were|describes|denotes|constitutes|represents)\b/i);
  const subject = subjectMatch?.[1]?.replace(/^the\s+/i, "").trim();
  if (!subject) return { status: "pending" };
  if (slugify(subject) === requestedSlug || slugify(subject) === slugify(requestedTitle)) return { status: "valid" };

  const words = subject.split(/\s+/).filter(Boolean);
  const looksLikeAlternateSubject = words.length >= 2 && words.length <= 8 && !/^(?:it|this|that|these|those|there)\b/i.test(subject) && !/[.!?;:()[\]{}]/.test(subject);
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

function dedupeRetrievedSourceArticles(articles: Array<{ slug: string; title: string; content: string }>) {
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

export function summarizeRetrievedSource(article: { slug: string; title: string; content: string }): string {
  return normalizeArticleSnippet(article.content);
}

function hintsToSearchStrings(hints: IncomingHint[]): string[] {
  return hints.map((h) => h.hiddenHint);
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

function internalLinkSlugsFromMarkdown(markdown: string): Set<string> {
  return new Set(
    parseMarkdownLinks(markdown).links
      .filter((link) => (link.kind === "halu" || link.kind === "ref") && link.slug)
      .map((link) => link.slug as string),
  );
}

function hasInternalMarkdownLink(markdown: string): boolean {
  return internalLinkSlugsFromMarkdown(markdown).size > 0;
}

function sectionContainsNonLinkedBullets(section: string): boolean {
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*+]\s+/.test(line))
    .some((line) => !hasInternalMarkdownLink(line));
}

function cachedArticleNeedsRepair(markdown: string): boolean {
  const normalized = normalizeMarkdownLinks(markdown, "article");
  if (normalized.changed) return true;
  if (hasFootnoteArtifacts(markdown)) return true;
  const bodyMarkdown = stripTopLevelSections(markdown, ["References", "See also"]);
  const bodyLinkSlugs = internalLinkSlugsFromMarkdown(bodyMarkdown);
  const referencesSection = sectionSlice(markdown, "References");
  const seeAlsoSection = sectionSlice(markdown, "See also");
  if (referencesSection && sectionContainsNonLinkedBullets(referencesSection)) return true;
  if (seeAlsoSection) {
    const seeAlsoSlugs = internalLinkSlugsFromMarkdown(seeAlsoSection);
    if ([...seeAlsoSlugs].some((slug) => bodyLinkSlugs.has(slug))) return true;
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
const USED_REFS_HEADING_ALIASES = ["References", "See also", "Used References", "Used Refs", "References Used", "Refs Used", "Reference List", "Sources", "Bibliography"];

function sanitizeGeneratedBody(markdown: string): string {
  return fixSlugVisibleText(stripFootnoteArtifacts(stripTopLevelSections(markdown, USED_REFS_HEADING_ALIASES)));
}

function shouldPromoteResolvedTitle(requestedSlug: string, resolvedTitle: string): boolean {
  const resolvedSlug = slugify(resolvedTitle);
  if (!resolvedSlug || resolvedSlug === requestedSlug) return false;
  return resolvedSlug.startsWith(`${requestedSlug}-`) && /[^\x00-\x7F]/.test(resolvedSlug);
}

function deriveArticleIdentity(bodyMarkdown: string, requestedTitle: string, requestedSlug: string) {
  const requestedCanonicalTitle = normalizeCanonicalTitle(requestedTitle);
  const rawDisplayTitle = extractDisplayTitle(bodyMarkdown);
  const resolvedTitle = normalizeCanonicalTitle(extractTitle(bodyMarkdown, requestedTitle));
  const canonicalTitle = shouldPromoteResolvedTitle(requestedSlug, resolvedTitle) ? resolvedTitle : requestedCanonicalTitle;
  const canonicalSlug = slugify(canonicalTitle) || requestedSlug;
  const rawDisplayPlainTitle = rawDisplayTitle ? normalizeCanonicalTitle(extractTitle(`# ${rawDisplayTitle}`, requestedTitle)) : "";
  const displayTitle = rawDisplayTitle && rawDisplayPlainTitle === requestedCanonicalTitle ? rawDisplayTitle : undefined;
  return { canonicalTitle, canonicalSlug, displayTitle };
}

function replaceTopLevelTomlValue(source: string, key: "model" | "thinking", value: string): string {
  const line = `${key} = ${value}`;
  const pattern = new RegExp(`^${key}\\s*=.*$`, "m");
  if (pattern.test(source)) {
    return source.replace(pattern, line);
  }
  return `${line}\n${source}`;
}

function updateRunnablePromptConfig(promptKey: string, model: "heavy" | "light", thinking: boolean) {
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

function articleImagePresetKeyFromName(name: string): string {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/^article_image_?/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!key) {
    throw new Error("preset name must include at least one letter or number");
  }
  if (key === "default" || key === "documentary_photo" || key === "article_image") {
    throw new Error("base image preset is reserved");
  }
  return key;
}

function normalizeArticleImagePresetKey(value: string | undefined): string {
  const key = (value ?? "").trim().toLowerCase();
  if (!key || key === "article_image") return "documentary_photo";
  if (key === "auto") return "auto";
  const normalized = key.replace(/^article_image_/, "");
  if (!/^[a-z0-9_]+$/i.test(normalized)) {
    throw new Error("invalid image preset key");
  }
  return normalized;
}

function listArticleImagePromptOptions() {
  return [
    {
      key: "documentary_photo",
      label: "documentary_photo",
      allowText: false,
      recommendedAspectRatios: [],
    },
    ...listArticleImagePresetFiles().map((preset) => ({
      key: preset.key,
      label: preset.label,
      allowText: preset.allowText === true,
      recommendedAspectRatios: preset.recommendedAspectRatios,
    })),
  ];
}

function readArticleImagePromptSelection(key: string) {
  const presetKey = normalizeArticleImagePresetKey(key);
  if (presetKey === "documentary_photo") {
    const meta = readPromptFile("runnable", "article_image");
    if (!meta) throw new Error("article_image prompt not found");
    return {
      ...meta,
      key: "documentary_photo",
      label: "documentary_photo",
      allowText: false,
      recommendedAspectRatios: [],
    };
  }
  const preset = readArticleImagePresetFile(presetKey);
  if (!preset) throw new Error(`unknown image preset: ${presetKey}`);
  return preset;
}

function articleImageTextPolicy(allowText: boolean | undefined): string {
  if (allowText === true) {
    return ["Text policy:", "- Readable text is allowed only when it is short, legible, natural for the chosen artifact, and directly grounded in the supplied context.", "- Do not invent headlines, slogans, labels, prices, stats, UI strings, captions, fake words, pseudo-text, glyph text, lorem ipsum, or gibberish.", "- When exact text is not needed, use blank areas, icons, shapes, crops, blur, or redaction instead of text-like filler."].join("\n");
  }
  return ["Text policy:", "- Do not render readable text, captions, labels, UI text, headlines, signs, watermarks, fake words, pseudo-text, glyph text, lorem ipsum, or gibberish.", "- Use blank areas, icons, shapes, crops, blur, or redaction instead of textual filler."].join("\n");
}

function parseMediaGenerationMetadata(value: string | undefined): unknown {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function formatRecentEditHistoryForPrompt(revisions: ReturnType<typeof listArticleRevisions>): string {
  const editableOperations = new Set(["rewrite", "section-rewrite", "selection-edit"]);
  const recent = revisions
    .filter((revision) => editableOperations.has(revision.operation) && revision.instructions.trim().length > 0)
    .slice(0, 2)
    .reverse();
  return recent
    .map((revision, index) => {
      const timestamp = Number.isFinite(revision.createdAt) ? new Date(revision.createdAt).toISOString() : String(revision.createdAt);
      const instructions = revision.instructions.replace(/\s+/g, " ").trim();
      return `${index + 1}. ${timestamp} (${revision.operation}): ${instructions}`;
    })
    .join("\n");
}

async function generateArticleSummary(llm: LlmRouter, promptConfig: ReturnType<typeof loadConfig>["prompts"], requestedTitle: string, articleMarkdown: string): Promise<string> {
  const prompt = getPrompt(promptConfig, "article_summary");
  const role = prompt.model ?? "heavy";
  const currentArticle = stripTopLevelSections(articleMarkdown, ["References", "See also"]).slice(0, 12000);
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
    previousSummary = summary || raw.replace(/\s+/g, " ").trim().slice(0, 360) || "(empty)";
    summaryFeedback = "too_similar_to_lead";
  }

  return summaryMarkdownFromArticle(articleMarkdown);
}

function sampleRandomInspirationArticles(db: ReturnType<typeof openDatabase>, count: number): Array<{ title: string; slug: string }> {
  const articles = db
    .prepare(
      `SELECT title, slug FROM articles
       WHERE is_disambiguation = 0
       ORDER BY RANDOM() LIMIT ?`,
    )
    .all(Math.max(0, count)) as Array<{ title: string; slug: string }>;

  return articles;
}

async function ensureHomepageCache(deps: PipelineDeps): Promise<HomepagePayload> {
  const recorder = getTraceRecorder(deps.runtime.app.pipeline.trace);
  const result = await queueWorkflow(homepageRefreshWorkflow, {
    input: {
      requestId: randomUUID(),
      workflow: "homepage.refresh",
      slug: "homepage",
      instructions: "refresh homepage cache",
    },
    deps,
    recorder,
    logger: deps.logger,
    origin: "maintenance",
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

function buildLinkedPromptSystem(promptConfig: ReturnType<typeof loadConfig>["prompts"], key: string): string {
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

  const candidates = [normalized, stripSelectionDecorators(normalized), stripSelectionDecorators(normalized.split(/[:.;!?]/u)[0] ?? ""), normalized.split(/[:.;!?]/u)[0] ?? "", normalized.split(/\s[-–—]\s/u)[0] ?? ""].map(normalizeSelectionText).filter(Boolean);

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

function findBestWrapRange(markdown: string, selectedText: string): { start: number; end: number; visibleLabel: string } | null {
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

function normalizeSuggestedTargetSlug(suggestedSlug: string, sourceSlug: string, visibleLabel: string): string {
  const normalized = slugify(suggestedSlug);
  const fallback = slugify(visibleLabel);
  if (!normalized || normalized === sourceSlug) return fallback;
  return normalized;
}

async function generateLinkSuggestion(llm: LlmRouter, promptConfig: ReturnType<typeof loadConfig>["prompts"], requestedTitle: string, selectedText: string, articleExcerpt: string, ragContext: string, relatedTitles: string[]): Promise<LinkSuggestion> {
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
      related_titles: relatedTitles.length ? relatedTitles.map((title) => `- ${title}`).join("\n") : "(none)",
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
  const applyImageGenerationConfig = (base: ReturnType<typeof loadConfig>) => {
    if (!options.imageGenerationConfig) return base;
    return {
      ...base,
      app: {
        ...base.app,
        images: {
          ...base.app.images,
          generation: {
            ...base.app.images.generation,
            ...options.imageGenerationConfig,
            openai: {
              ...base.app.images.generation.openai,
              ...options.imageGenerationConfig.openai,
            },
            ollama: {
              ...base.app.images.generation.ollama,
              ...options.imageGenerationConfig.ollama,
            },
          },
        },
      },
    };
  };
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
  runtime = applyImageGenerationConfig(runtime);
  const db = openDatabase(runtime.app.storage.database_path);
  const mediaDb = openMediaDatabase(options.mediaDatabasePath ?? runtime.app.images.media_database_path);
  const indexResponseCache = makeVersionedCache(db);
  const mediaResponseCache = makeVersionedCache(mediaDb);

  // Startup sync: ingest any TOML edits made outside the UI into DB, and write
  // TOML for any DB-current entries whose files are missing.
  {
    const { runnable, shared } = listPromptFiles();
    const tomlKeys = new Set<string>();
    for (const { scope, key } of [...runnable.map((p) => ({ scope: "runnable" as const, key: p.key })), ...shared.map((p) => ({ scope: "shared" as const, key: p.key }))]) {
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

  let llm: LlmRouter = options.llmClient ?? new OpenAICompatRouter(runtime.llm, logger);

  // ---- Canonical LanceDB RAG runtime. Content saves enqueue durable jobs that
  // the background drainer below processes into LanceDB. ----
  // Co-locate the corpus with its database so each database gets its own store
  // (production data/halupedia.sqlite → data/rag.lance; tests get an isolated
  // corpus under their temp dir rather than sharing the real data/rag.lance).
  const ragPath = options.ragPath ?? (runtime.app.rag as { path?: string }).path ?? join(dirname(runtime.app.storage.database_path), "rag.lance");
  const rag: RagRuntime = await createRagRuntime({
    db,
    llm,
    path: ragPath,
    logger,
    // reference_search backs the chat research subagent's search_articles
    // tool — its ontologyQuota is config-driven (config/app.toml's
    // [agent].search_ontology_quota) so ontology-fact exposure can be tuned
    // without a code change; every other profile keeps its hardcoded default.
    // ontologyFactsPerRetrievedArticle is canonical, so it overrides every profile
    // uniformly from [rag].ontology_facts_per_retrieved_article rather than being
    // agent-tool-specific like ontologyQuota above.
    profiles: {
      article_generation: {
        ...DEFAULT_PROFILES.article_generation,
        ontologyFactsPerRetrievedArticle: runtime.app.rag.ontology_facts_per_retrieved_article,
      },
      article_rewrite: {
        ...DEFAULT_PROFILES.article_rewrite,
        ontologyFactsPerRetrievedArticle: runtime.app.rag.ontology_facts_per_retrieved_article,
      },
      article_refresh: {
        ...DEFAULT_PROFILES.article_refresh,
        ontologyFactsPerRetrievedArticle: runtime.app.rag.ontology_facts_per_retrieved_article,
      },
      reference_search: {
        ...DEFAULT_PROFILES.reference_search,
        ontologyFactsPerRetrievedArticle: runtime.app.rag.ontology_facts_per_retrieved_article,
        ontologyQuota: runtime.app.agent.search_ontology_quota,
      },
    },
    ontologyLlmExtraction: runtime.app.rag.ontology_llm_extraction,
    prompts: runtime.prompts,
    imageDescriptions: (ids) => {
      const map = new Map<string, string>();
      for (const id of ids) {
        const desc = getMediaById(mediaDb, id)?.description ?? "";
        if (desc) map.set(id, desc);
      }
      return map;
    },
    // The background reindex drainer runs ontology LLM extraction outside any
    // HTTP request, so nothing else pushes its result anywhere: without this,
    // new suggestions only ever show up after a manual page reload, and the
    // run itself never appears in the admin traces view. Record a completed
    // trace row (the call has already finished by the time this fires, so
    // there's no pending/running phase to show) and push a live update to any
    // open article page for this slug.
    onOntologyExtracted: (slug, info) => {
      const recorder = getTraceRecorder(runtime.app.pipeline.trace);
      const runId = randomUUID();
      const startedAt = Date.now() - info.durationMs;
      recorder.recordRun({
        workflow: "ontology.auto_extract",
        runId,
        requestId: randomUUID(),
        slug,
        startedAt,
        durationMs: info.durationMs,
        status: info.error ? "error" : "ok",
        nodesExecuted: 1,
        error: info.error ? { message: info.error.message, stack: info.error.stack } : undefined,
        origin: "rag_drain_auto",
      });
      // A node row (not just the run row) so this shows the same prompt/
      // response/token analytics on expand as every other traced LLM call —
      // without it the trace view has a title and a duration but nothing to
      // actually inspect.
      recorder.recordNode({
        workflow: "ontology.auto_extract",
        runId,
        nodeName: "llm.ontology_extract",
        nodeKind: "llm",
        startedAt,
        durationMs: info.durationMs,
        status: info.error ? "error" : "ok",
        reads: [],
        writes: [],
        error: info.error ? { message: info.error.message, stack: info.error.stack } : undefined,
        promptChars: info.promptChars,
        promptText: info.promptText,
        responseText: info.responseText,
        llmRole: info.metadata?.requestedRole,
        llmResolvedRole: info.metadata?.resolvedRole,
        llmConfigKey: info.metadata?.configKey,
        llmModel: info.metadata?.model,
        llmBaseUrl: info.metadata?.baseUrl,
        llmHost: info.metadata?.host,
        llmTemperature: info.metadata?.temperature,
        llmMaxTokens: info.metadata?.maxTokens,
        llmTopK: info.metadata?.topK,
        llmTopP: info.metadata?.topP,
        llmMinP: info.metadata?.minP,
        llmThinking: info.thinking,
        llmJsonMode: info.jsonMode,
      });
      notifySidecar(slug, { type: "ontology", ontology: buildArticleOntologyPayload(slug) });
    },
  });
  {
    // A missing corpus is tolerated (fresh/empty wiki, tests) — the drainer
    // builds it from enqueued jobs. But a corpus left half-built by a crashed
    // rebuild, or built for a different embedding model (query and stored
    // vectors would live in different spaces), silently degrades every
    // retrieval — refuse to start so it gets rebuilt.
    const meta = await rag.store.readMeta().catch(() => null);
    if (!meta) {
      logger.warn("rag.startup_no_corpus", {
        path: ragPath,
        hint: "run: pnpm run rag:rebuild",
      });
    } else if (!meta.buildComplete || meta.textEmbeddingModel !== rag.embedder.model) {
      logger.error("rag.startup_corpus_stale", {
        path: ragPath,
        build_complete: meta.buildComplete,
        meta_model: meta.textEmbeddingModel,
        config_model: rag.embedder.model,
        hint: "run: pnpm run rag:rebuild",
      });
      throw new Error(`RAG corpus at ${ragPath} is stale (build_complete=${meta.buildComplete}, corpus model=${meta.textEmbeddingModel} vs configured ${rag.embedder.model}). Run: pnpm run rag:rebuild`);
    }
    const pending = countPendingRagJobs(db);
    if (pending > 0) {
      logger.info("rag.startup_drain", { pending });
      await rag.drain().catch((err) => logger.warn("rag.startup_drain_failed", { error: String(err) }));
    }
  }
  // Background drainer: process enqueued indexing jobs without blocking request
  // handlers. Re-entrancy guarded; timer unref'd so it never holds the process.
  let ragDraining = false;
  const ragDrainTimer = setInterval(() => {
    if (ragDraining || countPendingRagJobs(db) === 0) return;
    ragDraining = true;
    void rag
      .drain()
      .catch((err) => logger.warn("rag.drain_failed", { error: String(err) }))
      .finally(() => {
        ragDraining = false;
      });
  }, 2000);
  ragDrainTimer.unref?.();

  const app = new Hono();

  // Log every request that reaches the server — method, path, status, and
  // duration — plus any exception a handler throws (which Hono would
  // otherwise turn into a bare 500 with nothing in the logs). Skip static
  // asset/vite-internal noise so this stays useful for actual page/API hits.
  // High-frequency admin poll endpoints whose successful requests would
  // otherwise flood the log once per second. Errors still log normally.
  const NOISY_POLL_PATHS = new Set(["/api/admin/generation-queue", "/api/admin/llm", "/api/admin/runs", "/api/admin/pipeline/workflows", "/api/admin/pipeline/runs"]);
  app.use("*", async (c, next) => {
    const { method } = c.req;
    const { pathname, search } = new URL(c.req.url);
    if (pathname.startsWith("/assets/") || pathname.startsWith("/@") || pathname.startsWith("/node_modules/")) {
      return next();
    }
    const startedAt = Date.now();
    try {
      await next();
      const quiet = method === "GET" && c.res.status < 400 && NOISY_POLL_PATHS.has(pathname);
      if (quiet) return;
      logger.info("http.request", {
        method,
        path: pathname + search,
        status: c.res.status,
        duration_ms: Date.now() - startedAt,
      });
    } catch (error) {
      logger.error("http.request_error", {
        method,
        path: pathname + search,
        duration_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  });

  const distRoot = options.distRoot ? resolve(options.distRoot) : resolve(process.cwd(), "dist");

  const inFlightGenerations = new Set<Promise<unknown>>();
  interface GenerationQueueEntry {
    promise: Promise<ArticleRecord>;
    slug: string;
    title: string;
    seq: number;
    queuedAt: number;
    startedAt?: number;
    waiting: number;
    workflow: string;
    phase: string;
    state: "queued" | "processing" | "llm";
    /** Live model chain-of-thought, accumulated as the LLM streams it. Surfaced
     *  only in the admin generation queue. */
    reasoning?: string;
    llmViews: Map<string, LiveLlmView>;
    /** Active stream subscribers — receives every progress/status event. */
    progressListeners: Set<(event: unknown) => void>;
  }
  const slugGenerations = new Map<string, GenerationQueueEntry>();
  let activeArticleGenerations = 0;
  const articleGenerationWaiters: Array<() => void> = [];
  // Tracks any active non-generate workflow (refresh, rewrite, post_process) per slug.
  interface LiveLlmView {
    node: string;
    reasoning?: string;
    response?: string;
  }
  // Process-wide live index of every queued/running workflow, populated
  // automatically by `queueWorkflow` — see pipeline/runtime/liveRegistry.ts.
  const liveRunRegistry = getLiveRunRegistry();
  let generationSeq = 0;
  const inFlightEdits = new Set<string>(); // Track slugs with in-flight edits to prevent stale overwrites

  // Per-article sidecar push: clients subscribe via GET /api/article/:slug/live
  // and receive NDJSON events when post-process updates sidecar data.
  const articleListeners = new Map<string, Set<(e: unknown) => void>>();
  // Tracks slugs that have had an auto-post-process triggered this session
  // so we don't re-fire on every page load before the infobox is written.
  const autoPostProcessed = new Set<string>();
  const homepageFeaturedImageQueued = new Set<string>();
  const homepageNewsImageQueued = new Set<string>();
  const homepageFeaturedImageAttempts = new Map<string, number>();
  const homepageNewsImageAttempts = new Map<string, number>();
  function notifySidecar(slug: string, event: unknown) {
    const listeners = articleListeners.get(slug);
    if (!listeners) return;
    // Pre-render infobox values inline so the client receives HTML, not raw markdown.
    // Run linkReferencesInline first so bare title mentions become ref: links.
    const liveRefs = loadPriorReferenceList(db, slug) ?? [];
    let wire = event as Record<string, unknown>;
    if (wire.type === "infobox" && wire.infobox) {
      const raw = wire.infobox as {
        title?: string;
        subtitle?: string;
        groups?: Array<{
          label: string;
          rows: Array<{ label: string; value: string }>;
        }>;
      };
      wire = {
        ...wire,
        infobox: {
          ...raw,
          title: renderInlineMarkdown(raw.title ?? ""),
          subtitle: raw.subtitle ? renderInlineMarkdown(linkReferencesInline(raw.subtitle, liveRefs)) : undefined,
          groups: (raw.groups ?? []).map((g) => ({
            label: renderInlineMarkdown(g.label),
            rows: g.rows.map((r) => ({
              label: renderInlineMarkdown(r.label),
              value: renderInlineMarkdown(linkReferencesInline(r.value, liveRefs)),
            })),
          })),
        },
      };
    } else if (wire.type === "caption" && typeof wire.caption === "string") {
      wire = {
        ...wire,
        caption: renderInlineMarkdown(linkReferencesInline(wire.caption, liveRefs)),
      };
    }
    for (const cb of listeners) {
      try {
        cb(wire);
      } catch {}
    }
  }

  // Push every workflow's queued/running/phase/done transitions onto that
  // slug's live NDJSON stream — this is what lets an article page show "in
  // process" state for *any* workflow (ontology inference, rewrite, refresh,
  // post-process, image generation, ...) without each route wiring its own
  // sidecar push.
  liveRunRegistry.onChange(({ kind, entry }) => {
    if (!entry.slug) return;
    notifySidecar(entry.slug, {
      type: "workflow",
      runId: entry.runId,
      workflow: entry.workflow,
      phase: entry.phase,
      state: entry.state,
      done: kind === "done",
    });
  });

  const maintenance = new MaintenanceScheduler(logger);

  function trackGeneration<T>(promise: Promise<T>): Promise<T> {
    const id = Math.random().toString(36).slice(2, 8);
    inFlightGenerations.add(promise);
    logger.debug("generation.tracked", {
      id,
      in_flight: inFlightGenerations.size,
    });
    void promise
      .finally(() => {
        inFlightGenerations.delete(promise);
        logger.debug("generation.settled", {
          id,
          in_flight: inFlightGenerations.size,
        });
      })
      .catch(() => {});
    return promise;
  }

  function articleGenerationLimit(): number {
    return Math.max(1, Math.floor(runtime.app.generation.max_in_flight));
  }

  function pumpArticleGenerationQueue() {
    while (activeArticleGenerations < articleGenerationLimit()) {
      const next = articleGenerationWaiters.shift();
      if (!next) return;
      next();
    }
  }

  async function acquireArticleGenerationSlot(): Promise<() => void> {
    if (activeArticleGenerations < articleGenerationLimit()) {
      activeArticleGenerations += 1;
      return () => {
        activeArticleGenerations = Math.max(0, activeArticleGenerations - 1);
        pumpArticleGenerationQueue();
      };
    }
    await new Promise<void>((resolve) => {
      articleGenerationWaiters.push(() => {
        activeArticleGenerations += 1;
        resolve();
      });
    });
    return () => {
      activeArticleGenerations = Math.max(0, activeArticleGenerations - 1);
      pumpArticleGenerationQueue();
    };
  }

  function reserveSlugGeneration(
    slug: string,
    title: string,
    generate: () => Promise<ArticleRecord>,
  ): {
    promise: Promise<ArticleRecord>;
    seq: number;
    joined: boolean;
    releaseWaiter: () => void;
  } {
    const seq = ++generationSeq;
    const queueDepth = slugGenerations.size;
    const existing = slugGenerations.get(slug);
    if (existing) {
      existing.waiting += 1;
      logger.info("page.join", {
        slug,
        seq,
        origin_seq: existing.seq,
        waiting: existing.waiting,
      });
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
    const entry: GenerationQueueEntry = {
      promise: undefined as unknown as Promise<ArticleRecord>,
      slug,
      title,
      seq,
      queuedAt: Date.now(),
      waiting: 0,
      workflow: "article.generate",
      phase: "queued",
      state: "queued",
      llmViews: new Map(),
      progressListeners: new Set(),
    };
    const promise = (async () => {
      const release = await acquireArticleGenerationSlot();
      entry.startedAt = Date.now();
      entry.phase = "starting";
      entry.state = "processing";
      entry.progressListeners.forEach((cb) => cb({ type: "status", message: "Writing..." }));
      try {
        return await trackGeneration(generate());
      } finally {
        release();
      }
    })().finally(() => {
      if (slugGenerations.get(slug)?.seq === seq) {
        slugGenerations.delete(slug);
      }
    });
    entry.promise = promise;
    slugGenerations.set(slug, entry);
    return { promise, seq, joined: false, releaseWaiter: () => {} };
  }

  // Cap the live CoT surfaced to the admin queue: keep only the most recent
  // chars so the (1s-polled) payload stays small even for long reasoning runs.
  const LIVE_COT_TAIL_CHARS = 6_000;
  function liveCot(reasoning: string | undefined): string | undefined {
    if (!reasoning) return undefined;
    return reasoning.length > LIVE_COT_TAIL_CHARS ? `…${reasoning.slice(-LIVE_COT_TAIL_CHARS)}` : reasoning;
  }

  // Stash the model's streaming reasoning on whichever active entry owns this
  // slug (a generation or a non-generate operation), for live admin display.
  function recordLiveReasoning(slug: string, accumulated: string) {
    const gen = slugGenerations.get(slug);
    if (gen) gen.reasoning = accumulated;
  }

  const LIVE_LLM_TEXT_TAIL_CHARS = 24_000;
  function liveLlmText(text: string | undefined): string | undefined {
    if (!text) return undefined;
    return text.length > LIVE_LLM_TEXT_TAIL_CHARS ? `…${text.slice(-LIVE_LLM_TEXT_TAIL_CHARS)}` : text;
  }

  function recordLiveLlmUpdate(update: LiveLlmUpdate) {
    if (!update.slug) return;
    const write = (views: Map<string, LiveLlmView>) => {
      const current = views.get(update.node) ?? { node: update.node };
      views.set(update.node, {
        ...current,
        ...(update.reasoning !== undefined ? { reasoning: liveLlmText(update.reasoning) } : {}),
        ...(update.response !== undefined ? { response: liveLlmText(update.response) } : {}),
      });
    };
    const generation = slugGenerations.get(update.slug);
    if (generation) write(generation.llmViews);
  }

  function generationQueuePayload() {
    const now = Date.now();
    const generating = [...slugGenerations.values()]
      .sort((a, b) => (a.startedAt ?? a.queuedAt) - (b.startedAt ?? b.queuedAt))
      .map((entry) => {
        // slugGenerations tracks HTTP client join/dedup, not the workflow run
        // itself — look the runId up in the registry so the client can fetch
        // this run's live node trace (/api/admin/pipeline/runs/:runId) while
        // it's still executing.
        const registryEntry = liveRunRegistry
          .getBySlug(entry.slug)
          .find((r) => r.workflow === "article.generate");
        return {
          slug: entry.slug,
          title: entry.title,
          seq: entry.seq,
          runId: registryEntry?.runId,
          queuedAt: entry.queuedAt,
          startedAt: entry.startedAt,
          queuedMs: Math.max(0, (entry.startedAt ?? now) - entry.queuedAt),
          activeMs: entry.startedAt ? Math.max(0, now - entry.startedAt) : 0,
          waiting: entry.waiting,
          workflow: entry.workflow,
          phase: entry.phase,
          state: entry.state,
          reasoning: liveCot(entry.reasoning),
          views: [...entry.llmViews.values()],
        };
      });
    // Every non-generate workflow (rewrite, refresh, post-process, image
    // generation, ontology inference, homepage refresh, maintenance, ...) is
    // registered automatically by `queueWorkflow` — nothing here has to
    // remember to opt in. `article.generate` runs are excluded because
    // they're already covered above via `slugGenerations` (which also
    // tracks HTTP client join/dedup, not just workflow phase).
    const updating = liveRunRegistry
      .snapshot()
      .filter((entry) => !(entry.slug && slugGenerations.has(entry.slug)))
      .map((entry) => ({
        slug: entry.slug ?? "",
        title: entry.title ?? entry.slug ?? entry.workflow,
        seq: -1,
        runId: entry.runId,
        queuedAt: entry.queuedAt,
        startedAt: entry.startedAt,
        queuedMs: entry.queuedMs,
        activeMs: entry.activeMs,
        waiting: 0,
        workflow: entry.workflow,
        phase: entry.phase,
        state: entry.state,
        reasoning: liveCot(entry.reasoning),
        views: entry.views,
        parentRunId: entry.parentRunId,
        origin: entry.origin,
      }));
    return {
      maxInFlight: articleGenerationLimit(),
      active: activeArticleGenerations,
      queued: articleGenerationWaiters.length,
      items: [...generating, ...updating],
    };
  }

  /**
   * Lightweight post-save hook: re-index RAG and regenerate the summary. Called
   * after any operation that mutates an article without going through the full
   * postProcessArticle pipeline (e.g. add-link, revert). Non-blocking — fires
   * via trackGeneration and logs failures.
   */
  /** Enqueue a durable LanceDB re-index job for an article's current body. The
   *  background drainer processes it; failures are logged there. */
  function indexArticleNow(slug: string): void {
    enqueueRagIndexJob(db, {
      articleSlug: slug,
      sourceKind: "article_body",
      sourceId: slug,
      operation: "upsert",
    });
  }

  function afterArticleSaved(slug: string, title: string, markdown: string, generatedAt: number): void {
    trackGeneration(
      (async () => {
        indexArticleNow(slug);
        const summaryMarkdown = await generateArticleSummary(llm, runtime.prompts, title, markdown).catch(() => summaryMarkdownFromArticle(markdown));
        updateArticleSummary(db, slug, summaryMarkdown, {
          updateRevisionGeneratedAt: generatedAt,
        });
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
    const draining = new Set<Promise<unknown>>([...inFlightGenerations, ...[...slugGenerations.values()].map((entry) => entry.promise)]);
    if (draining.size > 0) {
      logger.info("shutdown.draining", {
        in_flight: inFlightGenerations.size,
        queued: slugGenerations.size,
      });
      const startTime = Date.now();
      await Promise.allSettled([...draining]);
      const elapsed = Date.now() - startTime;
      logger.info("shutdown.drained", { elapsed_ms: elapsed });
    }
    logger.info("shutdown.closing_database");
    clearInterval(ragDrainTimer);
    await rag.close().catch(() => {});
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
    runtime = applyImageGenerationConfig(runtime);
    if (!options.llmClient) {
      llm = new OpenAICompatRouter(runtime.llm, logger);
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
    pumpArticleGenerationQueue();
  }

  await reloadRuntime();

  function canonicalPathForArticle(article: { canonicalSlug: string; title: string }) {
    return `/wiki/${titleToWikiSegment(normalizeCanonicalTitle(article.title || slugToTitle(article.canonicalSlug)))}`;
  }

  function repairStoredArticleTitle(article: { slug: string; canonicalSlug: string; title: string; markdown: string; html: string; summaryMarkdown?: string; plain_text: string; generated_at: number }) {
    const normalizedTitle = normalizeCanonicalTitle(article.title || slugToTitle(article.canonicalSlug));
    const normalizedMarkdown = rewriteArticleTitleHeading(article.markdown, normalizedTitle);
    if (normalizedTitle === article.title && normalizedMarkdown === article.markdown) return article;

    const links = extractAllBodyLinks(db, normalizedMarkdown, article.slug);
    const repairedArticle = {
      ...article,
      title: normalizedTitle,
      markdown: normalizedMarkdown,
      plain_text: markdownToPlainText(normalizedMarkdown),
      html: rewriteArticleHtml(renderMarkdown(normalizedMarkdown), links),
      generated_at: Date.now(),
    };
    saveArticle(db, repairedArticle, links, Array.from(new Set([repairedArticle.slug, repairedArticle.canonicalSlug])), {
      operation: "repair",
      instructions: "Normalize lowercase-first canonical title.",
      skipRevision: true,
    });
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
    const titleDerivedSlug = slugify(repaired.title || slugToTitle(repaired.canonicalSlug));
    if (requestedSlug && requestedSlug !== repaired.slug && titleDerivedSlug === requestedSlug) {
      const fromSlug = repaired.slug;
      const renamed = renameArticleSlug(db, repaired.slug, requestedSlug);
      if (renamed) {
        // Old slug's RAG docs are now orphaned; drop them and index the new slug.
        enqueueRagIndexJob(db, {
          articleSlug: fromSlug,
          sourceKind: "article_body",
          sourceId: fromSlug,
          operation: "delete",
        });
        enqueueRagIndexJob(db, {
          articleSlug: requestedSlug,
          sourceKind: "article_body",
          sourceId: requestedSlug,
          operation: "upsert",
        });
        logger.info("page.slug_repair", {
          slug: requestedSlug,
          from: repaired.slug,
        });
        const fresh = getArticleByLookup(db, requestedSlug);
        if (fresh) repaired = fresh;
      }
    }
    return repaired;
  }

  function repairCachedArticle(article: ArticleRecord): ArticleRecord {
    const normalizedTitle = normalizeCanonicalTitle(article.title || slugToTitle(article.canonicalSlug));
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
    const links = extractAllBodyLinks(db, markdown, article.slug);
    const repairedArticle: ArticleRecord = {
      ...article,
      title: normalizedTitle,
      markdown,
      html: rewriteArticleHtml(renderMarkdown(markdown), links),
      summaryMarkdown: article.summaryMarkdown?.trim() || summaryMarkdownFromArticle(markdown),
      plain_text: markdownToPlainText(markdown),
      generated_at: Date.now(),
    };
    saveArticle(db, repairedArticle, links, Array.from(new Set([repairedArticle.slug, repairedArticle.canonicalSlug])), {
      operation: "repair",
      instructions: "Repair cached article artifacts.",
      skipRevision: true,
    });
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
      const links = extractAllBodyLinks(db, combined, article.slug);
      html = rewriteArticleHtml(rendered, links);
      rememberArticleHtml(article.slug, article.generatedAt, html);
    }
    // `combined` is the legacy markdown projection: body with ref links
    // resolved, while references and see-also stay in sidecar metadata.
    return articleToResponse(article, html, combined);
  }

  function buildReferenceStatus(response: ArticleResponse, rawMarkdown: string): ReferenceStatus {
    const listed = new Set(response.metadata.references.map((ref) => slugify(ref.slug)));
    // Strip baked-in metadata sections before scanning so old-style articles
    // with embedded References/See also don't produce spurious status flags.
    const bodyForScan = stripTopLevelSections(response.body, ["References", "See also"]);
    // missing: only explicit ref:slug links in body that aren't in sidecar.
    // Plain halu links to existing articles are NOT counted — they are just
    // internal wiki links, not explicit citations.
    const missing: ReferenceStatusEntry[] = [];
    if (bodyForScan.includes("ref:")) {
      const seen = new Set<string>();
      const selfSlug = slugify(response.slug);
      for (const link of parseMarkdownLinks(bodyForScan).links) {
        if (link.kind !== "ref" || !link.slug) continue;
        const slug = link.slug;
        if (!slug || slug === selfSlug || seen.has(slug)) continue;
        seen.add(slug);
        if (listed.has(slug)) continue;
        const article = getArticleByLookup(db, slug);
        if (article) missing.push({ slug: article.slug, title: article.title });
      }
    }
    // unformatted: halu links to articles that ARE in sidecar — these should
    // be converted to ref: links for proper footnote rendering.
    const legacyHaluRefs = findExistingArticleLinkReferences(db, bodyForScan, response.slug);
    return {
      missing,
      unformatted: legacyHaluRefs.filter((ref) => listed.has(ref.slug)).map((ref) => ({ slug: ref.slug, title: ref.title })),
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
          title: renderInlineMarkdown(rawInfobox.title),
          subtitle: rawInfobox.subtitle ? renderInlineMarkdown(linkReferencesInline(rawInfobox.subtitle, sidebarRefs)) : undefined,
          groups: rawInfobox.groups.map((g) => ({
            label: renderInlineMarkdown(g.label),
            rows: g.rows.map((r) => ({
              label: renderInlineMarkdown(r.label),
              value: renderInlineMarkdown(linkReferencesInline(r.value, sidebarRefs)),
            })),
          })),
        }
      : null;
    const headlineMediaRow = getArticleHeadlineMedia(db, response.slug);
    const headlineMedia = headlineMediaRow
      ? {
          mediaId: headlineMediaRow.mediaId,
          caption: headlineMediaRow.caption ? renderInlineMarkdown(linkReferencesInline(headlineMediaRow.caption, sidebarRefs)) : "",
          description: getMediaById(mediaDb, headlineMediaRow.mediaId)?.description ?? "",
        }
      : null;
    return {
      cached: opts.cached,
      referenceStatus: buildReferenceStatus(response, rawRecord?.markdown ?? response.body),
      redirectedFrom: opts.canonicalPath && opts.requestedPath && opts.canonicalPath !== opts.requestedPath ? opts.requestedPath : undefined,
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
      ...(opts.refreshChanged !== undefined ? { refreshChanged: opts.refreshChanged } : {}),
    };
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

  function buildPipelineDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
    return {
      db,
      mediaDb,
      llm,
      prompts: buildPromptRegistry(runtime.prompts),
      logger,
      runtime,
      rag,
      onSidecarUpdate: notifySidecar,
      onLlmUpdate: recordLiveLlmUpdate,
      generateArticleImageAttachment: generateAndAttachArticleImage,
      ...overrides,
    };
  }

  async function buildArticle(slug: string, requestedTitle: string, onProgress?: (html: string, markdown: string) => void, onStatus?: (message: string) => void) {
    onStatus?.("Writing...");
    // Seed the article's vibe from incoming halu hidden-hints on first
    // generation. Those hints are the wiki's existing canon about this topic
    // ("what everything that links here already says about me"), which makes a
    // sensible starting vibe. Only seeds when no vibe exists yet so a
    // human-authored vibe is never overwritten. This is the one LLM-derived
    // vibe; afterward the vibe is human-curated.
    if (!getArticleVibe(db, slug).trim()) {
      const seedHints = listIncomingHints(db, slug);
      if (seedHints.length > 0) {
        const seed = formatIncomingHintsForPrompt(seedHints, slug, runtime.app.rag.prompt_link_hints_max).trim();
        if (seed && seed !== "(none yet)") {
          setArticleVibe(db, slug, seed, "hint-seed");
          logger.info("article.vibe_hint_seed", {
            slug,
            hints: seedHints.length,
          });
        }
      }
    }
    const recorder = getTraceRecorder(runtime.app.pipeline.trace);
    const genEntry = slugGenerations.get(slug);
    const result = await queueWorkflow(generateArticleWorkflow, {
      input: {
        requestId: randomUUID(),
        workflow: "article.generate",
        slug,
        requestedTitle,
      },
      deps: buildPipelineDeps({
        onProgress: onProgress ?? (() => {}),
        onReasoningDelta: (_delta, accumulated) => recordLiveReasoning(slug, accumulated),
      }),
      recorder,
      logger,
      origin: "http",
      onNode: (nodeName) => {
        if (genEntry) {
          genEntry.phase = nodeName;
          genEntry.state = nodeName.startsWith("llm.") ? "llm" : "processing";
        }
      },
    });
    if (result.status === "error") throw result.error ?? new Error("article generation failed");

    const canonicalSlug = result.state.canonicalSlug ?? slug;
    const persistedAt = result.state.persistedAt;
    logger.info("page.generated", {
      slug: canonicalSlug,
      duration_ms: result.durationMs,
      nodes: result.nodesExecuted,
    });

    const article = getArticleByLookup(db, canonicalSlug);
    if (!article) throw new Error(`article not found after generation: ${canonicalSlug}`);

    // Enqueue a LanceDB index job for the raw persisted body so back-to-back
    // generations can retrieve this article once the drainer processes it
    // (post-process also re-indexes the final body as its last step).
    indexArticleNow(canonicalSlug);

    // Post-process async: link repair, see-also, summary, RAG indexing.
    const ppPromise = queueWorkflow(postProcessWorkflow, {
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
      origin: "post_process_auto",
      parentRunId: result.runId,
    }).catch(() => {});
    trackGeneration(ppPromise);
    queueAutoArticleImageAfterPostProcess(canonicalSlug, ppPromise);

    return article;
  }

  function queueAutoArticleImageAfterPostProcess(articleSlug: string, postProcessPromise: Promise<unknown>) {
    const autoImageConfigured = runtime.app.images.generation.enabled && runtime.app.images.generation.auto_generate_for_new_articles;
    logger.info("article_image.auto_check", {
      slug: articleSlug,
      enabled: runtime.app.images.generation.enabled,
      auto_generate_for_new_articles: runtime.app.images.generation.auto_generate_for_new_articles,
      backend: runtime.app.images.generation.backend,
      configured: autoImageConfigured,
      has_headline_image: Boolean(getArticleHeadlineMedia(db, articleSlug)),
    });
    if (!autoImageConfigured) return;

    const imagePromise = postProcessPromise.then(async () => {
      if (getArticleHeadlineMedia(db, articleSlug)) {
        logger.info("article_image.auto_skipped_existing", {
          slug: articleSlug,
        });
        return;
      }
      const title = getArticleByLookup(db, articleSlug)?.title ?? articleSlug;
      const workflowPromise = runArticleImageGenerationWorkflow(articleSlug, false, "auto", "auto", title, "post_process_auto");
      logger.info("article_image.auto_queued", { slug: articleSlug });
      try {
        await workflowPromise;
      } catch (err) {
        logger.warn("article_image.auto_failed", {
          slug: articleSlug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    trackGeneration(imagePromise);
  }

  function queueHomepageFeaturedImageIfMissing(featured: { slug: string; title?: string } | null | undefined) {
    const autoImageConfigured = runtime.app.images.generation.enabled && runtime.app.images.generation.auto_generate_for_featured_article;
    const hasHeadlineImage = featured?.slug ? Boolean(getArticleHeadlineMedia(db, featured.slug)) : false;
    const autoCheckFields = {
      slug: featured?.slug ?? "",
      enabled: runtime.app.images.generation.enabled,
      auto_generate_for_featured_article: runtime.app.images.generation.auto_generate_for_featured_article,
      backend: runtime.app.images.generation.backend,
      configured: autoImageConfigured,
      has_headline_image: hasHeadlineImage,
      attempts: featured?.slug ? (homepageFeaturedImageAttempts.get(featured.slug) ?? 0) : 0,
      max_attempts: runtime.app.images.generation.homepage_auto_image_max_attempts,
    };
    if (autoImageConfigured) {
      logger.info("homepage_featured_image.auto_check", autoCheckFields);
    } else {
      logger.debug("homepage_featured_image.auto_check", autoCheckFields);
    }
    if (!autoImageConfigured || !featured?.slug) return;
    if (hasHeadlineImage) return;
    if (homepageFeaturedImageQueued.has(featured.slug)) return;
    const previousAttempts = homepageFeaturedImageAttempts.get(featured.slug) ?? 0;
    const maxAttempts = runtime.app.images.generation.homepage_auto_image_max_attempts;
    if (previousAttempts >= maxAttempts) {
      logger.warn("homepage_featured_image.auto_skipped_attempt_limit", {
        slug: featured.slug,
        attempts: previousAttempts,
        max_attempts: maxAttempts,
      });
      return;
    }

    const article = getArticleByLookup(db, featured.slug);
    if (!article) {
      logger.warn("homepage_featured_image.auto_skipped_missing_article", {
        slug: featured.slug,
      });
      return;
    }

    homepageFeaturedImageQueued.add(featured.slug);
    homepageFeaturedImageAttempts.set(featured.slug, previousAttempts + 1);
    const title = article.title ?? featured.title ?? featured.slug;
    const imagePromise = runArticleImageGenerationWorkflow(featured.slug, false, "auto", "auto", title, "homepage_auto");
    logger.info("homepage_featured_image.auto_queued", { slug: featured.slug });
    trackGeneration(
      imagePromise
        .then(() => {
          homepageFeaturedImageAttempts.delete(featured.slug);
          logger.info("homepage_featured_image.auto_done", {
            slug: featured.slug,
          });
        })
        .catch((err) => {
          logger.warn("homepage_featured_image.auto_failed", {
            slug: featured.slug,
            attempt: homepageFeaturedImageAttempts.get(featured.slug) ?? previousAttempts + 1,
            max_attempts: runtime.app.images.generation.homepage_auto_image_max_attempts,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          homepageFeaturedImageQueued.delete(featured.slug);
        }),
    );
  }

  function queueHomepageNewsImageIfMissing(news: { slug: string; title?: string } | null | undefined) {
    const imageConfigured = runtime.app.images.generation.enabled;
    const hasHeadlineImage = news?.slug ? Boolean(getArticleHeadlineMedia(db, news.slug)) : false;
    const autoCheckFields = {
      slug: news?.slug ?? "",
      enabled: runtime.app.images.generation.enabled,
      backend: runtime.app.images.generation.backend,
      presetKey: "broadcast_news_still",
      aspectRatioKey: "landscape",
      configured: imageConfigured,
      has_headline_image: hasHeadlineImage,
      attempts: news?.slug ? (homepageNewsImageAttempts.get(news.slug) ?? 0) : 0,
      max_attempts: runtime.app.images.generation.homepage_auto_image_max_attempts,
    };
    if (imageConfigured) {
      logger.info("homepage_news_image.auto_check", autoCheckFields);
    } else {
      logger.debug("homepage_news_image.auto_check", autoCheckFields);
    }
    if (!imageConfigured || !news?.slug) return;
    if (hasHeadlineImage) return;
    if (homepageNewsImageQueued.has(news.slug)) return;
    const previousAttempts = homepageNewsImageAttempts.get(news.slug) ?? 0;
    const maxAttempts = runtime.app.images.generation.homepage_auto_image_max_attempts;
    if (previousAttempts >= maxAttempts) {
      logger.warn("homepage_news_image.auto_skipped_attempt_limit", {
        slug: news.slug,
        attempts: previousAttempts,
        max_attempts: maxAttempts,
      });
      return;
    }

    const article = getArticleByLookup(db, news.slug);
    if (!article) {
      logger.warn("homepage_news_image.auto_skipped_missing_article", {
        slug: news.slug,
      });
      return;
    }

    homepageNewsImageQueued.add(news.slug);
    homepageNewsImageAttempts.set(news.slug, previousAttempts + 1);
    const title = article.title ?? news.title ?? news.slug;
    const imagePromise = runArticleImageGenerationWorkflow(news.slug, false, "broadcast_news_still", "landscape", title, "homepage_auto");
    logger.info("homepage_news_image.auto_queued", { slug: news.slug });
    trackGeneration(
      imagePromise
        .then(() => {
          homepageNewsImageAttempts.delete(news.slug);
          logger.info("homepage_news_image.auto_done", { slug: news.slug });
        })
        .catch((err) => {
          logger.warn("homepage_news_image.auto_failed", {
            slug: news.slug,
            attempt: homepageNewsImageAttempts.get(news.slug) ?? previousAttempts + 1,
            max_attempts: runtime.app.images.generation.homepage_auto_image_max_attempts,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          homepageNewsImageQueued.delete(news.slug);
        }),
    );
  }

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      model: runtime.llm.chat.model,
      database_path: runtime.app.storage.database_path,
    }),
  );

  const HOMEPAGE_TTL_MS = runtime.app.homepage.rotation_hours * 60 * 60 * 1000;
  const homepageCacheNeedsBootstrap = (cached: HomepagePayload | null): boolean =>
    Boolean(cached && cached.featured === null && countArticles(db) > 0);
  let homepageRequestRefreshTriggeredAt = 0;
  let homepageRefreshFailures = 0;
  let homepageRefreshNextAllowedAt = 0;
  const homepageRefreshBackoffDelay = (now: number) => Math.max(0, homepageRefreshNextAllowedAt - now);

  if (!options.skipHomepagePrepare) {
    maintenance.register({
      name: HOMEPAGE_MAINTENANCE_TASK,
      nextDelayMs: () => {
        const now = Date.now();
        const backoffDelay = homepageRefreshBackoffDelay(now);
        if (backoffDelay > 0) return backoffDelay;
        const cached = getHomepageCache(db);
        if (!cached) return 0;
        if (!hasCurrentOrNoHomepageNews(cached.todaysNews, runtime.app)) return 0;
        if (homepageCacheNeedsBootstrap(cached)) return 0;
        return cached.generatedAt + HOMEPAGE_TTL_MS - now + HOMEPAGE_REFRESH_GRACE_MS;
      },
      run: async () => {
        const cached = getHomepageCache(db);
        const now = Date.now();
        const reason = !cached ? "missing" : cached.generatedAt + HOMEPAGE_TTL_MS <= now ? "expired" : "scheduled";
        logger.info("homepage.refresh_start", {
          reason,
          age_ms: cached ? now - cached.generatedAt : 0,
          ttl_ms: HOMEPAGE_TTL_MS,
        });
        try {
          await reloadRuntime();
          const payload = await ensureHomepageCache(buildPipelineDeps());
          queueHomepageFeaturedImageIfMissing(payload.featured);
          queueHomepageNewsImageIfMissing(payload.todaysNews);
          logger.info("homepage.refresh_done", {
            facts: payload.didYouKnow.length,
            featured: payload.featured?.slug ?? "",
            generated_at: payload.generatedAt,
            expires_at: payload.expiresAt,
          });
          homepageRefreshFailures = 0;
          homepageRefreshNextAllowedAt = 0;
        } catch (error) {
          homepageRefreshFailures += 1;
          homepageRefreshNextAllowedAt = Date.now() + homepageRefreshFailureBackoffMs(homepageRefreshFailures);
          logger.error("homepage.refresh_failed", {
            reason,
            failures: homepageRefreshFailures,
            next_allowed_at: homepageRefreshNextAllowedAt,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    });
  }

  function triggerHomepageRefreshFromRequest(reason: string, now: number, bypassCooldown = false): number {
    const backoffDelay = homepageRefreshBackoffDelay(now);
    if (backoffDelay > 0) {
      logger.info("homepage.refresh_trigger_suppressed", {
        reason,
        suppression: "failure_backoff",
        wait_ms: backoffDelay,
        next_allowed_at: homepageRefreshNextAllowedAt,
      });
      return Math.max(HOMEPAGE_PENDING_RETRY_MS, backoffDelay);
    }

    const cooldownDelay = homepageRequestRefreshTriggeredAt > 0 ? HOMEPAGE_REQUEST_TRIGGER_COOLDOWN_MS - (now - homepageRequestRefreshTriggeredAt) : 0;
    if (!bypassCooldown && cooldownDelay > 0) {
      logger.info("homepage.refresh_trigger_suppressed", {
        reason,
        suppression: "request_cooldown",
        wait_ms: cooldownDelay,
        last_triggered_at: homepageRequestRefreshTriggeredAt,
      });
      return Math.max(HOMEPAGE_PENDING_RETRY_MS, cooldownDelay);
    }

    homepageRequestRefreshTriggeredAt = now;
    maintenance.trigger(HOMEPAGE_MAINTENANCE_TASK, reason);
    return HOMEPAGE_PENDING_RETRY_MS;
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
      await pipeline((await import("node:fs")).createReadStream(rawPath), createGzip({ level: 6 }), createWriteStream(gzPath));
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

  /** Attach headline media, when present, to homepage article payloads. */
  function withHomepageImages<
    T extends {
      featured: { slug: string } | null;
      todaysNews?: { slug: string } | null;
    },
  >(payload: T): T {
    const slugs = [payload.featured?.slug, payload.todaysNews?.slug].filter((slug): slug is string => Boolean(slug));
    if (slugs.length === 0) return payload;
    const media = getHeadlineMediaForSlugs(db, slugs);
    const featured = payload.featured ? media.get(payload.featured.slug) : undefined;
    const todaysNews = payload.todaysNews ? media.get(payload.todaysNews.slug) : undefined;
    return {
      ...payload,
      featured:
        featured && payload.featured
          ? {
              ...payload.featured,
              imageId: featured.mediaId,
              imageCaption: featured.caption || undefined,
            }
          : payload.featured,
      todaysNews:
        todaysNews && payload.todaysNews
          ? {
              ...payload.todaysNews,
              imageId: todaysNews.mediaId,
              imageCaption: todaysNews.caption || undefined,
            }
          : payload.todaysNews,
    } as T;
  }

  app.get("/api/homepage", (c) => {
    const cached = getHomepageCache(db);
    const now = Date.now();
    if (
      cached
      && cached.generatedAt + HOMEPAGE_TTL_MS > now
      && hasCurrentOrNoHomepageNews(cached.todaysNews, runtime.app)
      && !homepageCacheNeedsBootstrap(cached)
    ) {
      queueHomepageFeaturedImageIfMissing(cached.featured);
      queueHomepageNewsImageIfMissing(cached.todaysNews);
      return c.json(
        withHomepageImages({
          ...cached,
          expiresAt: cached.generatedAt + HOMEPAGE_TTL_MS,
        }),
      );
    }

    const needsBootstrap = homepageCacheNeedsBootstrap(cached);
    const pendingRetryMs = triggerHomepageRefreshFromRequest(
      needsBootstrap ? "empty_cache_bootstrap" : cached ? "expired_cache_request" : "missing_cache_request",
      now,
      needsBootstrap,
    );
    if (cached) {
      queueHomepageFeaturedImageIfMissing(cached.featured);
      if (isCurrentHomepageNews(cached.todaysNews, runtime.app)) {
        queueHomepageNewsImageIfMissing(cached.todaysNews);
      }
      return c.json(
        withHomepageImages({
          ...cached,
          expiresAt: now + pendingRetryMs,
          refreshPending: true,
        }),
      );
    }
    return c.json({
      featured: null,
      todaysNews: null,
      didYouKnow: [],
      generatedAt: now,
      expiresAt: now + pendingRetryMs,
      refreshPending: true,
    });
  });

  // Returns up to 50 prior homepage snapshots, newest first.
  app.get("/api/homepage/history", (c) => {
    const history = listHomepageHistory(db, 50);
    return c.json({ history });
  });

  app.get("/api/top-articles", (c) => {
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? "10")));
    const articles = listTopArticles(db, limit);
    const media = getHeadlineMediaForSlugs(
      db,
      articles.map((a) => a.slug),
    );
    return c.json({
      articles: articles.map((a) => {
        const headline = media.get(a.slug);
        return headline
          ? {
              ...a,
              imageId: headline.mediaId,
              imageCaption: headline.caption || undefined,
            }
          : a;
      }),
    });
  });

  app.get("/api/graph", (c) => {
    return c.json(getGraphData(db));
  });

  app.get("/api/random-page", async (c) => {
    try {
      await reloadRuntime();
      const inspiration = sampleRandomInspirationArticles(db, runtime.app.random_page.inspiration_count);
      logger.info("random_page.request", {
        "random article inspiration titles": inspiration.map((a) => `${a.title} (${a.slug})`).join(", "),
      });
      const recorder = getTraceRecorder(runtime.app.pipeline.trace);
      const result = await queueWorkflow(randomPageWorkflow, {
        input: {
          requestId: randomUUID(),
          workflow: "random.page",
          slug: "",
          inspiration,
        },
        deps: buildPipelineDeps(),
        recorder,
        logger,
        origin: "http",
      });
      if (result.status !== "ok" || !result.state.randomPageChoice) {
        throw result.error ?? new Error("random page workflow failed");
      }
      const choice = result.state.randomPageChoice;
      logger.info("random_page.done", {
        slug: choice.slug,
        title: choice.title,
      });
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
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/api/page/:slug", async (c) => {
    const requestedSegment = c.req.param("slug");
    const segmentTitle = normalizeCanonicalTitle(wikiSegmentToRequestedTitle(requestedSegment));
    // The client sends the user's literal typed title (e.g. "Test: The
    // Movie", "Banana 🍌") as a header rather than a URL param — keeps the
    // address bar clean and lets punctuation/emoji that can't survive in the
    // slug reach the model verbatim instead of an approximation reconstructed
    // from it. Header values must be ASCII/Latin-1, so the client
    // percent-encodes it for transport — decode it back here. ?title= remains
    // supported for old/shared links.
    const requestedTitleHeader = c.req.header("x-requested-title");
    let decodedRequestedTitle: string | undefined;
    if (requestedTitleHeader) {
      try {
        decodedRequestedTitle = decodeURIComponent(requestedTitleHeader);
      } catch {
        // malformed encoding — fall through to the other sources
      }
    }
    const requestedTitle = normalizeCanonicalTitle(decodedRequestedTitle || c.req.query("title") || segmentTitle);
    const lookupSlug = slugify(segmentTitle);
    const legacyLookupSlug = legacySlugify(segmentTitle);
    if (!lookupSlug || !requestedTitle) return c.json({ error: "invalid slug" }, 400);
    const requestedPath = `/wiki/${requestedSegment}`;

    // Check if there's an in-flight edit for this article
    const hasInFlightEdit = inFlightEdits.has(lookupSlug) || (legacyLookupSlug !== lookupSlug && inFlightEdits.has(legacyLookupSlug));
    if (hasInFlightEdit) {
      logger.info("page.in_flight_edit", { slug: lookupSlug });
    }

    // Resolve the canonical record (slug lookup, then title fallback, then
    // any cache repair needed). All article shaping happens in
    // buildArticleResponseFor/buildPageResponse so the wire format stays
    // single-sourced.
    let resolvedLookupSlug = lookupSlug;
    let record = legacyLookupSlug !== lookupSlug ? getArticleByLookup(db, legacyLookupSlug) : null;
    if (record) {
      resolvedLookupSlug = legacyLookupSlug;
      logger.info("page.legacy_slug_hit", {
        slug: lookupSlug,
        canonical_slug: record.slug,
      });
    }
    if (!record) {
      record = getArticleByLookup(db, lookupSlug);
      if (record) resolvedLookupSlug = lookupSlug;
    }
    if (!record) {
      const titleMatch = getArticleByTitle(db, requestedTitle);
      if (titleMatch) {
        resolvedLookupSlug = titleMatch.slug;
        record = titleMatch;
      }
    }
    if (!record) {
      // A slug-form segment that didn't match as a title may be an EXACT
      // existing slug (legacy shared links like /wiki/test-article from
      // before hyphenated titles slugged distinctly). Lookup-only: it never
      // changes what new articles get generated or what URLs we emit.
      const rawSegment = (() => {
        try {
          return decodeURIComponent(requestedSegment);
        } catch {
          return requestedSegment;
        }
      })().replace(/^\/+|\/+$/g, "");
      if (rawSegment !== lookupSlug && isSlugForm(rawSegment)) {
        const exactSlugMatch = getArticleByLookup(db, rawSegment);
        if (exactSlugMatch) {
          logger.info("page.exact_slug_hit", {
            segment: rawSegment,
            slug: exactSlugMatch.slug,
          });
          resolvedLookupSlug = rawSegment;
          record = exactSlugMatch;
        }
      }
    }
    if (!record) {
      const equivalentMatch = getArticleByEquivalentLookup(db, lookupSlug);
      if (equivalentMatch) {
        logger.info("page.equivalent_hit", {
          slug: lookupSlug,
          canonical_slug: equivalentMatch.slug,
        });
        resolvedLookupSlug = equivalentMatch.slug;
        record = equivalentMatch;
      }
    }
    if (record) {
      record = repairStoredArticleIdentity(record, resolvedLookupSlug);
      if (cachedArticleNeedsRepair(record.markdown)) {
        logger.warn("page.cache_repair", {
          slug: record.slug,
          in_flight_edit: hasInFlightEdit,
        });
        record = repairCachedArticle(record);
        invalidateArticleHtml(record.slug);
      }
      const response = buildArticleResponseFor(record.slug);
      if (response) {
        const canonicalPath = canonicalPathForArticle(record);
        logger.info("page.hit", {
          slug: resolvedLookupSlug,
          in_flight_edit: hasInFlightEdit,
        });

        // Auto-sidebar: fire post-process in the background on first view if
        // the article has no infobox yet (e.g. imported or created before
        // post-process ran). Tracked so it only fires once per server session.
        if (!getArticleInfobox(db, record.slug) && !autoPostProcessed.has(record.slug) && liveRunRegistry.getBySlug(record.slug).length === 0) {
          autoPostProcessed.add(record.slug);
          logger.info("page.auto_post_process", { slug: record.slug });
          trackGeneration(
            queueWorkflow(postProcessWorkflow, {
              input: {
                requestId: randomUUID(),
                workflow: "article.post_process",
                slug: record.slug,
                requestedTitle: record.title,
              },
              deps: buildPipelineDeps(),
              recorder: getTraceRecorder(runtime.app.pipeline.trace),
              logger,
              origin: "post_process_auto",
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
      const listeners = existingGeneration.progressListeners;
      let streamOpen = true;
      let listener: ((event: unknown) => void) | null = null;
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

          send({
            type: "start",
            slug: lookupSlug,
            cached: false,
            seq: joinSeq,
            joined: true,
          });

          listener = (event: unknown) => send(event);
          listeners.add(listener);

          existingGeneration.promise
            .then((result) => {
              if (listener) listeners.delete(listener);
              const canonicalPath = canonicalPathForArticle(result);
              logger.info("page.join_done", { slug: lookupSlug, seq: joinSeq });
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
            })
            .catch((error) => {
              if (listener) listeners.delete(listener);
              send({
                type: "error",
                message: error instanceof Error ? error.message : String(error),
              });
              close();
            });
        },
        cancel() {
          if (listener) listeners.delete(listener);
          streamOpen = false;
        },
      });
      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    }

    let streamOpen = true;
    let originSend: ((payload: unknown) => void) | null = null;
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
        originSend = send;
        const close = () => {
          if (!streamOpen) return;
          streamOpen = false;
          try {
            controller.close();
          } catch {}
        };

        const broadcast = (event: unknown) => {
          slugGenerations.get(lookupSlug)?.progressListeners.forEach((cb) => cb(event));
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
            (html, markdown) => broadcast({ type: "progress", html, markdown }),
            (message) => broadcast({ type: "status", message }),
          ),
        );

        // Subscribe this stream as the first listener before any LLM chunks arrive.
        slugGenerations.get(lookupSlug)?.progressListeners.add(send);

        send({ type: "start", slug: lookupSlug, cached: false, seq, joined });
        send({ type: "status", message: "Waiting and contemplating..." });

        generation
          .then((result) => {
            slugGenerations.get(lookupSlug)?.progressListeners.delete(send);
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
            slugGenerations.get(lookupSlug)?.progressListeners.delete(send);
            logger.error("page.stream_error", {
              slug: lookupSlug,
              seq,
              error: error instanceof Error ? error.message : String(error),
            });
            send({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
            close();
            releaseWaiter();
          });
      },
      cancel() {
        if (originSend) slugGenerations.get(lookupSlug)?.progressListeners.delete(originSend);
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
    // The persisted blacklist rides along so the edit panel can show (and
    // edit) blocks made in earlier sessions instead of starting empty.
    return c.json({
      references,
      blacklist: listArticleBlacklistSlugs(db, article.slug),
    });
  });

  // ── Article vibe (per-article canonical source) ────────────────────────────
  // The vibe is the persistent, human-authored ground truth for an article. It
  // is shown in the edit panel, versioned, and used as the rewrite instruction.
  // Saving is decoupled from rewriting: this only stores a revision.

  app.get("/api/article/:slug/vibe", (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    // Allow reading the vibe for not-yet-generated slugs (new-article flow).
    const article = getArticleByLookup(db, lookupSlug);
    const slug = article?.slug ?? lookupSlug;
    return c.json({
      content: getArticleVibe(db, slug),
      revisions: listArticleVibeRevisions(db, slug),
    });
  });

  app.put("/api/article/:slug/vibe", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    const slug = article?.slug ?? lookupSlug;
    const body = (await c.req.json().catch(() => ({}))) as { content?: string };
    const content = (body.content ?? "").slice(0, 20_000);
    const revisionId = setArticleVibe(db, slug, content, "save");
    logger.info("article.vibe_saved", { slug, changed: revisionId !== null });
    return c.json({
      content: getArticleVibe(db, slug),
      revisions: listArticleVibeRevisions(db, slug),
      changed: revisionId !== null,
    });
  });

  app.post("/api/article/:slug/vibe/revert", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    const slug = article?.slug ?? lookupSlug;
    const body = (await c.req.json().catch(() => ({}))) as {
      revisionId?: number;
    };
    if (typeof body.revisionId !== "number") return c.json({ error: "missing revisionId" }, 400);
    const prior = reconstructArticleVibeRevision(db, slug, body.revisionId);
    if (prior === null) return c.json({ error: "revision not found" }, 404);
    setArticleVibe(db, slug, prior, "revert");
    logger.info("article.vibe_reverted", {
      slug,
      revision_id: body.revisionId,
    });
    return c.json({
      content: getArticleVibe(db, slug),
      revisions: listArticleVibeRevisions(db, slug),
    });
  });

  // New-article-with-vibe: store a vibe for a not-yet-generated slug, then let
  // the client navigate to /wiki/<segment> to trigger generation. The lazy
  // generate path seeds a vibe only when none exists, so this human-authored
  // vibe is preserved and used as canonical source for the first generation.
  app.post("/api/article/:slug/create", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    if (getArticleByLookup(db, lookupSlug)) return c.json({ error: "article already exists" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      vibe?: string;
    };
    const title = normalizeCanonicalTitle((body.title ?? "").trim() || wikiSegmentToRequestedTitle(lookupSlug));
    const vibe = (body.vibe ?? "").slice(0, 20_000);
    if (vibe.trim()) setArticleVibe(db, lookupSlug, vibe, "save");
    logger.info("article.create_with_vibe", {
      slug: lookupSlug,
      has_vibe: !!vibe.trim(),
    });
    return c.json({
      slug: lookupSlug,
      title,
      segment: titleToWikiSegment(title),
    });
  });

  // Toggle the pinned flag on a saved reference without triggering a full rewrite.
  app.post("/api/article/:slug/pin-reference", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      refSlug?: string;
      pinned?: boolean;
    };
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
    logger.info("references.pin_toggled", {
      slug: article.slug,
      ref_slug: refSlug,
      pinned,
    });
    return c.json({ ok: true });
  });

  // Raw markdown save — no LLM, just versioned storage. The markdown is
  // normalised and run through the standard link/reference pipeline but
  // never passed to a language model.
  app.post("/api/article/:slug/raw-save", async (c) => {
    const routeSlug = c.req.param("slug");
    const lookupSlug = slugify(routeSlug);
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    let article = getArticleByLookup(db, lookupSlug);
    if (!article) {
      const rawSlug = (() => {
        try {
          return decodeURIComponent(routeSlug);
        } catch {
          return routeSlug;
        }
      })().replace(/^\/+|\/+$/g, "");
      if (rawSlug !== lookupSlug) {
        article = getArticleByLookup(db, rawSlug);
      }
    }
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
      const result = await queueWorkflow(rawSaveArticleWorkflow, {
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
        origin: "http",
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

    const body = (await c.req.json().catch(() => ({}))) as {
      markdown?: string;
    };
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
          brokenLinks.push({
            slug: link.slug,
            reason: `no article with slug "${link.slug}"`,
          });
        }
      }
    }
    const html = renderMarkdown(normalized.markdown);
    const diagnostics = [
      ...normalized.diagnostics.filter((d) => d.severity === "warn" || d.severity === "error").map((d) => ({ severity: d.severity, message: d.message })),
      ...brokenLinks.map((b) => ({
        severity: "warn" as const,
        message: `Broken link to "${b.slug}": ${b.reason}`,
      })),
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
      articles.push({
        slug: s,
        title: a.title,
        summaryMarkdown: a.summaryMarkdown ?? "",
      });
    };

    if (body.fuzzyTitles?.trim()) {
      const { articles: matched } = findReferencedArticlesInEditText(db, body.fuzzyTitles, article.slug, 10);
      for (const a of matched) addArticle({ ...a, summaryMarkdown: a.summaryMarkdown ?? "" });

      const fuzzy = findFuzzyTitleMatchesInEditText(
        db,
        body.fuzzyTitles,
        article.slug,
        10,
        matched.map((a) => a.slug),
      );
      for (const a of fuzzy) addArticle({ ...a, summaryMarkdown: a.summaryMarkdown ?? "" });
    }

    if (body.ragQuery?.trim()) {
      const retrieved = toPromptSourceArticles(
        buildEvidenceContext(
          await rag.retrieve({
            targetSlug: article.slug,
            queryText: body.ragQuery.trim(),
            minScore: runtime.app.rag.min_score,
            profile: "reference_search",
          }),
        ),
      );
      for (const src of retrieved) {
        addArticle({
          slug: src.slug,
          title: src.title,
          summaryMarkdown: src.content?.slice(0, 360) ?? "",
        });
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
    const linkEvidence = buildEvidenceContext(
      await rag.retrieve({
        targetSlug: article.slug,
        queryText: hintsToSearchStrings(hints).join("\n"),
        minScore: runtime.app.rag.min_score,
        profile: "reference_search",
      }),
    );
    const retrieved = {
      sourceArticles: toPromptSourceArticles(linkEvidence),
      relatedTitles: linkEvidence.relatedTitles,
    };
    const excerpt = extractSelectionExcerpt(article.markdown, selectedText);
    const wrapRange = findBestWrapRange(article.markdown, selectedText);
    if (!wrapRange) {
      logger.debug("add_link.wrap_range_not_found", {
        slug: article.slug,
        selected_phrase: selectedText,
      });
      return c.json(
        {
          error: "could not find selectable text to wrap in the article markdown",
        },
        422,
      );
    }
    // ── Fast path: visible label resolves to an existing article in the DB ──
    // Try slug-form first, then equivalent-key lookup (handles "The Foo" → "foo").
    const labelSlug = slugify(wrapRange.visibleLabel);
    const existingArticle = labelSlug ? (getArticleByLookup(db, labelSlug) ?? getArticleByEquivalentLookup(db, labelSlug)) : null;
    if (existingArticle && existingArticle.slug !== article.slug) {
      const refLink = `[${wrapRange.visibleLabel}](ref:${existingArticle.slug})`;
      const nextMarkdown = stripSelfLinks(article.markdown.slice(0, wrapRange.start) + refLink + article.markdown.slice(wrapRange.end), article.slug);
      const recorder = getTraceRecorder(runtime.app.pipeline.trace);
      const result = await queueWorkflow(addLinkArticleWorkflow, {
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
        origin: "http",
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
      return c.json(
        buildPageResponse(response, {
          cached: true,
          canonicalPath: canonicalPathForArticle(response),
        }),
      );
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
      suggestion = await generateLinkSuggestion(llm, runtime.prompts, article.title, wrapRange.visibleLabel, excerpt, formatRagContextForPrompt(retrieved.sourceArticles, 4000), retrieved.relatedTitles);
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
      return c.json({ error: `link suggestion failed: ${errorMsg}` }, 500);
    }

    const targetSlug = normalizeSuggestedTargetSlug(suggestion.slug, article.slug, wrapRange.visibleLabel);
    if (!targetSlug) return c.json({ error: "link suggestion produced an invalid target" }, 500);

    const wrapped = buildHaluLink(wrapRange.visibleLabel, targetSlug, suggestion.description);
    const nextMarkdown = stripSelfLinks(article.markdown.slice(0, wrapRange.start) + wrapped + article.markdown.slice(wrapRange.end), article.slug);

    const recorder = getTraceRecorder(runtime.app.pipeline.trace);
    const result = await queueWorkflow(addLinkArticleWorkflow, {
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
      origin: "http",
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
    const body = (await c.req.json().catch(() => ({}))) as {
      isProtected?: boolean;
    };
    const newValue = body.isProtected ?? !isArticleProtected(db, article.slug);
    setArticleProtection(db, article.slug, newValue);
    logger.info("article.protection_changed", {
      slug: article.slug,
      isProtected: newValue,
    });
    return c.json({ ok: true, slug: article.slug, isProtected: newValue });
  });

  app.post("/api/article/:slug/protect-section", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      sectionId?: string;
      heading?: string;
      isProtected?: boolean;
    };
    const sectionId = body.sectionId ?? "";
    if (!sectionId) return c.json({ error: "missing sectionId" }, 400);
    const heading = body.heading ?? sectionId;
    const newValue = body.isProtected ?? !isArticleSectionProtected(db, article.slug, sectionId);
    setArticleSectionProtection(db, article.slug, sectionId, heading, newValue);
    logger.info("article.section_protection_changed", {
      slug: article.slug,
      sectionId,
      isProtected: newValue,
    });
    const sections = listProtectedSections(db, article.slug);
    return c.json({
      ok: true,
      slug: article.slug,
      sectionId,
      isProtected: newValue,
      protectedSections: sections,
    });
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
    const newHtml = renderMarkdown(newMarkdown);
    db.prepare(`UPDATE articles SET markdown = ?, html = ?, plain_text = ?, display_title = '' WHERE slug = ?`).run(newMarkdown, newHtml, markdownToPlainText(newMarkdown), article.slug);
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
    return c.json(
      buildPageResponse(response, {
        cached: true,
        canonicalPath: canonicalPathForArticle(updated),
      }),
    );
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
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);

    // The vibe remains canonical and persists independently. A quick edit
    // instruction applies only to this request and is recorded in its revision.
    const vibe = getArticleVibe(db, article.slug).trim();
    const hasVibe = vibe.length > 0;
    const quickEditInstruction = (body.instructions ?? "").replace(/\s+/g, " ").trim().slice(0, 1000);
    const hasQuickEditInstruction = quickEditInstruction.length > 0;
    if (!hasVibe && !hasQuickEditInstruction && !hasReferenceEditFields(body)) return c.json({ error: "Set an article vibe or provide a quick edit instruction." }, 400);
    const instructions = quickEditInstruction || "rewrite-to-vibe";

    // Refs-only edit: the user changed the reference selection (add/remove/
    // pin/block) and there is no rewrite directive. Update the sidecar directly
    // — no LLM call, no retrieval, no post-process.
    if (!hasVibe && !hasQuickEditInstruction) {
      const refs = applyReferenceOnlyEdit(db, article.slug, body, runtime.app.rag, logger);
      invalidateArticleHtml(article.slug);
      logger.info("article.reference_only_edit", {
        slug: article.slug,
        refs: refs.length,
      });
      const response = buildArticleResponseFor(article.slug);
      if (!response) return c.json({ error: "failed to hydrate response" }, 500);
      return c.json(
        buildPageResponse(response, {
          cached: true,
          canonicalPath: canonicalPathForArticle(article),
        }),
      );
    }

    // ── Protection check ──────────────────────────────────────────────────────
    const isManualEdit = body.isManualEdit === true;
    const articleIsProtected = !isManualEdit && !body.sectionId && !body.selectedText && isArticleProtected(db, article.slug);
    if (articleIsProtected) {
      // Skip LLM entirely; record that the rewrite was blocked and return current content.
      db.prepare(
        `INSERT INTO article_revisions (article_slug, title, markdown, html, summary_markdown, plain_text, generated_at, created_at, operation, instructions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(article.slug, article.title, article.markdown, article.html, article.summaryMarkdown ?? "", article.plain_text, article.generated_at, Date.now(), "rewrite-skipped-protected", instructions);
      logger.info("article.rewrite_blocked_protection", { slug: article.slug });
      const response = buildArticleResponseFor(article.slug);
      if (!response) return c.json({ error: "failed to hydrate response" }, 500);
      return c.json(
        buildPageResponse(response, {
          cached: true,
          canonicalPath: canonicalPathForArticle(article),
        }),
      );
    }

    const selectedText = (body.selectedText ?? "").trim();
    let selectionRange: { start: number; end: number } | null = null;
    if (selectedText) {
      // Use the position-mapped finder so formatted selections (bold, links, etc.)
      // are located correctly even when the plain-text does not appear verbatim.
      selectionRange = findSelectionRangeInMarkdown(article.markdown, selectedText);
      if (!selectionRange) return c.json({ error: "selected text not found in article" }, 422);
    }

    const sectionId = (body.sectionId ?? "").trim();
    // Send the actual markdown slice (not the client plain text) so the LLM
    // sees proper markdown syntax and can return well-formed replacement markdown.
    const articleBodyOnly = stripTopLevelSections(article.markdown, ["References", "See also"]);
    const selectedSection = selectionRange ? article.markdown.slice(selectionRange.start, selectionRange.end) : sectionId ? articleSectionMarkdown(article.markdown, sectionId) : articleBodyOnly;

    const ragEnabled = body.ragEnabled === true;
    const ragQuery = (body.ragQuery ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    // Explicit reference slugs from the new UI — survive pruning for this build.
    const explicitSlugs = (body.referenceSlugs ?? []).map((s) => slugify(s)).filter(Boolean);
    // Which of those refs the user has pinned — pinned refs don't count toward cap.
    const pinnedSlugsSet = new Set((body.pinnedSlugs ?? []).map((s) => slugify(s)).filter(Boolean));
    // Slugs the user removed — excluded even if RAG would otherwise pick them.
    const blacklistSlugs = (body.blacklistSlugs ?? []).map((s) => slugify(s)).filter(Boolean);
    const partialEdit = Boolean(selectionRange || sectionId);
    const priorReferenceList = loadPriorReferenceList(db, article.slug) ?? [];
    const priorReferenceSlugs = priorReferenceList.map((ref) => ref.slug);
    const priorReferenceSlugSet = new Set(priorReferenceSlugs);
    const newExplicitSlugs = explicitSlugs.filter((slug) => !priorReferenceSlugSet.has(slug));
    const effectiveExplicitSlugs = partialEdit ? Array.from(new Set([...priorReferenceSlugs, ...newExplicitSlugs])) : explicitSlugs;
    // Blocked refs apply in all edit modes (partial edits previously dropped
    // them) and persist: stored blocks survive future edits/refreshes until
    // the user re-adds the reference.
    persistBlacklistForEdit(db, article.slug, body);
    const effectiveBlacklistSlugs = Array.from(new Set([...blacklistSlugs, ...listArticleBlacklistSlugs(db, article.slug)]));

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

    const wantsStream = c.req.query("stream") === "1" || (c.req.header("accept") ?? "").includes("application/x-ndjson");

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
        const onProgress = (html: string, markdown: string) => {
          send?.({ type: "progress", html, markdown });
        };
        const result = await queueWorkflow(rewriteArticleWorkflow, {
          input: rewriteInput,
          deps: buildPipelineDeps({
            onProgress,
            onReasoningDelta: (_delta, accumulated) => recordLiveReasoning(article.slug, accumulated),
          }),
          recorder,
          logger,
          origin: "http",
        });
        if (result.status === "error") throw result.error ?? new Error("rewrite failed");

        const updatedSlug = result.state.canonicalSlug ?? article.slug;
        invalidateArticleHtml(updatedSlug);

        const ppRewritePromise = queueWorkflow(postProcessWorkflow, {
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
          origin: "post_process_auto",
          parentRunId: result.runId,
        }).catch(() => {});
        trackGeneration(ppRewritePromise);

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
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
            } catch {
              rewriteStreamOpen = false;
            }
          };
          const close = () => {
            if (!rewriteStreamOpen) return;
            rewriteStreamOpen = false;
            try {
              controller.close();
            } catch {}
          };
          send({ type: "start", slug: article.slug, cached: false });
          trackGeneration(
            runRewrite(send)
              .then((payload) => {
                send({ type: "done", ...payload });
                close();
              })
              .catch((error) => {
                send({
                  type: "error",
                  message: error instanceof Error ? error.message : String(error),
                });
                close();
              }),
          );
        },
        cancel() {
          rewriteStreamOpen = false;
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
    const wantsStream = c.req.query("stream") === "1" || /\bapplication\/x-ndjson\b/i.test(c.req.header("accept") ?? "");

    const runRefresh = async (send?: (event: Record<string, unknown>) => void) => {
      send?.({ type: "status", message: "Retrieving context..." });
      const recorder = getTraceRecorder(runtime.app.pipeline.trace);

      const onProgress = (html: string, markdown: string) => {
        send?.({ type: "progress", html, markdown });
      };

      const result = await queueWorkflow(refreshArticleWorkflow, {
        input: {
          requestId: randomUUID(),
          workflow: "article.refresh",
          slug: article.slug,
          requestedTitle: article.title,
          instructions: "article.refresh",
        },
        deps: buildPipelineDeps({
          onProgress,
          onReasoningDelta: (_delta, accumulated) => recordLiveReasoning(article.slug, accumulated),
        }),
        recorder,
        logger,
        origin: "http",
      });
      if (result.status === "error") throw result.error ?? new Error("refresh failed");

      const updatedSlug = result.state.canonicalSlug ?? article.slug;
      const persistedAt = result.state.persistedAt;
      const updatedRecord = getArticleByLookup(db, updatedSlug);
      const refreshChanged = !!updatedRecord && updatedRecord.markdown !== article.markdown;
      logger.info("page.refresh", {
        slug: updatedSlug,
        changed: refreshChanged,
      });
      invalidateArticleHtml(updatedSlug);

      const ppRefreshPromise = queueWorkflow(postProcessWorkflow, {
        input: {
          requestId: randomUUID(),
          workflow: "article.post_process",
          slug: updatedSlug,
          requestedTitle: article.title,
        },
        deps: buildPipelineDeps(),
        recorder,
        logger,
        origin: "post_process_auto",
        parentRunId: result.runId,
      }).catch(() => {});
      trackGeneration(ppRefreshPromise);

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
            try {
              controller.close();
            } catch {
              /* client already disconnected */
            }
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
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
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
    const links = extractAllBodyLinks(db, nextArticle.markdown, nextArticle.slug);
    nextArticle.html = rewriteArticleHtml(renderMarkdown(nextArticle.markdown), links);
    saveArticle(db, nextArticle, links, Array.from(new Set([nextArticle.slug, nextArticle.canonicalSlug])), {
      operation: "revert",
      instructions: `Reverted to revision ${revision.id}.`,
      revertedFromRevisionId: revision.id,
    });
    if (revision.headlineMediaId) {
      upsertArticleHeadlineMedia(db, nextArticle.slug, revision.headlineMediaId, revision.headlineMediaCaption ?? "");
    } else {
      removeArticleMedia(db, nextArticle.slug, 1);
    }
    updateLatestArticleRevisionMediaSnapshot(db, nextArticle.slug, revision.headlineMediaId, revision.headlineMediaCaption);
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
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? (all ? "10000" : "200"), 10) || 200, 1), all ? 10000 : 500);
    const cached = indexResponseCache.get(`idx:${offset}:${limit}:${all ? 1 : 0}`, () => {
      const page = listArticles(db, offset, limit);
      return JSON.stringify({
        items: page.items,
        cursor: page.nextOffset === null ? null : String(page.nextOffset),
        complete: page.nextOffset === null,
        total: page.total,
      });
    });
    if (c.req.header("if-none-match") === cached.etag) {
      return c.body(null, 304, { etag: cached.etag });
    }
    return c.body(cached.body, 200, {
      "content-type": "application/json",
      etag: cached.etag,
    });
  });

  registerPipelineAdminRoutes(
    app,
    () => runtime.app.pipeline.trace,
    () => buildPipelineDeps(),
  );
  registerRagAdminRoutes(
    app,
    () => rag,
    () => runtime.app.rag.min_score,
    {
      db,
      getLlm: () => llm,
      getPrompts: () => runtime.prompts,
      logger,
    },
  );
  registerAgentRoutes(app, () => ({
    db,
    rag,
    llm,
    promptConfig: runtime.prompts,
    recorder: getTraceRecorder(runtime.app.pipeline.trace),
    agentConfig: runtime.app.agent,
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
      modelConfigs,
      imageGeneration: {
        enabled: runtime.app.images.generation.enabled,
        autoGenerateForNewArticles: runtime.app.images.generation.auto_generate_for_new_articles,
        autoPresetMultipass: runtime.app.images.generation.auto_preset_multipass,
        homepageAutoImageMaxAttempts: runtime.app.images.generation.homepage_auto_image_max_attempts,
        backend: runtime.app.images.generation.backend,
        openaiModel: runtime.app.images.generation.openai.model,
        ollamaModel: runtime.app.images.generation.ollama.model,
        ollamaBaseUrl: runtime.app.images.generation.ollama.base_url,
        autoGenerateForFeaturedArticle: runtime.app.images.generation.auto_generate_for_featured_article,
      },
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

  // Drop the cached homepage payload and re-trigger the refresh task so the
  // featured article, Did-you-know facts, and timer all regenerate together —
  // a plain maintenance trigger would no-op while the cache is still fresh.
  app.post("/api/admin/reset-featured-article", (c) => {
    invalidateHomepageCache(db);
    maintenance.trigger(HOMEPAGE_MAINTENANCE_TASK, "Manual reset from admin panel");
    return c.json({ status: "triggered" });
  });

  app.post("/api/admin/prompt-model", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
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
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // ----- LLM hosts / roles admin -----
  // All writes patch config/llm.toml surgically (comments preserved) and apply
  // live via reloadRuntime() — which rebuilds the router, re-probes host model
  // capabilities, and re-applies per-host queue depths.
  const ROLE_TABLE: Record<string, string> = {
    heavy: "llm.chat",
    light: "llm.light",
    images: "llm.images",
    embeddings: "llm.embeddings",
  };
  const MASKED_API_KEY = "********";
  const HOST_ID_RE = /^[A-Za-z0-9_-]+$/;
  const editLlmToml = (mutate: (src: string) => string) => {
    const path = resolve(process.cwd(), "config", "llm.toml");
    const src = existsSync(path) ? readFileSync(path, "utf8") : "";
    writeFileSync(path, mutate(src));
  };
  const editAppToml = (mutate: (src: string) => string) => {
    const path = resolve(process.cwd(), "config", "app.toml");
    const examplePath = resolve(process.cwd(), "config", "app.toml.example");
    const src = existsSync(path) ? readFileSync(path, "utf8") : existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "";
    writeFileSync(path, mutate(src));
  };
  const editOntologyToml = (mutate: (src: string) => string) => {
    const path = resolve(process.cwd(), "config", "ontology.toml");
    const examplePath = resolve(process.cwd(), "config", "ontology.toml.example");
    const src = existsSync(path) ? readFileSync(path, "utf8") : existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "";
    writeFileSync(path, mutate(src));
  };

  // POST /api/admin/ontology/apply — write operator-selected vocabulary review
  // proposals into config/ontology.toml and hot-reload the running vocabulary
  // (no restart needed; existing articles re-extract lazily on next view/ref).
  app.post("/api/admin/ontology/apply", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      additions?: PredicateAdditionProposal[];
      removals?: string[];
    };
    const vocab = rag.vocab;
    const seenNames = new Set<string>();
    const additions = (Array.isArray(body.additions) ? body.additions : []).map((a) => sanitizePredicateAddition(a, vocab, seenNames)).filter((a): a is PredicateAdditionProposal => a !== null);
    const removalNames = new Set<string>();
    const removals = (Array.isArray(body.removals) ? body.removals : [])
      .filter((n): n is string => typeof n === "string")
      .map((name) => sanitizePredicateRemoval({ name }, vocab, removalNames)?.name ?? null)
      .filter((n): n is string => n !== null);

    if (additions.length === 0 && removals.length === 0) {
      return c.json({ error: "no valid additions or removals" }, 400);
    }

    editOntologyToml((src) => {
      let next = removePredicates(src, removals);
      next = appendPredicates(next, additions);
      return next;
    });
    rag.reloadVocab();

    return c.json(getVocabularyReviewStats(db, rag.vocab));
  });

  const liveRouter = () => (llm instanceof OpenAICompatRouter ? llm : null);

  app.get("/api/admin/llm", (c) => {
    const live = new Map((liveRouter()?.hostSnapshot() ?? []).map((h) => [h.id, h]));
    const hosts = Object.values(runtime.llm.hosts).map((h) => {
      const l = live.get(h.id);
      return {
        id: h.id,
        base_url: h.base_url,
        api_key: h.api_key ? MASKED_API_KEY : "",
        max_in_flight: h.max_in_flight,
        pref: h.pref,
        blacklist: h.blacklist,
        online: l?.online ?? false,
        active: l?.active ?? 0,
        queued: l?.queued ?? 0,
        activeJobs: l?.activeJobs ?? [],
        queuedJobs: l?.queuedJobs ?? [],
        models: l?.models ?? null,
      };
    });
    const roleEntry = (cfg: ChatConfig) => ({
      hosts: cfg.hosts,
      model: cfg.model,
      temperature: cfg.temperature,
      max_tokens: cfg.max_tokens,
      ...Object.fromEntries(OPTIONAL_OLLAMA_PARAMETER_KEYS.map((key) => [key, cfg[key] ?? null])),
    });
    const roles = {
      heavy: {
        ...roleEntry(runtime.llm.chat),
        candidates: liveRouter()?.candidatesFor("heavy") ?? [],
      },
      light: {
        ...roleEntry(runtime.llm.light),
        candidates: liveRouter()?.candidatesFor("light") ?? [],
      },
      images: runtime.llm.images
        ? {
            ...roleEntry(runtime.llm.images),
            candidates: liveRouter()?.candidatesFor("images") ?? [],
          }
        : null,
      embeddings: {
        hosts: runtime.llm.embeddings.hosts,
        model: runtime.llm.embeddings.model,
        enabled: runtime.llm.embeddings.enabled,
        candidates: liveRouter()?.candidatesFor("embeddings") ?? [],
      },
    };
    return c.json({
      hosts,
      roles,
      imageGeneration: {
        enabled: runtime.app.images.generation.enabled,
        autoGenerateForNewArticles: runtime.app.images.generation.auto_generate_for_new_articles,
        autoGenerateForFeaturedArticle: runtime.app.images.generation.auto_generate_for_featured_article,
        homepageAutoImageMaxAttempts: runtime.app.images.generation.homepage_auto_image_max_attempts,
        autoPresetMultipass: runtime.app.images.generation.auto_preset_multipass,
        backend: runtime.app.images.generation.backend,
        aspectRatios: listArticleImageAspectRatios(runtime.app.images.generation),
        openai: {
          baseUrl: runtime.app.images.generation.openai.base_url,
          apiKey: runtime.app.images.generation.openai.api_key ? MASKED_API_KEY : "",
          model: runtime.app.images.generation.openai.model,
          size: runtime.app.images.generation.openai.size,
          quality: runtime.app.images.generation.openai.quality,
          outputFormat: runtime.app.images.generation.openai.output_format,
          outputCompression: runtime.app.images.generation.openai.output_compression,
          timeoutMs: runtime.app.images.generation.openai.timeout_ms,
        },
        ollama: {
          baseUrl: runtime.app.images.generation.ollama.base_url,
          model: runtime.app.images.generation.ollama.model,
          width: runtime.app.images.generation.ollama.width,
          height: runtime.app.images.generation.ollama.height,
          steps: runtime.app.images.generation.ollama.steps,
          timeoutMs: runtime.app.images.generation.ollama.timeout_ms,
        },
      },
    });
  });

  app.get("/api/admin/llm/host/:id/models", async (c) => {
    const host = runtime.llm.hosts[c.req.param("id")];
    if (!host) return c.json({ error: "unknown host" }, 404);
    const models = await fetchHostModels(host.base_url, host.api_key, logger);
    if (models === null) return c.json({ error: "host unreachable", models: [] }, 502);
    return c.json({ models });
  });

  app.put("/api/admin/llm/role/:role", async (c) => {
    const role = c.req.param("role");
    const table = ROLE_TABLE[role];
    if (!table) return c.json({ error: "unknown role" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
      hosts?: unknown;
      model?: unknown;
      temperature?: unknown;
      max_tokens?: unknown;
      num_predict?: unknown;
      enabled?: unknown;
    } & Partial<Record<OptionalOllamaParameterKey, unknown>>;
    try {
      editLlmToml((src) => {
        let next = src;
        if (Array.isArray(body.hosts)) next = setTomlTableValue(next, table, "hosts", body.hosts.map(String));
        if (typeof body.model === "string") next = setTomlTableValue(next, table, "model", body.model);
        if (typeof body.temperature === "number") next = setTomlTableValue(next, table, "temperature", body.temperature);
        if (typeof body.max_tokens === "number") next = setTomlTableValue(next, table, "max_tokens", body.max_tokens);
        if (typeof body.num_predict === "number") next = setTomlTableValue(next, table, "num_predict", body.num_predict);
        else if (body.num_predict === null) next = removeTomlTableKey(next, table, "num_predict");
        for (const key of OPTIONAL_OLLAMA_PARAMETER_KEYS) {
          if (typeof body[key] === "number") next = setTomlTableValue(next, table, key, body[key] as number);
          else if (body[key] === null) next = removeTomlTableKey(next, table, key);
        }
        if (role === "embeddings" && typeof body.enabled === "boolean") next = setTomlTableValue(next, table, "enabled", body.enabled);
        return next;
      });
      await reloadRuntime();
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.put("/api/admin/llm/host/:id", async (c) => {
    const id = c.req.param("id");
    if (!runtime.llm.hosts[id]) return c.json({ error: "unknown host" }, 404);
    if (!HOST_ID_RE.test(id)) return c.json({ error: "host id is not directly editable; define it in config" }, 400);
    const table = `llm.host.${id}`;
    const body = (await c.req.json().catch(() => ({}))) as {
      base_url?: unknown;
      api_key?: unknown;
      max_in_flight?: unknown;
      pref?: unknown;
      blacklist?: unknown;
    };
    try {
      editLlmToml((src) => {
        let next = src;
        if (typeof body.base_url === "string") next = setTomlTableValue(next, table, "base_url", body.base_url);
        // Only write the key when the UI sends a real (non-masked) value.
        if (typeof body.api_key === "string" && body.api_key !== MASKED_API_KEY && body.api_key.length > 0) next = setTomlTableValue(next, table, "api_key", body.api_key);
        if (typeof body.max_in_flight === "number") next = setTomlTableValue(next, table, "max_in_flight", body.max_in_flight);
        if (typeof body.pref === "number") next = setTomlTableValue(next, table, "pref", body.pref);
        if (Array.isArray(body.blacklist)) next = setTomlTableValue(next, table, "blacklist", body.blacklist.map(String));
        return next;
      });
      await reloadRuntime();
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/admin/llm/host", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: unknown;
      base_url?: unknown;
      api_key?: unknown;
      max_in_flight?: unknown;
      pref?: unknown;
      blacklist?: unknown;
    };
    const id = String(body.id ?? "");
    if (!HOST_ID_RE.test(id)) return c.json({ error: "id must match [A-Za-z0-9_-]+" }, 400);
    if (runtime.llm.hosts[id]) return c.json({ error: "host already exists" }, 409);
    if (typeof body.base_url !== "string" || !body.base_url) return c.json({ error: "base_url is required" }, 400);
    try {
      editLlmToml((src) =>
        addTomlTable(src, `llm.host.${id}`, {
          base_url: body.base_url as string,
          api_key: typeof body.api_key === "string" && body.api_key.length > 0 ? body.api_key : "local",
          max_in_flight: typeof body.max_in_flight === "number" ? body.max_in_flight : 4,
          pref: typeof body.pref === "number" ? body.pref : 100,
          ...(Array.isArray(body.blacklist) && body.blacklist.length ? { blacklist: body.blacklist.map(String) } : {}),
        }),
      );
      await reloadRuntime();
      return c.json({ ok: true, id });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.put("/api/admin/images/generation", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: unknown;
      autoGenerateForNewArticles?: unknown;
      autoGenerateForFeaturedArticle?: unknown;
      homepageAutoImageMaxAttempts?: unknown;
      autoPresetMultipass?: unknown;
      backend?: unknown;
      openai?: {
        baseUrl?: unknown;
        apiKey?: unknown;
        model?: unknown;
        size?: unknown;
        quality?: unknown;
        outputFormat?: unknown;
        outputCompression?: unknown;
        timeoutMs?: unknown;
      };
      ollama?: {
        baseUrl?: unknown;
        model?: unknown;
        width?: unknown;
        height?: unknown;
        steps?: unknown;
        timeoutMs?: unknown;
      };
    };
    try {
      editAppToml((src) => {
        let next = src;
        if (typeof body.enabled === "boolean") {
          next = setTomlTableValue(next, "images.generation", "enabled", body.enabled);
        }
        if (typeof body.autoGenerateForNewArticles === "boolean") {
          next = setTomlTableValue(next, "images.generation", "auto_generate_for_new_articles", body.autoGenerateForNewArticles);
        }
        if (typeof body.autoGenerateForFeaturedArticle === "boolean") {
          next = setTomlTableValue(next, "images.generation", "auto_generate_for_featured_article", body.autoGenerateForFeaturedArticle);
        }
        if (typeof body.homepageAutoImageMaxAttempts === "number") {
          next = setTomlTableValue(next, "images.generation", "homepage_auto_image_max_attempts", Math.max(0, Math.floor(body.homepageAutoImageMaxAttempts)));
        }
        if (typeof body.autoPresetMultipass === "boolean") {
          next = setTomlTableValue(next, "images.generation", "auto_preset_multipass", body.autoPresetMultipass);
        }
        if (body.backend === "openai" || body.backend === "ollama") {
          next = setTomlTableValue(next, "images.generation", "backend", body.backend);
        }
        if (body.openai && typeof body.openai === "object") {
          if (typeof body.openai.baseUrl === "string") {
            next = setTomlTableValue(next, "images.generation.openai", "base_url", body.openai.baseUrl);
          }
          if (typeof body.openai.apiKey === "string" && body.openai.apiKey.length > 0 && body.openai.apiKey !== MASKED_API_KEY) {
            next = setTomlTableValue(next, "images.generation.openai", "api_key", body.openai.apiKey);
          }
          if (typeof body.openai.model === "string") {
            next = setTomlTableValue(next, "images.generation.openai", "model", body.openai.model);
          }
          if (typeof body.openai.size === "string") {
            next = setTomlTableValue(next, "images.generation.openai", "size", body.openai.size);
          }
          if (typeof body.openai.quality === "string") {
            next = setTomlTableValue(next, "images.generation.openai", "quality", body.openai.quality);
          }
          if (typeof body.openai.outputFormat === "string") {
            next = setTomlTableValue(next, "images.generation.openai", "output_format", body.openai.outputFormat);
          }
          if (typeof body.openai.outputCompression === "number") {
            next = setTomlTableValue(next, "images.generation.openai", "output_compression", body.openai.outputCompression);
          }
          if (typeof body.openai.timeoutMs === "number") {
            next = setTomlTableValue(next, "images.generation.openai", "timeout_ms", body.openai.timeoutMs);
          }
        }
        if (body.ollama && typeof body.ollama === "object") {
          if (typeof body.ollama.baseUrl === "string") {
            next = setTomlTableValue(next, "images.generation.ollama", "base_url", body.ollama.baseUrl);
          }
          if (typeof body.ollama.model === "string") {
            next = setTomlTableValue(next, "images.generation.ollama", "model", body.ollama.model);
          }
          if (typeof body.ollama.width === "number") {
            next = setTomlTableValue(next, "images.generation.ollama", "width", body.ollama.width);
          }
          if (typeof body.ollama.height === "number") {
            next = setTomlTableValue(next, "images.generation.ollama", "height", body.ollama.height);
          }
          if (typeof body.ollama.steps === "number") {
            next = setTomlTableValue(next, "images.generation.ollama", "steps", body.ollama.steps);
          }
          if (typeof body.ollama.timeoutMs === "number") {
            next = setTomlTableValue(next, "images.generation.ollama", "timeout_ms", body.ollama.timeoutMs);
          }
        }
        return next;
      });
      await reloadRuntime();
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // Corpus wipe endpoint — disabled. The admin button was removed; leaving the
  // route live made it too easy to nuke the whole corpus with a stray POST.
  // Uncomment (and restore a confirmation flow) if a reset surface is needed.
  // app.post("/api/admin/wipe", (c) => {
  //   const dbPath = resolve(process.cwd(), runtime.app.storage.database_path);
  //   if (existsSync(dbPath)) {
  //     const ts = new Date().toISOString().replace(/[:.]/g, "-");
  //     const backupPath = `${dbPath}.backup-${ts}`;
  //     try {
  //       copyFileSync(dbPath, backupPath);
  //       logger.info("admin.backup_before_wipe", { backup: backupPath });
  //     } catch (err) {
  //       logger.error("admin.backup_failed", {
  //         error: err instanceof Error ? err.message : String(err),
  //       });
  //     }
  //   }
  //   wipeGeneratedCorpus(db);
  //   logger.warn("admin.wipe_generated_corpus");
  //   return c.json({ ok: true });
  // });

  app.post("/api/admin/delete-article", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { slug?: string };
    const slug = slugify(body.slug ?? "");
    if (!slug) return c.json({ error: "missing slug" }, 400);
    const deleted = deleteArticleBySlug(db, slug);
    if (deleted) {
      enqueueRagIndexJob(db, {
        articleSlug: slug,
        sourceKind: "article_body",
        sourceId: slug,
        operation: "delete",
      });
    }
    return c.json({ ok: deleted, slug });
  });

  app.post("/api/admin/regenerate-summary", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { slug?: string };
    const lookupSlug = articleLookupSlugFromInput(body.slug ?? "");
    if (!lookupSlug) return c.json({ error: "missing slug" }, 400);

    try {
      await reloadRuntime();
      const recorder = getTraceRecorder(runtime.app.pipeline.trace);
      const result = await queueWorkflow(regenerateSummaryWorkflow, {
        input: {
          requestId: randomUUID(),
          workflow: "regenerate.summary",
          slug: lookupSlug,
        },
        deps: buildPipelineDeps(),
        recorder,
        logger,
        origin: "http",
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
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
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
    const body = (await c.req.json().catch(() => ({}))) as {
      aliasSlug?: string;
      articleSlug?: string;
    };
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

    const displaced = getArticle(db, sourceSlug);
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
      enqueueRagIndexJob(db, {
        articleSlug: displaced.slug,
        sourceKind: "article_body",
        sourceId: displaced.slug,
        operation: "delete",
      });
      logger.info("admin.article_archived", {
        slug: displaced.slug,
        reason: "canonical_redirect",
        canonicalSlug,
      });
    }

    addSlugAlias(db, sourceSlug, canonicalSlug);
    logger.info("admin.redirect_added", {
      sourceSlug,
      canonicalSlug,
      displaced: displaced?.slug ?? null,
    });
    return c.json({
      ok: true,
      sourceSlug,
      canonicalSlug,
      archived: displaced ? displaced.slug : null,
    });
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
    const body = (await c.req.json().catch(() => ({}))) as {
      confirm?: boolean;
    };
    const archived = getArchivedArticle(db, slug);
    if (!archived) return c.json({ error: "archived article not found" }, 404);

    const existing = getArticleByLookup(db, slug);
    if (existing && !body.confirm) {
      return c.json({
        requiresConfirm: true,
        message: `An article already exists at ${slug}. Send confirm:true to overwrite it with the archived version.`,
      });
    }

    const links = extractAllBodyLinks(db, archived.markdown, archived.slug);
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

  app.get("/api/admin/article-image-prompts", (c) => {
    return c.json({ prompts: listArticleImagePromptOptions() });
  });

  app.get("/api/admin/article-image-aspect-ratios", (c) => {
    return c.json({
      aspectRatios: listArticleImageAspectRatios(runtime.app.images.generation),
    });
  });

  app.get("/api/admin/article-image-prompts/:key", (c) => {
    const key = c.req.param("key");
    try {
      const prompt = readArticleImagePromptSelection(key);
      if (prompt.key === "documentary_photo") {
        const current = getPromptCurrent(db, "runnable", "article_image");
        return c.json({ ...prompt, ...(current ?? {}) });
      }
      return c.json(prompt);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.post("/api/admin/article-image-prompts", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      copyFrom?: unknown;
    };
    if (typeof body.name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }
    let key: string;
    try {
      key = articleImagePresetKeyFromName(body.name);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const copyFrom = typeof body.copyFrom === "string" && body.copyFrom.trim() ? body.copyFrom.trim() : "documentary_photo";
    let source: ReturnType<typeof readArticleImagePromptSelection>;
    try {
      source = readArticleImagePromptSelection(copyFrom);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    if (source.key === "documentary_photo") {
      const current = getPromptCurrent(db, "runnable", "article_image");
      if (current) source = { ...source, ...current };
    }
    const created = createArticleImagePresetFile(key, source.system, source.user, {
      model: source.model,
      thinking: source.thinking,
      json: source.json,
      allowText: source.allowText,
    });
    if ("error" in created) return c.json(created, /exists/i.test(created.error) ? 409 : 400);
    await reloadRuntime();
    return c.json({
      ok: true,
      prompt: { ...created, system: source.system, user: source.user },
      prompts: listArticleImagePromptOptions(),
    });
  });

  app.put("/api/admin/article-image-prompts/:key", async (c) => {
    let key: string;
    try {
      key = normalizeArticleImagePresetKey(c.req.param("key"));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    if (key === "documentary_photo") {
      return c.json({ error: "documentary_photo preset is edited through article_image" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      system?: unknown;
      user?: unknown;
    };
    if (typeof body.system !== "string" || typeof body.user !== "string") {
      return c.json({ error: "system and user must be strings" }, 400);
    }
    const err = writeArticleImagePresetFile(key, body.system, body.user);
    if (err) return c.json(err, /not found/i.test(err.error) ? 404 : 400);
    await reloadRuntime();
    const prompt = readArticleImagePresetFile(key);
    return c.json({
      ok: true,
      prompt: prompt ? { ...prompt, system: body.system, user: body.user } : null,
    });
  });

  app.delete("/api/admin/article-image-prompts/:key", async (c) => {
    let key: string;
    try {
      key = normalizeArticleImagePresetKey(c.req.param("key"));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    if (key === "documentary_photo") {
      return c.json({ error: "the documentary_photo image prompt cannot be deleted" }, 400);
    }
    const err = deleteArticleImagePresetFile(key);
    if (err) return c.json(err, /not found/i.test(err.error) ? 404 : 400);
    await reloadRuntime();
    return c.json({ ok: true, prompts: listArticleImagePromptOptions() });
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
    const body = (await c.req.json().catch(() => ({}))) as {
      system?: unknown;
      user?: unknown;
    };
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
    return c.json({
      ok: true,
      prompt: meta ? { ...meta, system: body.system, user: body.user } : null,
    });
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
    return c.json({
      ok: true,
      prompt: meta ? { ...meta, system: target.system, user: target.user } : null,
    });
  });

  app.post("/api/disambiguation", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      entries?: Array<{ title: string; description: string }>;
    };
    const title = (body.title ?? "").replace(/\s+/g, " ").trim();
    if (!title) return c.json({ error: "missing title" }, 400);
    const entries = (body.entries ?? []).filter((e) => e.title?.trim() && e.description?.trim());
    if (entries.length < 2) return c.json({ error: "at least 2 entries required" }, 400);

    const normalizedTitle = normalizeCanonicalTitle(title);
    const slug = slugify(normalizedTitle);
    if (!slug) return c.json({ error: "invalid title" }, 400);

    const lines = [`# ${normalizedTitle} (disambiguation)`, "", `**${normalizedTitle}** may refer to:`, ""];
    for (const entry of entries) {
      const entrySlug = slugify(entry.title.trim());
      const hint = entry.description.trim();
      lines.push(`- ${buildHaluLink(entry.title.trim(), entrySlug, hint)} — ${hint.replace(/"/g, "'")}`);
    }
    const markdown = lines.join("\n");
    const links = extractAllBodyLinks(db, markdown, slug);
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
    if (!article || !article.isDisambiguation) return c.json({ error: "not a disambiguation page" }, 404);
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

    // Treat the query as a possible direct target: a raw slug or a pasted
    // /wiki/ link (or full URL) should resolve to its article — following
    // aliases — and surface as the top exact hit, even when fuzzy text search
    // wouldn't rank it first. Only on the first page, and de-duplicated.
    if (offset === 0) {
      const directSlug = articleLookupSlugFromInput(q);
      const direct = directSlug ? getArticleByLookup(db, directSlug) : null;
      if (direct) {
        const canonical = getCanonicalSlugForTarget(db, direct.slug);
        if (!results.some((r) => r.slug === canonical)) {
          results.unshift({
            slug: canonical,
            title: direct.title === direct.slug ? slugToTitle(direct.slug) : direct.title,
            summary: direct.summaryMarkdown?.trim() || summaryMarkdownFromArticle(direct.markdown),
            exists: true,
          });
        }
      }
    }

    const resultSlugs = results.map((r) => r.slug);
    const random =
      offset === 0
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
    const { model_b64: _b64, generation_metadata: generationMetadata, ...safe } = record as any;
    return c.json({
      ...safe,
      generation: parseMediaGenerationMetadata(generationMetadata),
    });
  });

  app.patch("/api/media/:id/description", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as {
      description?: string;
    };
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
    // Optional pagination (?cursor & ?limit, mirroring /api/index); without
    // params the full list is returned for existing clients.
    const limitParam = c.req.query("limit");
    const offset = Math.max(parseInt(c.req.query("cursor") ?? "0", 10) || 0, 0);
    const page = limitParam
      ? {
          limit: Math.min(Math.max(parseInt(limitParam, 10) || 200, 1), 500),
          offset,
        }
      : undefined;
    const buildBody = () => {
      const { items, total } = listMedia(mediaDb, q || undefined, page);
      const nextOffset = page && offset + items.length < total ? offset + items.length : null;
      return JSON.stringify({
        media: items,
        total,
        cursor: nextOffset === null ? null : String(nextOffset),
        complete: nextOffset === null,
      });
    };
    // Search/paged queries are unbounded as cache keys, so only the full list is cached.
    if (q || page) return c.body(buildBody(), 200, { "content-type": "application/json" });
    const cached = mediaResponseCache.get("media:", buildBody);
    if (c.req.header("if-none-match") === cached.etag) {
      return c.body(null, 304, { etag: cached.etag });
    }
    return c.body(cached.body, 200, {
      "content-type": "application/json",
      etag: cached.etag,
    });
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

    const body = (await c.req.json().catch(() => ({}))) as {
      instructions?: string;
      articleSlug?: string;
    };
    const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
    const articleSlug = typeof body.articleSlug === "string" ? slugify(body.articleSlug) : "";

    const recorder = getTraceRecorder(runtime.app.pipeline.trace);
    const result = await queueWorkflow(captionImageWorkflow, {
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
      origin: "http",
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

  /** Enqueue a LanceDB re-index job for a slug (its body + infobox are
   *  re-derived by the drainer). */
  function reindexSidebarRag(slug: string): void {
    if (!getArticleByLookup(db, slug)) return;
    enqueueRagIndexJob(db, {
      articleSlug: slug,
      sourceKind: "article_body",
      sourceId: slug,
      operation: "upsert",
    });
  }

  /** Build the pre-rendered sidebar payload for a slug (same shape as page payload). */
  function buildSidebarPayload(slug: string) {
    const rawInfobox = getArticleInfobox(db, slug);
    const sidebarRefs = loadPriorReferenceList(db, slug) ?? [];
    const infobox = rawInfobox
      ? {
          ...rawInfobox,
          title: renderInlineMarkdown(rawInfobox.title),
          subtitle: rawInfobox.subtitle ? renderInlineMarkdown(linkReferencesInline(rawInfobox.subtitle, sidebarRefs)) : undefined,
          groups: rawInfobox.groups.map((g) => ({
            label: renderInlineMarkdown(g.label),
            rows: g.rows.map((r) => ({
              label: renderInlineMarkdown(r.label),
              value: renderInlineMarkdown(linkReferencesInline(r.value, sidebarRefs)),
            })),
          })),
        }
      : null;
    const headlineMediaRow = getArticleHeadlineMedia(db, slug);
    const caption = headlineMediaRow?.caption ? renderInlineMarkdown(linkReferencesInline(headlineMediaRow.caption, sidebarRefs)) : "";
    return { infobox, caption };
  }

  // Resolve an article from a /wiki/-style path segment the same way the page
  // endpoint does. A naive slugify of a hyphenated-title URL (e.g. the
  // "Regulation-of-semen-flow-…" links emitted in pipeline traces) dash-mangles
  // into a slug that no single lookup matches, so fall back through legacy,
  // title, exact-slug, and equivalent lookups. The sidebar editor endpoints
  // pass the raw wiki segment from the URL, so they must resolve as robustly as
  // page loads do — otherwise editing/regenerating a reachable article 404s.
  function resolveArticleFromSegment(segment: string): ArticleRecord | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      decoded = segment;
    }
    decoded = decoded.replace(/^\/+|\/+$/g, "");
    const segmentTitle = normalizeCanonicalTitle(wikiSegmentToRequestedTitle(decoded));
    const lookupSlug = slugify(segmentTitle);
    const legacyLookup = legacySlugify(segmentTitle);
    return getArticleByLookup(db, lookupSlug) ?? (legacyLookup !== lookupSlug ? getArticleByLookup(db, legacyLookup) : null) ?? getArticleByTitle(db, segmentTitle) ?? (isSlugForm(decoded) ? getArticleByLookup(db, decoded) : null) ?? getArticleByEquivalentLookup(db, lookupSlug);
  }

  // Assemble an article's ontology facts for the viewer/editor. Brings the
  // article up to the live vocabulary lazily and deterministically (no model
  // call) when it is stale, enqueuing a background reindex to catch up the
  // embeddings + LLM pass. Any referenced object article that is itself stale is
  // enqueued for the same background refresh ("reload it on request, including
  // if it's being referenced") without blocking this response.
  function buildArticleOntologyPayload(slug: string) {
    if (ensureArticleOntologyFresh(db, slug, rag.vocab)) {
      enqueueRagIndexJob(db, {
        articleSlug: slug,
        sourceKind: "article_body",
        sourceId: slug,
        operation: "upsert",
      });
    }
    const { entity, facts, identifiers, categories } = listArticleEntityFacts(db, slug);
    const seenObject = new Set<string>();
    for (const fact of facts) {
      if (fact.objectSlug && !seenObject.has(fact.objectSlug)) {
        seenObject.add(fact.objectSlug);
        if (isArticleOntologyStale(db, fact.objectSlug, rag.vocab)) {
          enqueueRagIndexJob(db, {
            articleSlug: fact.objectSlug,
            sourceKind: "article_body",
            sourceId: fact.objectSlug,
            operation: "upsert",
          });
        }
      }
    }
    return {
      entityType: entity?.entityType ?? null,
      facts: facts.map((f: ArticleOntologyFact) => ({
        id: f.relationId,
        predicate: f.predicate,
        label: rag.vocab.predicates.get(f.predicate)?.label ?? f.predicate.replace(/_/g, " "),
        object: f.object,
        objectHtml: renderOntologyValueHtml(f.object),
        objectSlug: f.objectSlug,
        source: f.source,
        confidence: f.confidence,
      })),
      identifiers,
      categories,
      suggestions: listOntologySuggestions(db, slug).map((suggestion) => ({
        ...suggestion,
        label: rag.vocab.predicates.get(suggestion.predicate)?.label ?? suggestion.predicate.replace(/_/g, " "),
        objectHtml: renderOntologyValueHtml(suggestion.object),
      })),
    };
  }

  function normalizeSubmittedPredicate(value: unknown): string {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (!trimmed) return "";
    return rag.vocab.predicates.has(trimmed) ? trimmed : normalizeLabel(trimmed);
  }

  // GET /api/ontology/vocabulary — predicates + entity types for the fact editor.
  app.get("/api/ontology/vocabulary", (c) => {
    const predicates = [...rag.vocab.predicates.values()]
      .filter((p) => p.arity === "binary" && p.name !== "is_a")
      .map((p) => ({
        name: p.name,
        label: p.label,
        subject: p.subject,
        object: p.object,
      }));
    return c.json({ predicates, entityTypes: [...rag.vocab.entityTypes] });
  });

  // GET /api/ontology/graph — corpus-wide semantic graph projection.
  app.get("/api/ontology/graph", (c) => {
    return c.json(buildOntologyGraphPayload(db, rag.vocab));
  });

  // GET /api/article/:slug/ontology — facts for the article (lazy-refreshed).
  app.get("/api/article/:slug/ontology", (c) => {
    const article = resolveArticleFromSegment(c.req.param("slug"));
    if (!article) return c.json({ error: "not found" }, 404);
    return c.json(buildArticleOntologyPayload(article.slug));
  });

  app.patch("/api/article/:slug/ontology/entity", async (c) => {
    const article = resolveArticleFromSegment(c.req.param("slug"));
    if (!article) return c.json({ error: "not found" }, 404);
    const slug = article.slug;
    const body = (await c.req.json().catch(() => ({}))) as { entityType?: string };
    const entityType = typeof body.entityType === "string" ? body.entityType.trim() : "";
    if (!entityType || !rag.vocab.entityTypes.has(entityType)) {
      return c.json({ error: "unknown entity type" }, 400);
    }
    ensureArticleOntologyFresh(db, slug, rag.vocab);
    if (!updateArticleEntityType(db, slug, entityType)) {
      return c.json({ error: "article has no ontology entity" }, 409);
    }
    enqueueRagIndexJob(db, {
      articleSlug: slug,
      sourceKind: "article_body",
      sourceId: slug,
      operation: "upsert",
    });
    return c.json(buildArticleOntologyPayload(slug));
  });

  // POST /api/article/:slug/ontology/facts — add a hand-curated fact. The object
  // is either a link to another article (objectSlug) or a plain literal value.
  app.post("/api/article/:slug/ontology/facts", async (c) => {
    const article = resolveArticleFromSegment(c.req.param("slug"));
    if (!article) return c.json({ error: "not found" }, 404);
    const slug = article.slug;

    const body = (await c.req.json().catch(() => ({}))) as {
      predicate?: string;
      objectSlug?: string;
      objectLiteral?: string;
    };
    const predicate = normalizeSubmittedPredicate(body.predicate);
    if (!predicate) return c.json({ error: "predicate required" }, 400);

    // Ensure the subject article has an entity to attach the fact to.
    ensureArticleOntologyFresh(db, slug, rag.vocab);
    const subjectId = getArticleEntityId(db, slug);
    if (subjectId === null) return c.json({ error: "article has no ontology entity" }, 409);

    let objectEntityId: number | null = null;
    let objectLiteral: string | null = null;
    const objectSlug = typeof body.objectSlug === "string" ? body.objectSlug.trim() : "";
    if (objectSlug) {
      const target = resolveArticleFromSegment(objectSlug);
      if (!target) return c.json({ error: "linked article not found" }, 400);
      // Lazily materialize the target's entity so the fact links to a real node.
      ensureArticleOntologyFresh(db, target.slug, rag.vocab);
      objectEntityId = getArticleEntityId(db, target.slug);
      if (objectEntityId === null) objectLiteral = target.title;
    } else {
      objectLiteral = typeof body.objectLiteral === "string" ? body.objectLiteral.trim() : "";
      if (!objectLiteral) return c.json({ error: "object required" }, 400);
    }

    addCuratedFact(db, {
      subjectId,
      predicate,
      objectEntityId,
      objectLiteral,
      provenanceSlug: slug,
    });
    enqueueRagIndexJob(db, {
      articleSlug: slug,
      sourceKind: "article_body",
      sourceId: slug,
      operation: "upsert",
    });
    return c.json(buildArticleOntologyPayload(slug));
  });

  // DELETE /api/article/:slug/ontology/facts/:id — remove a fact (any source).
  // Curated facts are deleted outright; non-curated facts are suppressed so
  // they survive re-extraction without reappearing.
  app.delete("/api/article/:slug/ontology/facts/:id", (c) => {
    const article = resolveArticleFromSegment(c.req.param("slug"));
    if (!article) return c.json({ error: "not found" }, 404);
    const slug = article.slug;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    const removed = deleteCuratedFact(db, slug, id) || suppressFact(db, slug, id);
    if (!removed) return c.json({ error: "fact not found" }, 404);
    enqueueRagIndexJob(db, {
      articleSlug: slug,
      sourceKind: "article_body",
      sourceId: slug,
      operation: "upsert",
    });
    return c.json(buildArticleOntologyPayload(slug));
  });

  // PATCH /api/article/:slug/ontology/facts/:id — edit a fact. Curated facts
  // are updated in place; non-curated facts are promoted to curated on edit.
  app.patch("/api/article/:slug/ontology/facts/:id", async (c) => {
    const article = resolveArticleFromSegment(c.req.param("slug"));
    if (!article) return c.json({ error: "not found" }, 404);
    const slug = article.slug;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);

    const body = (await c.req.json().catch(() => ({}))) as {
      predicate?: string;
      objectSlug?: string;
      objectLiteral?: string;
    };
    const updates: {
      predicate?: string;
      objectEntityId?: number | null;
      objectLiteral?: string | null;
    } = {};
    if (typeof body.predicate === "string" && body.predicate.trim()) {
      updates.predicate = normalizeSubmittedPredicate(body.predicate);
      if (!updates.predicate) return c.json({ error: "predicate required" }, 400);
    }
    const objectSlug = typeof body.objectSlug === "string" ? body.objectSlug.trim() : "";
    if (objectSlug) {
      const target = resolveArticleFromSegment(objectSlug);
      if (!target) return c.json({ error: "linked article not found" }, 400);
      ensureArticleOntologyFresh(db, target.slug, rag.vocab);
      updates.objectEntityId = getArticleEntityId(db, target.slug);
      updates.objectLiteral = updates.objectEntityId === null ? target.title : null;
    } else if (typeof body.objectLiteral === "string" && body.objectLiteral.trim()) {
      updates.objectEntityId = null;
      updates.objectLiteral = body.objectLiteral.trim();
    }

    const newId = updateFact(db, slug, id, updates);
    if (newId === null) return c.json({ error: "fact not found" }, 404);
    enqueueRagIndexJob(db, {
      articleSlug: slug,
      sourceKind: "article_body",
      sourceId: slug,
      operation: "upsert",
    });
    return c.json(buildArticleOntologyPayload(slug));
  });

  // POST /api/article/:slug/ontology/infer — refresh persisted suggestions.
  app.post("/api/article/:slug/ontology/infer", async (c) => {
    const article = resolveArticleFromSegment(c.req.param("slug"));
    if (!article) return c.json({ error: "not found" }, 404);
    const slug = article.slug;

    try {
      const recorder = getTraceRecorder(runtime.app.pipeline.trace);
      const result = await queueWorkflow(ontologyInferWorkflow, {
        input: { requestId: randomUUID(), workflow: "ontology.infer", slug },
        deps: buildPipelineDeps(),
        recorder,
        logger,
        origin: "http",
      });

      if (result.status === "error") throw result.error ?? new Error("ontology inference failed");

      return c.json(buildArticleOntologyPayload(slug));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "LLM error" }, 500);
    }
  });

  async function runOntologySuggestionAction(c: Context, mode: "append" | "merge") {
    const segment = c.req.param("slug");
    if (!segment) return c.json({ error: "not found" }, 404);
    const article = resolveArticleFromSegment(segment);
    if (!article) return c.json({ error: "not found" }, 404);
    const slug = article.slug;
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is number => Number.isInteger(id) && id > 0) : undefined;
    const workflow = mode === "merge" ? ontologySuggestionsMergeWorkflow : ontologySuggestionsAppendWorkflow;
    const result = await queueWorkflow(workflow, {
      input: {
        requestId: randomUUID(),
        workflow: workflow.name,
        slug,
        ontologySuggestionIds: ids,
      },
      deps: buildPipelineDeps(),
      recorder: getTraceRecorder(runtime.app.pipeline.trace),
      logger,
      origin: "http",
    });
    if (result.status === "error") {
      return c.json({ error: result.error?.message ?? "ontology suggestion action failed" }, 500);
    }
    return c.json(buildArticleOntologyPayload(slug));
  }

  app.post("/api/article/:slug/ontology/suggestions/append", (c) => runOntologySuggestionAction(c, "append"));
  app.post("/api/article/:slug/ontology/suggestions/merge", (c) => runOntologySuggestionAction(c, "merge"));
  app.delete("/api/article/:slug/ontology/suggestions/:id", (c) => {
    const article = resolveArticleFromSegment(c.req.param("slug"));
    if (!article) return c.json({ error: "not found" }, 404);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid suggestion id" }, 400);
    deleteOntologySuggestions(db, article.slug, [id]);
    return c.json(buildArticleOntologyPayload(article.slug));
  });
  app.delete("/api/article/:slug/ontology/suggestions", (c) => {
    const article = resolveArticleFromSegment(c.req.param("slug"));
    if (!article) return c.json({ error: "not found" }, 404);
    deleteOntologySuggestions(db, article.slug);
    return c.json(buildArticleOntologyPayload(article.slug));
  });

  // GET /api/article/:slug/infobox — raw (unrendered) infobox data for the editor.
  app.get("/api/article/:slug/infobox", (c) => {
    const article = resolveArticleFromSegment(c.req.param("slug"));
    if (!article) return c.json({ error: "not found" }, 404);
    const slug = article.slug;
    const rawInfobox = getArticleInfobox(db, slug);
    const headlineMediaRow = getArticleHeadlineMedia(db, slug);
    return c.json({
      infobox: rawInfobox,
      caption: headlineMediaRow?.caption ?? "",
    });
  });

  // PATCH /api/article/:slug/infobox — raw save of infobox JSON + optional caption.
  app.patch("/api/article/:slug/infobox", async (c) => {
    const article = resolveArticleFromSegment(c.req.param("slug"));
    if (!article) return c.json({ error: "not found" }, 404);
    const slug = article.slug;

    const body = (await c.req.json().catch(() => ({}))) as {
      infobox?: InfoboxData;
      caption?: string;
    };
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
      if (headlineMedia)
        notifySidecar(slug, {
          type: "caption",
          caption: body.caption.trim(),
          mediaId: headlineMedia.mediaId,
        });
    }

    return c.json({ ok: true, ...payload });
  });

  // POST /api/article/:slug/infobox/regenerate — AI re-generation with optional instructions.
  app.post("/api/article/:slug/infobox/regenerate", async (c) => {
    const article = resolveArticleFromSegment(c.req.param("slug"));
    if (!article) return c.json({ error: "not found" }, 404);
    const slug = article.slug;

    const body = (await c.req.json().catch(() => ({}))) as {
      instructions?: string;
    };
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
    const article = resolveArticleFromSegment(c.req.param("slug"));
    if (!article) return c.json({ error: "not found" }, 404);
    const revisions = listSidebarRevisions(db, article.slug);
    return c.json({ revisions });
  });

  // POST /api/article/:slug/infobox/restore — restore a prior sidebar revision.
  app.post("/api/article/:slug/infobox/restore", async (c) => {
    const article = resolveArticleFromSegment(c.req.param("slug"));
    if (!article) return c.json({ error: "not found" }, 404);
    const slug = article.slug;

    const body = (await c.req.json().catch(() => ({}))) as {
      revisionId?: number;
    };
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
      if (headlineMedia)
        notifySidecar(slug, {
          type: "caption",
          caption: rev.caption,
          mediaId: headlineMedia.mediaId,
        });
    }

    return c.json({ ok: true, ...payload });
  });

  // Live sidecar stream — NDJSON events pushed when post-process updates
  // infobox, caption, or article body for this slug. Clients subscribe on
  // page load and receive updates without polling.
  app.get("/api/article/:slug/live", (c) => {
    // Key the listener channel on the canonical slug so it matches what
    // notifySidecar pushes to — a naive slugify of a hyphenated-title URL would
    // register a dash-mangled channel that never receives updates.
    const slug = resolveArticleFromSegment(c.req.param("slug"))?.slug || slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const enc = new TextEncoder();
    let open = true;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (payload: unknown) => {
          if (!open) return;
          try {
            controller.enqueue(enc.encode(`${JSON.stringify(payload)}\n`));
          } catch {
            open = false;
          }
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
          try {
            controller.close();
          } catch {}
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

  function preserveCurrentImageSnapshot(articleSlug: string) {
    const article = getArticleByLookup(db, articleSlug);
    if (!article) return;
    const headlineMedia = getArticleHeadlineMedia(db, article.slug);
    listArticleRevisions(db, article.slug);
    updateLatestArticleRevisionMediaSnapshot(db, article.slug, headlineMedia?.mediaId ?? null, headlineMedia?.caption ?? null);
  }

  function recordImageSnapshot(articleSlug: string, operation: string, instructions: string) {
    insertArticleRevisionSnapshot(db, articleSlug, { operation, instructions });
  }

  /** Shared helper: attach a just-ingested image, fire caption pipeline async. */
  function attachAndCaption(articleSlug: string, mediaId: string, isNew: boolean, width: number, height: number, operation = "image-attach") {
    // ── Strip any existing inline media images from the article body ──────────
    // Articles should never have headline images inline; they live in the sidebar.
    const article = getArticleByLookup(db, articleSlug);
    const previousHeadline = article ? getArticleHeadlineMedia(db, article.slug) : null;
    const previousRecord = previousHeadline ? getMediaById(mediaDb, previousHeadline.mediaId) : null;
    const newRecord = getMediaById(mediaDb, mediaId);
    if (previousHeadline?.mediaId === mediaId && previousHeadline.caption) {
      invalidateArticleHtml(articleSlug);
      return { mediaId, isNew, width, height };
    }
    preserveCurrentImageSnapshot(articleSlug);
    if (article) {
      const cleaned = article.markdown.replace(/!\[[^\]]*\]\(media:[^)]+\)\n?/g, "").trimEnd();
      if (cleaned !== article.markdown) {
        const links = extractAllBodyLinks(db, cleaned, article.slug);
        saveArticle(
          db,
          {
            ...article,
            markdown: cleaned,
            html: renderMarkdown(cleaned),
            plain_text: markdownToPlainText(cleaned),
            generated_at: Date.now(),
          },
          links,
          [],
          { operation: "strip-inline-media" },
        );
        invalidateArticleHtml(articleSlug);
      }
    }

    upsertArticleHeadlineMedia(db, articleSlug, mediaId, "");
    recordImageSnapshot(articleSlug, operation, previousHeadline ? `Changed headline image from ${previousHeadline.mediaId} to ${mediaId}.` : `Attached headline image ${mediaId}.`);
    invalidateArticleHtml(articleSlug);

    // ── Hash-check: skip pipeline if same image is already captioned ──────────
    if (previousHeadline?.caption && previousRecord && newRecord && previousRecord.sha256 === newRecord.sha256) {
      updateArticleMediaCaption(db, articleSlug, 1, previousHeadline.caption, "generated", {
        updateArticleRevision: true,
      });
      logger.info("image.caption_skipped_same_hash", {
        slug: articleSlug,
        mediaId,
        sha256: newRecord.sha256,
      });
      return { mediaId, isNew, width, height };
    }

    // ── Fire caption + post-process pipeline ──────────────────────────────────
    trackGeneration(
      queueWorkflow(captionImageWorkflow, {
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
        origin: "image_caption_auto",
      })
        .then((result) => {
          if (result.status === "ok") {
            const currentHeadline = getArticleHeadlineMedia(db, articleSlug);
            if (currentHeadline?.mediaId !== mediaId) {
              logger.info("image.caption_stale_attachment", {
                slug: articleSlug,
                mediaId,
              });
              return;
            }
            invalidateArticleHtml(articleSlug);
            // Fire post-process so the infobox regenerates with the new image
            // context — but only when the article row actually exists. If the
            // image was attached while generation was still streaming, the
            // generation's own post-process pass will pick the image up.
            if (!getArticleByLookup(db, articleSlug)) {
              logger.info("image.post_process_deferred_no_article", {
                slug: articleSlug,
                mediaId,
              });
              return;
            }
            trackGeneration(
              queueWorkflow(postProcessWorkflow, {
                input: {
                  requestId: randomUUID(),
                  workflow: "article.post_process",
                  slug: articleSlug,
                  requestedTitle: getArticleByLookup(db, articleSlug)?.title ?? articleSlug,
                },
                deps: buildPipelineDeps(),
                recorder: getTraceRecorder(runtime.app.pipeline.trace),
                logger,
                origin: "post_process_auto",
                parentRunId: result.runId,
              })
                .then(() => {
                  logger.info("image.post_process_done", {
                    slug: articleSlug,
                    mediaId,
                  });
                })
                .catch(() => {}),
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

  async function generateAndAttachArticleImage(articleSlug: string, _replace = false, presetKey = "documentary_photo", aspectRatioKey = "landscape") {
    const generationConfig = runtime.app.images.generation;
    if (!generationConfig.enabled) {
      throw new Error("image generation is disabled");
    }
    const imagePreset = readArticleImagePromptSelection(presetKey);
    const aspectRatio = resolveArticleImageAspectRatio(generationConfig, aspectRatioKey);
    const article = getArticleByLookup(db, articleSlug);
    if (!article) {
      throw new Error("article not found");
    }
    const infobox = getArticleInfobox(db, article.slug);
    const sidebarContext = infobox ? [infobox.title, infobox.subtitle ?? "", ...infobox.groups.flatMap((group) => [group.label, ...group.rows.flatMap((row) => [row.label, row.value])])].filter(Boolean).join("\n").slice(0, 2000) : "";
    const articleBody = stripTopLevelSections(article.markdown, ["References", "See also"]);
    const imagePromptConfig =
      imagePreset.key === "documentary_photo"
        ? runtime.prompts
        : {
            ...runtime.prompts,
            prompts: {
              ...runtime.prompts.prompts,
              article_image: {
                system: imagePreset.system,
                user: imagePreset.user,
                model: imagePreset.model,
                thinking: imagePreset.thinking,
                json: imagePreset.json,
              },
            },
          };
    const rendered = buildPromptRegistry(imagePromptConfig).render("article_image", {
      requested_title: article.title,
      summary: article.summaryMarkdown || summaryMarkdownFromArticle(article.markdown),
      article_excerpt: articleBody.slice(0, 3500),
      sidebar_context: sidebarContext,
      related_context: formatImageRelatedContext(article.slug),
    });
    const generated = await generateArticleImage({
      prompt: [rendered.system.trim(), rendered.user.trim(), articleImageTextPolicy(imagePreset.allowText)].filter(Boolean).join("\n\n"),
      config: generationConfig,
      logger,
      size: aspectRatio.size,
    });
    const result = await ingestImageFromBuffer(generated.bytes, generated.mime, {
      mediaDb,
      config: runtime.app.images,
      logger,
      sourceLabel: `${generated.backend}:${generated.model}`,
    });
    updateMediaGenerationMetadata(
      mediaDb,
      result.mediaId,
      JSON.stringify({
        kind: "article-image",
        presetKey: imagePreset.key,
        presetLabel: imagePreset.label,
        aspectRatioKey: aspectRatio.key,
        aspectRatioLabel: aspectRatio.label,
        size: aspectRatio.size,
        backend: generated.backend,
        model: generated.model,
        revisedPrompt: generated.revisedPrompt,
        generatedAt: Date.now(),
      }),
    );
    const attached = attachAndCaption(article.slug, result.mediaId, result.isNew, result.width, result.height, "image-generate");
    const response = buildArticleResponseFor(article.slug);
    if (response) {
      notifySidecar(article.slug, { type: "article", article: response });
    }
    logger.info("article_image.attached", {
      slug: article.slug,
      mediaId: attached.mediaId,
      presetKey: imagePreset.key,
      aspectRatioKey: aspectRatio.key,
      size: aspectRatio.size,
      backend: generated.backend,
      model: generated.model,
    });
    return {
      ...attached,
      backend: generated.backend,
      model: generated.model,
      presetKey: imagePreset.key,
      aspectRatioKey: aspectRatio.key,
      revisedPrompt: generated.revisedPrompt,
    };
  }

  async function runArticleImageGenerationWorkflow(articleSlug: string, replace: boolean, presetKey: string, aspectRatioKey: string, requestedTitle: string, origin: string, parentRunId?: string) {
    const result = await queueWorkflow(articleImageGenerationWorkflow, {
      input: {
        requestId: randomUUID(),
        workflow: "article.image_generate",
        slug: articleSlug,
        requestedTitle,
        imageReplace: replace,
        imagePromptKey: presetKey,
        imageAspectRatioKey: aspectRatioKey,
      },
      deps: buildPipelineDeps(),
      recorder: getTraceRecorder(runtime.app.pipeline.trace),
      logger,
      origin,
      parentRunId,
    });
    if (result.status === "error") {
      throw result.error ?? new Error("article image generation failed");
    }
    const generated = result.state.imageGenerationResult;
    if (!generated) {
      throw new Error("article image generation produced no result");
    }
    return generated;
  }

  function formatImageRelatedContext(articleSlug: string): string {
    const backlinks = listBacklinks(db, articleSlug).existing.slice(0, 10);
    const outgoing = db
      .prepare(
        `SELECT l.target_slug AS slug,
                COALESCE(a.title, l.visible_label, l.target_slug) AS title,
                l.visible_label AS visibleLabel,
                l.hidden_hint AS hiddenHint,
                COALESCE(a.summary_markdown, '') AS summaryMarkdown
         FROM article_links l
         LEFT JOIN articles a ON a.slug = l.target_slug
         WHERE l.source_slug = ?
         ORDER BY l.created_at DESC, l.target_slug ASC
         LIMIT 12`,
      )
      .all(articleSlug) as unknown as Array<{
      slug: string;
      title: string;
      visibleLabel: string;
      hiddenHint: string;
      summaryMarkdown: string;
    }>;
    const lines: string[] = [];
    for (const row of outgoing) {
      lines.push([`Outgoing link: ${row.title} (${row.slug})`, row.visibleLabel ? `label: ${row.visibleLabel}` : "", row.hiddenHint ? `hint: ${row.hiddenHint}` : "", row.summaryMarkdown ? `summary: ${row.summaryMarkdown}` : ""].filter(Boolean).join(" | "));
    }
    for (const row of backlinks) {
      lines.push([`Backlink: ${row.title} (${row.slug})`, row.visibleLabel ? `label: ${row.visibleLabel}` : "", row.hiddenHint ? `hint: ${row.hiddenHint}` : "", row.summaryMarkdown ? `summary: ${row.summaryMarkdown}` : ""].filter(Boolean).join(" | "));
    }
    return lines.join("\n").slice(0, 5000);
  }

  app.post("/api/article/:slug/image", async (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
      url?: string;
      mediaId?: string;
    };

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
      result = await ingestImageFromUrl(url, {
        mediaDb,
        config: runtime.app.images,
        logger,
      });
    } catch (err: any) {
      return c.json({ error: err?.message || "Image ingestion failed" }, 400);
    }
    const attached = attachAndCaption(slug, result.mediaId, result.isNew, result.width, result.height, "image-attach");
    const response = buildArticleResponseFor(slug);
    if (!response) return c.json({ error: "article not found" }, 404);
    return c.json({ ...attached, article: response });
  });

  app.post("/api/article/:slug/image/generate", async (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    if (!runtime.app.images.generation.enabled) {
      return c.json({ error: "image generation is disabled" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      replace?: boolean;
      promptKey?: string;
      presetKey?: string;
      aspectRatioKey?: string;
    };
    let presetKey: string;
    let aspectRatioKey: string;
    try {
      presetKey = normalizeArticleImagePresetKey(typeof body.presetKey === "string" ? body.presetKey : body.promptKey);
      aspectRatioKey = normalizeArticleImageAspectRatioKey(body.aspectRatioKey);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    try {
      const article = getArticleByLookup(db, slug);
      const imagePromise = runArticleImageGenerationWorkflow(slug, body.replace === true, presetKey, aspectRatioKey, article?.title ?? slug, "http");
      const generated = await trackGeneration(imagePromise);
      const response = buildArticleResponseFor(slug);
      if (!response) return c.json({ error: "article not found" }, 404);
      return c.json({ ...generated, article: response });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /not found/i.test(message) ? 404 : /already has/i.test(message) ? 409 : 400;
      return c.json({ error: message }, status as 400 | 404 | 409);
    }
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
      return c.json(
        {
          error: "send multipart/form-data with an 'image' field, or raw bytes with an image/* content-type",
        },
        400,
      );
    }
    let result: Awaited<ReturnType<typeof ingestImageFromBuffer>>;
    try {
      result = await ingestImageFromBuffer(bytes, mime, {
        mediaDb,
        config: runtime.app.images,
        logger,
      });
    } catch (err: any) {
      return c.json({ error: err?.message || "Image processing failed" }, 400);
    }
    const attached = attachAndCaption(slug, result.mediaId, result.isNew, result.width, result.height, "image-upload");
    const response = buildArticleResponseFor(slug);
    if (!response) return c.json({ error: "article not found" }, 404);
    return c.json({ ...attached, article: response });
  });

  app.delete("/api/article/:slug/image", (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    preserveCurrentImageSnapshot(slug);
    const previousHeadline = getArticleHeadlineMedia(db, slug);
    removeArticleMedia(db, slug, 1);
    if (previousHeadline) {
      recordImageSnapshot(slug, "image-remove", `Removed headline image ${previousHeadline.mediaId}.`);
    }
    invalidateArticleHtml(slug);
    const response = buildArticleResponseFor(slug);
    if (!response) return c.json({ error: "article not found" }, 404);
    return c.json({ article: response });
  });

  app.patch("/api/article/:slug/image/caption", async (c) => {
    const slug = slugify(decodeURIComponent(c.req.param("slug")));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { caption?: string };
    const caption = typeof body.caption === "string" ? body.caption : null;
    if (caption === null) return c.json({ error: "caption required" }, 400);
    preserveCurrentImageSnapshot(slug);
    updateArticleMediaCaption(db, slug, 1, caption, "user-edit");
    const headlineMedia = getArticleHeadlineMedia(db, slug);
    if (headlineMedia) {
      recordImageSnapshot(slug, "image-caption-edit", `Changed headline image caption for ${headlineMedia.mediaId}.`);
    }
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
      const canonicalPath = `/wiki/${titleToWikiSegment(wikiSegmentToRequestedTitle(requestedSegment))}`;
      if (isSlugStyleWikiSegment(requestedSegment) && canonicalPath !== path) {
        logger.info("page.redirect", { slug: bareSlug, from: path });
        return c.redirect(canonicalPath, 302);
      }
    }
    if (bareSlug && !path.startsWith("/wiki/")) {
      logger.info("page.redirect", { slug: bareSlug, from: path });
      return c.redirect(`/wiki/${bareSlug}`, 302);
    }

    if (path === "/" || path === "/Random" || path === "/random" || path === "/search" || path === "/all-entries" || path === "/admin" || path === "/settings" || path === "/graph" || path === "/media" || path.startsWith("/media/") || routeSlug(path)) {
      try {
        return c.html(await readFile(resolve(distRoot, "index.html"), "utf8"));
      } catch {
        // dist not built yet (dev mode) — redirect to root so Vite serves the shell
        return c.redirect("/", 302);
      }
    }

    const filePath = resolve(distRoot, path.slice(1));
    const ext = extname(filePath);
    if (!ext) return c.notFound();

    try {
      const file = await readFile(filePath);
      return new Response(file, {
        headers: {
          "content-type": ext === ".js" ? "application/javascript; charset=utf-8" : ext === ".css" ? "text/css; charset=utf-8" : "application/octet-stream",
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

  // Final safety net: an uncaught handler exception would otherwise reach the
  // client as an opaque, unlogged 500. The request-logging middleware above
  // already records it; this just shapes a clean JSON response to match the
  // rest of the API instead of Hono's bare-text default.
  app.onError((error, c) => {
    logger.error("http.unhandled_error", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
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

const isEntrypoint = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isEntrypoint) {
  bootstrap().catch((error) => {
    createConsoleLogger().error("server.startup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
