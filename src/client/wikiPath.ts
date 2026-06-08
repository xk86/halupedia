export function toWikiSegment(titleOrSlug: string): string {
  let segment = titleOrSlug
    .trim()
    .replace(/\s+/g, "_")
    // Keep letters, numbers, pictographic emoji, underscore, and safe ASCII
    // punctuation. Must match the server's titleToWikiSegment allowed-set
    // exactly so client- and server-built /wiki/ URLs are byte-identical —
    // a mismatch (e.g. emoji kept on one side, stripped on the other) lands
    // the user on a different slug. Emoji are kept (not stripped) so a title
    // like "Chiquita 🍌" round-trips through its URL.
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}_'(),.-]+/gu, "");
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
