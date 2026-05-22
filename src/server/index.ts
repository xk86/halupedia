// TODO: split api and shit out because jesus christ this file is way too long
// TODO: make sure that formatting text isn't being added into link replacement/strips.
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
import {
  deleteArticleBySlug,
  getAdminOverview,
  getArticleByLookup,
  getArticleByTitle,
  getArticleByEquivalentLookup,
  getArticleRevision,
  getCanonicalSlugForTarget,
  getHomepageCache,
  getRandomArticles,
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
  saveHomepageCache,
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
} from "./db";
import {
  findFuzzyTitleMatchesInEditText,
  findReferencedArticlesInEditText,
} from "./editReferences";
import { OpenAICompatClient, type LlmClient } from "./llm";
import { createConsoleLogger, type Logger } from "./logger";
import { formatIncomingHintsForPrompt } from "./linkHints";
import { MaintenanceScheduler } from "./maintenance";
import {
  articleSectionMarkdown,
  buildHaluLink,
  extractDisplayTitle,
  extractInternalLinks,
  extractTitle,
  firstParagraphMarkdownFromArticle,
  fixSlugVisibleText,
  LINK_RE,
  listArticleSections,
  markdownToPlainText,
  normalizeMarkdown,
  renderMarkdown,
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
  ReferenceList,
  ReferenceListEntry,
  SeeAlsoCandidate,
} from "./types";
import {
  buildReferenceList,
  convertExistingArticleLinksToRefs,
  extractRefLinksAsInternalLinks,
  findBodyReferencedArticles,
  findExistingArticleLinkReferences,
  formatReferencesForPrompt,
  formatReferencesForPromptJson,
  linkMentionedReferencesInBody,
  loadPriorReferenceList,
  resolveRefLinks,
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
import {
  ensureDykHasSourceLink,
  normalizeHomepageFact,
  generateDidYouKnowFact,
} from "./dyk";
export { ensureDykHasSourceLink } from "./dyk";

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
  distRoot?: string;
  skipLlmProbe?: boolean;
  skipHomepagePrepare?: boolean;
  logger?: Logger;
  llmClient?: LlmClient;
}

type FrameSection = "meta" | "body" | "usedRefs";

// Prefix: 1+ of dash, underscore, or equals  (model may emit ---, ===, ___, or mixes)
// Group 1 = keyword (dashes or underscores as separators), group 2 = inline content.
// halu- prefixed: any prefix length (1+)
// non-halu aliases: 3+ prefix chars to avoid false positives with bullet points
const HALU_MARKER_RE = /^[-_=]+(halu[-_]body|halu[-_]meta|halu[-_]used[-_]refs|halu[-_]used[-_]references)\s*(.*)?$/;
const ALIAS_MARKER_RE = /^[-_=]{3,}(body|used[-_]refs|used[-_]references|references[-_]used|meta)\s*(.*)?$/;

/** Normalise a marker keyword: underscores → dashes, lowercase. */
function normKeyword(s: string): string { return s.toLowerCase().replace(/_/g, "-"); }

function identifyFrameMarker(line: string): { section: FrameSection; inline: string } | null {
  const normalized = line.trim().toLowerCase();

  // halu- prefixed form: any prefix char count
  const hm = HALU_MARKER_RE.exec(normalized);
  if (hm) {
    const kw = normKeyword(hm[1]);
    const inline = hm[2]?.trim() ?? "";
    switch (kw) {
      case "halu-body": return { section: "body", inline };
      case "halu-meta": return { section: "meta", inline };
      case "halu-used-refs":
      case "halu-used-references": return { section: "usedRefs", inline };
    }
  }

  // Non-halu prefix form: require 3+ chars to avoid bullet-point false positives
  const am = ALIAS_MARKER_RE.exec(normalized);
  if (am) {
    const kw = normKeyword(am[1]);
    const inline = am[2]?.trim() ?? "";
    switch (kw) {
      case "body": return { section: "body", inline };
      case "meta": return { section: "meta", inline };
      case "used-refs":
      case "used-references":
      case "references-used": return { section: "usedRefs", inline };
    }
  }

  // ## Style aliases (exact match, case-insensitive)
  switch (normalized) {
    case "## meta": case "## metadata": return { section: "meta", inline: "" };
    case "## body": case "## article": case "## article body": return { section: "body", inline: "" };
    case "## used refs": case "## used references": case "## references used": return { section: "usedRefs", inline: "" };
  }

  return null;
}

function extractFrameSections(raw: string): {
  sections: Partial<Record<FrameSection, string>>;
  preBody: string;
} {
  const sectionLines: Partial<Record<FrameSection, string[]>> = {};
  const preSectionLines: string[] = [];
  let current: FrameSection | null = null;
  for (const line of raw.split("\n")) {
    const result = identifyFrameMarker(line);
    if (result !== null) {
      current = result.section;
      sectionLines[current] ??= [];
      // Preserve any content on the same line as the marker (e.g. inline JSON)
      if (result.inline) (sectionLines[current] ??= []).push(result.inline);
    } else if (current !== null) {
      (sectionLines[current] ??= []).push(line);
    } else {
      preSectionLines.push(line);
    }
  }
  const sections: Partial<Record<FrameSection, string>> = {};
  for (const [k, lines] of Object.entries(sectionLines) as [FrameSection, string[]][]) {
    sections[k] = lines.join("\n").trimEnd();
  }
  return { sections, preBody: preSectionLines.join("\n").trim() };
}

export function parseArticleFrameOutput(
  raw: string,
  providedSlugs: ReadonlySet<string>,
  pinnedSlugs: ReadonlySet<string>,
  logger?: Logger,
): { ok: true; body: string; refsUsed: string[] } | { ok: false; body: string; missingPinned: string[]; reason?: string } {
  const { sections, preBody } = extractFrameSections(raw);

  let body = sections.body ?? "";

  // Layer 1: no markers found at all → whole raw is body
  if (!body && !sections.meta && !sections.usedRefs && !preBody) {
    body = raw.trim();
  }

  // Layer 2: content appeared before the first section marker
  // (model output article text before any ---halu-* line)
  if (!body && preBody) {
    body = preBody;
  }

  // Layer 3: model emitted ---halu-meta but skipped ---halu-body, so the body
  // was absorbed into the meta section.  Extract everything from the first
  // markdown heading onward.
  if (!body && sections.meta) {
    const headingIdx = sections.meta.search(/^#+ /m);
    if (headingIdx >= 0) body = sections.meta.slice(headingIdx).trim();
  }

  if (!body) {
    return { ok: false, body: raw, missingPinned: [], reason: "missing-body" };
  }

  let declaredRefs: string[] = [];
  if (sections.usedRefs) {
    try {
      const parsed = JSON.parse(sections.usedRefs) as unknown;
      if (Array.isArray(parsed)) {
        declaredRefs = (parsed as unknown[])
          .filter((s): s is string => typeof s === "string")
          // Strip halu: or ref: prefix the model may emit (e.g. "halu:some-slug")
          .map((s) => s.replace(/^(?:halu|ref):/, ""))
          .filter((s) => providedSlugs.has(s));
      }
    } catch { /* derive from body links below */ }
  }

  const proseBody = stripTopLevelSections(body, ["References", "See also"]);
  const fromBody: string[] = [];
  for (const m of proseBody.matchAll(/\(ref:([\w-]+)\)/g)) {
    if (providedSlugs.has(m[1]) && !declaredRefs.includes(m[1])) fromBody.push(m[1]);
  }

  const refsUsed = [...new Set([...declaredRefs, ...fromBody])];
  const unused = [...providedSlugs].filter((s) => !refsUsed.includes(s));
  logger?.info("article.refs_resolved", {
    json_declared: declaredRefs.join(", ") || "(none)",
    body_found: fromBody.join(", ") || "(none)",
    merged: refsUsed.join(", ") || "(none)",
    unused: unused.join(", ") || "(none)",
  });

  const missingPinned = [...pinnedSlugs].filter((s) => !refsUsed.includes(s));
  if (missingPinned.length > 0) return { ok: false, body, missingPinned };

  return { ok: true, body, refsUsed };
}

export function parsePartialArticleFrame(accumulated: string): string | null {
  const { sections, preBody } = extractFrameSections(accumulated);

  // Primary: explicit body section with content
  if (sections.body) return sections.body;

  // Fallback: article body arrived before any section marker (model skipped framing).
  // Require a markdown heading so we don't show stray JSON or marker lines.
  if (preBody && /^#+ /m.test(preBody)) return preBody;

  // Fallback: body was absorbed into the meta section because the model emitted
  // ---halu-meta but skipped ---halu-body.  Stream from the first heading onward.
  if (sections.meta) {
    const headingIdx = sections.meta.search(/^#+ /m);
    if (headingIdx >= 0) return sections.meta.slice(headingIdx);
  }

  return null;
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

async function generateSeeAlsoCandidates(
  llm: LlmClient,
  lightLlm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  requestedTitle: string,
  bodyMarkdown: string,
  referenceSlugs: string[],
  forbiddenSlugs: string[] = [],
): Promise<InternalArticleCandidate[]> {
  const prompt = getPrompt(promptConfig, "see_also");
  const selectedLlm = prompt.model === "light" ? lightLlm : llm;
  const referenceSlugsList = referenceSlugs.length
    ? referenceSlugs.map((s) => `- ${s}`).join("\n")
    : "(none)";
  const alreadyUsedSection = forbiddenSlugs.length
    ? `Already used or rejected (do not re-suggest):\n${forbiddenSlugs.map((s) => `- ${s}`).join("\n")}\n\n`
    : "";
  const raw = await selectedLlm.chat(
    prompt.system,
    renderTemplate(prompt.user, {
      requested_title: requestedTitle,
      article_excerpt: bodyMarkdown.slice(0, 6000),
      reference_slugs: referenceSlugsList,
      already_used_section: alreadyUsedSection,
    }),
    { thinking: prompt.thinking, jsonMode: prompt.json },
  );
  // Accept either a bare JSON array or an object wrapping it in an `items` key.
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  let items: SeeAlsoCandidate[] = [];
  if (arrayMatch) {
    try { items = JSON.parse(arrayMatch[0]) as SeeAlsoCandidate[]; } catch { /* fall through */ }
  }
  if (items.length === 0 && objectMatch) {
    try {
      const obj = JSON.parse(objectMatch[0]) as { items?: SeeAlsoCandidate[] };
      items = obj.items ?? [];
    } catch { /* fall through */ }
  }
  return dedupeArticleCandidates(
    items
      .filter((item) => item.slug)
      .map((item) => ({
        slug: slugify(item.slug ?? ""),
        title: slugToTitle(slugify(item.slug ?? "")),
        hiddenHint: (item.hint ?? "").replace(/\s+/g, " ").trim(),
      })),
  );
}

async function recheckArticleLinks(
  llm: LlmClient,
  lightLlm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  requestedTitle: string,
  bodyMarkdown: string,
  references: ReferenceList = [],
): Promise<string> {
  const links = extractInternalLinks(bodyMarkdown);
  if (links.length === 0 && !bodyMarkdown.includes("ref:")) return bodyMarkdown;

  const prompt = getPrompt(promptConfig, "link_recheck");
  const selectedLlm = prompt.model === "light" ? lightLlm : llm;
  const raw = await selectedLlm.chat(
    prompt.system,
    renderTemplate(prompt.user, {
      requested_title: requestedTitle,
      article_body: bodyMarkdown.slice(0, 12000),
      references_list: formatReferencesForPrompt(references),
      slug: slugify(requestedTitle),
      article_excerpt: "",
      rag_context: "",
      link_hints: "",
      link_list: "",
      related_titles: "",
      parent_comment: "",
      selected_text: "",
      edit_instructions: "",
    }),
    { thinking: prompt.thinking, jsonMode: prompt.json },
  );

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return bodyMarkdown;

  let parsed: {
    links?: Array<{ original: string; action: string; fixed?: string }>;
  };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return bodyMarkdown;
  }
  if (!parsed.links || parsed.links.length === 0) return bodyMarkdown;

  let result = bodyMarkdown;
  for (const entry of parsed.links) {
    if (!entry.original) continue;
    if (entry.action === "remove") {
      const visibleMatch = entry.original.match(/^\[([^\]]+)\]/);
      const plainText = visibleMatch ? visibleMatch[1] : "";
      result = result.replace(entry.original, plainText);
    } else if (entry.action === "fix" && entry.fixed) {
      result = result.replace(entry.original, entry.fixed);
    }
  }

  return result;
}

/**
 * After the primary halu-link normalizer runs, scan for any `halu:` occurrences
 * that are NOT inside a properly matched LINK_RE range. If found, send the
 * surrounding context to a light LLM with the link_repair prompt so truly
 * malformed links get a second chance at being fixed.
 *
 * This is deliberately lightweight: called only when malformed links remain.
 */
/**
 * Repair malformed `halu:` link occurrences in article BODY markdown.
 *
 * **Contract**: the caller MUST pass body-only markdown — i.e. a string that
 * does NOT contain the algorithmically-rendered "References" or "See also"
 * sections. References and see-also live only in sidecar metadata.
 *
 * If a References or See also heading is detected anywhere in the input,
 * this function logs an error and returns the input unchanged rather than
 * risk corrupting metadata.
 */
async function repairMalformedHaluLinks(
  markdown: string,
  lightLlm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  logger: Logger,
  contextSlug?: string,
): Promise<string> {
  if (!markdown.includes("halu:")) return markdown;

  // Hard guard: this function is body-only. Refuse to operate on input that
  // still contains metadata sections — they are algorithmically generated
  // from validated slugs and must never be rewritten by the LLM.
  if (/^#{2,6}\s+(references|see also):?\s*#*\s*$/im.test(markdown)) {
    logger.error("link_repair.refused_metadata_in_input", {
      slug: contextSlug ?? "(unknown)",
      reason:
        "Input contained References/See-also section; caller must strip metadata first.",
    });
    return markdown;
  }

  // Collect ranges of already-valid halu links so we can skip them
  const validRanges: Array<{ start: number; end: number }> = [];
  const linkPattern = new RegExp(LINK_RE.source, LINK_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = linkPattern.exec(markdown)) !== null) {
    validRanges.push({ start: m.index, end: m.index + m[0].length });
  }

  // Identify positions of `halu:` that fall outside all valid ranges
  const malformed: number[] = [];
  let searchPos = 0;
  while (true) {
    const idx = markdown.indexOf("halu:", searchPos);
    if (idx < 0) break;
    if (!validRanges.some((r) => idx >= r.start && idx < r.end)) {
      malformed.push(idx);
    }
    searchPos = idx + 1;
  }

  if (malformed.length === 0) return markdown;
  logger.warn("link_repair.malformed_detected", {
    slug: contextSlug ?? "(unknown)",
    count: malformed.length,
  });

  let prompt: ReturnType<typeof getPrompt>;
  try {
    prompt = getPrompt(promptConfig, "link_repair");
  } catch {
    // Prompt not configured — skip repair
    return markdown;
  }

  // Repair each malformed occurrence: send surrounding context to LLM
  let result = markdown;
  let offset = 0; // tracks position shift from prior replacements
  for (const rawPos of malformed) {
    const pos = rawPos + offset;
    const contextStart = Math.max(0, pos - 120);
    const contextEnd = Math.min(result.length, pos + 300);
    const context = result.slice(contextStart, contextEnd);

    try {
      const repaired = await lightLlm.chat(
        prompt.system,
        renderTemplate(prompt.user, { context }),
        { thinking: false },
      );
      if (repaired && repaired.trim() !== context.trim()) {
        result =
          result.slice(0, contextStart) +
          repaired.trim() +
          result.slice(contextEnd);
        offset += repaired.trim().length - (contextEnd - contextStart);
      }
    } catch (err) {
      logger.warn("link_repair.repair_failed", {
        slug: contextSlug ?? "(unknown)",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

async function generateArticleSummary(
  llm: LlmClient,
  lightLlm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  requestedTitle: string,
  articleMarkdown: string,
): Promise<string> {
  const prompt = getPrompt(promptConfig, "article_summary");
  const selectedLlm = prompt.model === "light" ? lightLlm : llm;
  const currentArticle = stripTopLevelSections(articleMarkdown, [
    "References",
    "See also",
  ]).slice(0, 12000);
  let previousSummary = "(none)";
  let summaryFeedback = "(none)";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await selectedLlm.chat(
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
  llm: LlmClient,
  lightLlm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  inspiration: Array<{ title: string; slug: string }> = [],
): Promise<{ title: string; slug: string }> {
  const prompt = getPrompt(promptConfig, "random_page");
  const selectedLlm = prompt.model === "light" ? lightLlm : llm;
  const raw = await selectedLlm.chat(
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
  db: ReturnType<typeof openDatabase>,
  llm: LlmClient,
  lightLlm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  ttlMs: number,
  logger: Logger,
): Promise<HomepagePayload> {
  const now = Date.now();
  const cached = getHomepageCache(db);
  if (cached && cached.generatedAt + ttlMs > now) {
    return {
      ...cached,
      expiresAt: cached.generatedAt + ttlMs,
    };
  }

  const sources = getRandomArticles(db, 5);
  const generatedAt = Date.now();
  if (sources.length === 0) {
    const empty = {
      featured: null,
      didYouKnow: [],
      generatedAt,
      expiresAt: generatedAt + ttlMs,
    };
    saveHomepageCache(db, empty);
    return empty;
  }

  const didYouKnow = [];
  for (const article of sources) {
    try {
      const fact = await generateDidYouKnowFact(
        llm,
        lightLlm,
        promptConfig,
        article,
      );
      if (fact) {
        // Guarantee every DYK fact links back to the source article.
        // The LLM may or may not include a link natively; this is the fallback.
        const linkedFact = ensureDykHasSourceLink(fact, article.slug, article.title);
        didYouKnow.push({ slug: article.slug, title: article.title, fact: linkedFact });
      }
    } catch (error) {
      logger.warn("homepage.dyk_generation_failed", {
        slug: article.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const featured = sources[0]
    ? {
        slug: sources[0].slug,
        title: sources[0].title,
        summaryMarkdown: firstParagraphMarkdownFromArticle(sources[0].markdown),
      }
    : null;
  const payload = {
    featured,
    didYouKnow,
    generatedAt,
    expiresAt: generatedAt + ttlMs,
  };
  saveHomepageCache(db, payload);
  logger.info("homepage.cache_prepared", {
    facts: didYouKnow.length,
    featured: featured?.slug ?? "",
  });
  return payload;
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
  llm: LlmClient,
  lightLlm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  requestedTitle: string,
  selectedText: string,
  articleExcerpt: string,
  ragContext: string,
  relatedTitles: string[],
): Promise<LinkSuggestion> {
  const prompt = getPrompt(promptConfig, "link_suggestion");
  const selectedLlm = prompt.model === "light" ? lightLlm : llm;
  const raw = await selectedLlm.chat(
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
    throw new Error(`link suggestion returned invalid JSON. Raw response: "${raw.slice(0, 500)}"`);
  }
  let parsed: Partial<LinkSuggestion>;
  try {
    parsed = JSON.parse(match[0]);
  } catch (jsonErr) {
    throw new Error(`link suggestion JSON parsing failed: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}. JSON: "${match[0]}"`);
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
  let llm: LlmClient =
    options.llmClient ??
    new OpenAICompatClient(
      runtime.llm.chat,
      runtime.llm.embeddings,
      logger,
      "heavy",
    );
  let lightLlm: LlmClient =
    options.llmClient ??
    new OpenAICompatClient(
      runtime.llm.light,
      runtime.llm.embeddings,
      logger,
      "light",
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
        await indexArticleChunks(
          db,
          llm,
          slug,
          markdown,
          runtime.app.rag.enabled && runtime.llm.embeddings.enabled,
          runtime.app.rag.chunk_size,
          logger,
        );
        const summaryMarkdown = await generateArticleSummary(
          llm,
          lightLlm,
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
      llm = new OpenAICompatClient(
        runtime.llm.chat,
        runtime.llm.embeddings,
        logger,
        "heavy",
      );
      lightLlm = new OpenAICompatClient(
        runtime.llm.light,
        runtime.llm.embeddings,
        logger,
        "light",
      );
    }
    logger.info("startup", {
      server: `http://${runtime.app.server.host}:${runtime.app.server.port}`,
      database: runtime.app.storage.database_path,
      heavy_base_url: runtime.llm.chat.base_url,
      heavy_model: runtime.llm.chat.model,
      light_base_url: runtime.llm.light.base_url,
      light_model: runtime.llm.light.model,
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

  // Resolve a list of slugs to ReferenceListEntry objects for userAdditions.
  function slugsToUserAdditions(slugs: string[], pinnedSet: ReadonlySet<string> = new Set()): ReferenceList {
    const result: ReferenceList = [];
    for (const s of slugs) {
      const a = getArticleByLookup(db, s);
      if (!a) continue;
      result.push({
        slug: a.slug,
        title: a.title,
        content: a.summaryMarkdown ?? "",
        kind: "summary",
        pinned: pinnedSet.has(a.slug),
        revisionId: "current",
        source: "user",
      });
    }
    return result;
  }

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

  /**
   * Build the `related_titles` block shown to the LLM in article-body prompts.
   *
   * Two distinct RAG signals are merged here, each clearly labeled so the model
   * (and anyone reading prompt logs) can tell them apart:
   *
   *   1. RAG-retrieved chunks — from article_chunks via retrieveContext.
   *      Titles of articles whose chunks scored above the relevancy threshold.
   *   2. Backlinks — from article_links via listBacklinks. Titles of articles
   *      that link TO the slug being generated. These are not topic-matched
   *      by RAG but are graph-adjacent (someone already considered them related).
   *
   * Returns "(none)" when both sources are empty. Dedupes by title.
   */
  function formatRelatedTitlesForPrompt(
    slug: string,
    ragTitles: string[],
  ): { rendered: string; ragCount: number; backlinkCount: number; uniqueTotal: number } {
    const backlinks = listBacklinks(db, slug);
    const backlinkTitles = backlinks.existing.map((b) => b.title);
    const seen = new Set<string>();
    const ragUnique = ragTitles.filter((t) => {
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
    const backlinkUnique = backlinkTitles.filter((t) => {
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
    const ragSection = ragUnique.length
      ? `From RAG-retrieved chunks:\n${ragUnique.map((t) => `- ${t}`).join("\n")}`
      : "";
    const backlinkSection = backlinkUnique.length
      ? `From articles linking here (backlinks):\n${backlinkUnique.map((t) => `- ${t}`).join("\n")}`
      : "";
    const rendered =
      [ragSection, backlinkSection].filter(Boolean).join("\n\n") || "(none)";
    return {
      rendered,
      ragCount: ragUnique.length,
      backlinkCount: backlinkUnique.length,
      uniqueTotal: ragUnique.length + backlinkUnique.length,
    };
  }

  /**
   * Save an article + its reference list immediately, without LLM calls.
   *
   * The reference list is constructed via `buildReferenceList` from validated
   * slugs only — never produced or modified by an LLM. References are stored
   * as sidecar metadata and rendered only for display.
   *
   * Any References/See-also sections present in the LLM body are stripped
   * defensively, because metadata is owned by sidecar tables, not the body.
   */
  // userAdditions: slugs that survive pruning for this save (user-selected).
  // blacklistSlugs: slugs explicitly removed by the user; never included.
  async function saveArticleImmediately(
    slug: string,
    requestedTitle: string,
    bodyMarkdown: string,
    retrieved: Awaited<ReturnType<typeof retrieveContext>>,
    revision: {
      operation?: string;
      instructions?: string;
      revertedFromRevisionId?: number | null;
      skipRevision?: boolean;
    } = {},
    { userAdditionSlugs = [], pinnedSlugsSet = new Set<string>(), blacklistSlugs = [], scrapeExistingBodyLinks = true, selectedReferenceSlugs = null }: {
      userAdditionSlugs?: string[];
      pinnedSlugsSet?: ReadonlySet<string>;
      blacklistSlugs?: string[];
      scrapeExistingBodyLinks?: boolean;
      selectedReferenceSlugs?: string[] | null;
    } = {},
  ) {
    const selectedReferenceSet = selectedReferenceSlugs
      ? new Set(selectedReferenceSlugs.map((s) => slugify(s)).filter(Boolean))
      : null;
    const parsedInput = normalizeMarkdownLinks(bodyMarkdown, "article");
    logger.info("text.pipeline.start", {
      slug,
      source: revision.operation ?? "save",
      chars: bodyMarkdown.length,
      links: parsedInput.stats.total,
      halu: parsedInput.stats.halu,
      ref: parsedInput.stats.ref,
      bare_ref: parsedInput.stats.bareRef,
      bare_halu: parsedInput.stats.bareHalu,
      loose_ref: parsedInput.stats.looseRef,
      loose_halu: parsedInput.stats.looseHalu,
      wiki: parsedInput.stats.wiki,
      plain_slug: parsedInput.stats.plainSlug,
      external: parsedInput.stats.external,
      diagnostics: parsedInput.stats.diagnostics,
      changed: parsedInput.changed,
    });
    bodyMarkdown = parsedInput.markdown;

    const { canonicalTitle, canonicalSlug, displayTitle } =
      deriveArticleIdentity(bodyMarkdown, requestedTitle, slug);

    // (a) Strip any References/See-also the LLM produced; those are metadata,
    //     not body, and are owned by sidecar tables.
    const sanitizedBody = stripTopLevelSections(bodyMarkdown, [
      "References",
      "See also",
    ]);
    let normalizedBodyMarkdown = rewriteArticleTitleHeading(
      sanitizedBody,
      canonicalTitle,
    );

    // (b) Build the canonical reference list from validated sources.
    // Use findBodyReferencedArticles (not findExistingArticleLinkReferences) so
    // that ref:slug links already resolved from a preliminary ref list are
    // included as user additions. Without this, body arrives with ref:slug from
    // resolveRefLinks but those slugs never enter buildReferenceList and the
    // sidecar ends up missing them, triggering the stale-refs notice.
    const existingBodyReferences = scrapeExistingBodyLinks
      ? findBodyReferencedArticles(
          db,
          normalizedBodyMarkdown,
          canonicalSlug,
        )
      : [];
    const explicitUserAdditions = slugsToUserAdditions(
      userAdditionSlugs.map((s) => slugify(s)).filter(Boolean),
      pinnedSlugsSet,
    );
    const userAdditionsBySlug = new Map<string, ReferenceListEntry>();
    for (const ref of [...explicitUserAdditions, ...existingBodyReferences]) {
      userAdditionsBySlug.set(ref.slug, ref);
    }
    const userAdditions = Array.from(userAdditionsBySlug.values());

    const referenceList = buildReferenceList(
      db,
      {
        articleSlug: canonicalSlug,
        ragSources: selectedReferenceSet
          ? retrieved.sourceArticles.filter((source) => selectedReferenceSet.has(source.slug))
          : retrieved.sourceArticles,
        priorReferences: selectedReferenceSet
          ? (loadPriorReferenceList(db, canonicalSlug) ?? []).filter((ref) => selectedReferenceSet.has(ref.slug) || ref.pinned)
          : loadPriorReferenceList(db, canonicalSlug),
        userAdditions,
        blacklistSlugs,
        revisionId: "current",
        config: runtime.app.rag,
      },
      logger,
    );

    normalizedBodyMarkdown = resolveRefLinks(
      normalizedBodyMarkdown,
      referenceList,
    );
    const linkedBodyMarkdown = linkMentionedReferencesInBody(
      normalizedBodyMarkdown,
      referenceList,
    );
    if (linkedBodyMarkdown !== normalizedBodyMarkdown) {
      logger.debug("save.article_immediate.linked_reference_mentions", {
        slug: canonicalSlug,
      });
      normalizedBodyMarkdown = linkedBodyMarkdown;
    }
    if (scrapeExistingBodyLinks) {
      normalizedBodyMarkdown = convertExistingArticleLinksToRefs(
        db,
        normalizedBodyMarkdown,
        canonicalSlug,
      );
    }
    const finalParsed = normalizeMarkdownLinks(normalizedBodyMarkdown, "article");
    if (finalParsed.changed) {
      logger.info("text.pipeline.final_cleanup", {
        slug: canonicalSlug,
        links: finalParsed.stats.total,
        halu: finalParsed.stats.halu,
        ref: finalParsed.stats.ref,
        bare_ref: finalParsed.stats.bareRef,
        bare_halu: finalParsed.stats.bareHalu,
        loose_ref: finalParsed.stats.looseRef,
        loose_halu: finalParsed.stats.looseHalu,
        rewritten: finalParsed.stats.rewritten,
        stripped: finalParsed.stats.stripped,
        diagnostics: finalParsed.stats.diagnostics,
      });
      normalizedBodyMarkdown = finalParsed.markdown;
    }

    const markdown = stripSelfLinks(normalizedBodyMarkdown.trim(), canonicalSlug);

    const article = {
      slug: canonicalSlug,
      canonicalSlug,
      title: canonicalTitle,
      displayTitle,
      markdown,
      html: "",
      summaryMarkdown: summaryMarkdownFromArticle(markdown),
      plain_text: markdownToPlainText(markdown),
      generated_at: Date.now(),
    };
    const links = extractAllBodyLinks(markdown, canonicalSlug);
    article.html = rewriteArticleHtml(renderMarkdown(markdown), links);

    logger.debug("save.article_immediate.starting", { slug: canonicalSlug });
    saveArticle(
      db,
      article,
      links,
      Array.from(new Set([slug, canonicalSlug, article.canonicalSlug])),
      revision,
    );
    if (!revision.skipRevision) {
      logger.info("revision.saved", {
        slug: canonicalSlug,
        operation: revision.operation ?? "update",
        ...(revision.instructions ? { instructions: revision.instructions } : {}),
      });
    }
    logger.debug("save.article_immediate.saved_article", { slug: canonicalSlug });

    // (d) Persist the reference list using the canonical ReferenceList shape.
    saveArticleReferences(db, canonicalSlug, article.generated_at, referenceList);
    logger.info("text.pipeline.done", {
      slug: canonicalSlug,
      clean_chars: markdown.length,
      links: links.length,
      references: referenceList.length,
      changed: parsedInput.changed || markdown !== bodyMarkdown,
    });
    logger.debug("save.article_immediate.saved_references", {
      slug: canonicalSlug,
      reference_count: referenceList.length,
      references: JSON.stringify(
        referenceList.map((r) => ({
          slug: r.slug,
          title: r.title,
          kind: r.kind,
          source: r.source,
          pinned: r.pinned,
          revision: r.revisionId,
        })),
      ),
    });

    return {
      article,
      links,
      normalizedTitle: canonicalTitle,
      normalizedBodyMarkdown,
    };
  }

  async function postProcessArticle(
    slug: string,
    normalizedTitle: string,
    normalizedBodyMarkdown: string,
    retrieved: Awaited<ReturnType<typeof retrieveContext>>,
    hints: IncomingHint[],
    expectedGeneratedAt?: number,
    { blacklistSlugs = [], userAdditionSlugs = [], selectedReferenceSlugs = null }: {
      blacklistSlugs?: string[];
      userAdditionSlugs?: string[];
      selectedReferenceSlugs?: string[] | null;
    } = {},
  ) {
    const normalizedSlug = slugify(slug);
    const selectedReferenceSet = selectedReferenceSlugs
      ? new Set(selectedReferenceSlugs.map((s) => slugify(s)).filter(Boolean))
      : null;
    logger.debug("post_process.start", { slug: normalizedSlug });
    try {
      // Repair malformed halu links in the BODY only. References/See-also are
      // built algorithmically from validated slugs (referenceList.ts) and must
      // never be sent through the LLM — strip them defensively even though
      // postProcessArticle receives body markdown.
      logger.debug("post_process.repairing_links", { slug: normalizedSlug });
      const bodyOnly = stripTopLevelSections(normalizedBodyMarkdown, [
        "References",
        "See also",
      ]);
      const repairedBodyMarkdown = await repairMalformedHaluLinks(
        bodyOnly,
        lightLlm,
        runtime.prompts,
        logger,
        normalizedSlug,
      );
      logger.debug("post_process.links_repaired", { slug: normalizedSlug });

      const bodyLinkSlugs = new Set(
        extractInternalLinks(repairedBodyMarkdown).map(
          (link) => link.targetSlug,
        ),
      );

      const existing = getArticleByLookup(db, normalizedSlug);
      if (!existing) return;

      if (
        expectedGeneratedAt &&
        existing.generated_at !== expectedGeneratedAt
      ) {
        logger.info("page.post_process_skipped", { slug: normalizedSlug, reason: "stale" });
        return;
      }

      // Re-resolve the reference list from the now-persisted state so the
      // post-processed body uses the same list (and any user pins) as the
      // initial save. References are algorithmically rendered — no LLM.
      const existingBodyReferences = findBodyReferencedArticles(
        db,
        repairedBodyMarkdown,
        normalizedSlug,
      );
      // Explicit user additions (from the edit that triggered post-processing) come
      // first so they survive the carried-entry cap even when there are many body refs.
      // Backlink source articles are also always included as user additions so they
      // appear as references even when RAG scores are zero.
      const postProcessHints = listIncomingHints(db, normalizedSlug);
      const postProcessBacklinkSlugs = [...new Set(postProcessHints.map((h) => h.sourceSlug).filter(Boolean))];
      const explicitPostProcessAdditions = slugsToUserAdditions([
        ...(selectedReferenceSet ? [] : postProcessBacklinkSlugs),
        ...userAdditionSlugs,
      ]);
      const postProcessAdditionsBySlug = new Map<string, ReferenceListEntry>();
      for (const ref of [...explicitPostProcessAdditions, ...existingBodyReferences]) {
        postProcessAdditionsBySlug.set(ref.slug, ref);
      }
      const postProcessUserAdditions = Array.from(postProcessAdditionsBySlug.values());
      // Merge backlink article context into retrieved sources so the reference list
      // builder has their content even if the original RAG retrieval scored zero.
      const postProcessBacklinkContext = postProcessBacklinkSlugs.length > 0
        ? retrieveDirectArticleContext(db, normalizedSlug, postProcessBacklinkSlugs, runtime.app.rag.mode, runtime.app.rag.max_results, logger)
        : { context: "", relatedTitles: [], sourceArticles: [] };
      const postProcessRetrieved = mergeRetrievedContextPackets(retrieved, postProcessBacklinkContext);
      const referenceList = buildReferenceList(
        db,
        {
          articleSlug: normalizedSlug,
          ragSources: selectedReferenceSet
            ? postProcessRetrieved.sourceArticles.filter((source) => selectedReferenceSet.has(source.slug))
            : postProcessRetrieved.sourceArticles,
          priorReferences: selectedReferenceSet
            ? (loadPriorReferenceList(db, normalizedSlug) ?? []).filter((ref) => selectedReferenceSet.has(ref.slug) || ref.pinned)
            : loadPriorReferenceList(db, normalizedSlug),
          userAdditions: postProcessUserAdditions,
          blacklistSlugs,
          revisionId: "current",
          config: runtime.app.rag,
        },
        logger,
      );
      logger.debug("post_process.assembling_markdown", {
        slug: normalizedSlug,
        source_articles_count: retrieved.sourceArticles.length,
        reference_count: referenceList.length,
        references: JSON.stringify(
          referenceList.map((r) => ({
            slug: r.slug,
            kind: r.kind,
            pinned: r.pinned,
          })),
        ),
      });

      // Assemble body only. References and see-also stay sidecar-only metadata
      // and are rendered from their sidecar tables, never baked into article
      // markdown.
      const bodyWithReferenceLinks = convertExistingArticleLinksToRefs(
        db,
        resolveRefLinks(repairedBodyMarkdown, referenceList),
        normalizedSlug,
      );
      const markdown = stripSelfLinks(bodyWithReferenceLinks.trim(), slug);
      logger.debug("post_process.markdown_assembled", {
        slug: normalizedSlug,
        markdown_length: markdown.length,
      });

      // Start SA and summary in parallel — both are LLM calls with no dependency on each other.
      logger.debug("post_process.generating_see_also_and_summary", { slug: normalizedSlug });

      /** A candidate is valid for See Also only if the article does not already exist. */
      const isHaluOnly = (slug: string) =>
        slug !== normalizedSlug &&
        !bodyLinkSlugs.has(slug) &&
        !getArticleByLookup(db, slug);

      // Run summary in parallel with the first see-also attempt.
      const referenceSlugsForSeeAlso = referenceList.map((r) => r.slug);
      const [seeAlsoRaw, summaryMarkdown] = await Promise.all([
        generateSeeAlsoCandidates(
          llm,
          lightLlm,
          runtime.prompts,
          normalizedTitle,
          repairedBodyMarkdown,
          referenceSlugsForSeeAlso,
        ).catch(() => []),
        generateArticleSummary(
          llm,
          lightLlm,
          runtime.prompts,
          normalizedTitle,
          markdown,
        ).catch(() => summaryMarkdownFromArticle(markdown)),
      ]);

      let seeAlso = seeAlsoRaw.filter((c) => isHaluOnly(c.slug)).slice(0, 7);

      // Retry if the model returned too many existing-article slugs.
      if (seeAlso.length < 3) {
        const rejected = seeAlsoRaw.map((c) => c.slug).filter((s) => !isHaluOnly(s));
        logger.debug("post_process.see_also_retry", {
          slug: normalizedSlug,
          valid: seeAlso.length,
          rejected: rejected.length,
        });
        const retryRaw = await generateSeeAlsoCandidates(
          llm,
          lightLlm,
          runtime.prompts,
          normalizedTitle,
          repairedBodyMarkdown,
          referenceSlugsForSeeAlso,
          [...referenceSlugsForSeeAlso, ...rejected],
        ).catch(() => []);
        const retryCandidates = retryRaw.filter((c) => isHaluOnly(c.slug)).slice(0, 7);
        if (retryCandidates.length > seeAlso.length) seeAlso = retryCandidates;
      }

      logger.debug("post_process.see_also_generated", { slug: normalizedSlug, count: seeAlso.length });
      logger.debug("post_process.summary_generated", { slug: normalizedSlug });

      const freshCheck = getArticleByLookup(db, normalizedSlug);
      if (
        expectedGeneratedAt &&
        freshCheck &&
        freshCheck.generated_at !== expectedGeneratedAt
      ) {
        logger.info("page.post_process_skipped", { slug: normalizedSlug, reason: "concurrent_edit" });
        return;
      }

      const links = extractAllBodyLinks(markdown, normalizedSlug);
      const updated = {
        ...existing,
        markdown,
        html: rewriteArticleHtml(renderMarkdown(markdown), links),
        summaryMarkdown,
        plain_text: markdownToPlainText(markdown),
        generated_at: Date.now(),
      };
      updateArticleInPlace(
        db,
        normalizedSlug,
        {
          markdown: updated.markdown,
          html: updated.html,
          summaryMarkdown: updated.summaryMarkdown,
          plain_text: updated.plain_text,
        },
        links,
        expectedGeneratedAt ? { updateRevisionGeneratedAt: expectedGeneratedAt } : {},
      );

      // Persist see-also to its dedicated sidecar table. This makes see-also
      // accessible as structured metadata (Article.metadata.seeAlso) without
      // needing to re-parse or mutate body markdown.
      saveArticleSeeAlso(
        db,
        normalizedSlug,
        updated.generated_at,
        seeAlso.map((entry) => ({
          slug: entry.slug,
          title: entry.title,
          hint: entry.hiddenHint ?? "",
        })),
      );
      saveArticleReferences(db, normalizedSlug, updated.generated_at, referenceList);
      logger.info("page.post_process_done", {
        slug: normalizedSlug,
        see_also_count: seeAlso.length,
        reference_count: referenceList.length,
      });
    } catch (error) {
      logger.warn("page.post_process_failed", {
        slug: normalizedSlug,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.debug("post_process.indexing_chunks", { slug: normalizedSlug, rag_enabled: runtime.app.rag.enabled, embeddings_enabled: runtime.llm.embeddings.enabled });
    await indexArticleChunks(
      db,
      llm,
      normalizedSlug,
      getArticleByLookup(db, normalizedSlug)?.markdown ??
        normalizedBodyMarkdown,
      runtime.app.rag.enabled && runtime.llm.embeddings.enabled,
      runtime.app.rag.chunk_size,
      logger,
    ).catch((error) => {
      logger.warn("page.index_failed", {
        slug: normalizedSlug,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    logger.debug("post_process.complete", { slug: normalizedSlug });
  }

  async function buildArticle(
    slug: string,
    requestedTitle: string,
    onProgress?: (html: string, markdown: string) => void,
    onStatus?: (message: string) => void,
  ) {
    logger.debug("build.article_start", { slug });
    onStatus?.("Gathering references...");
    const hints = listIncomingHints(db, slug);
    logger.debug("build.article_rag_retrieving", { slug, incoming_hints: hints.length });
    const ragRetrieved = await retrieveContext(
      db,
      llm,
      slug,
      hintsToSearchStrings(hints),
      runtime.app.rag.enabled,
      runtime.app.rag.mode,
      runtime.app.rag.max_results,
      runtime.app.rag.min_score,
      runtime.llm.embeddings.enabled,
      logger,
      [requestedTitle, slug].filter(Boolean).join("\n"),
    );
    // Always pull in the full text of articles that link HERE so the generator
    // has concrete context even when RAG embeddings score zero.
    const backlinkSlugs = [...new Set(hints.map((h) => h.sourceSlug).filter(Boolean))];
    const backlinkRetrieved = backlinkSlugs.length > 0
      ? retrieveDirectArticleContext(db, slug, backlinkSlugs, runtime.app.rag.mode, runtime.app.rag.max_results, logger)
      : { context: "", relatedTitles: [], sourceArticles: [] };
    const retrieved = mergeRetrievedContextPackets(ragRetrieved, backlinkRetrieved);
    const relatedTitlesBlock = formatRelatedTitlesForPrompt(slug, retrieved.relatedTitles);
    logger.info("build.article_rag_retrieved", {
      slug,
      rag_chunk_sources: ragRetrieved.sourceArticles.length,
      backlink_direct_sources: backlinkRetrieved.sourceArticles.length,
      rag_chunk_titles: relatedTitlesBlock.ragCount,
      backlink_titles: relatedTitlesBlock.backlinkCount,
      incoming_link_hints: hints.length,
      related_titles_total: relatedTitlesBlock.uniqueTotal,
      context_length: retrieved.context?.length ?? 0,
    });

    // Build a preliminary reference list so the prompt can expose ref:N
    // shorthand and the LLM can link back to sources without knowing slugs.
    const backlinkUserAdditions = slugsToUserAdditions(backlinkSlugs);
    const preliminaryRefs = buildReferenceList(
      db,
      {
        articleSlug: slug,
        ragSources: retrieved.sourceArticles,
        priorReferences: loadPriorReferenceList(db, slug),
        userAdditions: backlinkUserAdditions,
        revisionId: "current",
        config: runtime.app.rag,
      },
      logger,
    );

    const prompt = getPrompt(runtime.prompts, "article");
    const selectedLlm = prompt.model === "light" ? lightLlm : llm;
    const renderedUserPrompt = renderTemplate(prompt.user, {
      slug,
      requested_title: requestedTitle,
      link_hints: formatIncomingHintsForPrompt(hints, slug),
      references_list: formatReferencesForPrompt(preliminaryRefs),
      references_json: formatReferencesForPromptJson(preliminaryRefs, runtime.app.rag.prompt_ref_content_min_score, runtime.app.rag.prompt_ref_content_top_k),
      rag_context: retrieved.context || "(none)",
      related_titles: relatedTitlesBlock.rendered,
      article_excerpt: "",
      parent_comment: "",
    });

    logger.debug("build.article_generating_body", { slug, rag_sources: retrieved.sourceArticles.length, link_hints: hints.length, backlink_titles: relatedTitlesBlock.backlinkCount });
    onStatus?.("Writing...");
    const streamResult = await selectedLlm.streamChat(
      prompt.system,
      renderedUserPrompt,
      (_delta, accumulated) => {
        if (!onProgress) return;
        const partialBody = parsePartialArticleFrame(accumulated);
        if (!partialBody) return;
        const progressMarkdown = sanitizeGeneratedBody(normalizeMarkdown(partialBody));
        onProgress(renderMarkdown(progressMarkdown), progressMarkdown);
      },
      { thinking: prompt.thinking },
    );
    const rawOutput = streamResult.content;
    logger.debug("build.article_body_generated", { slug, body_length: rawOutput.length });
    const parseResult = parseArticleFrameOutput(rawOutput, new Set(preliminaryRefs.map((r) => r.slug)), new Set(), logger);
    if (!parseResult.ok) {
      throw new Error(`article generation returned invalid structured output: ${parseResult.reason ?? "missing required refs"}`);
    }
    if (onProgress) {
      const progressMarkdown = sanitizeGeneratedBody(normalizeMarkdown(parseResult.body));
      onProgress(renderMarkdown(progressMarkdown), progressMarkdown);
    }

    // Resolve ref:N shorthand links the LLM may have emitted before any
    // further processing; must run before stripTopLevelSections in saveArticleImmediately.
    let markdown = sanitizeGeneratedBody(normalizeMarkdown(parseResult.body));
    markdown = resolveRefLinks(markdown, preliminaryRefs);
    const refLinksResolved = extractInternalLinks(markdown).length;
    logger.debug("build.article_ref_links_resolved", { slug, halu_links: refLinksResolved });
    const resolvedTitle = extractTitle(markdown, requestedTitle);
    const uniqueLinkCount = extractInternalLinks(markdown).length;
    const titleOk = articleSubjectMatchesRequested(
      markdown,
      requestedTitle,
      slug,
    );
    if (!titleOk) {
      logger.warn("page.title_mismatch", { slug, got: resolvedTitle });
    }
    onStatus?.("Resolving canon...");
    // Build article WITHOUT link repair (repair happens in post-processing)
    const { article, links, normalizedTitle, normalizedBodyMarkdown } =
      await saveArticleImmediately(slug, requestedTitle, markdown, retrieved, {
        operation: "generate",
      }, {
        userAdditionSlugs: parseResult.ok ? parseResult.refsUsed : [],
        selectedReferenceSlugs: parseResult.ok ? parseResult.refsUsed : [],
      });
    logger.info("page.generated", { slug, links: links.length, sources: retrieved.sourceArticles.length });

    logger.debug("build.article_returning", { slug: article.slug });
    // Post-processing: link repair, see-also, summary, indexing
    trackGeneration(
      postProcessArticle(
        article.slug,
        normalizedTitle,
        normalizedBodyMarkdown,
        retrieved,
        hints,
        article.generated_at,
        {
          userAdditionSlugs: parseResult.ok ? parseResult.refsUsed : [],
          selectedReferenceSlugs: parseResult.ok ? parseResult.refsUsed : [],
        },
      ).catch(() => {}),
    );

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
          const payload = await ensureHomepageCache(
            db,
            llm,
            lightLlm,
            runtime.prompts,
            HOMEPAGE_TTL_MS,
            logger,
          );
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
        lightLlm,
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
    const updated = current.map((r) => (r.slug === refSlug ? { ...r, pinned } : r));
    saveArticleReferences(db, article.slug, Date.now(), updated);
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

    // Empty retrieval — no RAG/LLM, just whatever the user provided.
    const emptyRetrieved: Awaited<ReturnType<typeof retrieveContext>> = {
      context: "",
      sourceArticles: [],
      relatedTitles: [],
    };

    try {
      const { article: updatedArticle } = await saveArticleImmediately(
        article.slug,
        article.title,
        rawMarkdown,
        emptyRetrieved,
        { operation: "raw-edit" },
        {
          userAdditionSlugs: userSlugs,
          pinnedSlugsSet: pinnedSet,
          scrapeExistingBodyLinks: true,
        },
      );
      invalidateArticleHtml(updatedArticle.slug);
      logger.info("raw_edit.saved", { slug: updatedArticle.slug });
      const response = buildArticleResponseFor(updatedArticle.slug);
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
    // Check for broken halu:/ref: links (slugs that don't exist in the DB).
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

    // Fuzzy / wiki-path lookup (reuses existing CSV parsing + title matching)
    if (body.fuzzyTitles?.trim()) {
      const { articles: matched } = findReferencedArticlesInEditText(
        db,
        body.fuzzyTitles,
        article.slug,
        10,
      );
      for (const a of matched) addArticle({ ...a, summaryMarkdown: a.summaryMarkdown ?? "" });

      // Also try fuzzy title scoring for whatever wasn't resolved above
      const fuzzy = findFuzzyTitleMatchesInEditText(
        db,
        body.fuzzyTitles,
        article.slug,
        10,
        matched.map((a) => a.slug),
      );
      for (const a of fuzzy) addArticle({ ...a, summaryMarkdown: a.summaryMarkdown ?? "" });
    }

    // RAG / vector search
    if (body.ragQuery?.trim()) {
      const retrieved = await retrieveContext(
        db,
        llm,
        article.slug,
        [body.ragQuery.trim()],
        runtime.app.rag.enabled,
        runtime.app.rag.mode,
        runtime.app.rag.max_results,
        runtime.app.rag.min_score,
        runtime.llm.embeddings.enabled,
        logger,
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
        lightLlm,
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

    const nextArticle = {
      ...article,
      markdown: nextMarkdown,
      html: "",
      summaryMarkdown:
        article.summaryMarkdown || summaryMarkdownFromArticle(nextMarkdown),
      plain_text: markdownToPlainText(nextMarkdown),
      generated_at: Date.now(),
    };
    const links = extractAllBodyLinks(nextMarkdown, nextArticle.slug);
    nextArticle.html = rewriteArticleHtml(renderMarkdown(nextMarkdown), links);
    saveArticle(
      db,
      nextArticle,
      links,
      Array.from(new Set([nextArticle.slug, nextArticle.canonicalSlug])),
      {
        operation: "add-link",
        instructions: `Linked selected text: ${selectedText}`,
      },
    );
    // add-link only annotates existing text — content doesn't change so
    // summary doesn't need re-generating; only re-index RAG chunks.
    trackGeneration(
      indexArticleChunks(
        db,
        llm,
        nextArticle.slug,
        nextMarkdown,
        runtime.app.rag.enabled && runtime.llm.embeddings.enabled,
        runtime.app.rag.chunk_size,
        logger,
      ).catch((error) => {
        logger.warn("article.reindex_failed", {
          slug: nextArticle.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );

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
    db.prepare(`UPDATE articles SET markdown = ?, html = ?, plain_text = ? WHERE slug = ?`)
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
    const selectedLlm = prompt.model === "light" ? lightLlm : llm;
    const renderedSystemPrompt = renderTemplate(prompt.system, {
      rewrite_mode: modePrompt,
      link_hints: formatIncomingHintsForPrompt(hints, article.slug),
    });
    // TODO: factor prompts out into configurable file
    const recentEditHistory = body.includeRecentEditHistory === true
      ? formatRecentEditHistoryForPrompt(listArticleRevisions(db, article.slug))
      : "";
    const promptEditInstructions = recentEditHistory
      ? `Recent edit history, oldest to newest:\n${recentEditHistory}\n\nCurrent user instructions:\n${instructions}`
      : instructions;
    const selectionEditInstructions = selectionRange
      ? `SELECTION EDIT: The user selected specific text from the article and wants it rewritten. The "Current article" field below contains ONLY the selected text. Return ONLY the replacement text — do not return the full article, do not add headings, do not add surrounding context. Your response replaces the selection verbatim.\n\nUser instructions: ${promptEditInstructions}`
      : promptEditInstructions;

    // Build preliminary refs for the prompt so the LLM can use ref:N links.
    const rewritePromptRefs = buildReferenceList(
      db,
      {
        articleSlug: article.slug,
        ragSources: retrieved.sourceArticles,
        priorReferences: priorReferenceList,
        userAdditions: slugsToUserAdditions(effectiveUserAdditionSlugs, pinnedSlugsSet),
        blacklistSlugs: effectiveBlacklistSlugs,
        revisionId: "current",
        config: runtime.app.rag,
      },
      logger,
    );

    const renderedRewritePrompt = renderTemplate(prompt.user, {
      slug: article.slug,
      requested_title: article.title,
      edit_instructions: selectionEditInstructions,
      current_article: selectedSection,
      full_article: articleBodyOnly,
      link_hints: formatIncomingHintsForPrompt(hints, article.slug),
      references_list: formatReferencesForPrompt(rewritePromptRefs),
      references_json: formatReferencesForPromptJson(rewritePromptRefs, runtime.app.rag.prompt_ref_content_min_score, runtime.app.rag.prompt_ref_content_top_k),
      rag_context: retrieved.context || "(none)",
      related_titles: formatRelatedTitlesForPrompt(article.slug, retrieved.relatedTitles).rendered,
      article_excerpt: "",
      parent_comment: "",
      selected_text: "",
    });

    const rewriteProvidedSlugs = new Set(rewritePromptRefs.map((r) => r.slug));

    const wantsStream =
      c.req.query("stream") === "1" ||
      (c.req.header("accept") ?? "").includes("application/x-ndjson");
    const operationName = selectionRange
      ? "selection-edit"
      : sectionId
        ? "section-rewrite"
        : "rewrite";

    // Splice protected sections back into a freshly LLM-written body.
    const applyProtectedSections = (llmBody: string): string => {
      const protectedIds = listProtectedSections(db, article.slug).map((s) => s.sectionId);
      return protectedIds.length > 0
        ? spliceProtectedSections(llmBody, protectedIds, article.markdown)
        : llmBody;
    };

    const persistRewrite = async (raw: string, refsUsed: string[] = []) => {
      inFlightEdits.add(article.slug);
      logger.debug("rewrite.edit_in_flight", { slug: article.slug, in_flight_edits: inFlightEdits.size });
      try {
        let nextMarkdown: string;
        if (selectionRange) {
          const replacement = normalizeMarkdown(raw)
            .replace(/^#\s+.+?\n*/m, "")
            .trim();
          nextMarkdown =
            article.markdown.slice(0, selectionRange.start) +
            replacement +
            article.markdown.slice(selectionRange.end);
        } else {
          const rewrittenBody = sanitizeGeneratedBody(normalizeMarkdown(raw));
          nextMarkdown = sectionId
            ? replaceArticleSection(article.markdown, sectionId, rewrittenBody)
            : rewrittenBody;
        }
        nextMarkdown = stripTopLevelSections(nextMarkdown, USED_REFS_HEADING_ALIASES);
        // Resolve any ref:N shorthand the LLM used against the current ref list.
        const rewriteRefs = buildReferenceList(
          db,
          {
            articleSlug: article.slug,
            ragSources: retrieved.sourceArticles,
            priorReferences: priorReferenceList,
            userAdditions: slugsToUserAdditions(effectiveUserAdditionSlugs, pinnedSlugsSet),
            blacklistSlugs: effectiveBlacklistSlugs,
            revisionId: "current",
            config: runtime.app.rag,
          },
          logger,
        );
        nextMarkdown = resolveRefLinks(nextMarkdown, rewriteRefs);
        logger.debug("rewrite.body_prepared", { slug: article.slug, body_length: nextMarkdown.length });
        const {
          article: updatedArticle,
          links,
          normalizedTitle,
          normalizedBodyMarkdown,
        } = await saveArticleImmediately(
          article.slug,
          article.title,
          nextMarkdown,
          retrieved,
          { operation: operationName, instructions },
          {
            userAdditionSlugs: Array.from(new Set([...effectiveUserAdditionSlugs, ...refsUsed])),
            selectedReferenceSlugs: Array.from(new Set([...effectiveUserAdditionSlugs, ...refsUsed])),
            pinnedSlugsSet,
            blacklistSlugs: effectiveBlacklistSlugs,
            scrapeExistingBodyLinks: !selectionRange && !sectionId,
          },
        );
        if (selectionRange || sectionId) {
          trackGeneration(
            indexArticleChunks(
              db,
              llm,
              updatedArticle.slug,
              updatedArticle.markdown,
              runtime.app.rag.enabled && runtime.llm.embeddings.enabled,
              runtime.app.rag.chunk_size,
              logger,
            ).catch((error) => {
              logger.warn("page.index_failed", {
                slug: updatedArticle.slug,
                error: error instanceof Error ? error.message : String(error),
              });
            }),
          );
        } else {
          trackGeneration(
            postProcessArticle(
              updatedArticle.slug,
              normalizedTitle,
              normalizedBodyMarkdown,
              retrieved,
              hints,
              updatedArticle.generated_at,
              {
                blacklistSlugs: effectiveBlacklistSlugs,
                userAdditionSlugs: Array.from(new Set([...effectiveUserAdditionSlugs, ...refsUsed])),
                selectedReferenceSlugs: Array.from(new Set([...effectiveUserAdditionSlugs, ...refsUsed])),
              },
            ).catch(() => {}),
          );
        }
        invalidateArticleHtml(updatedArticle.slug);
        const response = buildArticleResponseFor(updatedArticle.slug);
        if (!response) {
          throw new Error(`failed to hydrate response for ${updatedArticle.slug}`);
        }
        return buildPageResponse(response, {
          cached: true,
          canonicalPath: canonicalPathForArticle(updatedArticle),
        });
      } finally {
        inFlightEdits.delete(article.slug);
        logger.debug("rewrite.edit_complete", { slug: article.slug, in_flight_edits: inFlightEdits.size });
      }
    };

    const renderRewriteProgress = (raw: string) => {
      let previewMarkdown: string;
      if (selectionRange) {
        const replacement = normalizeMarkdown(raw)
          .replace(/^#\s+.+?\n*/m, "")
          .trim();
        previewMarkdown =
          article.markdown.slice(0, selectionRange.start) +
          replacement +
          article.markdown.slice(selectionRange.end);
      } else {
        const rewrittenBody = sanitizeGeneratedBody(normalizeMarkdown(raw));
        previewMarkdown = sectionId
          ? replaceArticleSection(article.markdown, sectionId, rewrittenBody)
          : rewrittenBody;
      }
      previewMarkdown = stripTopLevelSections(previewMarkdown, USED_REFS_HEADING_ALIASES);
      const links = extractAllBodyLinks(previewMarkdown, article.slug);
      return {
        html: rewriteArticleHtml(renderMarkdown(previewMarkdown), links),
        markdown: previewMarkdown,
      };
    };

    if (wantsStream) {
      const encoder = new TextEncoder();
      let rewriteStreamOpen = true;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: unknown) => {
            if (!rewriteStreamOpen) return;
            try {
              controller.enqueue(
                encoder.encode(`${JSON.stringify(payload)}\n`),
              );
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

          const rewrite = (async () => {
            logger.debug("rewrite.generating", {
              slug: article.slug,
              operation: operationName,
              rag_sources: retrieved.sourceArticles.length,
              selected_text_length: selectionRange ? selectionRange.end - selectionRange.start : 0,
            });
            const streamResult = await selectedLlm.streamChat(
              renderedSystemPrompt,
              renderedRewritePrompt,
              (_delta, accumulated) => {
                const partialBody = parsePartialArticleFrame(accumulated);
                if (!partialBody) return;
                const preview = renderRewriteProgress(partialBody);
                send({ type: "progress", ...preview });
              },
              { thinking: prompt.thinking },
            );
            const rawOutput = streamResult.content;
            let rewriteResult = parseArticleFrameOutput(rawOutput, rewriteProvidedSlugs, pinnedSlugsSet, logger);
            if (!rewriteResult.ok) {
              logger.warn("rewrite.invalid_structured_output", { slug: article.slug, reason: rewriteResult.reason ?? "missing-pinned-refs", missing: rewriteResult.missingPinned.join(", ") });
              const retryOutput = await selectedLlm.chat(renderedSystemPrompt, renderedRewritePrompt, { thinking: prompt.thinking });
              rewriteResult = parseArticleFrameOutput(retryOutput, rewriteProvidedSlugs, pinnedSlugsSet, logger);
            }
            if (!rewriteResult.ok) {
              throw new Error(`rewrite returned invalid structured output: ${rewriteResult.reason ?? "missing required refs"}`);
            }
            logger.debug("rewrite.generated", {
              slug: article.slug,
              operation: operationName,
              rewrite_length: rewriteResult.body.length,
            });
            const payload = await persistRewrite(applyProtectedSections(rewriteResult.body), rewriteResult.ok ? rewriteResult.refsUsed : []);
            logger.debug("rewrite.persisted", {
              slug: article.slug,
              operation: operationName,
            });
            send({ type: "done", ...payload });
            close();
          })().catch((error) => {
            send({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
            close();
          });

          trackGeneration(rewrite);
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

    logger.debug("rewrite.generating", {
      slug: article.slug,
      operation: operationName,
      rag_sources: retrieved.sourceArticles.length,
      selected_text_length: selectionRange ? selectionRange.end - selectionRange.start : 0,
    });
    const rawOutput = await selectedLlm.chat(
      renderedSystemPrompt,
      renderedRewritePrompt,
      { thinking: prompt.thinking },
    );
    let nonStreamResult = parseArticleFrameOutput(rawOutput, rewriteProvidedSlugs, pinnedSlugsSet, logger);
    if (!nonStreamResult.ok) {
      logger.warn("rewrite.invalid_structured_output", { slug: article.slug, reason: nonStreamResult.reason ?? "missing-pinned-refs", missing: nonStreamResult.missingPinned.join(", ") });
      const retryOutput = await selectedLlm.chat(renderedSystemPrompt, renderedRewritePrompt, { thinking: prompt.thinking });
      nonStreamResult = parseArticleFrameOutput(retryOutput, rewriteProvidedSlugs, pinnedSlugsSet, logger);
    }
    if (!nonStreamResult.ok) {
      throw new Error(`rewrite returned invalid structured output: ${nonStreamResult.reason ?? "missing required refs"}`);
    }
    logger.debug("rewrite.generated", {
      slug: article.slug,
      operation: operationName,
      rewrite_length: nonStreamResult.body.length,
    });

    try {
      const result = await persistRewrite(applyProtectedSections(nonStreamResult.body), nonStreamResult.ok ? nonStreamResult.refsUsed : []);
      logger.debug("rewrite.persisted", {
        slug: article.slug,
        operation: operationName,
      });
      return c.json(result);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        422,
      );
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
      const hints = listIncomingHints(db, article.slug);
      const currentBodyMarkdown = stripTopLevelSections(article.markdown, [
        "References",
        "See also",
      ]);
      const ragRetrieved = await retrieveContext(
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
        [article.title, currentBodyMarkdown].filter(Boolean).join("\n\n"),
      );
      // Pull in the full text of linking articles directly — backlinks always
      // provide context even when RAG embeddings score too low to be picked.
      const refreshBacklinkSlugs = [...new Set(hints.map((h) => h.sourceSlug).filter(Boolean))];
      const backlinkRetrieved = refreshBacklinkSlugs.length > 0
        ? retrieveDirectArticleContext(db, article.slug, refreshBacklinkSlugs, runtime.app.rag.mode, runtime.app.rag.max_results, logger)
        : { context: "", relatedTitles: [], sourceArticles: [] };
      const retrieved = mergeRetrievedContextPackets(ragRetrieved, backlinkRetrieved);
      const currentArticleReferences = findBodyReferencedArticles(
        db,
        article.markdown,
        article.slug,
      );
      const backlinkAdditions = slugsToUserAdditions(refreshBacklinkSlugs);
      const additionsBySlug = new Map<string, ReferenceListEntry>();
      for (const ref of [...backlinkAdditions, ...currentArticleReferences]) {
        additionsBySlug.set(ref.slug, ref);
      }
      const refreshPromptRefs = buildReferenceList(
        db,
        {
          articleSlug: article.slug,
          ragSources: retrieved.sourceArticles,
          priorReferences: loadPriorReferenceList(db, article.slug),
          userAdditions: Array.from(additionsBySlug.values()),
          revisionId: "current",
          config: runtime.app.rag,
        },
        logger,
      );
      // Short-circuit if the article is fully protected — skip LLM entirely.
      if (isArticleProtected(db, article.slug)) {
        logger.info("article.refresh_blocked_protection", { slug: article.slug });
        const response = buildArticleResponseFor(article.slug);
        if (!response) throw new Error("failed to hydrate response");
        return buildPageResponse(response, {
          cached: true,
          canonicalPath: canonicalPathForArticle(article),
          refreshChanged: false,
        });
      }

      let bodyMarkdown = currentBodyMarkdown;
      let operation = "refresh-context";
      let instructions = "Refreshed retrieved context and derived references.";
      let refreshRefsUsed: string[] | null = null;
      const renderRefreshProgress = (raw: string) => {
        let previewMarkdown = sanitizeGeneratedBody(normalizeMarkdown(raw));
        previewMarkdown = stripTopLevelSections(previewMarkdown, ["References", "See also"]);
        const links = extractAllBodyLinks(previewMarkdown, article.slug);
        return {
          html: rewriteArticleHtml(renderMarkdown(previewMarkdown), links),
          markdown: previewMarkdown,
        };
      };
      {
        send?.({ type: "status", message: "Refreshing article formatting and context..." });
        const prompt = getPrompt(runtime.prompts, "article_refresh");
        const selectedLlm = prompt.model === "light" ? lightLlm : llm;
        const subtleMode = runtime.prompts.rewriteModes.subtle?.prompt ?? "";
        const renderedRefreshSystem = renderTemplate(prompt.system, {
          rewrite_mode: subtleMode,
          link_hints: formatIncomingHintsForPrompt(hints, article.slug),
        });
        const renderedRefreshUser = renderTemplate(prompt.user, {
          slug: article.slug,
          requested_title: article.title,
          current_article: currentBodyMarkdown,
          link_hints: formatIncomingHintsForPrompt(hints, article.slug),
          references_list: formatReferencesForPrompt(refreshPromptRefs),
          references_json: formatReferencesForPromptJson(refreshPromptRefs, runtime.app.rag.prompt_ref_content_min_score, runtime.app.rag.prompt_ref_content_top_k),
          rag_context: retrieved.context || "(none)",
          related_titles: formatRelatedTitlesForPrompt(article.slug, retrieved.relatedTitles).rendered,
          article_excerpt: "",
          parent_comment: "",
          selected_text: "",
          edit_instructions: "",
        });
        const streamResult = send
          ? await selectedLlm.streamChat(
            renderedRefreshSystem,
            renderedRefreshUser,
            (_delta, accumulated) => {
              const partialBody = parsePartialArticleFrame(accumulated);
              if (!partialBody) return;
              send({ type: "progress", ...renderRefreshProgress(partialBody) });
            },
            { thinking: prompt.thinking },
          )
          : await selectedLlm.chat(
            renderedRefreshSystem,
            renderedRefreshUser,
            { thinking: prompt.thinking },
          );
        const rawOutput = typeof streamResult === "string" ? streamResult : streamResult.content;
        const refreshParseResult = parseArticleFrameOutput(rawOutput, new Set(refreshPromptRefs.map((r) => r.slug)), new Set(), logger);
        if (!refreshParseResult.ok) {
          throw new Error(`refresh returned invalid structured output: ${refreshParseResult.reason ?? "missing required refs"}`);
        }
        let refreshedBody = sanitizeGeneratedBody(normalizeMarkdown(refreshParseResult.body));
        // Splice protected sections back if any sections are locked.
        const refreshProtectedIds = listProtectedSections(db, article.slug).map((s) => s.sectionId);
        if (refreshProtectedIds.length > 0) {
          refreshedBody = spliceProtectedSections(refreshedBody, refreshProtectedIds, currentBodyMarkdown);
        }
        bodyMarkdown = refreshedBody;
        refreshRefsUsed = refreshParseResult.ok ? refreshParseResult.refsUsed : [];
        operation = "refresh-context-rewrite";
        instructions = "Refreshed article body from retrieved context.";
      }
      send?.({ type: "status", message: "Saving refreshed article..." });
      // Always normalize markdown formatting regardless of whether the LLM rewrote
      // the body — this corrects whitespace, heading levels, and stray artifacts
      // from prior edits even on a context-only refresh.
      bodyMarkdown = sanitizeGeneratedBody(normalizeMarkdown(bodyMarkdown));
      bodyMarkdown = normalizeMarkdownLinks(bodyMarkdown, "article").markdown;
      bodyMarkdown = resolveRefLinks(bodyMarkdown, refreshPromptRefs);
      bodyMarkdown = normalizeMarkdownLinks(bodyMarkdown, "article").markdown;
      const refreshUserAdditionSlugs = Array.from(new Set(refreshRefsUsed ?? [...refreshBacklinkSlugs, ...refreshPromptRefs.map((ref) => ref.slug)]));
      const { article: updatedArticle } = await saveArticleImmediately(
        article.slug,
        article.title,
        bodyMarkdown,
        retrieved,
        { operation, instructions },
        {
          userAdditionSlugs: refreshUserAdditionSlugs,
          selectedReferenceSlugs: refreshRefsUsed,
        },
      );
      const refreshChanged = updatedArticle.markdown !== article.markdown;
      logger.info("page.refresh", { slug: updatedArticle.slug, changed: refreshChanged });
      invalidateArticleHtml(updatedArticle.slug);

      // Always kick off full post-processing (see-also, summary, RAG indexing)
      // after a refresh — previously this was missing, so see-also and summary
      // were never updated on refresh.
      trackGeneration(
        postProcessArticle(
          updatedArticle.slug,
          updatedArticle.title,
          updatedArticle.markdown,
          retrieved,
          hints,
          updatedArticle.generated_at,
          {
            userAdditionSlugs: refreshUserAdditionSlugs,
            selectedReferenceSlugs: refreshRefsUsed,
          },
        ).catch(() => {}),
      );

      const response = buildArticleResponseFor(updatedArticle.slug);
      if (!response) throw new Error("failed to hydrate response");
      return buildPageResponse(response, {
        cached: true,
        canonicalPath: canonicalPathForArticle(updatedArticle),
        refreshChanged,
      });
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
    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);

    try {
      await reloadRuntime();
      const summaryMarkdown = await generateArticleSummary(
        llm,
        lightLlm,
        runtime.prompts,
        article.title,
        article.markdown,
      );
      const updated = updateArticleSummary(db, article.slug, summaryMarkdown, {
        updateRevisionGeneratedAt: article.generated_at,
      });
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
      });
    }

    const results = searchCorpus(db, q, runtime.app.search.limit).map(
      (item) => ({
        slug: item.canonicalSlug,
        title: item.title === item.slug ? slugToTitle(item.slug) : item.title,
        summary: item.summary,
        exists: Boolean(item.existsFlag),
      }),
    );

    const resultSlugs = results.map((r) => r.slug);
    const random = getRandomSuggestions(db, 5, resultSlugs).map((r) => ({
      slug: r.slug,
      title: r.title,
      summary: r.summaryMarkdown?.trim() || summaryMarkdownFromArticle(r.markdown),
    }));

    return c.json({
      query: q,
      results,
      suggestions: random,
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
