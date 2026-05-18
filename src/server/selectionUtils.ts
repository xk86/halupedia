/**
 * Helpers for locating and normalising user text selections within article
 * markdown, and for finding candidate wrap ranges when adding inline links.
 *
 * These are pure / near-pure utilities with no database or LLM dependencies.
 */

import { markdownToPlainText } from "./markdown";

export const LARGE_SELECTION_CHAR_THRESHOLD = 120;
export const LARGE_SELECTION_WORD_THRESHOLD = 18;

export function normalizeSelectionText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

/**
 * Strip inline markdown formatting (bold, italic, links) while building a
 * map from each plain-text character index → its position in the raw markdown.
 * Used so we can locate a rendered-text selection inside the raw markdown source.
 */
function stripInlineMarkdownWithPositions(
  md: string,
): { plain: string; posMap: number[] } {
  const posMap: number[] = [];
  let plain = "";
  let i = 0;

  while (i < md.length) {
    if (md[i] === "*" && md[i + 1] === "*") { i += 2; continue; }
    if (md[i] === "_" && md[i + 1] === "_") { i += 2; continue; }

    if (md[i] === "[") {
      const labelEnd = md.indexOf("]", i + 1);
      if (labelEnd >= 0 && md[labelEnd + 1] === "(") {
        const parenClose = md.indexOf(")", labelEnd + 2);
        if (parenClose >= 0) {
          for (let j = i + 1; j < labelEnd; j++) {
            plain += md[j];
            posMap.push(j);
          }
          i = parenClose + 1;
          continue;
        }
      }
    }

    if (
      (md[i] === "*" || md[i] === "_") &&
      md[i + 1] !== "*" &&
      md[i + 1] !== "_"
    ) {
      i++;
      continue;
    }

    if (md[i] === "`") {
      const closeBacktick = md.indexOf("`", i + 1);
      if (closeBacktick >= 0) {
        for (let j = i + 1; j < closeBacktick; j++) {
          plain += md[j];
          posMap.push(j);
        }
        i = closeBacktick + 1;
        continue;
      }
    }

    plain += md[i];
    posMap.push(i);
    i++;
  }

  return { plain, posMap };
}

/**
 * Extend a markdown range outward to include any enclosing formatting markers
 * (bold **, italic *, link [label](url)) that straddle the current boundaries.
 */
function extendRangeToFormattingBoundaries(
  md: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let s = start;
  let e = end;

  while (s > 0) {
    const ch = md[s - 1];
    if (ch === "*" || ch === "_") {
      s--;
    } else if (ch === "[") {
      s--;
      break;
    } else {
      break;
    }
  }

  while (e < md.length) {
    const ch = md[e];
    if (ch === "*" || ch === "_") {
      e++;
    } else if (ch === "]" && md[e + 1] === "(") {
      const parenClose = md.indexOf(")", e + 2);
      if (parenClose >= 0) e = parenClose + 1;
      break;
    } else {
      break;
    }
  }

  return { start: s, end: e };
}

/**
 * Find the markdown character range that corresponds to a plain-text selection
 * made in the rendered article HTML.
 *
 * Falls back from a fast exact indexOf to a position-mapped search that
 * accounts for inline formatting markers. Returns null if the selection cannot
 * be located.
 */
export function findSelectionRangeInMarkdown(
  markdown: string,
  plainTextSelection: string,
): { start: number; end: number } | null {
  const normalized = normalizeSelectionText(plainTextSelection);
  if (!normalized) return null;

  const exactIdx = markdown.indexOf(normalized);
  if (exactIdx >= 0) {
    return extendRangeToFormattingBoundaries(markdown, exactIdx, exactIdx + normalized.length);
  }

  const { plain, posMap } = stripInlineMarkdownWithPositions(markdown);
  const plainNorm = plain.replace(/\s+/g, " ");
  const ptIdx = plainNorm.toLowerCase().indexOf(normalized.toLowerCase());
  if (ptIdx < 0) return null;

  const ptEnd = ptIdx + normalized.length - 1;
  const mdStart = posMap[ptIdx];
  const mdEnd = posMap[ptEnd];
  if (mdStart === undefined || mdEnd === undefined) return null;

  return extendRangeToFormattingBoundaries(markdown, mdStart, mdEnd + 1);
}

export function shouldRefineSelection(text: string): boolean {
  const normalized = normalizeSelectionText(text);
  return (
    normalized.length > LARGE_SELECTION_CHAR_THRESHOLD ||
    normalized.split(/\s+/).filter(Boolean).length > LARGE_SELECTION_WORD_THRESHOLD
  );
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordChar(char: string | undefined): boolean {
  return !!char && /[\p{L}\p{N}]/u.test(char);
}

export function collectExistingLinkRanges(
  markdown: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const pattern = /\[([^\]]*)\]\([^)]*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

export function overlapsExistingLink(
  index: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

export function findWrapRange(
  markdown: string,
  selectedText: string,
): { start: number; end: number; visibleLabel: string } | null {
  const normalizedSelection = normalizeSelectionText(selectedText);
  if (!normalizedSelection) return null;
  const linkRanges = collectExistingLinkRanges(markdown);
  const exact = new RegExp(escapeRegExp(normalizedSelection), "giu");
  let match: RegExpExecArray | null;

  while ((match = exact.exec(markdown)) !== null) {
    let start = match.index;
    let end = match.index + match[0].length;
    if (overlapsExistingLink(start, linkRanges)) continue;
    while (isWordChar(markdown[start - 1])) start -= 1;
    while (isWordChar(markdown[end])) end += 1;
    const visibleLabel = markdown.slice(start, end).trim();
    if (visibleLabel) return { start, end, visibleLabel };
  }

  const words = normalizedSelection.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    for (let size = words.length - 1; size >= 1; size--) {
      for (let offset = 0; offset + size <= words.length; offset++) {
        const phrase = words.slice(offset, offset + size).join(" ");
        const found = findWrapRange(markdown, phrase);
        if (found) return found;
      }
    }
  }

  return null;
}

export function extractSelectionExcerpt(
  markdown: string,
  selectedText: string,
): string {
  const normalizedSelection = normalizeSelectionText(selectedText);
  const source = markdownToPlainText(markdown);
  const index = source.toLowerCase().indexOf(normalizedSelection.toLowerCase());
  if (index < 0) return source.slice(0, 400);
  const start = Math.max(0, index - 180);
  const end = Math.min(source.length, index + normalizedSelection.length + 180);
  return source.slice(start, end).trim();
}
