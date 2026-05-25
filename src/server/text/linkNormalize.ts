import { slugToTitle, slugify } from "../slug";
import {
  parseMarkdownLinks,
  type BareBracketKind,
  type LinkDiagnostic,
  type MarkdownLinkKind,
  type ParsedBareBracket,
  type ParsedLooseInternalMarker,
  type ParsedMarkdownLink,
} from "./markdownLinkParser";
import { buildHaluLink } from "./links/haluLinks";

export type LinkPolicyContext =
  | "article"
  | "dyk"
  | "summary"
  | "see-also"
  | "references";

export interface NormalizedLink {
  original: ParsedMarkdownLink | ParsedBareBracket | ParsedLooseInternalMarker;
  kind: MarkdownLinkKind | BareBracketKind | "loose-ref" | "loose-halu";
  canonicalKind?: "halu" | "ref";
  slug?: string;
  hint?: string;
  action: "keep" | "rewrite" | "strip" | "inert" | "ignore";
  reason: string;
}

export interface LinkStats {
  total: number;
  halu: number;
  ref: number;
  wiki: number;
  plainSlug: number;
  external: number;
  unknown: number;
  bareRef: number;
  bareHalu: number;
  looseRef: number;
  looseHalu: number;
  rewritten: number;
  stripped: number;
  diagnostics: number;
}

export interface NormalizedMarkdown {
  markdown: string;
  links: NormalizedLink[];
  diagnostics: LinkDiagnostic[];
  stats: LinkStats;
  changed: boolean;
}

function emptyStats(): LinkStats {
  return {
    total: 0,
    halu: 0,
    ref: 0,
    wiki: 0,
    plainSlug: 0,
    external: 0,
    unknown: 0,
    bareRef: 0,
    bareHalu: 0,
    looseRef: 0,
    looseHalu: 0,
    rewritten: 0,
    stripped: 0,
    diagnostics: 0,
  };
}

function isSlugLikeLabel(label: string): boolean {
  // Label is a raw slug or a ref:/halu: marker — not a human-readable title.
  if (/^(ref|halu):/i.test(label)) return true;
  if (/^[a-z0-9][a-z0-9-]*$/.test(label) && label.includes("-")) return true;
  return false;
}

function displayLabel(link: ParsedMarkdownLink): string {
  const label = link.label.trim();
  if (!label || isSlugLikeLabel(label)) return link.slug ? slugToTitle(link.slug) : "";
  return label;
}

function fallbackHint(link: ParsedMarkdownLink): string {
  const label = displayLabel(link);
  return label || (link.slug ? slugToTitle(link.slug) : "");
}

function canonicalForLink(
  link: ParsedMarkdownLink,
  context: LinkPolicyContext,
): { text: string; normalized: NormalizedLink } {
  const label = displayLabel(link);

  if (link.kind === "halu") {
    // Slugify normalizes wiki-format slugs (The_American_Trade_Bloc → the-american-trade-bloc)
    // and any other non-canonical forms the model may emit.
    const slug = slugify(link.slug ?? "");
    const hint = link.hint?.trim() ?? "";
    if (!label || !slug) {
      return {
        text: label || link.raw,
        normalized: { original: link, kind: link.kind, action: "ignore", reason: "invalid_halu" },
      };
    }
    const text = buildHaluLink(label, slug, hint);
    // A halu link is already canonical if only difference from raw is the empty hint that
    // buildHaluLink appends ("") — avoid counting no-op normalizations as rewrites.
    const slugUnchanged = slug === (link.slug ?? "").trim();
    const isAlreadyCanonical = text === link.raw || (hint === "" && slugUnchanged && label === link.label.trim());
    return {
      text,
      normalized: {
        original: link,
        kind: link.kind,
        canonicalKind: "halu",
        slug,
        hint,
        action: isAlreadyCanonical ? "keep" : "rewrite",
        reason: isAlreadyCanonical ? "canonical_halu" : "canonicalize_halu",
      },
    };
  }

  if (link.kind === "ref") {
    const slug = slugify(link.slug ?? "");
    if (context === "see-also") {
      const text = buildHaluLink(label || slugToTitle(slug), slug, fallbackHint(link));
      return {
        text,
        normalized: {
          original: link,
          kind: link.kind,
          canonicalKind: "halu",
          slug,
          hint: fallbackHint(link),
          action: "rewrite",
          reason: "see_also_uses_halu",
        },
      };
    }
    const text = slug ? `[${label || slugToTitle(slug)}](ref:${slug})` : label;
    return {
      text,
      normalized: {
        original: link,
        kind: link.kind,
        canonicalKind: "ref",
        slug,
        action: text === link.raw ? "keep" : "rewrite",
        reason: text === link.raw ? "canonical_ref" : "canonicalize_ref",
      },
    };
  }

  if ((link.kind === "wiki" || link.kind === "plain-slug") && link.slug) {
    const title = label || slugToTitle(link.slug);
    const hint = fallbackHint(link);
    const text = context === "references"
      ? `[${title}](ref:${link.slug})`
      : buildHaluLink(title, link.slug, hint);
    return {
      text,
      normalized: {
        original: link,
        kind: link.kind,
        canonicalKind: context === "references" ? "ref" : "halu",
        slug: link.slug,
        hint: context === "references" ? undefined : hint,
        action: "rewrite",
        reason: link.kind === "wiki" ? "fallback_wiki" : "fallback_plain_slug",
      },
    };
  }

  if (link.kind === "external") {
    return {
      text: label,
      normalized: {
        original: link,
        kind: link.kind,
        action: "strip",
        reason: "external_links_forbidden",
      },
    };
  }

  return {
    text: link.raw,
    normalized: {
      original: link,
      kind: link.kind,
      action: "ignore",
      reason: "unsupported_target",
    },
  };
}

function canonicalForBareBracket(link: ParsedBareBracket): { text: string; normalized: NormalizedLink } {
  const label = link.label.trim();
  if (link.kind === "ref-marker" || link.kind === "halu-marker") {
    return {
      text: "",
      normalized: {
        original: link,
        kind: link.kind,
        slug: link.slug,
        action: "strip",
        reason: "bare_internal_marker_artifact",
      },
    };
  }

  if (link.kind === "title-seed" && label && link.slug) {
    const text = buildHaluLink(label, link.slug, label);
    return {
      text,
      normalized: {
        original: link,
        kind: link.kind,
        canonicalKind: "halu",
        slug: link.slug,
        hint: label,
        action: "rewrite",
        reason: "legacy_bare_title_seed",
      },
    };
  }

  return {
    text: link.raw,
    normalized: {
      original: link,
      kind: link.kind,
      action: "ignore",
      reason: "unsupported_bare_bracket",
    },
  };
}

function canonicalForLooseMarker(link: ParsedLooseInternalMarker): { text: string; normalized: NormalizedLink } {
  return {
    text: "",
    normalized: {
      original: link,
      kind: link.kind === "halu" ? "loose-halu" : "loose-ref",
      slug: link.slug,
      action: "strip",
      reason: "loose_internal_marker_artifact",
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isInsideRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function linkNearestPrecedingTitle(
  markdownPrefix: string,
  slug: string,
  canonicalKind: "ref" | "halu",
  hint?: string,
): { markdown: string; linked: boolean } {
  const title = slugToTitle(slug);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(title).replace(/\\ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");
  const linkRanges = parseMarkdownLinks(markdownPrefix).links.map((link) => ({ start: link.start, end: link.end }));
  const paragraphBreak = markdownPrefix.lastIndexOf("\n\n");
  const sentenceBreak = markdownPrefix.lastIndexOf(".");
  const clauseBreak = markdownPrefix.lastIndexOf(";");
  const searchFloor = Math.max(
    paragraphBreak >= 0 ? paragraphBreak + 2 : 0,
    sentenceBreak >= 0 ? sentenceBreak + 1 : 0,
    clauseBreak >= 0 ? clauseBreak + 1 : 0,
  );
  let match: RegExpExecArray | null;
  let candidate: { start: number; end: number; visible: string } | null = null;
  while ((match = pattern.exec(markdownPrefix)) !== null) {
    if (match.index < searchFloor) continue;
    if (isInsideRange(match.index, linkRanges)) continue;
    candidate = { start: match.index, end: match.index + match[0].length, visible: match[0] };
  }
  if (!candidate) return { markdown: markdownPrefix.replace(/[ \t]+$/, ""), linked: false };
  const linked = canonicalKind === "ref"
    ? `[${candidate.visible}](ref:${slug})`
    : buildHaluLink(candidate.visible, slug, hint?.trim() || candidate.visible);
  return {
    markdown:
      markdownPrefix.slice(0, candidate.start) +
      linked +
      markdownPrefix.slice(candidate.end).replace(/[ \t]+$/, ""),
    linked: true,
  };
}

/** Fenced code block ranges (``` ... ``` and ` ... `) to skip during normalization. */
function fencedCodeRanges(markdown: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  // Fenced blocks: ``` ... ```
  const fenceRe = /^```[\s\S]*?^```\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(markdown)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  // Inline code: `...`
  const inlineRe = /`[^`]+`/g;
  while ((m = inlineRe.exec(markdown)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}

export function normalizeMarkdownLinks(
  markdown: string,
  context: LinkPolicyContext = "article",
): NormalizedMarkdown {
  const parsed = parseMarkdownLinks(markdown);
  const stats = emptyStats();
  stats.total =
    parsed.links.length +
    parsed.bareBrackets.length +
    parsed.looseInternalMarkers.length;
  stats.diagnostics = parsed.diagnostics.length;

  if (
    parsed.links.length === 0 &&
    parsed.bareBrackets.length === 0 &&
    parsed.looseInternalMarkers.length === 0
  ) {
    return {
      markdown,
      links: [],
      diagnostics: parsed.diagnostics,
      stats,
      changed: false,
    };
  }

  // Build fenced code block exclusion ranges so we never modify code content.
  const codeRanges = fencedCodeRanges(markdown);

  let output = "";
  let cursor = 0;
  const links: NormalizedLink[] = [];
  const tokens = [
    ...parsed.links.map((link) => ({ type: "link" as const, start: link.start, end: link.end, link })),
    ...parsed.bareBrackets.map((link) => ({ type: "bare" as const, start: link.start, end: link.end, link })),
    ...parsed.looseInternalMarkers.map((link) => ({ type: "loose" as const, start: link.start, end: link.end, link })),
  ].sort((a, b) => a.start - b.start || b.end - a.end);

  for (const token of tokens) {
    if (token.start < cursor) continue;
    // Skip any token that falls inside a fenced code block.
    if (codeRanges.some((r) => token.start >= r.start && token.end <= r.end)) continue;
    let replacement: { text: string; normalized: NormalizedLink };
    if (token.type === "link") {
      const link = token.link;
      if (link.kind === "halu") stats.halu += 1;
      else if (link.kind === "ref") stats.ref += 1;
      else if (link.kind === "wiki") stats.wiki += 1;
      else if (link.kind === "plain-slug") stats.plainSlug += 1;
      else if (link.kind === "external") stats.external += 1;
      else if (link.kind === "unknown") stats.unknown += 1;
      replacement = canonicalForLink(link, context);
    } else if (token.type === "bare") {
      const link = token.link;
      if (link.kind === "ref-marker") stats.bareRef += 1;
      else if (link.kind === "halu-marker") stats.bareHalu += 1;
      else if (link.kind === "unknown") stats.unknown += 1;
      replacement = canonicalForBareBracket(link);
    } else {
      const link = token.link;
      if (link.kind === "ref") stats.looseRef += 1;
      else stats.looseHalu += 1;
      replacement = canonicalForLooseMarker(link);
    }
    links.push(replacement.normalized);
    // Bare bracket expansions (bare→halu) are not counted as link rewrites since
    // they expand rather than change an existing link.
    if (replacement.normalized.action === "rewrite" && token.type !== "bare") stats.rewritten += 1;
    if (replacement.normalized.action === "strip") stats.stripped += 1;
    output += markdown.slice(cursor, token.start);
    if (token.type === "loose" && token.link.slug) {
      const linked = linkNearestPrecedingTitle(
        output,
        token.link.slug,
        token.link.kind,
        token.link.hint,
      );
      output = linked.markdown;
      if (linked.linked) replacement.normalized.reason = "loose_internal_marker_attached";
    }
    output += replacement.text;
    cursor = token.end;
  }
  output += markdown.slice(cursor);

  return {
    markdown: output,
    links,
    diagnostics: parsed.diagnostics,
    stats,
    changed: output !== markdown,
  };
}
