/**
 * @deprecated SCHEDULED FOR REMOVAL.
 *
 * This module's heuristic parsers (fuzzy title matching, edit-text scanning)
 * were sometimes used to mutate the reference list directly, which is the
 * root cause of stray LLM-shaped text appearing inside reference link labels.
 *
 * The replacement is `buildReferenceList` in `./referenceList.ts`, which
 * constructs the reference list algorithmically from validated slugs only.
 * All new code MUST route through `buildReferenceList`; do not add new
 * callers of anything in this file.
 *
 * Removal blockers (delete this file once these are gone):
 *   - findReferencedArticlesInEditText  (used by rewrite endpoint's RAG branch)
 *   - findFuzzyTitleMatchesInEditText   (used by rewrite endpoint's RAG branch)
 *
 * Both will be replaced when the rewrite endpoint is migrated to
 * `buildReferenceList`.
 */
import type { DatabaseSync } from "node:sqlite";
import { getArticleByLookup } from "./db";
import type { ArticleRecord } from "./types";
import { slugify, wikiSegmentToTitle } from "./slug";
import { fuzzyTitleScore, textTokens } from "./text/fuzzyMatch";
import { decodeWikiSegment, textMentionsTitle } from "./text/titleMatch";

export function findReferencedArticlesInEditText(
  db: DatabaseSync,
  text: string,
  currentSlug: string,
  limit = 6,
): { articles: ArticleRecord[]; requested: string[]; missing: string[] } {
  const requested: string[] = [];
  const missing: string[] = [];
  const articles: ArticleRecord[] = [];
  const seen = new Set<string>([slugify(currentSlug)]);

  const addArticle = (article: ArticleRecord | null, label: string) => {
    const cleanLabel = label.trim();
    if (cleanLabel) requested.push(cleanLabel);
    if (!article) {
      if (cleanLabel) missing.push(cleanLabel);
      return;
    }
    const slug = slugify(article.slug);
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    articles.push(article);
  };

  for (const match of text.matchAll(/(?:^|[\s"'(])\/?wiki\/([^\s"'<>#?)]+)/gi)) {
    if (articles.length >= limit) break;
    const rawSegment = match[1]?.replace(/[.,;:!?]+$/, "") ?? "";
    if (!rawSegment) continue;
    const title = wikiSegmentToTitle(decodeWikiSegment(rawSegment));
    addArticle(getArticleByLookup(db, slugify(title)), `wiki/${rawSegment}`);
  }

  if (articles.length < limit) {
    const candidates = db
      .prepare(
        `SELECT slug, title
         FROM articles
         WHERE is_disambiguation = 0
         ORDER BY length(title) DESC, title COLLATE NOCASE ASC
         LIMIT 500`,
      )
      .all() as Array<{ slug: string; title: string }>;

    for (const candidate of candidates) {
      if (articles.length >= limit) break;
      if (seen.has(slugify(candidate.slug))) continue;
      if (!textMentionsTitle(text, candidate.title)) continue;
      addArticle(getArticleByLookup(db, candidate.slug), candidate.title);
    }
  }

  return { articles, requested, missing };
}

export function findFuzzyTitleMatchesInEditText(
  db: DatabaseSync,
  text: string,
  currentSlug: string,
  limit = 6,
  excludeSlugs: string[] = [],
): ArticleRecord[] {
  const query = text.replace(/\s+/g, " ").trim();
  if (!query) return [];

  const queryTokens = textTokens(query);
  const seen = new Set<string>([
    slugify(currentSlug),
    ...excludeSlugs.map((slug) => slugify(slug)).filter(Boolean),
  ]);
  const candidates = db
    .prepare(
      `SELECT slug, title
       FROM articles
       WHERE is_disambiguation = 0
       ORDER BY title COLLATE NOCASE ASC
       LIMIT 1000`,
    )
    .all() as Array<{ slug: string; title: string }>;

  return candidates
    .map((candidate) => ({
      ...candidate,
      score: fuzzyTitleScore(query, queryTokens, candidate.title),
    }))
    .filter((candidate) => candidate.score >= 0.68)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .flatMap((candidate) => {
      const slug = slugify(candidate.slug);
      if (!slug || seen.has(slug)) return [];
      const article = getArticleByLookup(db, candidate.slug);
      if (!article) return [];
      seen.add(slug);
      return [article];
    })
    .slice(0, limit);
}
