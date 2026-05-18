// In-memory cache of rendered article HTML (body + algorithmic metadata).
//
// Rendering happens at the call site (needs access to rewriteArticleHtml,
// which is tied to the running app's DB). This module just stores the
// result keyed by slug+generatedAt so we can serve repeats without
// re-rendering. Never persisted; cleared on server restart.

import type { Article } from "./article";
import { renderReferencesSection } from "./referenceList";
import type { SeeAlsoList } from "./article";

interface CacheEntry {
  html: string;
  generatedAt: number;
}
const cache = new Map<string, CacheEntry>();

// Algorithmic see-also section — same contract as references: deterministic
// markdown links built from validated slugs only, no LLM.
export function renderSeeAlsoSection(seeAlso: SeeAlsoList): string {
  if (seeAlso.length === 0) return "";
  const lines = seeAlso.map((entry) => {
    const hintAttr = entry.hint ? ` "${entry.hint.replace(/"/g, "'")}"` : "";
    return `* [${entry.title}](halu:${entry.slug}${hintAttr})`;
  });
  return `## See also\n\n${lines.join("\n")}`;
}

// Combine body + refs + see-also into a single markdown string. Body MUST
// already be metadata-free (Article.body contract).
export function assembleArticleMarkdownForRender(article: Article): string {
  const refs = renderReferencesSection(article.metadata.references);
  const seeAlso = renderSeeAlsoSection(article.metadata.seeAlso);
  return [article.body.trim(), refs, seeAlso].filter(Boolean).join("\n\n");
}

// Look up cached HTML for this slug/generatedAt pair; miss => undefined so
// the caller can render and call rememberArticleHtml.
export function getCachedArticleHtml(
  slug: string,
  generatedAt: number,
): string | undefined {
  const entry = cache.get(slug);
  return entry && entry.generatedAt === generatedAt ? entry.html : undefined;
}

export function rememberArticleHtml(
  slug: string,
  generatedAt: number,
  html: string,
): void {
  cache.set(slug, { html, generatedAt });
}

// Drop cached render for this slug. Call on every write to body/refs/see-also.
export function invalidateArticleHtml(slug: string): void {
  cache.delete(slug);
}

export function clearArticleHtmlCache(): void {
  cache.clear();
}
