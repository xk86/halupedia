import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
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
  getLatestArticleReferences,
  type ArticleReference,
  saveHomepageCache,
  getRandomSuggestions,
  searchCorpus,
  updateArticleSummary,
  updateArticleInPlace,
  wipeGeneratedCorpus,
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
import type {
  ArticleRecord,
  HomepagePayload,
  LinkSelectionSuggestion,
  LinkSuggestion,
  SeeAlsoCandidate,
} from "./types";

const RESERVED_PATHS = new Set([
  "",
  "search",
  "all-entries",
  "admin",
  "random",
  "Random",
  "api",
  "assets",
]);
const LARGE_SELECTION_CHAR_THRESHOLD = 120;
const LARGE_SELECTION_WORD_THRESHOLD = 18;
const HOMEPAGE_MAINTENANCE_TASK = "homepage.refresh";
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

function buildReferenceLine(candidate: InternalArticleCandidate): string {
  return `- ${buildHaluLink(candidate.title, candidate.slug, candidate.hiddenHint)}`;
}

function buildSeeAlsoLine(candidate: InternalArticleCandidate): string {
  return `- ${buildHaluLink(candidate.title, candidate.slug, candidate.hiddenHint)}`;
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

function sanitizeGeneratedBody(markdown: string): string {
  return fixSlugVisibleText(
    stripFootnoteArtifacts(
      stripTopLevelSections(markdown, ["References", "See also"]),
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

function normalizeSelectionText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

/**
 * Strip inline markdown formatting (bold, italic, links) while building a
 * map from each plain-text character index → its position in the raw markdown.
 * Used so we can locate a rendered-text selection inside the raw markdown source.
 *
 * Limitations: block-level constructs (headings, bullets) are passed through
 * as-is since selections come from rendered inline content.
 */
function stripInlineMarkdownWithPositions(
  md: string,
): { plain: string; posMap: number[] } {
  const posMap: number[] = [];
  let plain = "";
  let i = 0;

  while (i < md.length) {
    // Bold: **...** — skip opening/closing markers, include inner text
    if (md[i] === "*" && md[i + 1] === "*") {
      i += 2;
      continue;
    }

    // Bold: __...__ — same treatment
    if (md[i] === "_" && md[i + 1] === "_") {
      i += 2;
      continue;
    }

    // Link or halu-link: [label](url "hint") — include only the label chars,
    // skip the [, ](url) parts so the visible label is mapped to label positions.
    if (md[i] === "[") {
      const labelEnd = md.indexOf("]", i + 1);
      if (labelEnd >= 0 && md[labelEnd + 1] === "(") {
        const parenClose = md.indexOf(")", labelEnd + 2);
        if (parenClose >= 0) {
          for (let j = i + 1; j < labelEnd; j++) {
            plain += md[j];
            posMap.push(j);
          }
          i = parenClose + 1;
          continue;
        }
      }
    }

    // Italic: * or _ (single) — skip the marker character
    if (
      (md[i] === "*" || md[i] === "_") &&
      md[i + 1] !== "*" &&
      md[i + 1] !== "_"
    ) {
      i++;
      continue;
    }

    // Inline code: `code` — include content, skip backticks
    if (md[i] === "`") {
      const closeBacktick = md.indexOf("`", i + 1);
      if (closeBacktick >= 0) {
        for (let j = i + 1; j < closeBacktick; j++) {
          plain += md[j];
          posMap.push(j);
        }
        i = closeBacktick + 1;
        continue;
      }
    }

    plain += md[i];
    posMap.push(i);
    i++;
  }

  return { plain, posMap };
}

/**
 * Extend a markdown range outward to include any enclosing formatting markers
 * (bold **, italic *, link [label](url)) that straddle the current boundaries.
 * This ensures replacement splices don't leave dangling markers.
 */
function extendRangeToFormattingBoundaries(
  md: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let s = start;
  let e = end;

  // Extend backward: absorb consecutive * or _ markers, and the [ of a link label
  while (s > 0) {
    const ch = md[s - 1];
    if (ch === "*" || ch === "_") {
      s--;
    } else if (ch === "[") {
      // We are at the start of a link label — include the opening [
      s--;
      break;
    } else {
      break;
    }
  }

  // Extend forward: absorb closing * or _ markers, and the ](url) of a link
  while (e < md.length) {
    const ch = md[e];
    if (ch === "*" || ch === "_") {
      e++;
    } else if (ch === "]" && md[e + 1] === "(") {
      // End of link label — include the closing ](url) part
      const parenClose = md.indexOf(")", e + 2);
      if (parenClose >= 0) e = parenClose + 1;
      break;
    } else {
      break;
    }
  }

  return { start: s, end: e };
}

/**
 * Find the markdown character range that corresponds to a plain-text selection
 * made in the rendered article HTML.
 *
 * Falls back from a fast exact indexOf to a position-mapped search that
 * accounts for inline formatting markers (bold, italic, links) between words.
 * The returned range is extended to include any enclosing formatting markers
 * so that splicing in a replacement doesn't leave dangling syntax.
 *
 * Returns null if the selection cannot be located.
 */
export function findSelectionRangeInMarkdown(
  markdown: string,
  plainTextSelection: string,
): { start: number; end: number } | null {
  const normalized = normalizeSelectionText(plainTextSelection);
  if (!normalized) return null;

  // Fast path: the plain text is already a verbatim substring of the markdown.
  // Still extend to formatting boundaries so callers get a well-formed splice range.
  const exactIdx = markdown.indexOf(normalized);
  if (exactIdx >= 0) {
    return extendRangeToFormattingBoundaries(
      markdown,
      exactIdx,
      exactIdx + normalized.length,
    );
  }

  // Slow path: strip inline formatting, find the selection in the plain text,
  // then map back to the markdown positions.
  const { plain, posMap } = stripInlineMarkdownWithPositions(markdown);
  const plainNorm = plain.replace(/\s+/g, " ");
  const searchLower = normalized.toLowerCase();
  const ptIdx = plainNorm.toLowerCase().indexOf(searchLower);
  if (ptIdx < 0) return null;

  const ptEnd = ptIdx + normalized.length - 1;
  const mdStart = posMap[ptIdx];
  const mdEnd = posMap[ptEnd];
  if (mdStart === undefined || mdEnd === undefined) return null;

  return extendRangeToFormattingBoundaries(markdown, mdStart, mdEnd + 1);
}

/**
 * Ensure a DYK fact string contains a link to the source article.
 *
 * If the fact already has a halu link pointing at `slug`, it is returned
 * unchanged.  If the article title appears as plain text, the first occurrence
 * is replaced with an inline halu link.  Otherwise a link is prepended to the
 * fact so readers always have a way to navigate to the source.
 */
export function ensureDykHasSourceLink(
  fact: string,
  slug: string,
  title: string,
): string {
  // DYK facts use standard wiki-path links ([Title](/wiki/Page)), not halu links.
  // Halu links are for seeding article generation; DYK is read-only display content.
  const wikiPath = `/wiki/${titleToWikiSegment(title)}`;
  const titleLink = `[${title}](${wikiPath})`;

  // Already contains a wiki-path link to this article → nothing to do
  const wikiPattern = new RegExp(
    `\\(${escapeRegExp(wikiPath)}\\)`,
    "i",
  );
  if (wikiPattern.test(fact)) return fact;

  // Bug guard: never insert a halu link either (shouldn't happen, but be safe)
  const haluPattern = new RegExp(`\\(halu:${escapeRegExp(slug)}[\\s"')/]`, "i");
  if (haluPattern.test(fact)) {
    // Strip the halu link and replace with a wiki link — halu in DYK is wrong
    return fact.replace(
      new RegExp(`\\[([^\\]]+)\\]\\(halu:${escapeRegExp(slug)}[^)]*\\)`, "gi"),
      `[$1](${wikiPath})`,
    );
  }

  // Title appears as plain text → linkify the first occurrence
  const titlePattern = new RegExp(
    `(?<![\\[(/])${escapeRegExp(title)}(?![\\]])`,
    "i",
  );
  const match = titlePattern.exec(fact);
  if (match) {
    return (
      fact.slice(0, match.index) +
      titleLink +
      fact.slice(match.index + match[0].length)
    );
  }

  // Title not present → prepend a link attribution
  if (fact.startsWith("... ")) {
    return `... ${titleLink}: ${fact.slice("... ".length)}`;
  }
  return `${titleLink} — ${fact}`;
}

function shouldRefineSelection(text: string): boolean {
  const normalized = normalizeSelectionText(text);
  return (
    normalized.length > LARGE_SELECTION_CHAR_THRESHOLD ||
    normalized.split(/\s+/).filter(Boolean).length >
      LARGE_SELECTION_WORD_THRESHOLD
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9]/.test(char);
}

function collectExistingLinkRanges(
  markdown: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const pattern = new RegExp(LINK_RE.source, LINK_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function overlapsExistingLink(
  index: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function findWrapRange(
  markdown: string,
  selectedText: string,
): { start: number; end: number; visibleLabel: string } | null {
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

function extractSelectionExcerpt(
  markdown: string,
  selectedText: string,
): string {
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
  seeAlso: InternalArticleCandidate[],
): string {
  const sections = [bodyMarkdown.trim()];
  if (references.length) {
    sections.push(
      `## References\n\n${references.map(buildReferenceLine).join("\n")}`,
    );
  }
  if (seeAlso.length) {
    sections.push(
      `## See also\n\n${seeAlso.map(buildSeeAlsoLine).join("\n")}`,
    );
  }
  return sections.filter(Boolean).join("\n\n").trim();
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

async function generateSeeAlsoCandidates(
  llm: LlmClient,
  lightLlm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  requestedTitle: string,
  bodyMarkdown: string,
  ragContext: string,
  linkHints: IncomingHint[],
  relatedTitles: string[],
): Promise<InternalArticleCandidate[]> {
  const prompt = getPrompt(promptConfig, "see_also");
  const selectedLlm = prompt.model === "light" ? lightLlm : llm;
  const raw = await selectedLlm.chat(
    prompt.system,
    renderTemplate(prompt.user, {
      slug: slugify(requestedTitle),
      requested_title: requestedTitle,
      article_excerpt: bodyMarkdown.slice(0, 6000),
      rag_context: ragContext || "(none)",
      link_hints: formatIncomingHintsForPrompt(linkHints, slugify(requestedTitle)),
      related_titles: relatedTitles.length
        ? relatedTitles.map((title) => `- ${title}`).join("\n")
        : "(none)",
      parent_comment: "",
    }),
    { thinking: prompt.thinking },
  );
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  const parsed = JSON.parse(match[0]) as { items?: SeeAlsoCandidate[] };
  return dedupeArticleCandidates(
    (parsed.items ?? []).map((item) => ({
      slug: slugify(item.title ?? ""),
      title: (item.title ?? "").replace(/\s+/g, " ").trim(),
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
): Promise<string> {
  const links = extractInternalLinks(bodyMarkdown);
  if (links.length === 0) return bodyMarkdown;

  const prompt = getPrompt(promptConfig, "link_recheck");
  const selectedLlm = prompt.model === "light" ? lightLlm : llm;
  const raw = await selectedLlm.chat(
    prompt.system,
    renderTemplate(prompt.user, {
      requested_title: requestedTitle,
      article_body: bodyMarkdown.slice(0, 12000),
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
    { thinking: prompt.thinking },
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
async function repairMalformedHaluLinks(
  markdown: string,
  lightLlm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  logger: Logger,
): Promise<string> {
  if (!markdown.includes("halu:")) return markdown;

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
  logger.warn("link_repair.malformed_detected", { count: malformed.length });

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
        full_article: articleMarkdown.slice(0, 12000),
      }),
      { thinking: prompt.thinking },
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

function normalizeHomepageFact(raw: string): string {
  let fact = stripJsonFences(raw)
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  fact = fact.replace(/^did you know(?:\.\.\.|\s+that|\s*)/i, "");
  fact = fact.replace(/^[.?!\s]+/, "");
  fact = fact.replace(/[.?!\s]+$/, "");
  return fact ? `... ${fact}.` : "";
}

async function generateDidYouKnowFact(
  llm: LlmClient,
  lightLlm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  article: ReturnType<typeof getRandomArticles>[number],
): Promise<string> {
  const prompt = getPrompt(promptConfig, "did_you_know");
  const selectedLlm = prompt.model === "light" ? lightLlm : llm;
  // DYK facts use plain wiki-path links, not halu links.
  // Halu links are for seeding new-article generation; DYK facts are read-only display.
  const articleTitleMarkdown = `[${article.title}](/wiki/${titleToWikiSegment(article.title)})`;
  const raw = await selectedLlm.chat(
    prompt.system,
    renderTemplate(prompt.user, {
      article_title: articleTitleMarkdown,
      article_excerpt: stripTopLevelSections(article.markdown, [
        "References",
        "See also",
      ]).slice(0, 6000),
      slug: article.slug,
      requested_title: article.title,
      current_article: article.markdown.slice(0, 12000),
      previous_summary: "",
      summary_feedback: "",
      rag_context: "",
      link_hints: "",
      related_titles: "",
      parent_comment: "",
      selected_text: "",
      edit_instructions: "",
      full_article: article.markdown.slice(0, 12000),
      dyk_articles: "",
    }),
    { thinking: prompt.thinking },
  );
  return normalizeHomepageFact(raw);
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
    { thinking: prompt.thinking },
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

async function generateLinkSelection(
  llm: LlmClient,
  lightLlm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  requestedTitle: string,
  selectedText: string,
  articleExcerpt: string,
  ragContext: string,
  relatedTitles: string[],
): Promise<string> {
  const prompt = getPrompt(promptConfig, "link_selection");
  const selectedLlm = prompt.model === "light" ? lightLlm : llm;
  const raw = await selectedLlm.chat(
    buildLinkedPromptSystem(promptConfig, "link_selection"),
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
    { thinking: prompt.thinking },
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
    { thinking: prompt.thinking },
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
  const maintenance = new MaintenanceScheduler(logger);

  function trackGeneration<T>(promise: Promise<T>): Promise<T> {
    inFlightGenerations.add(promise);
    promise.finally(() => inFlightGenerations.delete(promise));
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

  async function shutdown() {
    await maintenance.shutdown();
    if (inFlightGenerations.size > 0) {
      logger.info("shutdown.draining", { in_flight: inFlightGenerations.size });
      await Promise.allSettled([...inFlightGenerations]);
    }
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
      Array.from(
        new Set([repairedArticle.slug, repairedArticle.canonicalSlug]),
      ),
      {
        operation: "repair",
        instructions: "Normalize lowercase-first canonical title.",
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
    const bodyMarkdown = sanitizeGeneratedBody(article.markdown);
    const markdown = rewriteArticleTitleHeading(bodyMarkdown, normalizedTitle);
    const links = extractInternalLinks(markdown);
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
      },
    );
    return getArticleByLookup(db, repairedArticle.slug) ?? repairedArticle;
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

  async function saveArticleImmediately(
    slug: string,
    requestedTitle: string,
    bodyMarkdown: string,
    retrieved: Awaited<ReturnType<typeof retrieveContext>>,
    revision: {
      operation?: string;
      instructions?: string;
      revertedFromRevisionId?: number | null;
    } = {},
  ) {
    const { canonicalTitle, canonicalSlug, displayTitle } =
      deriveArticleIdentity(bodyMarkdown, requestedTitle, slug);
    const normalizedBodyMarkdown = rewriteArticleTitleHeading(
      bodyMarkdown,
      canonicalTitle,
    );
    const deterministicReferences = dedupeRetrievedSourceArticles(
      retrieved.sourceArticles,
    ).map((article) => ({
      slug: article.slug,
      title: article.title,
      hiddenHint: summarizeRetrievedSource(article) || article.title,
    }));

    const assembled = assembleArticleMarkdown(
      normalizedBodyMarkdown,
      deterministicReferences,
      [],
    );
    // Attempt to repair any halu links the normalizer couldn't parse
    const repaired = await repairMalformedHaluLinks(
      assembled,
      lightLlm,
      runtime.prompts,
      logger,
    );
    const markdown = stripSelfLinks(repaired, canonicalSlug);

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
    const links = extractInternalLinks(markdown);
    article.html = rewriteArticleHtml(renderMarkdown(markdown), links);
    saveArticle(
      db,
      article,
      links,
      Array.from(new Set([slug, canonicalSlug, article.canonicalSlug])),
      revision,
    );
    // Persist the reference articles used during this save so they can be
    // restored in subsequent edit sessions without a fresh RAG search.
    const referenceEntries: ArticleReference[] = dedupeRetrievedSourceArticles(
      retrieved.sourceArticles,
    ).map((src) => ({
      slug: src.slug,
      title: src.title,
      summaryMarkdown: src.content?.slice(0, 400) ?? "",
    }));
    saveArticleReferences(db, canonicalSlug, article.generated_at, referenceEntries);
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
  ) {
    const normalizedSlug = slugify(slug);
    try {
      const bodyLinkSlugs = new Set(
        extractInternalLinks(normalizedBodyMarkdown).map(
          (link) => link.targetSlug,
        ),
      );
      const seeAlso = (
        await generateSeeAlsoCandidates(
          llm,
          lightLlm,
          runtime.prompts,
          normalizedTitle,
          normalizedBodyMarkdown,
          retrieved.context,
          hints,
          retrieved.relatedTitles,
        ).catch(() => [])
      )
        .filter(
          (candidate) =>
            candidate.slug !== slug && !bodyLinkSlugs.has(candidate.slug),
        )
        .slice(0, 7);

      const existing = getArticleByLookup(db, normalizedSlug);
      if (!existing) return;

      if (
        expectedGeneratedAt &&
        existing.generated_at !== expectedGeneratedAt
      ) {
        logger.info("page.post_process_skipped", { slug: normalizedSlug, reason: "stale" });
        return;
      }

      const deterministicReferences = dedupeArticleCandidates(
        retrieved.sourceArticles.map((article) => ({
          slug: article.slug,
          title: article.title,
          hiddenHint: normalizeArticleSnippet(article.content) || article.title,
        })),
      );
      const markdown = stripSelfLinks(
        assembleArticleMarkdown(
          normalizedBodyMarkdown,
          deterministicReferences,
          seeAlso,
        ),
        slug,
      );
      const summaryMarkdown = await generateArticleSummary(
        llm,
        lightLlm,
        runtime.prompts,
        normalizedTitle,
        markdown,
      ).catch(() => summaryMarkdownFromArticle(markdown));

      const freshCheck = getArticleByLookup(db, normalizedSlug);
      if (
        expectedGeneratedAt &&
        freshCheck &&
        freshCheck.generated_at !== expectedGeneratedAt
      ) {
        logger.info("page.post_process_skipped", { slug: normalizedSlug, reason: "concurrent_edit" });
        return;
      }

      const links = extractInternalLinks(markdown);
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
      );
      logger.info("page.post_process_done", { slug: normalizedSlug });
    } catch (error) {
      logger.warn("page.post_process_failed", {
        slug: normalizedSlug,
        error: error instanceof Error ? error.message : String(error),
      });
    }

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
  }

  async function buildArticle(
    slug: string,
    requestedTitle: string,
    onProgress?: (html: string, markdown: string) => void,
    onStatus?: (message: string) => void,
  ) {
    onStatus?.("Gathering references...");
    const hints = listIncomingHints(db, slug);
    const retrieved = await retrieveContext(
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
    );

    const prompt = getPrompt(runtime.prompts, "article");
    const selectedLlm = prompt.model === "light" ? lightLlm : llm;
    const renderedUserPrompt = renderTemplate(prompt.user, {
      slug,
      requested_title: requestedTitle,
      link_hints: formatIncomingHintsForPrompt(hints, slug),
      rag_context: retrieved.context || "(none)",
      related_titles: retrieved.relatedTitles.length
        ? retrieved.relatedTitles.map((title) => `- ${title}`).join("\n")
        : "(none)",
      article_excerpt: "",
      parent_comment: "",
    });

    onStatus?.("Writing...");
    let rawMarkdown = "";
    if (onProgress) {
      await selectedLlm.streamChat(
        prompt.system,
        renderedUserPrompt,
        (_delta, accumulated) => {
          rawMarkdown = accumulated;
          const progressMarkdown = sanitizeGeneratedBody(
            normalizeMarkdown(accumulated),
          );
          onProgress(renderMarkdown(progressMarkdown), progressMarkdown);
        },
        { thinking: prompt.thinking },
      );
    } else {
      rawMarkdown = await selectedLlm.chat(prompt.system, renderedUserPrompt, {
        thinking: prompt.thinking,
      });
    }

    let markdown = sanitizeGeneratedBody(normalizeMarkdown(rawMarkdown));
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
    const { article, links, normalizedTitle, normalizedBodyMarkdown } =
      await saveArticleImmediately(slug, requestedTitle, markdown, retrieved, {
        operation: "generate",
      });
    logger.info("page.generated", { slug, links: links.length, sources: retrieved.sourceArticles.length });

    trackGeneration(
      postProcessArticle(
        article.slug,
        normalizedTitle,
        normalizedBodyMarkdown,
        retrieved,
        hints,
        article.generated_at,
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

    let article = getArticleByLookup(db, lookupSlug);
    if (!article) {
      const titleMatch = getArticleByTitle(db, requestedTitle);
      if (titleMatch) {
        article = repairStoredArticleIdentity(titleMatch, lookupSlug);
      }
    }
    if (article) {
      article = repairStoredArticleIdentity(article, lookupSlug);
      if (!cachedArticleNeedsRepair(article.markdown)) {
        const canonicalPath = canonicalPathForArticle(article);
        logger.info("page.hit", { slug: lookupSlug });
        return c.json({
          cached: true,
          redirectedFrom:
            canonicalPath !== requestedPath ? requestedPath : undefined,
          canonicalPath,
          article,
          sections: listArticleSections(article.markdown),
          backlinks: listBacklinks(db, article.slug),
        });
      }
      logger.warn("page.cache_repair", { slug: article.slug });
      article = repairCachedArticle(article);
      const canonicalPath = canonicalPathForArticle(article);
      logger.info("page.hit", { slug: lookupSlug });
      return c.json({
        cached: true,
        redirectedFrom:
          canonicalPath !== requestedPath ? requestedPath : undefined,
        canonicalPath,
        article,
        sections: listArticleSections(article.markdown),
        backlinks: listBacklinks(db, article.slug),
      });
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
            article = result;
            const canonicalPath = canonicalPathForArticle(article);
            logger.info("page.stream_done", { slug: lookupSlug, seq });
            send({
              type: "done",
              cached: false,
              redirectedFrom:
                canonicalPath !== requestedPath ? requestedPath : undefined,
              canonicalPath,
              article,
              sections: listArticleSections(article.markdown),
              backlinks: listBacklinks(db, article.slug),
            });
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
    const references = getLatestArticleReferences(db, article.slug);
    return c.json({ references });
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
    const selectedPhrase = shouldRefineSelection(selectedText)
      ? await generateLinkSelection(
          llm,
          lightLlm,
          runtime.prompts,
          article.title,
          selectedText,
          excerpt,
          retrieved.context,
          retrieved.relatedTitles,
        ).catch(() => selectedText)
      : selectedText;
    const wrapRange = findWrapRange(article.markdown, selectedPhrase);
    if (!wrapRange) {
      return c.json(
        {
          error:
            "could not find selectable text to wrap in the article markdown",
        },
        422,
      );
    }
    const suggestion = await generateLinkSuggestion(
      llm,
      lightLlm,
      runtime.prompts,
      article.title,
      wrapRange.visibleLabel,
      excerpt,
      retrieved.context,
      retrieved.relatedTitles,
    );

    const targetSlug = slugify(suggestion.title);
    if (!targetSlug)
      return c.json(
        { error: "link suggestion produced an invalid target" },
        500,
      );

    const wrapped = buildHaluLink(
      wrapRange.visibleLabel,
      targetSlug,
      suggestion.hint,
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
    const links = extractInternalLinks(nextMarkdown);
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
    await indexArticleChunks(
      db,
      llm,
      nextArticle.slug,
      nextMarkdown,
      runtime.app.rag.enabled && runtime.llm.embeddings.enabled,
      runtime.app.rag.chunk_size,
      logger,
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

    const body = (await c.req.json().catch(() => ({}))) as {
      instructions?: string;
      sectionId?: string;
      selectedText?: string;
      ragEnabled?: boolean;
      ragQuery?: string;
      rewriteMode?: string;
    };
    const instructions = (body.instructions ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2500);
    if (!instructions)
      return c.json({ error: "missing rewrite instructions" }, 400);

    const article = getArticleByLookup(db, lookupSlug);
    if (!article) return c.json({ error: "article not found" }, 404);

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
    const selectedSection = selectionRange
      ? article.markdown.slice(selectionRange.start, selectionRange.end)
      : sectionId
        ? articleSectionMarkdown(article.markdown, sectionId)
        : article.markdown;

    const ragEnabled = body.ragEnabled === true;
    const ragQuery = (body.ragQuery ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);

    const hints = listIncomingHints(db, article.slug);
    let retrieved: Awaited<ReturnType<typeof retrieveContext>>;
    if (ragEnabled) {
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
        editReferences.articles.map(
          (referencedArticle) => referencedArticle.slug,
        ),
      );
      // Pre-seed with articles that were used as references the last time this
      // article was saved/edited, so the context is consistent without a new search.
      const savedRefSlugs = getLatestArticleReferences(db, article.slug).map(
        (r) => r.slug,
      );
      const allDirectSlugs = Array.from(
        new Set([
          ...savedRefSlugs,
          ...[...editReferences.articles, ...fuzzyTitleMatches].map(
            (a) => a.slug,
          ),
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
            .map((referencedArticle) => referencedArticle.slug)
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
    const selectionEditInstructions = selectionRange
      ? `SELECTION EDIT: The user selected specific text from the article and wants it rewritten. The "Current article" field below contains ONLY the selected text. Return ONLY the replacement text — do not return the full article, do not add headings, do not add surrounding context. Your response replaces the selection verbatim.\n\nUser instructions: ${instructions}`
      : instructions;

    const renderedRewritePrompt = renderTemplate(prompt.user, {
      slug: article.slug,
      requested_title: article.title,
      edit_instructions: selectionEditInstructions,
      current_article: selectedSection,
      full_article: selectionRange ? article.markdown : article.markdown,
      link_hints: formatIncomingHintsForPrompt(hints, article.slug),
      rag_context: retrieved.context || "(none)",
      related_titles: retrieved.relatedTitles.length
        ? retrieved.relatedTitles.map((title) => `- ${title}`).join("\n")
        : "(none)",
      article_excerpt: "",
      parent_comment: "",
      selected_text: "",
    });

    const wantsStream =
      c.req.query("stream") === "1" ||
      (c.req.header("accept") ?? "").includes("application/x-ndjson");
    const operationName = selectionRange
      ? "selection-edit"
      : sectionId
        ? "section-rewrite"
        : "rewrite";

    const persistRewrite = async (raw: string) => {
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
      );
      trackGeneration(
        postProcessArticle(
          updatedArticle.slug,
          normalizedTitle,
          normalizedBodyMarkdown,
          retrieved,
          hints,
          updatedArticle.generated_at,
        ).catch(() => {}),
      );
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
            let raw = "";
            await selectedLlm.streamChat(
              renderedSystemPrompt,
              renderedRewritePrompt,
              (_delta, accumulated) => {
                raw = accumulated;
                const progressMarkdown = sanitizeGeneratedBody(
                  normalizeMarkdown(accumulated),
                );
                let mergedMarkdown: string;
                if (selectionRange) {
                  const replacement = normalizeMarkdown(accumulated)
                    .replace(/^#\s+.+?\n*/m, "")
                    .trim();
                  mergedMarkdown =
                    article.markdown.slice(0, selectionRange.start) +
                    replacement +
                    article.markdown.slice(selectionRange.end);
                } else if (sectionId) {
                  mergedMarkdown = replaceArticleSection(
                    article.markdown,
                    sectionId,
                    progressMarkdown,
                  );
                } else {
                  mergedMarkdown = progressMarkdown;
                }
                send({
                  type: "progress",
                  html: renderMarkdown(mergedMarkdown),
                  markdown: mergedMarkdown,
                });
              },
              { thinking: prompt.thinking },
            );
            const payload = await persistRewrite(raw);
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

    const raw = await selectedLlm.chat(
      renderedSystemPrompt,
      renderedRewritePrompt,
      { thinking: prompt.thinking },
    );

    try {
      return c.json(await persistRewrite(raw));
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
    const currentBodyMarkdown = stripTopLevelSections(article.markdown, [
      "References",
      "See also",
    ]);
    let bodyMarkdown = currentBodyMarkdown;
    let operation = "refresh-context";
    let instructions = "Refreshed retrieved context and derived references.";
    if (retrieved.context || hints.length) {
      const prompt = getPrompt(runtime.prompts, "article_refresh");
      const selectedLlm = prompt.model === "light" ? lightLlm : llm;
      const subtleMode = runtime.prompts.rewriteModes.subtle?.prompt ?? "";
      const renderedRefreshSystem = renderTemplate(prompt.system, {
        rewrite_mode: subtleMode,
        link_hints: formatIncomingHintsForPrompt(hints, article.slug),
      });
      const raw = await selectedLlm.chat(
        renderedRefreshSystem,
        renderTemplate(prompt.user, {
          slug: article.slug,
          requested_title: article.title,
          current_article: currentBodyMarkdown,
          link_hints: formatIncomingHintsForPrompt(hints, article.slug),
          rag_context: retrieved.context || "(none)",
          related_titles: retrieved.relatedTitles.length
            ? retrieved.relatedTitles.map((title) => `- ${title}`).join("\n")
            : "(none)",
          article_excerpt: "",
          parent_comment: "",
          selected_text: "",
          edit_instructions: "",
        }),
        { thinking: prompt.thinking },
      );
      bodyMarkdown = sanitizeGeneratedBody(normalizeMarkdown(raw));
      bodyMarkdown = await recheckArticleLinks(
        llm,
        lightLlm,
        runtime.prompts,
        article.title,
        bodyMarkdown,
      );
      operation = "refresh-context-rewrite";
      instructions = "Refreshed article body from retrieved context.";
    }
    // Always normalize markdown formatting regardless of whether the LLM rewrote
    // the body — this corrects whitespace, heading levels, and stray artifacts
    // from prior edits even on a context-only refresh.
    bodyMarkdown = sanitizeGeneratedBody(normalizeMarkdown(bodyMarkdown));
    const {
      article: updatedArticle,
      normalizedTitle,
      normalizedBodyMarkdown,
    } = await saveArticleImmediately(
      article.slug,
      article.title,
      bodyMarkdown,
      retrieved,
      { operation, instructions },
    );
    trackGeneration(
      postProcessArticle(
        updatedArticle.slug,
        normalizedTitle,
        normalizedBodyMarkdown,
        retrieved,
        hints,
        updatedArticle.generated_at,
      ).catch(() => {}),
    );
    const refreshChanged = updatedArticle.markdown !== article.markdown;
    logger.info("page.refresh", { slug: updatedArticle.slug, changed: refreshChanged });
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
    const links = extractInternalLinks(nextArticle.markdown);
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
    await indexArticleChunks(
      db,
      llm,
      nextArticle.slug,
      nextArticle.markdown,
      runtime.app.rag.enabled && runtime.llm.embeddings.enabled,
      runtime.app.rag.chunk_size,
      logger,
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
        operation: "summary-regenerate",
        instructions: "Regenerated article summary from current prompt config.",
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
    const links = extractInternalLinks(markdown);
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

    return c.json({
      cached: true,
      canonicalPath: canonicalPathForArticle(article),
      article,
      sections: listArticleSections(article.markdown),
      backlinks: listBacklinks(db, article.slug),
    });
  });

  app.get("/api/disambiguation/:slug", (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    const article = getArticleByLookup(db, lookupSlug);
    if (!article || !article.isDisambiguation)
      return c.json({ error: "not a disambiguation page" }, 404);
    return c.json({
      cached: true,
      canonicalPath: canonicalPathForArticle(article),
      article,
      sections: listArticleSections(article.markdown),
      backlinks: listBacklinks(db, article.slug),
    });
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
