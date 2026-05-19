export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function textMentionsTitle(text: string, title: string): boolean {
  const normalizedTitle = title.replace(/\s+/g, " ").trim();
  if (normalizedTitle.length < 4) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedTitle)}([^\\p{L}\\p{N}]|$)`, "iu").test(text);
}

export function decodeWikiSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
