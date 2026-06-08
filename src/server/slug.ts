import { emojiToSlugWords } from "./text/emojiNames";

export function slugify(input: string): string {
  return emojiToSlugWords(input)
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 120);
}

export function normalizeCanonicalTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) return normalized;

  const firstLetterIndex = normalized.search(/\p{L}/u);
  if (firstLetterIndex < 0) return normalized;

  const firstLetter = normalized[firstLetterIndex];
  const rest = normalized.slice(firstLetterIndex + 1);
  if (firstLetter === firstLetter.toUpperCase()) return normalized;
  if (/\p{Lu}/u.test(rest)) return normalized;

  return `${normalized.slice(0, firstLetterIndex)}${firstLetter.toUpperCase()}${rest}`;
}

export function slugToTitle(slug: string): string {
  if (!slug) return "Untitled";
  const title = slug
    .split("-")
    .filter(Boolean)
    .join(" ");
  return normalizeCanonicalTitle(title);
}

// Characters allowed verbatim in a /wiki/ URL segment: letters, numbers,
// pictographic emoji, and a small safe-punctuation set. Emoji are KEPT (not
// stripped) so a title like "Chiquita 🍌" round-trips through its URL —
// dropping it produced "/wiki/Chiquita_", which slugified back to a different
// article ("chiquita"). Must stay identical to the client's toWikiSegment so
// both sides build byte-identical URLs.
const WIKI_SEGMENT_DISALLOWED = /[^\p{L}\p{N}\p{Extended_Pictographic} _'(),.-]+/gu;

export function titleToWikiSegment(title: string): string {
  let segment = normalizeCanonicalTitle(title)
    .trim()
    .replace(/\s+/g, " ")
    .replace(WIKI_SEGMENT_DISALLOWED, "")
    .replace(/ /g, "_");
  const firstLetterIndex = segment.search(/\p{L}/u);
  if (firstLetterIndex >= 0) {
    segment = segment.slice(0, firstLetterIndex) + segment[firstLetterIndex].toUpperCase() + segment.slice(firstLetterIndex + 1);
  }
  return segment;
}

export function wikiSegmentToTitle(segment: string): string {
  return segment.trim().replace(/_/g, " ").replace(/\s+/g, " ");
}

export function isSlugStyleWikiSegment(segment: string): boolean {
  const decoded = decodeURIComponent(segment).replace(/^\/+|\/+$/g, "");
  if (decoded.includes("_")) return false;
  if ((decoded.match(/-/g) ?? []).length < 2) return false;
  return slugify(wikiSegmentToTitle(decoded)) === decoded.toLowerCase();
}

export function wikiSegmentToRequestedTitle(segment: string): string {
  const decoded = decodeURIComponent(segment).replace(/^\/+|\/+$/g, "");
  if (isSlugStyleWikiSegment(decoded)) {
    return slugToTitle(slugify(decoded));
  }
  return wikiSegmentToTitle(decoded);
}
