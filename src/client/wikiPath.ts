export function toWikiSegment(titleOrSlug: string): string {
  let segment = titleOrSlug
    .trim()
    .replace(/\s+/g, "_")
    // Keep letters, numbers, emoji/symbols (\p{S}), underscore, and safe ASCII punctuation.
    .replace(/[^\p{L}\p{N}\p{S}_'(),.-]+/gu, "");
  const firstLetterIndex = segment.search(/\p{L}/u);
  if (firstLetterIndex >= 0) {
    segment = segment.slice(0, firstLetterIndex) + segment[firstLetterIndex].toUpperCase() + segment.slice(firstLetterIndex + 1);
  }
  return segment;
}

export function articleInputToWikiSegment(input: string): string {
  let raw = String(input ?? "").trim();
  const wikiIndex = raw.toLowerCase().indexOf("wiki/");
  if (wikiIndex >= 0) raw = raw.slice(wikiIndex + "wiki/".length);
  raw = raw.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "");
  if (!raw) return "";
  // Always normalize spaces to underscores so the URL is copy-pasteable immediately.
  return toWikiSegment(raw);
}
