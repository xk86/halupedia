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
  RagConfig,
  ParsedInternalLink,
} from "./types";
import type { RetrievedSourceArticle } from "./retrieval";
import { getArticleByLookup, getLatestArticleReferences } from "./db";
import { slugify } from "./slug";

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
    "reference_max_results" | "reference_min_score" | "max_references"
  >;
}

interface InternalCandidate {
  entry: ReferenceListEntry;
  /**
   * Composite ranking score. Pinned entries get +Infinity so they sort first
   * and survive the pruning cut unconditionally.
   */
  rankScore: number;
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
      },
      rankScore: candidate.pinned ? Number.POSITIVE_INFINITY : rankScore,
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
          explicitRevisionId: ref.revisionId,
        },
        Number.POSITIVE_INFINITY,
      );
      pinnedCount += 1;
    }
  }

  // (2) non-pinned user-added entries — always survive ranking pruning but
  // they DO count toward max_references.
  for (const ref of userAdditions) {
    if (!ref.pinned) {
      add(
        {
          slug: ref.slug,
          title: ref.title,
          content: ref.content,
          kind: ref.kind,
          pinned: false,
          score: ref.score,
          explicitRevisionId: ref.revisionId,
        },
        Number.POSITIVE_INFINITY,
      );
    }
  }

  // (3) prior-save carry-over — preserve unless displaced by the cap.
  // We score them slightly above the relevancy threshold so they outrank
  // weak RAG matches but lose to strong new ones.
  for (const ref of priorReferences) {
    add(
      {
        slug: ref.slug,
        title: ref.title,
        content: ref.content,
        kind: ref.kind,
        pinned: ref.pinned,
        score: ref.score,
        explicitRevisionId: ref.revisionId,
      },
      ref.pinned ? Number.POSITIVE_INFINITY : config.reference_min_score + 0.01,
    );
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
    );
  }

  // Stable sort by rankScore desc. Pinned entries (+Infinity) come first.
  candidates.sort((a, b) => b.rankScore - a.rankScore);

  // Apply caps: pinned entries are FREE (don't count toward cap); the rest
  // of the list is clamped to reference_max_results AND max_references.
  const pinned = candidates.filter((c) => c.entry.pinned);
  const nonPinned = candidates.filter((c) => !c.entry.pinned);
  const nonPinnedCap = Math.min(
    config.reference_max_results,
    Math.max(0, config.max_references - pinned.length),
  );
  const kept = [...pinned, ...nonPinned.slice(0, nonPinnedCap)];

  logger?.info("references.built", {
    article: articleSlug,
    rag_input_count: ragSources.length,
    prior_count: priorReferences.length,
    user_added_count: userAdditions.length,
    pinned_count: pinnedCount,
    blacklist_count: blacklistSlugs.length,
    candidates: candidates.length,
    kept: kept.length,
    dropped: candidates.length - kept.length,
    score_floor: config.reference_min_score,
    cap_total: config.max_references,
    cap_per_build: config.reference_max_results,
  });
  logger?.debug("references.built_detail", {
    article: articleSlug,
    entries: JSON.stringify(
      kept.map((c) => ({
        slug: c.entry.slug,
        kind: c.entry.kind,
        pinned: c.entry.pinned,
        score: c.entry.score,
        revision: c.entry.revisionId,
      })),
    ),
  });

  return kept.map((c) => c.entry);
}

// Import here rather than at top-level to avoid circular dep
// (referenceList ← index.ts ← markdown.ts would be circular).
import { buildHaluLink, LINK_RE, normalizeHaluLinks } from "./markdown";
import { titleToWikiSegment } from "./slug";

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
    .map((r, i) => `- ref:${r.slug} → ${r.title}  (also reachable as ref:${i + 1})`)
    .join("\n");
}

// Matches [text](ref:n) or [](ref:n) where n is a number or slug.
const REF_LINK_RE = /\[([^\]]*)\]\(ref:([^)]+)\)/g;

/**
 * Resolve `ref:N` link shorthand in article body markdown into durable
 * slug-addressed reference links.
 *
 * The LLM may emit `[text](ref:1)` (by index) or `[](ref:some-slug)`.
 * At parse time we also tolerate slugs in the N position for robustness.
 * Result is a well-formed `ref:slug` link using the resolved reference.
 *
 * Must run on body-only markdown before sidecar references are rendered.
 * Unknown/out-of-range ref targets are left as-is so they surface during QA.
 */
export function resolveRefLinks(body: string, refs: ReferenceList): string {
  if (refs.length === 0 || !body.includes("ref:")) return body;
  const seen = new Set<string>();
  return body.replace(REF_LINK_RE, (match, _visibleText: string, target: string) => {
    const ref = resolveReferenceTarget(target, refs);
    if (!ref) return match;
    const label = _visibleText.trim() || ref.title;
    // First occurrence: link with the bracket text (or title if empty).
    // Subsequent occurrences: plain text only — no duplicate links per article.
    if (seen.has(ref.slug)) return label;
    seen.add(ref.slug);
    return `[${label}](ref:${ref.slug})`;
  });
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
  const pattern = new RegExp(LINK_RE.source, LINK_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalizedBody)) !== null) {
    const slug = slugify(match[2]);
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
  };
}

/**
 * Find all article references that are actually used by body markdown:
 * durable `ref:slug` links plus `halu:` links that already point at stored
 * articles. This is read-only and does not invoke retrieval or an LLM.
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

  if (body.includes("ref:")) {
    let match: RegExpExecArray | null;
    const pattern = new RegExp(REF_LINK_RE.source, REF_LINK_RE.flags);
    while ((match = pattern.exec(body)) !== null) {
      const slug = slugify(match[2]);
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
  const pattern = new RegExp(REF_LINK_RE.source, REF_LINK_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    const slug = slugify(m[2]);
    if (!slug || slug === normalizedSelf || seen.has(slug)) continue;
    seen.add(slug);
    const article = getArticleByLookup(db, slug);
    if (!article) continue;
    links.push({
      targetSlug: article.slug,
      visibleLabel: m[1].trim() || article.title,
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
  return normalizeHaluLinks(body).replace(
    LINK_RE,
    (match, visibleLabel: string, rawSlug: string, hint: string) => {
      const slug = slugify(rawSlug);
      if (!slug || slug === normalizedSelf) return match;
      const article = getArticleByLookup(db, slug);
      if (!article) return buildHaluLink(visibleLabel, slug, hint ?? "");
      return `[${visibleLabel.trim() || article.title}](ref:${article.slug})`;
    },
  );
}
