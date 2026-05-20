/**
 * Unified reference-list construction.
 *
 * This is the SOLE supported way to build the reference list for an article.
 * Every flow that modifies an article (generation, refresh, rewrite, edit)
 * MUST route through `buildReferenceList` so the rules below are enforced:
 *
 *   1. References are constructed algorithmically — NEVER produced by an LLM.
 *   2. Reference content is sourced from known-good places: article summaries
 *      cached in the database, RAG-retrieved chunks, user-pinned entries, and
 *      entries carried over from the prior save.
 *   3. Every entry's slug is validated against the database before inclusion.
 *   4. Pinned entries always survive ranking/pruning, and DO NOT count toward
 *      `max_references`.
 *   5. References are stored as sidecar metadata and rendered for display as
 *      ordered footnote targets.
 *
 * The module also exports display/prompt helpers used by article assembly.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "./logger";
import type {
  ReferenceKind,
  ReferenceList,
  ReferenceListEntry,
  ReferenceRevisionId,
  ReferenceSource,
  RagConfig,
  ParsedInternalLink,
} from "./types";
import type { RetrievedSourceArticle } from "./retrieval";
import { getArticleByLookup, getLatestArticleReferences } from "./db";
import { slugify, slugToTitle } from "./slug";

/**
 * Inputs for `buildReferenceList`.
 *
 * `ragSources` is the raw RAG output for this generation/refresh/rewrite.
 * `priorReferences` is the previously-saved list (or undefined for first save).
 * `userAdditions` is the list the user explicitly added/kept in the editor.
 * `revisionId` is the revision being saved (positive int) or an in-memory
 * sentinel for the current-not-yet-saved iteration.
 */
export interface BuildReferenceListInput {
  articleSlug: string;
  /** RAG chunks for this iteration. Each has a relevancy score. */
  ragSources: RetrievedSourceArticle[];
  /** Previously-persisted reference list (carried over unless pruned). */
  priorReferences?: ReferenceList;
  /**
   * References the user explicitly selected in the editor UI. These are
   * treated as non-prunable for this generation (rank above everything
   * except permanently-pinned entries). They count toward max_references.
   */
  userAdditions?: ReferenceList;
  /**
   * Slugs the user explicitly removed from the reference list. These are
   * excluded from the result regardless of RAG score. Does NOT affect
   * permanently-pinned entries (none exist yet in the UI).
   */
  blacklistSlugs?: string[];
  /** Revision id this build is associated with (sentinel for in-progress). */
  revisionId: ReferenceRevisionId;
  /** Reference-list-specific tuning from app config. */
  config: Pick<
    RagConfig,
    | "reference_max_results"
    | "reference_min_score"
    | "max_references"
    | "reference_recursive_depth"
    | "reference_recursive_max_per_article"
  >;
}

/**
 * Why a candidate has its ranking score — used only for logging.
 *
 * - "pinned"    : user-pinned, score is +Inf
 * - "trusted"   : body/user/prior ref, no RAG score, rank is also +Inf
 * - "rag"       : from vector search, score is cosine similarity
 * - "inherited" : recursive ref whose parent seed had a real RAG score
 * - "floor"     : recursive ref whose parent seed was non-RAG (body/user/prior/pinned),
 *                 so score falls back to reference_min_score
 */
type ScoreTag = "pinned" | "trusted" | "rag" | "inherited" | "floor";

interface InternalCandidate {
  entry: ReferenceListEntry;
  source: ReferenceSource;
  /**
   * Composite ranking score. Pinned entries get +Infinity so they sort first
   * and survive the pruning cut unconditionally.
   */
  rankScore: number;
  /** Explains why the rankScore is what it is (log/debug only). */
  scoreTag: ScoreTag;
}

interface RecursiveSeed {
  slug: string;
  score: number;
}

function addRecursiveSeed(
  seeds: RecursiveSeed[],
  seedSeen: Set<string>,
  slug: string,
  score: number,
) {
  const normalized = slugify(slug);
  if (!normalized || seedSeen.has(normalized)) return;
  seedSeen.add(normalized);
  seeds.push({ slug: normalized, score });
}

/**
 * Produce the canonical reference list for an article save.
 *
 * Sources are merged in this order of trust (highest first):
 *   1. user-pinned entries     (always survive, never count toward cap)
 *   2. user-added entries      (always survive, count toward cap)
 *   3. prior-save entries      (preserved by default; can be displaced)
 *   4. RAG sources             (subject to score threshold and cap)
 *
 * Each unique slug appears at most once in the result. The first source to
 * supply a slug wins, so a pinned entry will never be overwritten by a
 * RAG-derived one of the same slug.
 *
 * The slug of every candidate is verified to exist in the `articles` table
 * before inclusion — references must point at real articles.
 */
export function buildReferenceList(
  db: DatabaseSync,
  input: BuildReferenceListInput,
  logger?: Logger,
): ReferenceList {
  const {
    articleSlug,
    ragSources,
    priorReferences = [],
    userAdditions = [],
    blacklistSlugs = [],
    revisionId,
    config,
  } = input;

  // Slugs that are always excluded regardless of source. Self-referencing
  // entries and user-blacklisted ones are rejected before anything else.
  const blacklist = new Set<string>([
    slugify(articleSlug),
    ...blacklistSlugs.map((s) => slugify(s)).filter(Boolean),
  ]);
  // Track which slugs we've already accepted so each appears once.
  const seen = new Set<string>(blacklist);
  const candidates: InternalCandidate[] = [];
  const recursiveSeeds: RecursiveSeed[] = [];
  const recursiveSeedSeen = new Set<string>(blacklist);

  /**
   * Attempt to add a candidate. Skips if the slug self-references, is
   * duplicate, or fails the article-existence check. Pinned entries get
   * +Infinity so they always sort to the top and bypass the score floor.
   */
  const add = (
    candidate: Omit<ReferenceListEntry, "revisionId"> & {
      explicitRevisionId?: ReferenceRevisionId;
    },
    rankScore: number,
    source: InternalCandidate["source"],
    scoreTag: ScoreTag,
  ) => {
    const normalized = slugify(candidate.slug);
    if (!normalized || seen.has(normalized)) return;
    const article = getArticleByLookup(db, normalized);
    if (!article) {
      logger?.debug("references.skip_unknown_slug", {
        article: articleSlug,
        candidate_slug: normalized,
        kind: candidate.kind,
      });
      return;
    }
    seen.add(normalized);
    candidates.push({
      entry: {
        slug: normalized,
        title: candidate.title || article.title,
        content: candidate.content,
        kind: candidate.kind,
        pinned: candidate.pinned,
        revisionId: candidate.explicitRevisionId ?? revisionId,
        score: candidate.score,
        source: candidate.pinned ? "pinned" : source,
      },
      source: candidate.pinned ? "pinned" : source,
      rankScore: candidate.pinned ? Number.POSITIVE_INFINITY : rankScore,
      scoreTag: candidate.pinned ? "pinned" : scoreTag,
    });
  };

  // (1) user-pinned entries — always survive, never count toward the cap.
  let pinnedCount = 0;
  for (const ref of userAdditions) {
    if (ref.pinned) {
      add(
        {
          slug: ref.slug,
          title: ref.title,
          content: ref.content,
          kind: ref.kind,
          pinned: true,
          score: ref.score,
          source: ref.source,
          explicitRevisionId: ref.revisionId,
        },
        Number.POSITIVE_INFINITY,
        "pinned",
        "pinned",
      );
      pinnedCount += 1;
      addRecursiveSeed(recursiveSeeds, recursiveSeedSeen, ref.slug, Number.POSITIVE_INFINITY);
    }
  }

  // (2) non-pinned user-added entries — always survive RAG pruning but
  // they DO count toward max_references.
  for (const ref of userAdditions) {
    if (!ref.pinned) {
      const src = ref.source === "body" ? "body" : "user";
      add(
        {
          slug: ref.slug,
          title: ref.title,
          content: ref.content,
          kind: ref.kind,
          pinned: false,
          score: ref.score,
          source: ref.source,
          explicitRevisionId: ref.revisionId,
        },
        Number.POSITIVE_INFINITY,
        src,
        "trusted",
      );
      addRecursiveSeed(recursiveSeeds, recursiveSeedSeen, ref.slug, Number.POSITIVE_INFINITY);
    }
  }

  // (3) prior-save carry-over — preserve before adding new RAG references.
  // Existing references are part of the article's sidecar state; they should
  // not be displaced just because a refresh found more than reference_max_results
  // new chunks.
  for (const ref of priorReferences) {
    add(
      {
        slug: ref.slug,
        title: ref.title,
        content: ref.content,
        kind: ref.kind,
        pinned: ref.pinned,
        score: ref.score,
        source: ref.source,
        explicitRevisionId: ref.revisionId,
      },
      Number.POSITIVE_INFINITY,
      ref.pinned ? "pinned" : "prior",
      ref.pinned ? "pinned" : "trusted",
    );
    addRecursiveSeed(recursiveSeeds, recursiveSeedSeen, ref.slug, Number.POSITIVE_INFINITY);
  }

  // (4) new RAG sources — apply the reference-specific score floor.
  for (const src of ragSources) {
    const score = src.score ?? 0;
    if (score < config.reference_min_score) continue;
    add(
      {
        slug: src.slug,
        title: src.title,
        content: src.content,
        kind: "chunk",
        pinned: false,
        score,
      },
      score,
      "rag",
      "rag",
    );
    addRecursiveSeed(recursiveSeeds, recursiveSeedSeen, src.slug, score);
  }

  // TODO: logging of traversal. just dump slugs, depth and the source request
  let recursiveCandidateCount = 0;
  let recursiveTraversalCount = 0;
  const recursiveDepth = Math.max(0, Math.floor(config.reference_recursive_depth));
  const recursivePerArticle = Math.max(0, Math.floor(config.reference_recursive_max_per_article));
  let frontier = recursiveSeeds;
  const visitedRecursive = new Set<string>(blacklist);
  for (let depth = 1; depth <= recursiveDepth && recursivePerArticle > 0 && frontier.length > 0; depth += 1) {
    const nextFrontier: RecursiveSeed[] = [];
    for (const seed of frontier) {
      if (visitedRecursive.has(seed.slug)) continue;
      visitedRecursive.add(seed.slug);
      recursiveTraversalCount += 1;
      const sidecarRefs = getLatestArticleReferences(db, seed.slug).slice(0, recursivePerArticle);
      if (sidecarRefs.length === 0) {
        addRecursiveSeed(nextFrontier, recursiveSeedSeen, seed.slug, seed.score);
        continue;
      }
      for (const ref of sidecarRefs) {
        if (blacklist.has(ref.slug)) continue;
        recursiveCandidateCount += 1;
        // Propagate the parent seed's real RAG score when available.
        // If the seed was body/user/prior/pinned its rankScore is +Inf —
        // those aren't vector-ranked, so fall back to reference_min_score
        // (the floor) rather than inflating recursive entries to +Inf.
        const seedHasRagScore = Number.isFinite(seed.score);
        const inheritedScore = seedHasRagScore ? seed.score : config.reference_min_score;
        add(
          {
            slug: ref.slug,
            title: ref.title,
            content: ref.content,
            kind: ref.kind,
            pinned: false,
            score: seedHasRagScore ? seed.score : ref.score,
            source: "recursive",
            explicitRevisionId: ref.revisionId,
          },
          inheritedScore,
          "recursive",
          seedHasRagScore ? "inherited" : "floor",
        );
        addRecursiveSeed(nextFrontier, recursiveSeedSeen, ref.slug, inheritedScore);
      }
    }
    frontier = nextFrontier;
  }

  // Apply caps:
  //   - pinned entries are FREE (never count toward any cap).
  //   - carried entries (user-added, body-linked, prior-save, recursive) are
  //     capped only by max_references — they are never squeezed out by the
  //     RAG budget.
  //   - rag entries are capped first by reference_max_results (the per-build
  //     budget for newly-discovered vector-search results), then by whatever
  //     remains of max_references after carried entries are placed.
  //
  // reference_max_results strictly limits direct RAG additions only.
  const pinned = candidates.filter((c) => c.entry.pinned);
  const carried = candidates.filter((c) => !c.entry.pinned && c.source !== "rag");
  const rag = candidates
    .filter((c) => !c.entry.pinned && c.source === "rag")
    .sort((a, b) => b.rankScore - a.rankScore);
  const keptCarried = carried.slice(0, Math.max(0, config.max_references));
  const ragBudget = Math.min(
    config.reference_max_results,
    Math.max(0, config.max_references - keptCarried.length),
  );
  const kept = [...pinned, ...keptCarried, ...rag.slice(0, ragBudget)];

  // Format each kept entry as: slug[source:score-annotation]
  // Score annotations:
  //   (no annotation)   — body/user/prior: trusted, not vector-ranked
  //   pinned            — user-pinned, always included
  //   rag:0.656         — cosine similarity from vector search
  //   recursive:0.598   — inherited from a RAG-scored parent seed
  //   recursive:floor   — parent seed was body/user/prior (not vector-ranked)
  const formatEntry = (c: InternalCandidate): string => {
    switch (c.scoreTag) {
      case "pinned":    return `${c.entry.slug}[pinned]`;
      case "trusted":   return `${c.entry.slug}[${c.source}]`;
      case "rag":       return `${c.entry.slug}[rag:${(c.entry.score ?? 0).toFixed(3)}]`;
      case "inherited": return `${c.entry.slug}[recursive:${(c.entry.score ?? 0).toFixed(3)}]`;
      case "floor":     return `${c.entry.slug}[recursive:floor]`;
    }
  };

  logger?.info("references.built", {
    article: articleSlug,
    rag_sources: ragSources.length,
    prior: priorReferences.length,
    body: userAdditions.filter((ref) => ref.source === "body").length,
    user: userAdditions.filter((ref) => ref.source !== "body").length,
    pinned: pinnedCount,
    recursive_candidates: recursiveCandidateCount,
    recursive_traversed: recursiveTraversalCount,
    recursive_max_per_article: config.reference_recursive_max_per_article,
    blacklisted: blacklistSlugs.length,
    kept: kept.length,
    dropped: candidates.length - kept.length,
    score_floor: config.reference_min_score,
    cap: config.max_references,
    rag_cap: config.reference_max_results,
    refs: kept.map(formatEntry).join(", ") || "(none)",
  });

  return kept.map((c) => c.entry);
}

// Import here rather than at top-level to avoid circular dep
// (referenceList ← index.ts ← markdown.ts would be circular).
import { buildHaluLink, normalizeHaluLinks } from "./markdown";
import { titleToWikiSegment } from "./slug";
import { parseMarkdownLinks } from "./text/markdownLinkParser";

/**
 * Render the reference list as an HTML `<section>` with numbered items and
 * anchor IDs for in-page navigation.
 *
 * Returns empty string when the list is empty.
 */
export function renderReferencesHtml(refs: ReferenceList): string {
  if (refs.length === 0) return "";
  const items = refs
    .map((entry, i) => {
      const n = i + 1;
      const wikiPath = `/wiki/${titleToWikiSegment(entry.title)}`;
      return `<li id="ref-${n}"><a href="${wikiPath}">${entry.title}</a></li>`;
    })
    .join("");
  return `<section class="article-references"><h2>References</h2><ol>${items}</ol></section>`;
}

/**
 * Convenience: hydrate the previously-persisted reference list for an
 * article. Returns `undefined` if no rows exist so callers can distinguish
 * "no prior save" from "prior save with zero references".
 */
export function loadPriorReferenceList(
  db: DatabaseSync,
  articleSlug: string,
): ReferenceList | undefined {
  const rows = getLatestArticleReferences(db, articleSlug);
  return rows.length > 0 ? rows : undefined;
}

/**
 * Pure helper: return true when the given top-level section title belongs
 * to algorithmically-rendered metadata that link repair MUST skip.
 */
export function isMetadataSection(heading: string): boolean {
  const normalized = heading.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized === "references" || normalized === "see also";
}

/**
 * Format a reference list for prompts. The canonical citation form is
 * `ref:slug` — the slug is shown first so the model can copy it directly
 * into `[text](ref:slug)` without having to track ordinal numbers.
 * A 1-based index is kept in parentheses for backwards compatibility:
 * `ref:N` still resolves (see `resolveReferenceTarget`) but is no longer
 * the recommended form.
 *
 * Returns "(none)" when the list is empty.
 */
export function formatReferencesForPrompt(refs: ReferenceList): string {
  if (refs.length === 0) return "(none)";
  return refs
    .map((r) => `- [${r.title}](ref:${r.slug})`)
    .join("\n");
}

/**
 * Richer JSON format for article-generation prompts.
 * Includes the ref:slug link shorthand, pinned flag, and available content
 * (summary or chunk) so the LLM has factual grounding for each reference.
 *
 * contentMinScore: only include content for refs whose score meets this
 * threshold (or whose score is absent, meaning they were body/user/prior
 * linked rather than RAG-ranked). Pinned refs always get content regardless.
 */
export function formatReferencesForPromptJson(refs: ReferenceList, contentMinScore = 0.0, contentTopK = 0): string {
  if (refs.length === 0) return "[]";

  // Determine which non-pinned refs earn content inclusion by score, then
  // cap to the top-K highest scorers (0 = no cap).
  const eligible = refs
    .filter((r) => !r.pinned && (r.score === undefined || r.score >= contentMinScore))
    .sort((a, b) => (b.score ?? 1) - (a.score ?? 1));
  const cappedEligible = contentTopK > 0 ? eligible.slice(0, contentTopK) : eligible;
  const withContent = new Set(cappedEligible.map((r) => r.slug));

  const entries = refs.map((r) => ({
    reflink: `[${r.title}](ref:${r.slug})`,
    slug: r.slug,
    pinned: r.pinned,
    content: (r.pinned || withContent.has(r.slug)) ? (r.content || null) : null,
  }));
  return JSON.stringify(entries, null, 2);
}

/**
 * Resolve `ref:N` link shorthand in article body markdown into durable
 * slug-addressed reference links.
 *
 * The LLM may emit `[text](ref:1)`, `[text](ref:some-slug)`, or the empty
 * bracket form `[](ref:some-slug)`. All three are handled:
 *   - If the target resolves to a sidecar ref, use the ref title for empty brackets.
 *   - If the target does NOT resolve (sidecar list empty or slug not in list),
 *     empty brackets are still filled with the slug-derived title so `[]` never
 *     appears in rendered output.
 *   - Duplicate occurrences of the same slug collapse to plain text.
 */
export function resolveRefLinks(body: string, refs: ReferenceList): string {
  if (!body.includes("ref:")) return body;
  const seen = new Set<string>();
  const parsed = parseMarkdownLinks(body).links.filter((link) => link.kind === "ref");
  if (parsed.length === 0) return body;
  let output = "";
  let cursor = 0;
  for (const link of parsed) {
    const visibleText = link.label.trim();
    const ref = resolveReferenceTarget(link.slug ?? link.target, refs);
    let replacement = link.raw;
    if (!ref) {
      // Ref not in sidecar list. Fill empty brackets with a slug-derived title
      // so the link is never rendered as a bare [].
      if (!visibleText) {
        const derivedTitle = slugToTitle(slugify(link.slug ?? link.target.trim()));
        replacement = `[${derivedTitle}](ref:${link.target.trim()})`;
      }
    } else {
      const label = visibleText || ref.title;
      // First occurrence: anchor link. Subsequent occurrences: plain text only,
      // with inline formatting stripped so bold/italic from the link label doesn't
      // bleed into plain-text repetitions.
      if (seen.has(ref.slug)) replacement = label.replace(/\*\*?|__?|~~|`/g, "");
      else {
        seen.add(ref.slug);
        replacement = `[${label}](ref:${ref.slug})`;
      }
    }
    output += body.slice(cursor, link.start);
    output += replacement;
    cursor = link.end;
  }
  output += body.slice(cursor);
  return output;
}

export function resolveReferenceTarget(
  target: string,
  refs: ReferenceList,
): ReferenceListEntry | undefined {
  const trimmed = target.trim();
  const num = parseInt(trimmed, 10);
  if (!Number.isNaN(num) && String(num) === trimmed && num >= 1 && num <= refs.length) {
    return refs[num - 1];
  }
  const normalized = slugify(trimmed);
  return refs.find((r) => r.slug === normalized);
}

export function collectReferenceLinkSlugs(body: string): Set<string> {
  const slugs = new Set<string>();
  if (!body.includes("ref:")) return slugs;
  for (const link of parseMarkdownLinks(body).links) {
    if (link.kind !== "ref") continue;
    const slug = slugify(link.slug ?? link.target);
    if (slug) slugs.add(slug);
  }
  return slugs;
}

function markdownProtectedRanges(body: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const linkPattern = /\[[^\]]*]\([^)]+\)/g;
  const codePattern = /`[^`]*`/g;
  for (const pattern of [linkPattern, codePattern]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

function isInsideRange(index: number, ranges: Array<{ start: number; end: number }>) {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function titleMentionPattern(title: string): RegExp | null {
  const tokens = title.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped.join("\\s+")}(?![\\p{L}\\p{N}])`, "giu");
}

/**
 * Ensure every reference that is visibly mentioned by exact title text has an
 * inline ref:slug link. This is deliberately bounded deterministic repair:
 * no fuzzy matching, no LLM, no edits inside existing markdown links/code.
 */
export function linkMentionedReferencesInBody(
  body: string,
  refs: ReferenceList,
): string {
  if (refs.length === 0) return body;
  let nextBody = body;
  let linked = collectReferenceLinkSlugs(nextBody);

  for (const ref of refs) {
    if (linked.has(ref.slug)) continue;
    const pattern = titleMentionPattern(ref.title);
    if (!pattern) continue;
    const protectedRanges = markdownProtectedRanges(nextBody);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(nextBody)) !== null) {
      if (isInsideRange(match.index, protectedRanges)) continue;
      const visible = match[0];
      nextBody =
        nextBody.slice(0, match.index) +
        `[${visible}](ref:${ref.slug})` +
        nextBody.slice(match.index + visible.length);
      linked = collectReferenceLinkSlugs(nextBody);
      break;
    }
  }

  return nextBody;
}

/**
 * Scan body markdown for syntactically valid halu links whose target already
 * exists. Those links are references, not new hallucinated links, so save
 * flows add them to the reference sidecar and convert the body link to
 * `ref:slug`.
 */
export function findExistingArticleLinkReferences(
  db: DatabaseSync,
  body: string,
  selfSlug: string,
): ReferenceList {
  const normalizedSelf = slugify(selfSlug);
  const seen = new Set<string>();
  const refs: ReferenceList = [];
  const normalizedBody = normalizeHaluLinks(body);
  for (const link of parseMarkdownLinks(normalizedBody).links) {
    if (link.kind !== "halu") continue;
    const slug = slugify(link.slug ?? link.target);
    if (!slug || slug === normalizedSelf || seen.has(slug)) continue;
    const article = getArticleByLookup(db, slug);
    if (!article) continue;
    seen.add(article.slug);
    refs.push({
      slug: article.slug,
      title: article.title,
      content: article.summaryMarkdown ?? "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
      source: "body",
    });
  }
  return refs;
}

function articleToReferenceEntry(
  article: ReturnType<typeof getArticleByLookup>,
): ReferenceListEntry | null {
  if (!article) return null;
  return {
    slug: article.slug,
    title: article.title,
    content: article.summaryMarkdown ?? "",
    kind: "summary",
    pinned: false,
    revisionId: "current",
    source: "body",
  };
}

function normalizeMentionText(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mentionTitleIsSpecific(title: string): boolean {
  const normalized = normalizeMentionText(title);
  return normalized.length >= 12 && normalized.split(" ").length >= 2;
}

/**
 * Find existing articles whose exact title is mentioned as plain body text.
 * This is deliberately not fuzzy: punctuation and whitespace may differ, but
 * the normalized title token sequence must appear in full.
 */
export function findTitleMentionedArticles(
  db: DatabaseSync,
  body: string,
  selfSlug: string,
): ReferenceList {
  const normalizedSelf = slugify(selfSlug);
  const normalizedBody = ` ${normalizeMentionText(body)} `;
  if (!normalizedBody.trim()) return [];

  const rows = db
    .prepare(
      `SELECT slug,
              title,
              summary_markdown AS summaryMarkdown
       FROM articles
       WHERE is_disambiguation = 0`
    )
    .all() as Array<{ slug: string; title: string; summaryMarkdown: string }>;

  const refs: ReferenceList = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const slug = slugify(row.slug);
    if (!slug || slug === normalizedSelf || seen.has(slug)) continue;
    if (!mentionTitleIsSpecific(row.title)) continue;
    const normalizedTitle = normalizeMentionText(row.title);
    if (!normalizedTitle || !normalizedBody.includes(` ${normalizedTitle} `)) continue;
    seen.add(slug);
    refs.push({
      slug,
      title: row.title,
      content: row.summaryMarkdown ?? "",
      kind: "summary",
      pinned: false,
      revisionId: "current",
      source: "body",
    });
  }
  return refs;
}

/**
 * Find all article references that are actually used by body markdown:
 * durable `ref:slug` links plus `halu:` links that already point at stored
 * articles, plus exact title mentions. This is read-only and does not invoke
 * retrieval or an LLM.
 */
export function findBodyReferencedArticles(
  db: DatabaseSync,
  body: string,
  selfSlug: string,
): ReferenceList {
  const normalizedSelf = slugify(selfSlug);
  const bySlug = new Map<string, ReferenceListEntry>();

  for (const ref of findExistingArticleLinkReferences(db, body, selfSlug)) {
    bySlug.set(ref.slug, ref);
  }

  for (const ref of findTitleMentionedArticles(db, body, selfSlug)) {
    bySlug.set(ref.slug, ref);
  }

  if (body.includes("ref:")) {
    for (const link of parseMarkdownLinks(body).links) {
      if (link.kind !== "ref") continue;
      const slug = slugify(link.slug ?? link.target);
      if (!slug || slug === normalizedSelf || bySlug.has(slug)) continue;
      const ref = articleToReferenceEntry(getArticleByLookup(db, slug));
      if (ref) bySlug.set(ref.slug, ref);
    }
  }

  return Array.from(bySlug.values());
}

/**
 * Extract ref:slug links from body markdown as ParsedInternalLink entries.
 *
 * After convertExistingArticleLinksToRefs runs, halu links to existing
 * articles become ref: links. extractInternalLinks (halu-only) would miss
 * them, so callers that write to article_links for backlink tracking must
 * also call this function and combine the results.
 *
 * visible_label = the link's bracket text (or the article's title if empty)
 * hidden_hint   = the target article's summary_markdown, used as RAG context
 *                 by listIncomingHints when generating articles that are
 *                 linked-to by this article.
 */
export function extractRefLinksAsInternalLinks(
  db: DatabaseSync,
  body: string,
  selfSlug: string,
): ParsedInternalLink[] {
  if (!body.includes("ref:")) return [];
  const normalizedSelf = slugify(selfSlug);
  const seen = new Set<string>();
  const links: ParsedInternalLink[] = [];
  for (const link of parseMarkdownLinks(body).links) {
    if (link.kind !== "ref") continue;
    const slug = slugify(link.slug ?? link.target);
    if (!slug || slug === normalizedSelf || seen.has(slug)) continue;
    seen.add(slug);
    const article = getArticleByLookup(db, slug);
    if (!article) continue;
    links.push({
      targetSlug: article.slug,
      visibleLabel: link.label.trim() || article.title,
      hiddenHint: article.summaryMarkdown ?? "",
    });
  }
  return links;
}

/**
 * Convert valid halu links to existing database articles into durable
 * reference links. Non-existing halu targets remain halu links so they can
 * continue to act as new article seeds.
 */
export function convertExistingArticleLinksToRefs(
  db: DatabaseSync,
  body: string,
  selfSlug: string,
): string {
  const normalizedSelf = slugify(selfSlug);
  const normalizedBody = normalizeHaluLinks(body);
  const parsed = parseMarkdownLinks(normalizedBody).links.filter((link) => link.kind === "halu");
  if (parsed.length === 0) return normalizedBody;
  let output = "";
  let cursor = 0;
  for (const link of parsed) {
    const slug = slugify(link.slug ?? link.target);
    let replacement = link.raw;
    if (slug && slug !== normalizedSelf) {
      const article = getArticleByLookup(db, slug);
      replacement = article
        ? `[${link.label.trim() || article.title}](ref:${article.slug})`
        : buildHaluLink(link.label, slug, link.hint ?? "");
    }
    output += normalizedBody.slice(cursor, link.start);
    output += replacement;
    cursor = link.end;
  }
  output += normalizedBody.slice(cursor);
  return output;
}
