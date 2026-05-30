// In-memory render cache keyed by slug+generatedAt.

import type { Article } from "./article";
import { renderMarkdown } from "./markdown";
import {
  renderReferencesHtml,
  resolveRefLinks,
} from "./referenceList";
import type { SeeAlsoList } from "./article";
import type { InfoboxData, ArticleMediaRow } from "./db";

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
  return resolveRefLinks(article.body, article.metadata.references).trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderInfoboxHtml(
  infobox: InfoboxData | null,
  headlineMedia: ArticleMediaRow | null,
  mediaDescription: string = "",
): string {
  if (!infobox && !headlineMedia) return "";

  const title = infobox?.title ?? "";
  const subtitle = infobox?.subtitle ?? "";
  const groups = infobox?.groups ?? [];

  let imgHtml = "";
  if (headlineMedia) {
    const slug = encodeURIComponent(headlineMedia.mediaId);
    const caption = headlineMedia.caption || mediaDescription;
    imgHtml = `
      <a href="/media/${slug}" class="infobox-image-link">
        <img src="/api/media/${slug}" alt="${escapeHtml(caption)}" class="infobox-image">
      </a>
      ${caption ? `<p class="infobox-caption">${escapeHtml(caption)}</p>` : ""}`;
  }

  const groupsHtml = groups
    .map(
      (g) => `
      <tbody>
        ${g.label ? `<tr><th class="infobox-group-header" colspan="2">${escapeHtml(g.label)}</th></tr>` : ""}
        ${g.rows.map((r) => `<tr><th class="infobox-label">${escapeHtml(r.label)}</th><td class="infobox-value">${escapeHtml(r.value)}</td></tr>`).join("")}
      </tbody>`,
    )
    .join("");

  return `<aside class="infobox">
  ${title ? `<div class="infobox-title">${escapeHtml(title)}</div>` : ""}
  ${subtitle ? `<div class="infobox-subtitle">${escapeHtml(subtitle)}</div>` : ""}
  ${imgHtml}
  ${groupsHtml ? `<table class="infobox-table">${groupsHtml}</table>` : ""}
</aside>`;
}

/**
 * Render display HTML for an article.
 *
 * Four-part output:
 *   0. Infobox (optional sidecar): aside with headline image + structured rows.
 *   1. Body: markdown with ref: links resolved to wiki paths.
 *   2. References: HTML <ol> with #ref-N anchor IDs.
 *   3. See also: sidecar metadata rendered as markdown.
 */
export function renderArticleDisplayHtml(
  article: Article,
  opts: {
    infobox?: InfoboxData | null;
    headlineMedia?: ArticleMediaRow | null;
    mediaDescription?: string;
  } = {},
): string {
  const body = resolveRefLinks(article.body, article.metadata.references);
  const bodyHtml = renderMarkdown(body);
  const refsHtml = renderReferencesHtml(article.metadata.references);
  const seeAlsoMd = renderSeeAlsoSection(article.metadata.seeAlso);
  const seeAlsoHtml = seeAlsoMd ? renderMarkdown(seeAlsoMd) : "";
  const infoboxHtml = renderInfoboxHtml(
    opts.infobox ?? null,
    opts.headlineMedia ?? null,
    opts.mediaDescription ?? "",
  );
  return [infoboxHtml, bodyHtml, refsHtml, seeAlsoHtml].filter(Boolean).join("\n");
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
