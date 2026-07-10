// In-memory render cache keyed by slug+generatedAt.

import type { Article } from "./article";
import { renderMarkdown, stripSelfLinks } from "./markdown";
import {
  renderReferencesHtml,
  linkReferences,
} from "./referenceList";
import type { SeeAlsoList } from "./article";

interface CacheEntry {
  html: string;
  generatedAt: number;
}
const cache = new Map<string, CacheEntry>();

// Algorithmic see-also section (markdown). Same contract as references:
// deterministic halu links, never LLM-generated.
export function renderSeeAlsoSection(seeAlso: SeeAlsoList): string {
  if (seeAlso.length === 0) return "";
  const lines = seeAlso.map((entry) => {
    const hintAttr = entry.hint ? ` "${entry.hint.replace(/"/g, "'")}"` : "";
    return `* [${entry.title}](halu:${entry.slug}${hintAttr})`;
  });
  return `## See also\n\n${lines.join("\n")}`;
}

/**
 * Assemble the legacy markdown projection. Metadata stays sidecar-only and is
 * rendered for display from Article.metadata.
 */
export function assembleArticleMarkdownForRender(article: Article): string {
  const linked = linkReferences(article.body, article.metadata.references, article.slug);
  return stripSelfLinks(linked, article.slug).trim();
}

/**
 * Render display HTML for an article (body + references + see-also).
 * The infobox is NOT included here — it lives in the sidebar payload
 * so the client can render it in the right column.
 */
export function renderArticleDisplayHtml(article: Article): string {
  const linked = linkReferences(article.body, article.metadata.references, article.slug);
  const body = stripSelfLinks(linked, article.slug);
  const bodyHtml = renderMarkdown(body);
  const refsHtml = renderReferencesHtml(article.metadata.references);
  const seeAlsoMd = renderSeeAlsoSection(article.metadata.seeAlso);
  const seeAlsoHtml = seeAlsoMd ? renderMarkdown(seeAlsoMd) : "";
  return [bodyHtml, refsHtml, seeAlsoHtml].filter(Boolean).join("\n");
}

export function getCachedArticleHtml(slug: string, generatedAt: number): string | undefined {
  const entry = cache.get(slug);
  return entry && entry.generatedAt === generatedAt ? entry.html : undefined;
}

export function rememberArticleHtml(slug: string, generatedAt: number, html: string): void {
  cache.set(slug, { html, generatedAt });
}

export function invalidateArticleHtml(slug: string): void {
  cache.delete(slug);
}

export function clearArticleHtmlCache(): void {
  cache.clear();
}
