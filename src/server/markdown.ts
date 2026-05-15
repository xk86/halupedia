import MarkdownIt from "markdown-it";
import { slugify } from "./slug";
import type { ParsedInternalLink } from "./types";

const LINK_RE = /\[([^\]]+)\]\(halu:([^) "\t\r\n]+)(?:\s+"([^"]*)")?\)/g;

const md = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: false,
});

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const hrefIndex = tokens[idx].attrIndex("href");
  const titleIndex = tokens[idx].attrIndex("title");
  const href = hrefIndex >= 0 ? tokens[idx].attrs?.[hrefIndex]?.[1] ?? "" : "";
  if (!href.startsWith("halu:")) {
    tokens[idx].attrSet("href", "#");
    if (titleIndex >= 0) tokens[idx].attrs?.splice(titleIndex, 1);
    return defaultLinkOpen(tokens, idx, options, env, self);
  }

  const normalized = slugify(href.slice("halu:".length));
  tokens[idx].attrSet("href", `/wiki/${normalized}`);
  if (titleIndex >= 0) tokens[idx].attrs?.splice(titleIndex, 1);
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function normalizeMarkdown(input: string): string {
  let markdown = input.trim();
  markdown = markdown.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```$/i, "").trim();
  markdown = markdown.replace(/<!--[\s\S]*?-->/g, "");
  markdown = markdown.replace(/<script[\s\S]*?<\/script>/gi, "");
  markdown = markdown.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  markdown = markdown.replace(/<\/?[a-z][^>]*>/gi, "");
  return markdown;
}

export function extractInternalLinks(markdown: string): ParsedInternalLink[] {
  const links: ParsedInternalLink[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = LINK_RE.exec(markdown)) !== null) {
    const visibleLabel = match[1].trim();
    const targetSlug = slugify(match[2]);
    const hiddenHint = (match[3] ?? "").trim().slice(0, 400);
    if (!visibleLabel || !targetSlug || !hiddenHint) continue;
    const key = `${targetSlug}::${visibleLabel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ targetSlug, visibleLabel, hiddenHint });
  }

  return links;
}

export function renderMarkdown(markdown: string): string {
  return md.render(markdown);
}

export function extractTitle(markdown: string, fallbackSlug: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || fallbackSlug;
}

export function markdownToPlainText(markdown: string): string {
  return renderMarkdown(markdown)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
