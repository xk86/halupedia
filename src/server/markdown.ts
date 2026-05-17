import MarkdownIt from "markdown-it";
import katex from "katex";
import { slugToTitle, slugify, titleToWikiSegment } from "./slug";
import type { ArticleSection, ParsedInternalLink } from "./types";

export const LINK_RE =
  /\[([^\]]+)\]\(halu:([^)"\t\r\n ]+)-?\s*(?:"([^"\r\n)]*)"?\s*)?\)/g;

export function buildHaluLink(
  title: string,
  slug: string,
  hint: string,
): string {
  const safeHint = hint
    .replace(/"/g, "'")
    .replace(/[\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `[${title}](halu:${slug} "${safeHint}")`;
}

function isBareBracketLinkLabel(label: string): boolean {
  const trimmed = label.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 120 &&
    !trimmed.startsWith("^") &&
    !trimmed.includes("|") &&
    !/^https?:\/\//i.test(trimmed) &&
    /[\p{L}\p{N}]/u.test(trimmed)
  );
}

export function normalizeHaluLinks(markdown: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < markdown.length) {
    const labelStart = markdown.indexOf("[", cursor);
    if (labelStart < 0) {
      output += markdown.slice(cursor);
      break;
    }

    const labelEnd = markdown.indexOf("]", labelStart + 1);
    if (labelEnd < 0) {
      output += markdown.slice(cursor, labelStart + 1);
      cursor = labelStart + 1;
      continue;
    }

    const label = markdown.slice(labelStart + 1, labelEnd).trim();
    const afterLabel = markdown[labelEnd + 1];
    if (
      markdown[labelStart - 1] !== "!" &&
      afterLabel !== "(" &&
      isBareBracketLinkLabel(label)
    ) {
      output += markdown.slice(cursor, labelStart);
      output += buildHaluLink(label, slugify(label), label);
      cursor = labelEnd + 1;
      continue;
    }

    if (markdown.slice(labelEnd, labelEnd + 6) !== "](halu") {
      output += markdown.slice(cursor, labelStart + 1);
      cursor = labelStart + 1;
      continue;
    }

    const destinationStart = labelEnd + 2;
    if (markdown.slice(destinationStart, destinationStart + 5) !== "halu:") {
      output += markdown.slice(cursor, labelStart + 1);
      cursor = labelStart + 1;
      continue;
    }

    const slugStart = destinationStart + 5;
    let slugEnd = slugStart;
    while (
      slugEnd < markdown.length &&
      !/[)"\t\r\n ]/.test(markdown[slugEnd])
    ) {
      slugEnd += 1;
    }

    const rawSlug = markdown.slice(slugStart, slugEnd).replace(/-+$/, "");
    const targetSlug = slugify(rawSlug);
    if (!targetSlug) {
      output += markdown.slice(cursor, labelStart + 1);
      cursor = labelStart + 1;
      continue;
    }

    let position = slugEnd;
    while (markdown[position] === " " || markdown[position] === "\t")
      position += 1;

    let hint = "";
    let linkEnd = -1;
    if (markdown[position] === '"') {
      const hintStart = position + 1;
      const closingQuote = markdown.indexOf('"', hintStart);
      const closingParen = markdown.indexOf(")", hintStart);
      if (
        closingParen >= 0 &&
        (closingQuote < 0 || closingParen < closingQuote)
      ) {
        hint = markdown.slice(hintStart, closingParen);
        linkEnd = closingParen + 1;
      } else if (closingQuote >= 0) {
        hint = markdown.slice(hintStart, closingQuote);
        let afterQuote = closingQuote + 1;
        while (markdown[afterQuote] === " " || markdown[afterQuote] === "\t")
          afterQuote += 1;
        if (markdown[afterQuote] === ")") linkEnd = afterQuote + 1;
      }
    } else if (markdown[position] === ")") {
      linkEnd = position + 1;
    }

    if (linkEnd < 0) {
      output += markdown.slice(cursor, labelStart + 1);
      cursor = labelStart + 1;
      continue;
    }

    output += markdown.slice(cursor, labelStart);
    output += buildHaluLink(label, targetSlug, hint.trim());
    cursor = linkEnd;
  }

  return output;
}

export function fixSlugVisibleText(markdown: string): string {
  return normalizeHaluLinks(markdown).replace(
    LINK_RE,
    (match, visibleLabel: string, rawSlug: string, hint: string) => {
      const trimmed = visibleLabel.trim();
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(trimmed)) return match;
      if (!/[-]/.test(trimmed)) return match;
      const title = slugToTitle(trimmed);
      return buildHaluLink(title, rawSlug, hint ?? "");
    },
  );
}

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

function renderTeX(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode,
      output: "html",
      strict: "ignore",
      throwOnError: false,
      trust: false,
    });
  } catch {
    return escapeHtml(tex.trim());
  }
}

md.block.ruler.before(
  "fence",
  "block_tex",
  (state, startLine, endLine, silent) => {
    const startPos = state.bMarks[startLine] + state.tShift[startLine];
    if (state.src.slice(startPos, startPos + 2) !== "$$") return false;
    const restOfStart = state.src
      .slice(startPos + 2, state.eMarks[startLine])
      .trim();
    if (restOfStart) {
      const inlineClose = restOfStart.indexOf("$$");
      if (inlineClose >= 0) {
        if (!silent) {
          const token = state.push("block_tex", "", 0);
          token.content = restOfStart.slice(0, inlineClose);
          token.map = [startLine, startLine + 1];
        }
        state.line = startLine + 1;
        return true;
      }
    }
    let nextLine = startLine + 1;
    while (nextLine < endLine) {
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineText = state.src
        .slice(lineStart, state.eMarks[nextLine])
        .trim();
      if (lineText === "$$") break;
      nextLine += 1;
    }
    if (nextLine >= endLine) return false;
    if (!silent) {
      const content = state
        .getLines(startLine + 1, nextLine, state.tShift[startLine], false)
        .trim();
      const token = state.push("block_tex", "", 0);
      token.content = restOfStart ? `${restOfStart}\n${content}` : content;
      token.map = [startLine, nextLine + 1];
    }
    state.line = nextLine + 1;
    return true;
  },
);

md.renderer.rules.block_tex = (tokens, idx) =>
  `<div class="math-block">${renderTeX(tokens[idx].content, true)}</div>\n`;

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

md.renderer.rules.inline_tex = (tokens, idx) =>
  `<span class="math-inline">${renderTeX(tokens[idx].content, false)}</span>`;

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) =>
    self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const hrefIndex = tokens[idx].attrIndex("href");
  const titleIndex = tokens[idx].attrIndex("title");
  const href =
    hrefIndex >= 0 ? (tokens[idx].attrs?.[hrefIndex]?.[1] ?? "") : "";
  if (href.startsWith("#")) {
    return defaultLinkOpen(tokens, idx, options, env, self);
  }
  if (!href.startsWith("halu:")) {
    tokens[idx].attrSet("href", "#");
    if (titleIndex >= 0) tokens[idx].attrs?.splice(titleIndex, 1);
    return defaultLinkOpen(tokens, idx, options, env, self);
  }

  let visibleText = "";
  for (
    let i = idx + 1;
    i < tokens.length && tokens[i].type !== "link_close";
    i++
  ) {
    if (tokens[i].type === "text" || tokens[i].type === "code_inline") {
      visibleText += tokens[i].content;
    }
  }
  const wikiPath = visibleText.trim()
    ? `/wiki/${titleToWikiSegment(visibleText.trim())}`
    : `/wiki/${titleToWikiSegment(slugToTitle(slugify(href.slice("halu:".length))))}`;
  tokens[idx].attrSet("href", wikiPath);
  if (titleIndex >= 0) tokens[idx].attrs?.splice(titleIndex, 1);
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function normalizeMarkdown(input: string): string {
  let markdown = input.trim();
  markdown = markdown
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  markdown = markdown.replace(/<!--[\s\S]*?-->/g, "");
  markdown = markdown.replace(/<script[\s\S]*?<\/script>/gi, "");
  markdown = markdown.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  markdown = markdown.replace(/<\/?[a-z][^>]*>/gi, "");
  markdown = convertWikilinks(markdown);
  markdown = truncateAtDuplicateH1(markdown);
  return markdown;
}

function convertWikilinks(markdown: string): string {
  return markdown.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, target: string, display?: string) => {
      const title = (display || target).trim();
      const slug = slugify(target.trim());
      return buildHaluLink(title, slug, title);
    },
  );
}

function truncateAtDuplicateH1(markdown: string): string {
  const firstH1 = markdown.match(/^#\s+.+$/m);
  if (!firstH1) return markdown;
  const afterFirst = firstH1.index! + firstH1[0].length;
  const rest = markdown.slice(afterFirst);
  const secondH1 = rest.match(/^#\s+.+$/m);
  if (!secondH1) return markdown;
  return markdown
    .slice(0, afterFirst + secondH1.index!)
    .replace(/\n{2,}$/, "\n")
    .trim();
}

export function extractInternalLinks(markdown: string): ParsedInternalLink[] {
  const links: ParsedInternalLink[] = [];
  const seen = new Set<string>();
  const pattern = new RegExp(LINK_RE.source, LINK_RE.flags);
  let match: RegExpExecArray | null;
  const normalizedMarkdown = normalizeHaluLinks(markdown);

  while ((match = pattern.exec(normalizedMarkdown)) !== null) {
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

export function stripTopLevelSections(
  markdown: string,
  headings: string[],
): string {
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
  return md.render(normalizeHaluLinks(markdown));
}

export function summaryMarkdownFromArticle(markdown: string): string {
  const withoutTitle = markdown.replace(/^#\s+.+?$/m, "").trim();
  const withoutDerivedSections = stripTopLevelSections(withoutTitle, [
    "References",
    "See also",
  ]);
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
    .trim();
}

export function firstParagraphMarkdownFromArticle(markdown: string): string {
  const withoutTitle = markdown.replace(/^#\s+.+?$/m, "").trim();
  const withoutDerivedSections = stripTopLevelSections(withoutTitle, [
    "References",
    "See also",
  ]);
  return (
    withoutDerivedSections
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .find((part) => part && !part.startsWith("## ")) ?? ""
  );
}

export function extractTitle(markdown: string, fallbackSlug: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  const raw = match?.[1]?.trim() || fallbackSlug;
  return raw.replace(/\*+([^*]+)\*+/g, "$1").replace(/_+([^_]+)_+/g, "$1");
}

export function extractDisplayTitle(markdown: string): string | undefined {
  const match = markdown.match(/^#\s+(.+)$/m);
  if (!match) return undefined;
  const raw = match[1].trim();
  if (/[*_]/.test(raw)) return raw;
  return undefined;
}

export function stripSelfLinks(markdown: string, selfSlug: string): string {
  return normalizeHaluLinks(markdown).replace(
    LINK_RE,
    (match, visibleLabel, rawSlug) => {
      return slugify(rawSlug) === selfSlug ? visibleLabel : match;
    },
  );
}

export function leadBoldsTitle(markdown: string, title: string): boolean {
  const body = markdown.replace(/^#\s+.+?$/m, "").trim();
  const firstParagraph = body
    .split(/\n{2,}/)
    .find((p) => p.trim() && !p.trim().startsWith("##"));
  if (!firstParagraph) return false;
  const boldPattern = /\*\*([^*]+)\*\*/g;
  let match: RegExpExecArray | null;
  while ((match = boldPattern.exec(firstParagraph)) !== null) {
    if (slugify(match[1]) === slugify(title)) return true;
  }
  return false;
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
  const headings: Array<{
    title: string;
    start: number;
    end: number;
    raw: string;
  }> = [];
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(markdown)) !== null) {
    headings.push({
      title: match[1].trim(),
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
    });
  }

  const ranges: SectionRange[] = [];
  const leadEnd = headings[0]?.start ?? markdown.length;
  const lead = markdown.slice(bodyStart, leadEnd).trim();
  if (lead) {
    ranges.push({
      id: "lead",
      title: "Lead",
      start: bodyStart,
      end: leadEnd,
      heading: "",
    });
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

export function articleSectionMarkdown(
  markdown: string,
  sectionId: string,
): string {
  const range = sectionRanges(markdown).find(
    (section) => section.id === sectionId,
  );
  return range ? markdown.slice(range.start, range.end).trim() : markdown;
}

export function replaceArticleSection(
  markdown: string,
  sectionId: string,
  nextSectionMarkdown: string,
): string {
  const range = sectionRanges(markdown).find(
    (section) => section.id === sectionId,
  );
  if (!range) return nextSectionMarkdown.trim();

  let replacement = nextSectionMarkdown.trim();
  if (sectionId === "lead") {
    replacement = replacement
      .replace(/^#\s+.+?$/m, "")
      .replace(/^##\s+.+?$/m, "")
      .trim();
    replacement = replacement ? `\n\n${replacement}\n\n` : "\n\n";
  } else if (!replacement.match(/^##\s+/m)) {
    replacement = `${range.heading}\n\n${replacement}`;
  }

  return `${markdown.slice(0, range.start).trimEnd()}${replacement.startsWith("\n") ? "" : "\n\n"}${replacement}${replacement.endsWith("\n") ? "" : "\n\n"}${markdown.slice(range.end).trimStart()}`.trim();
}
