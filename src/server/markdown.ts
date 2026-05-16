import MarkdownIt from "markdown-it";
import katex from "katex";
import { slugToTitle, slugify, titleToWikiSegment } from "./slug";
import type { ArticleSection, ParsedInternalLink } from "./types";

const LINK_RE = /\[([^\]]+)\]\(halu:([^) "\t\r\n]+)(?:\s+"([^"]*)")?\)/g;

const md = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: false,
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInlineTeX(tex: string): string {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode: false,
      output: "html",
      strict: "ignore",
      throwOnError: false,
      trust: false,
    });
  } catch {
    return escapeHtml(tex.trim());
  }
}

md.inline.ruler.before("escape", "inline_tex", (state, silent) => {
  const start = state.pos;
  if (state.src[start] !== "$") return false;
  if (state.src[start + 1] === "$") return false;
  if (start > 0 && state.src[start - 1] === "\\") return false;

  let end = start + 1;
  while (end < state.posMax) {
    if (state.src[end] === "$" && state.src[end - 1] !== "\\") break;
    end += 1;
  }
  if (end >= state.posMax || end === start + 1) return false;
  if (!silent) {
    const token = state.push("inline_tex", "", 0);
    token.content = state.src.slice(start + 1, end);
  }
  state.pos = end + 1;
  return true;
});

md.renderer.rules.inline_tex = (tokens, idx) => `<span class="math-inline">${renderInlineTeX(tokens[idx].content)}</span>`;

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const hrefIndex = tokens[idx].attrIndex("href");
  const titleIndex = tokens[idx].attrIndex("title");
  const href = hrefIndex >= 0 ? tokens[idx].attrs?.[hrefIndex]?.[1] ?? "" : "";
  if (href.startsWith("#")) {
    return defaultLinkOpen(tokens, idx, options, env, self);
  }
  if (!href.startsWith("halu:")) {
    tokens[idx].attrSet("href", "#");
    if (titleIndex >= 0) tokens[idx].attrs?.splice(titleIndex, 1);
    return defaultLinkOpen(tokens, idx, options, env, self);
  }

  const normalized = slugify(href.slice("halu:".length));
  tokens[idx].attrSet("href", `/wiki/${titleToWikiSegment(slugToTitle(normalized))}`);
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
    const key = targetSlug;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ targetSlug, visibleLabel, hiddenHint });
  }

  return links;
}

function normalizeHeadingLabel(heading: string): string {
  return heading.trim().toLowerCase();
}

export function stripTopLevelSections(markdown: string, headings: string[]): string {
  const targetHeadings = new Set(headings.map(normalizeHeadingLabel));
  const lines = markdown.split("\n");
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      const heading = normalizeHeadingLabel(headingMatch[1]);
      if (targetHeadings.has(heading)) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) kept.push(line);
  }

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripFootnoteArtifacts(markdown: string): string {
  return markdown
    .replace(/\$\{\}\^\d+\$/g, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/^\$\{\}\^\d+\$.*$/gm, "")
    .replace(/^\[\^[^\]]+\]:.*$/gm, "")
    .replace(/^[-*]{3,}\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sectionSlice(markdown: string, heading: string): string {
  const pattern = new RegExp(`^##\\s+${heading}\\s*$`, "im");
  const match = pattern.exec(markdown);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const nextHeading = /\n##\s+/i.exec(rest);
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
}

export function renderMarkdown(markdown: string): string {
  return md.render(markdown);
}

export function summaryMarkdownFromArticle(markdown: string): string {
  const withoutTitle = markdown.replace(/^#\s+.+?$/m, "").trim();
  const withoutDerivedSections = stripTopLevelSections(withoutTitle, ["References", "See also"]);
  const firstParagraph =
    withoutDerivedSections
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .find((part) => part && !part.startsWith("## ")) ?? "";
  return firstParagraph
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\(halu:[^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);
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

interface SectionRange extends ArticleSection {
  start: number;
  end: number;
  heading: string;
}

function sectionRanges(markdown: string): SectionRange[] {
  const h1 = /^#\s+.+?$/m.exec(markdown);
  const bodyStart = h1 ? h1.index + h1[0].length : 0;
  const headingRe = /^##\s+(.+?)\s*$/gm;
  const headings: Array<{ title: string; start: number; end: number; raw: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(markdown)) !== null) {
    headings.push({ title: match[1].trim(), start: match.index, end: match.index + match[0].length, raw: match[0] });
  }

  const ranges: SectionRange[] = [];
  const leadEnd = headings[0]?.start ?? markdown.length;
  const lead = markdown.slice(bodyStart, leadEnd).trim();
  if (lead) {
    ranges.push({ id: "lead", title: "Lead", start: bodyStart, end: leadEnd, heading: "" });
  }
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    ranges.push({
      id: slugify(heading.title) || `section-${i + 1}`,
      title: heading.title,
      start: heading.start,
      end: headings[i + 1]?.start ?? markdown.length,
      heading: heading.raw,
    });
  }
  return ranges;
}

export function listArticleSections(markdown: string): ArticleSection[] {
  return sectionRanges(markdown).map(({ id, title }) => ({ id, title }));
}

export function articleSectionMarkdown(markdown: string, sectionId: string): string {
  const range = sectionRanges(markdown).find((section) => section.id === sectionId);
  return range ? markdown.slice(range.start, range.end).trim() : markdown;
}

export function replaceArticleSection(markdown: string, sectionId: string, nextSectionMarkdown: string): string {
  const range = sectionRanges(markdown).find((section) => section.id === sectionId);
  if (!range) return nextSectionMarkdown.trim();

  let replacement = nextSectionMarkdown.trim();
  if (sectionId === "lead") {
    replacement = replacement.replace(/^#\s+.+?$/m, "").replace(/^##\s+.+?$/m, "").trim();
    replacement = replacement ? `\n\n${replacement}\n\n` : "\n\n";
  } else if (!replacement.match(/^##\s+/m)) {
    replacement = `${range.heading}\n\n${replacement}`;
  }

  return `${markdown.slice(0, range.start).trimEnd()}${replacement.startsWith("\n") ? "" : "\n\n"}${replacement}${replacement.endsWith("\n") ? "" : "\n\n"}${markdown.slice(range.end).trimStart()}`.trim();
}
