import { slugify } from "../../slug";
import type { ParsedInternalLink } from "../../types";
import { parseMarkdownLinks, type ParsedMarkdownLink } from "../markdownLinkParser";

export function buildHaluLink(title: string, slug: string, hint: string): string {
  const safeHint = hint
    .replace(/"/g, "'")
    .replace(/[\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `[${title}](halu:${slug} "${safeHint}")`;
}

export function parsedHaluLinkToInternalLink(link: ParsedMarkdownLink): ParsedInternalLink | null {
  if (link.kind !== "halu") return null;
  const visibleLabel = link.label.trim();
  const targetSlug = slugify(link.slug ?? "");
  const hiddenHint = (link.hint ?? "").trim().slice(0, 400);
  if (!visibleLabel || !targetSlug || !hiddenHint) return null;
  return { targetSlug, visibleLabel, hiddenHint };
}

export function extractHaluLinks(markdown: string): ParsedInternalLink[] {
  const seen = new Set<string>();
  const links: ParsedInternalLink[] = [];
  for (const parsed of parseMarkdownLinks(markdown).links) {
    const link = parsedHaluLinkToInternalLink(parsed);
    if (!link || seen.has(link.targetSlug)) continue;
    seen.add(link.targetSlug);
    links.push(link);
  }
  return links;
}
