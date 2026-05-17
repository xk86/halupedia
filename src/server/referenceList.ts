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
 *      Because the markdown link is built by wrapping that validated slug
 *      (e.g. `[Title](halu:slug)`), the result is always well-formed and is
 *      exempt from the LLM link-repair pass.
 *   4. Pinned entries always survive ranking/pruning, and DO NOT count toward
 *      `max_references`.
 *   5. The reference list rendered into the article is just
 *        `entries.map(e => `* [${e.title}](halu:${e.slug})`).join("\n")`
 *      — there is no other code path that emits references.
 *
 * The module also exports `renderReferencesSection`, the algorithmic renderer
 * called by all article-assembly code. There is no other supported renderer.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "./logger";
import type {
  ReferenceKind,
  ReferenceList,
  ReferenceListEntry,
  ReferenceRevisionId,
  RagConfig,
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
  /** References the user pinned or added via the editor (always survive). */
  userAdditions?: ReferenceList;
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
    revisionId,
    config,
  } = input;

  // Track which slugs we've already accepted so each appears once.
  const seen = new Set<string>([slugify(articleSlug)]);
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

/**
 * Render the reference list into a markdown "References" section.
 *
 * This is the ONLY supported way to render references into an article body.
 * The output is generated deterministically from the entry slugs — no LLM
 * is ever involved. Because each link is built from a known-valid slug
 * (`[Title](halu:slug)`), the produced section is guaranteed well-formed
 * and the link-repair pass should skip it entirely.
 */
export function renderReferencesSection(refs: ReferenceList): string {
  if (refs.length === 0) return "";
  const lines = refs.map(
    (entry) => `* [${entry.title}](halu:${entry.slug})`,
  );
  return `## References\n\n${lines.join("\n")}`;
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
 *
 * Centralising this list ensures every consumer (link repair, refresh
 * scanning, body extraction) agrees on what counts as metadata.
 */
export function isMetadataSection(heading: string): boolean {
  const normalized = heading.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized === "references" || normalized === "see also";
}
