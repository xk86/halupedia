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

export function slugToTitle(slug: string): string {
  if (!slug) return "Untitled";
  const title = slug
    .split("-")
    .filter(Boolean)
    .join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
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
