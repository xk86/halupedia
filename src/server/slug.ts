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
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function titleToWikiSegment(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_'(),.-]+/gu, "");
}
