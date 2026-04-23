/**
 * Canonical slug normalization. Used by router, API, and post-cache href rewriting.
 * Must be deterministic and idempotent: slugify(slugify(x)) === slugify(x).
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/['"`’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

/**
 * Convert a slug back into a plausible human title.
 * "the-glass-bishops-of-novgorod-1247" -> "The Glass Bishops of Novgorod 1247"
 * The LLM can reshape punctuation (commas etc.) as it sees fit.
 */
export function slugToTitle(slug: string): string {
  const small = new Set([
    "a", "an", "and", "as", "at", "but", "by", "for", "in", "of",
    "on", "or", "the", "to", "vs", "via", "with",
  ]);
  const words = slug.split("-").filter(Boolean);
  return words
    .map((w, i) => {
      if (i !== 0 && small.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}
