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
