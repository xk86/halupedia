import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "./logger";
import {
  addArticleBlacklistSlugs,
  getArticleByLookup,
  listArticleBlacklistSlugs,
  removeArticleBlacklistSlugs,
  saveArticleReferences,
} from "./db";
import {
  buildReferenceList,
  loadPriorReferenceList,
  type BuildReferenceListInput,
} from "./referenceList";
import type { ReferenceList } from "./types";
import { slugify } from "./slug";

export interface ReferenceEditRequest {
  referenceSlugs?: string[];
  pinnedSlugs?: string[];
  blacklistSlugs?: string[];
}

/** True when the request carries any reference-selection fields at all —
 *  the signal that an empty-instructions edit is a refs-only edit rather
 *  than a mistake. */
export function hasReferenceEditFields(body: ReferenceEditRequest): boolean {
  return (
    Array.isArray(body.referenceSlugs) ||
    Array.isArray(body.pinnedSlugs) ||
    Array.isArray(body.blacklistSlugs)
  );
}

/**
 * Sync the persisted reference blacklist with an edit request: newly blocked
 * slugs are stored, and any slug the user re-selected as a reference is
 * unblocked (re-adding a blocked ref is the unblock gesture).
 */
export function persistBlacklistForEdit(
  db: DatabaseSync,
  articleSlug: string,
  body: ReferenceEditRequest,
): void {
  const blocked = (body.blacklistSlugs ?? []).map((s) => slugify(s)).filter(Boolean);
  if (Array.isArray(body.blacklistSlugs)) {
    // An explicit blacklist array is authoritative — the edit panel loads the
    // persisted list and sends back its full state, so a slug missing from it
    // was removed by the user and must be unblocked. (Without this, blocks
    // could be added but never removed.)
    const blockedSet = new Set(blocked);
    const stale = listArticleBlacklistSlugs(db, slugify(articleSlug)).filter(
      (s) => !blockedSet.has(s),
    );
    removeArticleBlacklistSlugs(db, articleSlug, stale);
  }
  // Re-adding a blocked slug as a reference is the other unblock gesture.
  const reAdded = [...(body.referenceSlugs ?? []), ...(body.pinnedSlugs ?? [])]
    .map((s) => slugify(s))
    .filter(Boolean);
  removeArticleBlacklistSlugs(db, articleSlug, reAdded);
  addArticleBlacklistSlugs(
    db,
    articleSlug,
    blocked.filter((s) => !reAdded.includes(s)),
  );
}

/**
 * Apply a refs-only edit: no LLM call, no retrieval, no post-process. The
 * client's reference selection is authoritative (its pinned set replaces the
 * stored one); the blacklist is persisted; the rebuilt list is saved as the
 * article's current reference sidecar.
 */
export function applyReferenceOnlyEdit(
  db: DatabaseSync,
  articleSlug: string,
  body: ReferenceEditRequest,
  ragConfig: BuildReferenceListInput["config"],
  logger?: Logger,
): ReferenceList {
  persistBlacklistForEdit(db, articleSlug, body);

  const pinnedSet = new Set((body.pinnedSlugs ?? []).map((s) => slugify(s)).filter(Boolean));
  const selectedSlugs = Array.from(
    new Set(
      [...(body.referenceSlugs ?? []), ...(body.pinnedSlugs ?? [])]
        .map((s) => slugify(s))
        .filter(Boolean),
    ),
  );
  const userAdditions: ReferenceList = [];
  for (const slug of selectedSlugs) {
    const article = getArticleByLookup(db, slug);
    if (!article) continue;
    userAdditions.push({
      slug: article.slug,
      title: article.title,
      content: article.summaryMarkdown ?? "",
      kind: "summary",
      pinned: pinnedSet.has(slug),
      revisionId: "current",
      source: "user",
    });
  }

  // When the client sent an explicit selection, it replaces the stored list —
  // prior refs are not merged back in (removing a ref from the panel must
  // actually remove it). Without a selection this is a blacklist-only edit:
  // keep priors, minus anything newly blocked.
  const refs = buildReferenceList(
    db,
    {
      articleSlug,
      ragSources: [],
      priorReferences: Array.isArray(body.referenceSlugs)
        ? []
        : (loadPriorReferenceList(db, articleSlug) ?? []),
      userAdditions,
      blacklistSlugs: (body.blacklistSlugs ?? []).map((s) => slugify(s)).filter(Boolean),
      revisionId: "current",
      config: ragConfig,
    },
    logger,
  );
  saveArticleReferences(db, articleSlug, Date.now(), refs);
  return refs;
}
