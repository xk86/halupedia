export function slugifyRuleId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export function parseSelectorList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((selector) => selector.trim())
    .filter(Boolean);
}
