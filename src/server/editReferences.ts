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
