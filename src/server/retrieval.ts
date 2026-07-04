/**
 * Prompt-assembly helpers for retrieved RAG context.
 *
 * Retrieval itself now lives in `./rag` (the LanceDB-backed structured
 * retriever). What remains here are the pure helpers that turn a retrieved
 * result — already mapped to the legacy `sourceArticles` shape via
 * `toLegacyView` — into the prompt blocks the generation/refresh/rewrite nodes
 * interpolate, plus the blacklist filter applied before any prompt sees a
 * source.
 */
import type { DatabaseSync } from "node:sqlite";
import { listArticleBlacklistSlugs } from "./db";
import { slugify } from "./slug";

/**
 * A single source article surfaced by retrieval.
 *
 * `score` is the relevancy score the source earned during ranking (higher is
 * better), carried through so the reference-list builder can re-rank against
 * summaries without re-running retrieval.
 */
export interface RetrievedSourceArticle {
  slug: string;
  title: string;
  content: string;
  score?: number;
}

/** Lowercase alphanumeric-only key for comparing content against a title/slug. */
function alnumKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * A retrieved source is only worth feeding the model when it carries text
 * beyond the article's own title/slug. Stub/short articles produce content that
 * normalizes to just their title — those add duplicate headings and noise
 * without information. Leading Markdown heading markers are stripped before the
 * comparison.
 */
function chunkHasUsefulContent(content: string, title: string, slug: string): boolean {
  const normalized = (content ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const body = normalized.replace(/^#{1,6}\s+/, "").trim();
  const key = alnumKey(body);
  if (!key) return false;
  return key !== alnumKey(title) && key !== alnumKey(slug);
}

/**
 * Strip user-blacklisted articles out of a retrieved-context block before it
 * reaches any prompt. Merges the slugs sent with the current request with the
 * article's persisted blacklist, so blocks made in earlier sessions hold for
 * every retrieval (generation, refresh, rewrite) — not just reference-list
 * builds.
 */
export function excludeBlacklistedSources<
  T extends { sourceArticles: RetrievedSourceArticle[]; ragTitles: string[] },
>(db: DatabaseSync, articleSlug: string, retrieved: T, requestBlacklistSlugs: string[] = []): T {
  const blocked = new Set<string>([
    ...requestBlacklistSlugs.map((s) => slugify(s)).filter(Boolean),
    ...listArticleBlacklistSlugs(db, slugify(articleSlug)),
  ]);
  if (blocked.size === 0) return retrieved;
  const blockedTitles = new Set(
    retrieved.sourceArticles.filter((a) => blocked.has(a.slug)).map((a) => a.title),
  );
  return {
    ...retrieved,
    sourceArticles: retrieved.sourceArticles.filter((a) => !blocked.has(a.slug)),
    ragTitles: retrieved.ragTitles.filter(
      (t) => !blockedTitles.has(t) && !blocked.has(slugify(t)),
    ),
  };
}

/**
 * Strip a leading echo of the article title from source content. Retrieved
 * body content often opens by restating the title verbatim (optionally as a
 * `# Heading`). Left in place, the prompt block would render the title twice —
 * once as our heading, once in the body.
 *
 * Only strips when the title is followed by a word boundary, so a single-letter
 * title like "A" is never clipped off content that merely starts with "a".
 */
export function stripLeadingTitleEcho(content: string, title: string): string {
  const body = content.replace(/^\s+/, "").replace(/^#{1,6}\s+/, "");
  const t = title.trim();
  if (!t) return body.trim();
  if (body.slice(0, t.length).toLowerCase() === t.toLowerCase()) {
    const after = body[t.length] ?? "";
    // Require a boundary after the echoed title (end-of-string or non-alphanumeric)
    // so we don't bite into a longer word that happens to share the prefix.
    if (after === "" || !/[\p{L}\p{N}]/u.test(after)) {
      return body.slice(t.length).replace(/^[\s:.–—-]+/, "").trim();
    }
  }
  return body.trim();
}

/**
 * Assemble retrieved source articles into the `rag_context` prompt block.
 *
 * Each source becomes its own `## Title` heading followed by its content, with
 * a leading title-echo stripped so the heading isn't immediately repeated.
 * Entries are added whole while they fit a hard character budget; any source
 * whose content can't fit is NOT dropped silently — its title is collected into
 * a compact "additional related topics" list appended below, so the model still
 * knows the topic exists. Each title appears at most once across both sections.
 */
export function formatRagContextForPrompt(
  sourceArticles: Array<{ title: string; content: string; slug?: string }>,
  maxChars: number,
  /**
   * Hard cap on how many sources get a full `## heading + body`. Sources past
   * the cap (or past the char budget) collapse into the title-only overflow
   * list. Refresh/rewrite pass a small cap so a wall of low-relevance context
   * can't drown the article being edited. 0 / omitted = unlimited.
   */
  maxArticles = 0,
): string {
  // Render the title as a ref link when we know the slug, so the linkable form
  // is repeated through the context and the model is nudged to cite it.
  const titleLabel = (s: { title: string; slug?: string }) =>
    s.slug ? `[${s.title}](ref:${s.slug})` : s.title;

  const parts: string[] = [];
  const overflow: string[] = []; // refs whose content didn't fit the budget
  const seenTitles = new Set<string>();
  let used = 0;
  for (const s of sourceArticles) {
    // Defense in depth: never emit an empty or title-only heading, and never
    // repeat the same article's heading (upstream should already dedupe, but
    // the prompt block must be clean regardless of caller).
    if (!chunkHasUsefulContent(s.content, s.title, s.slug ?? "")) continue;
    const titleKey = alnumKey(s.title);
    if (titleKey && seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);
    const entry = `## ${titleLabel(s)}\n${stripLeadingTitleEcho(s.content, s.title)}`;
    // Article-count cap reached, too big to ever fit, or no room left: list the
    // title below instead of giving it a full content block.
    if (
      (maxArticles > 0 && parts.length >= maxArticles) ||
      entry.length > maxChars ||
      (used + entry.length + 2 > maxChars && parts.length > 0)
    ) {
      overflow.push(titleLabel(s));
      continue;
    }
    parts.push(entry);
    used += entry.length + 2; // "\n\n" separator joined below
  }
  let out = parts.join("\n\n");
  if (overflow.length > 0) {
    const list = overflow.map((t) => `- ${t}`).join("\n");
    out += `${out ? "\n\n" : ""}Additional related topics (content omitted for length):\n${list}`;
  }
  return out;
}

/**
 * Format the "suggested related topics" bullet list for prompts. When a title
 * matches a known retrieved source we render it as a `[Title](ref:slug)` link
 * so the linkable form is repeated in context; titles without a resolvable
 * slug stay plain bullets (there is nothing safe to link them to). Duplicate
 * titles are collapsed.
 */
export function formatRelatedTitlesForPrompt(
  ragTitles: string[],
  sourceArticles: Array<{ title: string; slug?: string }> = [],
  /** Cap the number of suggestions (0 / omitted = unlimited). Refresh passes a
   *  small cap so a long noisy title list can't dominate the prompt. */
  limit = 0,
): string {
  const slugByTitle = new Map<string, string>();
  for (const s of sourceArticles) {
    const key = alnumKey(s.title);
    if (key && s.slug && !slugByTitle.has(key)) slugByTitle.set(key, s.slug);
  }
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const t of ragTitles) {
    if (limit > 0 && lines.length >= limit) break;
    const key = alnumKey(t);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const slug = slugByTitle.get(key);
    lines.push(slug ? `- [${t}](ref:${slug})` : `- ${t}`);
  }
  return lines.join("\n");
}
