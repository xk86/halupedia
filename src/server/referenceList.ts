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
import { stripLeadingTitleEcho } from "./retrieval";
import {
  getArticleByEquivalentLookup,
  getArticleByLookup,
  getArticleByTitle,
  getLatestArticleReferences,
  listArticleBlacklistSlugs,
  listWrittenBacklinks,
} from "./db";
import { legacySlugify, slugify, slugToTitle } from "./slug";

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
    | "reference_cull_min_score"
    | "reference_cull_top_k"
  > & {
    /**
     * Hard cap on the total number of recursively-discovered articles
     * admitted to the list, ranked by score. Optional here (defaults to
     * uncapped) so callers/tests that don't exercise recursion aren't forced
     * to set it; production config always supplies it.
     */
    reference_recursive_article_limit?: number;
  };
}

/**
 * Why a candidate has its ranking score — used only for logging.
 *
 * - "pinned"    : user-pinned, score is +Inf
 * - "trusted"   : body/user ref the user supplied this build, rank is +Inf
 * - "prior"     : carried-over ref from a previous save — reranked by its
 *                 stored score (or the floor when it never had one) and
 *                 discardable, NOT trusted
 * - "rag"       : from vector search, score is cosine similarity
 * - "inherited" : recursive ref whose parent seed had a real RAG score
 * - "floor"     : recursive ref whose parent seed was non-RAG (body/user/pinned),
 *                 so score falls back to reference_min_score
 */
type ScoreTag = "pinned" | "trusted" | "prior" | "rag" | "inherited" | "floor";

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
 *   2. user-added entries      (added THIS build; always survive, count toward cap)
 *   3. prior-save entries      (RERANKED by score; discardable unless pinned)
 *   4. RAG sources             (subject to score threshold and cap)
 *
 * Only pinned entries and references the user supplied for THIS build survive
 * unconditionally. Prior-save entries — including ones a user added by hand in
 * an earlier run — are reranked alongside RAG results and can be displaced or
 * culled, so the reference list does not silently accrete stale entries.
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
  // The persisted blacklist is merged in here so every reference-list build
  // (generation, refresh, rewrite, post-process) honors blocks the user made
  // in earlier sessions, not just the ones sent with this request.
  const blacklist = new Set<string>([
    slugify(articleSlug),
    ...blacklistSlugs.map((s) => slugify(s)).filter(Boolean),
    ...listArticleBlacklistSlugs(db, slugify(articleSlug)),
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

  // (3) prior-save carry-over — RERANKED, not preserved unconditionally.
  // A prior reference is not trusted just because it survived an earlier build.
  // Only pinned priors bypass ranking; every other prior competes on its stored
  // score (or the reference_min_score floor when it never had one — e.g. an old
  // hand-added ref) and can be displaced or culled exactly like a RAG result.
  // This is what lets a ref the user added by hand in a previous run get
  // reranked and potentially discarded unless they pin it. Refs the user added
  // THIS build arrive via userAdditions above and are deduped out here.
  for (const ref of priorReferences) {
    const hasScore = typeof ref.score === "number" && Number.isFinite(ref.score);
    const rankScore = ref.pinned
      ? Number.POSITIVE_INFINITY
      : hasScore
        ? (ref.score as number)
        : config.reference_min_score;
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
      rankScore,
      ref.pinned ? "pinned" : "prior",
      ref.pinned ? "pinned" : "prior",
    );
    addRecursiveSeed(recursiveSeeds, recursiveSeedSeen, ref.slug, rankScore);
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
  let backlinkCandidateCount = 0;
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

      // A recursive candidate's relevance is derived from the PARENT seed,
      // never from the child's own stored score (that score measures the
      // child's relevance to a different article, not to this one — using it
      // let a recursive entry surface with an unrelated 1.000). When the
      // parent has a real score (RAG, or a reranked prior) the child inherits
      // it; when the parent is a trusted non-vector seed (body/user/pinned,
      // rankScore +Inf) the child falls to the reference_min_score floor
      // rather than being inflated to +Inf. Applies identically regardless of
      // which graph direction (forward reference vs. backlink) surfaced it.
      const seedHasRagScore = Number.isFinite(seed.score);
      const inheritedScore = seedHasRagScore ? seed.score : config.reference_min_score;
      const scoreTag: ScoreTag = seedHasRagScore ? "inherited" : "floor";

      // Forward direction: articles this seed's own reference sidecar points at.
      const sidecarRefs = getLatestArticleReferences(db, seed.slug).slice(0, recursivePerArticle);
      for (const ref of sidecarRefs) {
        if (blacklist.has(ref.slug)) continue;
        recursiveCandidateCount += 1;
        add(
          {
            slug: ref.slug,
            title: ref.title,
            content: ref.content,
            kind: ref.kind,
            pinned: false,
            score: inheritedScore,
            source: "recursive",
            explicitRevisionId: ref.revisionId,
          },
          inheritedScore,
          "recursive",
          scoreTag,
        );
        addRecursiveSeed(nextFrontier, recursiveSeedSeen, ref.slug, inheritedScore);
      }

      // Backward direction: written articles that link TO this seed. Lets an
      // admitted article surface neighbours discovered because THEY reference
      // it, not just what it references — e.g. a well-known article backlinked
      // by many others still enters context even if its own sidecar is thin.
      const backlinks = listWrittenBacklinks(db, seed.slug, recursivePerArticle);
      for (const link of backlinks) {
        const linkSlug = slugify(link.slug);
        if (!linkSlug || blacklist.has(linkSlug)) continue;
        backlinkCandidateCount += 1;
        add(
          {
            slug: linkSlug,
            title: link.title,
            content: link.summaryMarkdown,
            kind: "summary",
            pinned: false,
            score: inheritedScore,
            source: "backlink",
            explicitRevisionId: "current",
          },
          inheritedScore,
          "backlink",
          scoreTag,
        );
        addRecursiveSeed(nextFrontier, recursiveSeedSeen, linkSlug, inheritedScore);
      }

      if (sidecarRefs.length === 0 && backlinks.length === 0) {
        addRecursiveSeed(nextFrontier, recursiveSeedSeen, seed.slug, seed.score);
      }
    }
    frontier = nextFrontier;
  }

  // Dedicated recursive-article cap: independent of reference_cull_top_k
  // (which also covers fresh RAG hits and reranked priors) and separate from
  // reference_recursive_max_per_article (which only bounds per-parent fan-out
  // DURING traversal, not the total admitted afterward). Covers both graph
  // directions — forward ("recursive") and backward ("backlink") — as one
  // combined admitted-article budget. Rank every recursively-discovered
  // candidate by its rankScore (descending, stable slug tie-break — this is
  // the "sort by relevance, cut by count" behavior: relevance determines
  // order, the configured limit determines the cutoff) and drop the tail
  // before it ever competes in the cull/count-cap stages below.
  let recursiveCapDropped = 0;
  const isRecursiveSource = (source: ReferenceSource) => source === "recursive" || source === "backlink";
  const recursiveArticleLimit = config.reference_recursive_article_limit;
  if (typeof recursiveArticleLimit === "number" && Number.isFinite(recursiveArticleLimit)) {
    const limit = Math.max(0, Math.floor(recursiveArticleLimit));
    const recursiveCandidates = candidates.filter((c) => isRecursiveSource(c.source));
    if (recursiveCandidates.length > limit) {
      const ranked = [...recursiveCandidates].sort(
        (a, b) => b.rankScore - a.rankScore || a.entry.slug.localeCompare(b.entry.slug),
      );
      const keepSlugs = new Set(ranked.slice(0, limit).map((c) => c.entry.slug));
      recursiveCapDropped = recursiveCandidates.length - keepSlugs.size;
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const c = candidates[i];
        if (isRecursiveSource(c.source) && !keepSlugs.has(c.entry.slug)) candidates.splice(i, 1);
      }
    }
  }

  // Cull stage: applied across the fully-assembled candidate pool before the
  // count caps below. Exempt sources are pinned, user-added, and body-linked
  // (source "user" or "body") — these are explicit human choices and immune.
  // Everything else (rag, recursive, prior carryover) is cull-eligible:
  //   1. Drop any cull-eligible candidate below reference_cull_min_score.
  //   2. Keep only the top reference_cull_top_k by rankScore (0 = no top-k cut).
  // This prevents deep recursive fan-out and stale prior carryover from
  // inflating the list with low-relevance entries.
  const cullExemptSources = new Set(["user", "body"]);
  const cullMinScore = config.reference_cull_min_score;
  const cullTopK = Math.max(0, Math.floor(config.reference_cull_top_k));
  const afterCull: InternalCandidate[] = [];
  const cullEligible: InternalCandidate[] = [];
  for (const c of candidates) {
    if (c.entry.pinned || cullExemptSources.has(c.source)) {
      afterCull.push(c);
    } else {
      cullEligible.push(c);
    }
  }
  const scorePassed = cullEligible.filter((c) => c.rankScore >= cullMinScore);
  scorePassed.sort((a, b) => b.rankScore - a.rankScore);
  const topKPassed = cullTopK > 0 ? scorePassed.slice(0, cullTopK) : scorePassed;
  const cullDropped = candidates.length - afterCull.length - topKPassed.length;
  afterCull.push(...topKPassed);

  // Apply count caps to the culled pool:
  //   - pinned entries are FREE (never count toward any cap).
  //   - user/body refs supplied for THIS build, plus recursive/backlink refs
  //     (already vetted by the cull stage), are carried — capped only by
  //     max_references and never squeezed out by the score budget.
  //   - rag results AND reranked prior refs share the score budget: they are
  //     ranked together by score and only the top reference_max_results (within
  //     whatever remains of max_references) survive. A prior is kept only if it
  //     out-scores the RAG competition; otherwise it is discarded.
  //
  // reference_max_results limits the combined score-ranked pool (fresh RAG +
  // reranked priors), so stale priors can no longer accrete past the budget.
  const pinned = afterCull.filter((c) => c.entry.pinned);
  const carried = afterCull.filter(
    (c) => !c.entry.pinned && (c.source === "user" || c.source === "body" || isRecursiveSource(c.source)),
  );
  const scored = afterCull
    .filter((c) => !c.entry.pinned && (c.source === "rag" || c.source === "prior"))
    .sort((a, b) => b.rankScore - a.rankScore);
  const keptCarried = carried.slice(0, Math.max(0, config.max_references));
  const scoreBudget = Math.min(
    config.reference_max_results,
    Math.max(0, config.max_references - keptCarried.length),
  );
  const kept = [...pinned, ...keptCarried, ...scored.slice(0, scoreBudget)];

  // Format each kept entry as: slug[source:score-annotation]
  // Score annotations:
  //   (no annotation)   — body/user: trusted this build, not vector-ranked
  //   pinned            — user-pinned, always included
  //   prior:0.642       — carried-over ref, reranked on its stored score
  //   prior:floor       — carried-over ref with no stored score (floor-ranked)
  //   rag:0.656         — cosine similarity from vector search
  //   recursive:0.598   — forward sidecar ref, inherited from a RAG-scored parent
  //   recursive:floor   — forward sidecar ref, parent was body/user/pinned
  //   backlink:0.598    — backward graph edge, inherited from a RAG-scored parent
  //   backlink:floor    — backward graph edge, parent was body/user/pinned
  const formatEntry = (c: InternalCandidate): string => {
    switch (c.scoreTag) {
      case "pinned":    return `${c.entry.slug}[pinned]`;
      case "trusted":   return `${c.entry.slug}[${c.source}]`;
      case "prior":     return `${c.entry.slug}[prior:${c.entry.score !== undefined ? c.entry.score.toFixed(3) : "floor"}]`;
      case "rag":       return `${c.entry.slug}[rag:${(c.entry.score ?? 0).toFixed(3)}]`;
      case "inherited": return `${c.entry.slug}[${c.source}:${(c.entry.score ?? 0).toFixed(3)}]`;
      case "floor":     return `${c.entry.slug}[${c.source}:floor]`;
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
    backlink_candidates: backlinkCandidateCount,
    recursive_traversed: recursiveTraversalCount,
    recursive_max_per_article: config.reference_recursive_max_per_article,
    recursive_article_limit: config.reference_recursive_article_limit,
    recursive_cap_dropped: recursiveCapDropped,
    blacklisted: blacklistSlugs.length,
    cull_dropped: cullDropped,
    cull_min_score: cullMinScore,
    cull_top_k: cullTopK,
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
import { buildHaluLink, cleanLinkLabels, extractInternalLinks, normalizeHaluLinks, stripSelfLinks } from "./markdown";
import { titleToWikiSegment } from "./slug";
import { parseMarkdownLinks } from "./text/markdownLinkParser";
import { normalizeMarkdownLinks } from "./text/linkNormalize";

/**
 * Render the reference list as an HTML `<section>` with numbered items and
 * anchor IDs for in-page navigation.
 *
 * Returns empty string when the list is empty.
 */
export function renderReferencesHtml(refs: ReferenceList): string {
  if (refs.length === 0) return "";

  // Linked refs (actually cited in body via ref:slug) are numbered footnotes.
  // Unlinked refs (provided to the LLM but not cited) are shown in grey parens
  // at the bottom so readers know what context was available.
  const linked = refs.filter((r) => r.linked !== false);
  const unlinked = refs.filter((r) => r.linked === false && !r.pinned);
  // Pinned refs always appear in the linked list even if not cited.
  const pinnedUnlinked = refs.filter((r) => r.linked === false && r.pinned);
  const allLinked = [...linked, ...pinnedUnlinked];

  let html = "";
  if (allLinked.length > 0) {
    const items = allLinked
      .map((entry, i) => {
        const n = i + 1;
        const wikiPath = `/wiki/${titleToWikiSegment(entry.title)}`;
        return `<li id="ref-${n}"><a href="${wikiPath}">${entry.title}</a></li>`;
      })
      .join("");
    html += `<section class="article-references"><h2>References</h2><ol>${items}</ol></section>`;
  }
  if (unlinked.length > 0) {
    const items = unlinked
      .map((entry) => {
        const wikiPath = `/wiki/${titleToWikiSegment(entry.title)}`;
        return `<span class="ref-context"><a href="${wikiPath}">${entry.title}</a></span>`;
      })
      .join("");
    html += `<section class="article-references-context">${items}</section>`;
  }
  return html;
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
 * Format references for article-generation prompts.
 *
 * Produces two clearly separated sections: pinned refs (which the model
 * should prioritize linking to) and additional refs (contextual, use if
 * relevant). The model is NOT required to cite all refs or declare which
 * ones it used — it simply links via [text](ref:slug).
 *
 * Content (summary/chunk) is included for refs meeting the score threshold
 * so the model has factual grounding. Pinned refs always include content.
 */
export function formatReferencesForPromptText(refs: ReferenceList, contentMinScore = 0.0, contentTopK = 0): string {
  if (refs.length === 0) return "(none)";

  const pinnedRefs = refs.filter((r) => r.pinned);
  const otherRefs = refs.filter((r) => !r.pinned);

  const eligible = otherRefs
    .filter((r) => r.score === undefined || r.score >= contentMinScore)
    .sort((a, b) => (b.score ?? 1) - (a.score ?? 1));
  const cappedEligible = contentTopK > 0 ? eligible.slice(0, contentTopK) : eligible;
  const withContent = new Set(cappedEligible.map((r) => r.slug));

  // Always render the title as a ref link so the linkable form is repeated in
  // context and the model is nudged to cite it.
  const refLink = (r: typeof refs[number]) => `[${r.title}](ref:${r.slug})`;

  /**
   * Render a group under `label`: every ref that carries content gets its own
   * `### heading + body`; refs without content (didn't make the score/topK cut,
   * or simply have none) collapse into a trailing ref-link list so their slug
   * still appears in context without bloating the prompt.
   */
  const section = (label: string, list: typeof refs, forceContent: boolean): string => {
    const detailed: string[] = [];
    const listed: string[] = [];
    for (const r of list) {
      const raw = (forceContent || withContent.has(r.slug)) ? (r.content?.trim() || "") : "";
      // Strip a leading echo of the title so the body doesn't restate the heading.
      const content = raw ? stripLeadingTitleEcho(raw, r.title) : "";
      if (content) detailed.push(`### ${refLink(r)}\n${content}`);
      else listed.push(`- ${refLink(r)}`);
    }
    const blocks = [label, ...detailed];
    if (listed.length > 0) {
      blocks.push(`Other related references:\n${listed.join("\n")}`);
    }
    return blocks.join("\n\n");
  };

  const parts: string[] = [];
  if (pinnedRefs.length > 0) {
    parts.push(section("PINNED REFERENCES — prioritize linking to these:", pinnedRefs, true));
  }
  if (otherRefs.length > 0) {
    parts.push(section("ADDITIONAL REFERENCES — use if relevant:", otherRefs, false));
  }
  return parts.join("\n\n");
}

export const formatReferencesForPromptJson = formatReferencesForPromptText;

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
 *   - Every occurrence of the same slug remains a full anchor link.
 */
export function resolveRefLinks(body: string, refs: ReferenceList): string {
  if (!body.includes("ref:")) return body;
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
      replacement = `[${label}](ref:${ref.slug})`;
    }
    // Strip a preceding plain-text duplicate of the link label. The LLM
    // sometimes appends [Title](ref:slug) right after the bare title text
    // instead of wrapping it, producing "Title[Title](ref:slug)". Stripping
    // the duplicate here prevents linkMentionedReferencesInBody from then
    // wrapping the bare title and producing two adjacent identical links.
    const segment = body.slice(cursor, link.start);
    const vis = (visibleText || (ref?.title ?? "")).trim();
    let cleanedSegment = segment;
    if (vis && cleanedSegment.endsWith(vis)) {
      const before = cleanedSegment.slice(0, cleanedSegment.length - vis.length);
      if (!before || /[^\p{L}\p{N}]$/u.test(before)) {
        cleanedSegment = before;
      }
    }
    output += cleanedSegment;
    output += replacement;
    cursor = link.end;
  }
  output += body.slice(cursor);
  return output;
}

/**
 * Resolve bare brackets like [Some Title] that the LLM wrote without a href.
 * - If the bracket's slug matches a known ref → convert to [label](ref:slug).
 * - Otherwise → strip the brackets and keep only the label text.
 *
 * This prevents [text] from surviving into the renderer and producing literal
 * visible brackets (or double-nested [[text](ref:slug)] when a later pass
 * wraps the label).
 */
export function resolveBareBracketsToRefs(text: string, refs: ReferenceList): string {
  const { bareBrackets } = parseMarkdownLinks(text);
  const candidates = bareBrackets.filter(
    (b) => b.kind === "title-seed" || b.kind === "ref-marker",
  );
  if (candidates.length === 0) return text;

  const alreadyLinked = collectReferenceLinkSlugs(text);
  // Apply end → start so earlier positions stay valid.
  const sorted = [...candidates].sort((a, b) => b.start - a.start);
  let result = text;
  for (const bracket of sorted) {
    const slug = bracket.slug ? slugify(bracket.slug) : "";
    const ref = slug ? refs.find((r) => r.slug === slug) : undefined;
    let replacement: string;
    if (ref && !alreadyLinked.has(ref.slug)) {
      replacement = `[${bracket.label || ref.title}](ref:${ref.slug})`;
    } else {
      // Not a known ref (or already linked): strip the brackets.
      replacement = bracket.label;
    }
    result = result.slice(0, bracket.start) + replacement + result.slice(bracket.end);
  }
  return result;
}

/**
 * Full deterministic reference-linking pass: resolves existing ref: links
 * (numeric → slug, empty bracket fill) then links every bare title mention
 * that isn't already inside a link or code span.
 *
 * Pass `selfSlug` to filter the self-article from refs and strip any surviving
 * self-links from the output. Pure text processing — no LLM.
 */
export function linkReferences(
  text: string,
  refs: ReferenceList,
  selfSlug?: string,
  db?: DatabaseSync,
): string {
  const normalizedSelf = selfSlug ? slugify(selfSlug) : "";
  const filtered = normalizedSelf
    ? refs.filter((r) => r.slug !== normalizedSelf)
    : refs;
  const selfTitle = normalizedSelf && db
    ? (getArticleByLookup(db, normalizedSelf)?.title ?? undefined)
    : undefined;
  let result = resolveRefLinks(text, filtered);
  result = resolveBareBracketsToRefs(result, filtered);
  result = linkMentionedReferencesInBody(result, filtered, db, selfTitle);
  return result;
}

/**
 * Same as linkReferences but for single-line inline text (infobox values,
 * captions, subtitles). No self-link concept for sidebar values.
 */
export const linkReferencesInline = (text: string, refs: ReferenceList): string =>
  linkReferences(text, refs);

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
  const exact = refs.find((r) => r.slug === normalized);
  if (exact) return exact;
  // Reference slugs name literal hyphens as "dash" (title-mode slugify), so the
  // canonical slug of "Purple Cheez-Its" is `purple-cheez-dash-its`. The model
  // routinely emits the natural collapsed kebab instead — `ref:purple-cheez-its`
  // — which never matches the dash-named slug. Fall back to the legacy
  // (hyphen-collapsing) form of each ref's title, which both spellings reduce
  // to, so the loose target still resolves to the right reference.
  const loose = legacySlugify(trimmed);
  if (!loose) return undefined;
  return refs.find((r) => legacySlugify(r.title) === loose);
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
  // Todo: remind claude to stop hand baking ten million bespoke regexps for every function and to rely on a library (or write one)
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

/**
 * Extract the text content of every bold/italic span in body that isn't already
 * inside an existing markdown link. Used to whitelist short ref titles that the
 * model has explicitly formatted.
 */
function extractFormattedTitleSpans(body: string): string[] {
  // Blank out existing links so we don't match inside their labels.
  // Todo: remind claude to stop hand baking ten million bespoke regexps for every function and to rely on a library (or write one)
  const stripped = body.replace(/\[[^\]]*\]\([^)]*\)/g, (m) => " ".repeat(m.length));
  const seen = new Set<string>();
  const spans: string[] = [];
  const add = (text: string) => {
    const t = text.trim();
    if (t && !seen.has(t)) { seen.add(t); spans.push(t); }
  };
  // Todo: remind claude to stop hand baking ten million bespoke regexps for every function and to rely on a library (or write one)
  for (const m of stripped.matchAll(/\*{2}([^*\n]+)\*{2}|_{2}([^_\n]+)_{2}/g)) add(m[1] ?? m[2] ?? "");
  // Todo: remind claude to stop hand baking ten million bespoke regexps for every function and to rely on a library (or write one)
  for (const m of stripped.matchAll(/(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g)) add(m[1] ?? m[2] ?? "");
  return spans;
}

function titleMentionPattern(title: string): RegExp | null {
  const tokens = title.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  // Todo: remind claude to stop hand baking ten million bespoke regexps for every function and to rely on a library (or write one)
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Todo: remind claude to stop hand baking ten million bespoke regexps for every function and to rely on a library (or write one)
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped.join("\\s+")}(?![\\p{L}\\p{N}])`, "giu");
}

/**
 * Expand a seed ref list one level deep: fetch every seed article's saved
 * reference sidecar, validate each child slug exists in the DB, and return
 * seeds + all unique valid children. Self-slug is excluded throughout.
 */
function expandRefsOneLevelDeep(
  db: DatabaseSync,
  seeds: ReferenceList,
  selfSlug: string,
): ReferenceList {
  const seen = new Set<string>([slugify(selfSlug)]);
  for (const r of seeds) seen.add(slugify(r.slug));
  const expanded = [...seeds];
  for (const seed of seeds) {
    for (const child of getLatestArticleReferences(db, seed.slug)) {
      const slug = slugify(child.slug);
      if (!slug || seen.has(slug)) continue;
      if (!getArticleByLookup(db, slug)) continue;
      seen.add(slug);
      expanded.push(child);
    }
  }
  return expanded;
}

/**
 * Ensure every bare mention of a reference title becomes a ref:slug link.
 *
 * Links ALL occurrences, not just the first. Longest title wins when titles
 * overlap (e.g. "Trans Ethology" beats "Ethology"). Skips text already inside
 * a markdown link, code span, or a range already claimed by a longer match.
 * No LLM, no fuzzy matching — pure deterministic text processing.
 *
 * Pass `db` to expand candidates one level deeper (refs-of-refs).
 * Pass `selfTitle` to claim self-article spans without linking them, preventing
 * refs whose titles are substrings of the article title from spuriously matching.
 */
export function linkMentionedReferencesInBody(
  body: string,
  refs: ReferenceList,
  db?: DatabaseSync,
  selfTitle?: string,
): string {
  // Derive self-title from the body H1 when not provided (handles new articles
  // not yet in the DB so self-protection always runs).
  const resolvedSelfTitle =
  // Todo: remind claude to stop hand baking ten million bespoke regexps for every function and to rely on a library (or write one)
    selfTitle ?? body.match(/^#+\s+(.+)$/m)?.[1]?.trim();
  const resolvedSelfSlug = resolvedSelfTitle ? slugify(resolvedSelfTitle) : "";

  // Bold any bare (un-bolded, un-linked) occurrences of the self-title before
  // doing anything else — do this before computing protected ranges so that
  // subsequent index arithmetic is based on the final body shape.
  if (resolvedSelfTitle) {
    const selfPat = titleMentionPattern(resolvedSelfTitle);
    if (selfPat) {
      const preProtected = markdownProtectedRanges(body);
      const toBold: Array<{ start: number; end: number; text: string }> = [];
      let m: RegExpExecArray | null;
      selfPat.lastIndex = 0;
      while ((m = selfPat.exec(body)) !== null) {
        if (isInsideRange(m.index, preProtected)) continue;
        // Skip heading lines — bolding inside `# Title` produces `# **Title**`.
        const lineStart = body.lastIndexOf("\n", m.index - 1) + 1;
        if (/^#+\s/.test(body.slice(lineStart, lineStart + 7))) continue;
        // Skip already-bold/italic text (single or double markers on either side).
        const pre = body[m.index - 1] ?? "";
        const post = body[m.index + m[0].length] ?? "";
        if (pre === "*" || pre === "_" || post === "*" || post === "_") continue;
        toBold.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      }
      for (let i = toBold.length - 1; i >= 0; i--) {
        const { start, end, text } = toBold[i];
        body = body.slice(0, start) + `**${text}**` + body.slice(end);
      }
    }
  }

  const expanded = db && refs.length > 0
    ? expandRefsOneLevelDeep(db, refs, resolvedSelfSlug)
    : refs;

  // Scan bold/italic spans. Any candidate whose title matches one bypasses the
  // short single-word filter. Also add DB-discovered articles from formatted
  // spans that aren't already in the candidate pool.
  const formattedSpans = extractFormattedTitleSpans(body);
  const formattedLower = new Set(formattedSpans.map((s) => s.toLowerCase()));
  const candidates = [...expanded];
  const bypassLengthFilter = new Set<string>();

  if (formattedSpans.length > 0) {
    const candidateSlugs = new Set(expanded.map((r) => r.slug));
    for (const ref of expanded) {
      if (formattedLower.has(ref.title.toLowerCase())) bypassLengthFilter.add(ref.slug);
    }
    if (db) {
      for (const span of formattedSpans) {
        const slug = slugify(span);
        if (!slug || candidateSlugs.has(slug) || slug === resolvedSelfSlug) continue;
        const article = getArticleByLookup(db, slug);
        if (!article) continue;
        candidateSlugs.add(article.slug);
        candidates.push({
          slug: article.slug,
          title: article.title,
          content: article.summaryMarkdown ?? "",
          kind: "summary",
          pinned: false,
          revisionId: "current",
        });
        bypassLengthFilter.add(article.slug);
      }
    }
  }

  if (candidates.length === 0 && !resolvedSelfTitle) return body;

  // Longest title first so longer matches claim their ranges before shorter ones.
  const sortedCandidates = [...candidates].sort((a, b) => b.title.length - a.title.length);

  // Collect ALL matches upfront (before any string mutation so indices stay valid).
  type Match = { start: number; end: number; slug: string; visible: string };
  const matches: Match[] = [];
  // Ranges already claimed by a longer-title match or self-article spans.
  const claimed: Array<{ start: number; end: number }> = [];
  const initialProtected = markdownProtectedRanges(body);

  // Self-article protection: claim all self-title spans without emitting links.
  // Runs before the candidates loop so substring refs don't match inside them.
  if (resolvedSelfTitle) {
    const selfWords = resolvedSelfTitle.trim().split(/\s+/).filter(Boolean);
    if (selfWords.length >= 2 || (selfWords[0]?.length ?? 0) >= 8) {
      const selfPattern = titleMentionPattern(resolvedSelfTitle);
      if (selfPattern) {
        selfPattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = selfPattern.exec(body)) !== null) {
          if (!isInsideRange(m.index, initialProtected)) {
            claimed.push({ start: m.index, end: m.index + m[0].length });
          }
        }
      }
    }
  }

  for (const ref of sortedCandidates) {
    // Skip single-word titles shorter than 8 chars (e.g. "Oil", "War") to avoid
    // false positives — unless the title appeared in bold/italic in the body,
    // which is an explicit signal that it's a named reference.
    const titleWords = ref.title.trim().split(/\s+/).filter(Boolean);
    if (titleWords.length < 2 && (titleWords[0]?.length ?? 0) < 8 && !bypassLengthFilter.has(ref.slug)) continue;
    const pattern = titleMentionPattern(ref.title);
    if (!pattern) continue;
    const blocked = [...initialProtected, ...claimed];
    let m: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(body)) !== null) {
      const end = m.index + m[0].length;
      if (isInsideRange(m.index, blocked)) continue;
      claimed.push({ start: m.index, end });
      matches.push({ start: m.index, end, slug: ref.slug, visible: m[0] });
    }
  }

  if (matches.length === 0) return body;

  // Apply substitutions from end → start so earlier indices stay valid.
  matches.sort((a, b) => b.start - a.start);
  let result = body;
  for (const r of matches) {
    result = result.slice(0, r.start) + `[${r.visible}](ref:${r.slug})` + result.slice(r.end);
  }
  return result;
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
    const slug = haluLinkTargetSlug(link);
    if (!slug || slug === normalizedSelf || seen.has(slug)) continue;
    const article = resolveExistingArticleForLink(db, slug, link.label);
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

/**
 * Remove matched markdown emphasis asterisks wrapping a label (`*x*`, `**x**`,
 * `***x***`). Asterisks only — wiki URLs are underscore-cased (spaces → `_`,
 * e.g. `/wiki/Foo_Bar`), so an underscore is a word separator and must survive
 * into the slug (slugify already treats it as one), never be peeled off as
 * emphasis.
 */
function stripWrappingEmphasis(text: string): string {
  let s = text.trim();
  let prev: string;
  do {
    prev = s;
    const m = s.match(/^(\*{1,3})([\s\S]+?)\1$/);
    if (m) s = m[2].trim();
  } while (s !== prev);
  return s;
}

/**
 * Canonical slug for a halu link, collapsing markdown emphasis the model
 * wrapped around the name. An emphasized label like `[*Algebra*]` slugifies to
 * `star-algebra-star` (slugify maps `*` → "star"); left alone that bogus slug
 * survives as a generation seed and spawns a duplicate "star-thing-star"
 * article. When the target slug was clearly derived straight from an
 * emphasis-wrapped label, re-derive it from the de-emphasized label so the link
 * seeds / resolves to the real "algebra" article. A deliberately different slug
 * (e.g. `[*New York City*](halu:nyc)`) is left untouched — redirect/alias
 * resolution still runs on the result via resolveExistingArticleForLink.
 */
function haluLinkTargetSlug(link: { slug?: string; target: string; label: string }): string {
  const slug = slugify(link.slug ?? link.target);
  const trimmedLabel = link.label.trim();
  const cleanedLabel = stripWrappingEmphasis(trimmedLabel);
  if (cleanedLabel !== trimmedLabel && slug === slugify(trimmedLabel)) {
    const cleanedSlug = slugify(cleanedLabel);
    if (cleanedSlug) return cleanedSlug;
  }
  return slug;
}

function resolveExistingArticleForLink(
  db: DatabaseSync,
  slug: string,
  label: string,
) {
  const targetMatch =
    getArticleByLookup(db, slug) ??
    getArticleByEquivalentLookup(db, slug);
  if (targetMatch) return targetMatch;

  const trimmedLabel = label.trim();
  if (!trimmedLabel) return null;

  const legacyLabelSlug = legacySlugify(trimmedLabel);
  if (legacyLabelSlug && legacyLabelSlug !== slug) {
    const legacyLabelMatch = getArticleByLookup(db, legacyLabelSlug);
    if (legacyLabelMatch) return legacyLabelMatch;
  }

  return getArticleByTitle(db, trimmedLabel);
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
 * Extract all internal graph links from saved article markdown.
 *
 * `halu:` links seed unwritten articles. `ref:` links point at existing
 * articles after `convertExistingArticleLinksToRefs` has canonicalized
 * generated body links. Article write paths must store both forms in
 * `article_links`, or ref-linked articles disappear from backlinks and
 * incoming hidden-hint context.
 */
export function extractAllBodyLinks(
  db: DatabaseSync,
  body: string,
  selfSlug: string,
): ParsedInternalLink[] {
  const haluLinks = extractInternalLinks(body);
  const haluSlugs = new Set(haluLinks.map((link) => link.targetSlug));
  const refLinks = extractRefLinksAsInternalLinks(db, body, selfSlug)
    .filter((link) => !haluSlugs.has(link.targetSlug));
  return [...haluLinks, ...refLinks];
}

/**
 * Shared deterministic article-body link cleanup.
 *
 * This is the common pass used by article generation, post-process, and
 * deterministic article writers before persisting body markdown. It normalizes
 * malformed/fallback markdown links, resolves known references, converts
 * existing `halu:` targets to durable `ref:` links, and strips self-links.
 */
export function resolveArticleBodyLinks(
  db: DatabaseSync,
  body: string,
  refs: ReferenceList,
  selfSlug: string,
): string {
  let resolved = cleanLinkLabels(body);
  resolved = normalizeMarkdownLinks(resolved, "article").markdown;
  resolved = linkReferences(resolved, refs, selfSlug, db);
  resolved = validateReferenceLinkTargets(db, resolved);
  resolved = convertExistingArticleLinksToRefs(db, resolved, selfSlug);
  return stripSelfLinks(resolved, selfSlug);
}

/**
 * Enforce the internal-link contract after model output has been normalized:
 * `ref:` may only target a stored article; an unwritten target must be `halu:`.
 * Existing aliases and title-derived targets are canonicalized to the stored
 * slug at the same time.
 */
function validateReferenceLinkTargets(db: DatabaseSync, body: string): string {
  const links = parseMarkdownLinks(body).links.filter((link) => link.kind === "ref");
  if (links.length === 0) return body;

  let output = "";
  let cursor = 0;
  for (const link of links) {
    const label = link.label.trim();
    const requestedSlug = slugify(link.slug ?? link.target);
    const article = requestedSlug
      ? resolveExistingArticleForLink(db, requestedSlug, label)
      : null;
    let replacement = link.raw;
    if (article) {
      replacement = `[${label || article.title}](ref:${article.slug})`;
    } else if (label && requestedSlug && !/^\d+$/.test(requestedSlug)) {
      replacement = buildHaluLink(label, requestedSlug, label);
    } else {
      replacement = label;
    }
    output += body.slice(cursor, link.start);
    output += replacement;
    cursor = link.end;
  }
  output += body.slice(cursor);
  return output;
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
    const slug = haluLinkTargetSlug(link);
    let replacement = link.raw;
    if (slug && slug !== normalizedSelf) {
      const article = resolveExistingArticleForLink(db, slug, link.label);
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
