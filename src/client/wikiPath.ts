export function toWikiSegment(titleOrSlug: string): string {
  let segment = titleOrSlug
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_'(),.-]+/gu, "");
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
  if (wikiIndex >= 0 || raw.includes("_") || raw.includes("-")) {
    return raw;
  }
  return toWikiSegment(raw);
}
