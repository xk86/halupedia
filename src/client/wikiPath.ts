export function toWikiSegment(titleOrSlug: string): string {
  return titleOrSlug
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_'(),.-]+/gu, "");
}
