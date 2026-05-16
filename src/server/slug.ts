export function slugify(input: string): string {
  return input
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

export function titleToWikiSegment(title: string): string {
  let segment = title
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} _'(),.-]+/gu, "")
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
