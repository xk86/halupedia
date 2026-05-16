export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
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
  return title
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} _'(),.-]+/gu, "")
    .replace(/ /g, "_");
}

export function wikiSegmentToTitle(segment: string): string {
  return segment.trim().replace(/_/g, " ").replace(/\s+/g, " ");
}
