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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textMentionsTitle(text: string, title: string): boolean {
  const normalizedTitle = title.replace(/\s+/g, " ").trim();
  if (normalizedTitle.length < 4) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedTitle)}([^\\p{L}\\p{N}]|$)`, "iu").test(text);
}

function textTokens(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length];
}

function tokenSimilarity(a: string, b: string): number {
  const maxLength = Math.max(a.length, b.length);
  if (!maxLength) return 1;
  return 1 - levenshtein(a, b) / maxLength;
}

function fuzzyTitleScore(text: string, queryTokens: string[], title: string): number {
  const normalizedText = text.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedTitle = title.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalizedTitle || normalizedTitle.length < 4) return 0;
  if (normalizedText.includes(normalizedTitle)) return 1;

  const titleTokens = textTokens(title);
  if (titleTokens.length === 0 || queryTokens.length === 0) return 0;

  let matched = 0;
  let similarityTotal = 0;
  for (const titleToken of titleTokens) {
    const best = Math.max(
      ...queryTokens.map((queryToken) =>
        queryToken === titleToken ? 1 : tokenSimilarity(queryToken, titleToken),
      ),
    );
    similarityTotal += best;
    if (best >= 0.78) matched += 1;
  }

  const coverage = matched / titleTokens.length;
  const averageSimilarity = similarityTotal / titleTokens.length;
  return coverage >= 0.5 ? (coverage + averageSimilarity) / 2 : 0;
}

function decodeWikiSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

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
