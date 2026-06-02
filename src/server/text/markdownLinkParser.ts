import { slugify, wikiSegmentToTitle } from "../slug";

export type MarkdownLinkKind =
  | "halu"
  | "ref"
  | "wiki"
  | "plain-slug"
  | "external"
  | "empty"
  | "unknown";

export type LinkDiagnosticCode =
  | "unclosed-label"
  | "unopened-label"
  | "unclosed-target"
  | "halu-outside-link"
  | "ref-outside-link"
  | "external-link"
  | "unsupported-target"
  | "missing-halu-hint"
  | "unknown-ref"
  | "bare-internal-marker"
  | "loose-internal-marker";

export interface LinkDiagnostic {
  code: LinkDiagnosticCode;
  start: number;
  end: number;
  severity: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface ParsedMarkdownLink {
  raw: string;
  label: string;
  target: string;
  title?: string;
  start: number;
  end: number;
  targetStart: number;
  targetEnd: number;
  kind: MarkdownLinkKind;
  slug?: string;
  hint?: string;
}

export type BareBracketKind =
  | "ref-marker"
  | "halu-marker"
  | "title-seed"
  | "unknown";

export interface ParsedBareBracket {
  raw: string;
  label: string;
  start: number;
  end: number;
  kind: BareBracketKind;
  slug?: string;
}

export interface ParsedLooseInternalMarker {
  raw: string;
  target: string;
  start: number;
  end: number;
  kind: "ref" | "halu";
  slug?: string;
  hint?: string;
}

export interface ParsedMarkdownLinks {
  links: ParsedMarkdownLink[];
  bareBrackets: ParsedBareBracket[];
  looseInternalMarkers: ParsedLooseInternalMarker[];
  diagnostics: LinkDiagnostic[];
}

function findClosingBracket(markdown: string, start: number): number {
  let escaped = false;
  for (let i = start + 1; i < markdown.length; i += 1) {
    const ch = markdown[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "]") return i;
    if (ch === "\n") return -1;
  }
  return -1;
}

function findClosingParen(markdown: string, start: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = start; i < markdown.length; i += 1) {
    const ch = markdown[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    if (ch === "\n") return -1;
  }
  return -1;
}

function findLenientClosingParen(markdown: string, start: number): number {
  let depth = 0;
  let escaped = false;
  for (let i = start; i < markdown.length; i += 1) {
    const ch = markdown[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    if (ch === "\n") return -1;
  }
  return -1;
}

function splitTarget(rawTarget: string): { target: string; title?: string } {
  const trimmed = rawTarget.trim();
  if (!trimmed) return { target: "" };

  const quoteIndex = (() => {
    const double = trimmed.indexOf('"');
    const single = trimmed.indexOf("'");
    if (double < 0) return single;
    if (single < 0) return double;
    return Math.min(double, single);
  })();

  if (quoteIndex >= 0) {
    const quote = trimmed[quoteIndex];
    const target = trimmed.slice(0, quoteIndex).trim();
    const titleStart = quoteIndex + 1;
    const titleEnd = trimmed.indexOf(quote, titleStart);
    const title = (titleEnd >= 0
      ? trimmed.slice(titleStart, titleEnd)
      : trimmed.slice(titleStart)
    ).trim();
    return { target, ...(title ? { title } : {}) };
  }

  return { target: trimmed };
}

function classifyTarget(target: string, title?: string): Pick<ParsedMarkdownLink, "kind" | "slug" | "hint"> {
  const trimmed = target.trim();
  if (!trimmed) return { kind: "empty" };
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) {
    return { kind: "external" };
  }
  if (trimmed.toLowerCase().startsWith("halu:")) {
    const raw = decodeWikiSegment(trimmed.slice("halu:".length).replace(/-+$/, "").trim());
    const slug = slugify(raw);
    return { kind: "halu", slug, hint: title?.trim() ?? "" };
  }
  if (trimmed.toLowerCase().startsWith("ref:")) {
    const raw = decodeWikiSegment(trimmed.slice("ref:".length).trim());
    return { kind: "ref", slug: slugify(raw) };
  }
  if (/^\/?wiki\//i.test(trimmed)) {
    const segment = trimmed.replace(/^\/?wiki\//i, "").replace(/[?#].*$/, "");
    return { kind: "wiki", slug: slugify(wikiSegmentToTitle(decodeWikiSegment(segment))) };
  }
  if (/^\/?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(trimmed) && trimmed.includes("-")) {
    return { kind: "plain-slug", slug: slugify(decodeWikiSegment(trimmed.replace(/^\//, ""))) };
  }
  return { kind: "unknown" };
}

function decodeWikiSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isInsideParsedLink(index: number, links: ParsedMarkdownLink[]): boolean {
  return links.some((link) => index >= link.start && index < link.end);
}

function isInsideParsedRange(
  index: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function classifyBareBracket(label: string): Pick<ParsedBareBracket, "kind" | "slug"> {
  const trimmed = label.trim();
  if (trimmed.toLowerCase().startsWith("ref:")) {
    return { kind: "ref-marker", slug: slugify(trimmed.slice("ref:".length).trim()) };
  }
  if (trimmed.toLowerCase().startsWith("halu:")) {
    return { kind: "halu-marker", slug: slugify(trimmed.slice("halu:".length).trim()) };
  }
  if (
    trimmed.length > 0 &&
    trimmed.length <= 120 &&
    !trimmed.startsWith("^") &&
    !trimmed.includes("|") &&
    !trimmed.includes('"') &&
    !/^https?:\/\//i.test(trimmed) &&
    /[\p{L}\p{N}]/u.test(trimmed)
  ) {
    return { kind: "title-seed", slug: slugify(trimmed) };
  }
  return { kind: "unknown" };
}

function parseBareBrackets(markdown: string, links: ParsedMarkdownLink[]): ParsedBareBracket[] {
  const brackets: ParsedBareBracket[] = [];
  let cursor = 0;
  while (cursor < markdown.length) {
    const labelStart = markdown.indexOf("[", cursor);
    if (labelStart < 0) break;
    if (markdown[labelStart - 1] === "!" || isInsideParsedLink(labelStart, links)) {
      cursor = labelStart + 1;
      continue;
    }
    const labelEnd = findClosingBracket(markdown, labelStart);
    if (labelEnd < 0) {
      cursor = labelStart + 1;
      continue;
    }
    if (markdown[labelEnd + 1] === "(") {
      cursor = labelEnd + 1;
      continue;
    }
    const label = markdown.slice(labelStart + 1, labelEnd);
    const classified = classifyBareBracket(label);
    brackets.push({
      raw: markdown.slice(labelStart, labelEnd + 1),
      label,
      start: labelStart,
      end: labelEnd + 1,
      ...classified,
    });
    cursor = labelEnd + 1;
  }
  return brackets;
}

function parseLooseInternalMarkers(
  markdown: string,
  links: ParsedMarkdownLink[],
): ParsedLooseInternalMarker[] {
  const ranges = links.map((link) => ({ start: link.start, end: link.end }));
  const markers: ParsedLooseInternalMarker[] = [];
  const markerPattern = /\((ref|halu):([^)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(markdown)) !== null) {
    if (isInsideParsedRange(match.index, ranges)) continue;
    const kind = match[1].toLowerCase() === "halu" ? "halu" : "ref";
    const target = match[2].trim();
    markers.push({
      raw: match[0],
      target,
      start: match.index,
      end: match.index + match[0].length,
      kind,
      slug: slugify(target),
    });
  }
  const nakedPattern = /\b(ref|halu):([a-z0-9][a-z0-9-]*)(?:[ \t]+(["'])(.*?)\3)?/gi;
  while ((match = nakedPattern.exec(markdown)) !== null) {
    const previousChar = markdown[match.index - 1];
    if (previousChar === "[") continue;
    if (isInsideParsedRange(match.index, ranges)) continue;
    if (isInsideParsedRange(match.index, markers)) continue;
    const kind = match[1].toLowerCase() === "halu" ? "halu" : "ref";
    const target = match[2].trim();
    const hint = match[4]?.trim();
    markers.push({
      raw: match[0],
      target,
      start: match.index,
      end: match.index + match[0].length,
      kind,
      slug: slugify(target),
      ...(hint ? { hint } : {}),
    });
  }
  markers.sort((a, b) => a.start - b.start || b.end - a.end);
  return markers;
}

function structuralDiagnostics(
  markdown: string,
  links: ParsedMarkdownLink[],
  bareBrackets: ParsedBareBracket[],
  looseInternalMarkers: ParsedLooseInternalMarker[],
): LinkDiagnostic[] {
  const diagnostics: LinkDiagnostic[] = [];
  const structuredRanges = [
    ...links.map((link) => ({ start: link.start, end: link.end })),
    ...bareBrackets.map((bracket) => ({ start: bracket.start, end: bracket.end })),
    ...looseInternalMarkers.map((marker) => ({ start: marker.start, end: marker.end })),
  ];

  for (const bracket of bareBrackets) {
    if (bracket.kind !== "ref-marker" && bracket.kind !== "halu-marker") continue;
    diagnostics.push({
      code: "bare-internal-marker",
      start: bracket.start,
      end: bracket.end,
      severity: "warn",
      message: `${bracket.kind === "ref-marker" ? "ref:" : "halu:"} appears in bare brackets`,
    });
  }

  for (const marker of looseInternalMarkers) {
    diagnostics.push({
      code: "loose-internal-marker",
      start: marker.start,
      end: marker.end,
      severity: "warn",
      message: `${marker.kind}: appears in a loose parenthesized marker`,
    });
  }

  for (const needle of ["halu:", "ref:"] as const) {
    let pos = 0;
    while (pos < markdown.length) {
      const index = markdown.toLowerCase().indexOf(needle, pos);
      if (index < 0) break;
      if (!isInsideParsedRange(index, structuredRanges)) {
        diagnostics.push({
          code: needle === "halu:" ? "halu-outside-link" : "ref-outside-link",
          start: index,
          end: index + needle.length,
          severity: "warn",
          message: `${needle} appears outside a valid markdown link`,
        });
      }
      pos = index + needle.length;
    }
  }

  return diagnostics;
}

export function parseMarkdownLinks(markdown: string): ParsedMarkdownLinks {
  const links: ParsedMarkdownLink[] = [];
  const diagnostics: LinkDiagnostic[] = [];
  let cursor = 0;

  while (cursor < markdown.length) {
    const labelStart = markdown.indexOf("[", cursor);
    if (labelStart < 0) break;
    if (markdown[labelStart - 1] === "!") {
      cursor = labelStart + 1;
      continue;
    }

    const labelEnd = findClosingBracket(markdown, labelStart);
    if (labelEnd < 0) {
      diagnostics.push({
        code: "unclosed-label",
        start: labelStart,
        end: labelStart + 1,
        severity: "warn",
        message: "markdown link label is not closed",
      });
      cursor = labelStart + 1;
      continue;
    }

    if (markdown[labelEnd + 1] !== "(") {
      cursor = labelEnd + 1;
      continue;
    }

    const targetOpen = labelEnd + 1;
    const strictTargetClose = findClosingParen(markdown, targetOpen);
    const lenientTargetClose = findLenientClosingParen(markdown, targetOpen);
    let targetClose = strictTargetClose;
    if (
      lenientTargetClose >= 0 &&
      (targetClose < 0 || lenientTargetClose < targetClose)
    ) {
      targetClose = lenientTargetClose;
    }
    if (targetClose < 0) {
      diagnostics.push({
        code: "unclosed-target",
        start: targetOpen,
        end: targetOpen + 1,
        severity: "warn",
        message: "markdown link target is not closed",
      });
      cursor = targetOpen + 1;
      continue;
    }

    const rawTarget = markdown.slice(targetOpen + 1, targetClose);
    const { target, title } = splitTarget(rawTarget);
    const classified = classifyTarget(target, title);
    const link: ParsedMarkdownLink = {
      raw: markdown.slice(labelStart, targetClose + 1),
      label: markdown.slice(labelStart + 1, labelEnd),
      target,
      ...(title !== undefined ? { title } : {}),
      start: labelStart,
      end: targetClose + 1,
      targetStart: targetOpen + 1,
      targetEnd: targetClose,
      ...classified,
    };
    links.push(link);

    if (link.kind === "external") {
      diagnostics.push({
        code: "external-link",
        start: link.targetStart,
        end: link.targetEnd,
        severity: "warn",
        message: "external markdown link is not supported",
      });
    } else if (link.kind === "halu" && !link.hint) {
      diagnostics.push({
        code: "missing-halu-hint",
        start: link.start,
        end: link.end,
        severity: "warn",
        message: "halu link is missing a hidden hint",
      });
    } else if (link.kind === "unknown") {
      diagnostics.push({
        code: "unsupported-target",
        start: link.targetStart,
        end: link.targetEnd,
        severity: "info",
        message: "markdown link target is not an internal supported target",
      });
    }

    cursor = targetClose + 1;
  }

  const bareBrackets = parseBareBrackets(markdown, links);
  const looseInternalMarkers = parseLooseInternalMarkers(markdown, links);
  diagnostics.push(
    ...structuralDiagnostics(markdown, links, bareBrackets, looseInternalMarkers),
  );
  return { links, bareBrackets, looseInternalMarkers, diagnostics };
}
