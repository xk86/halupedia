export function slugifyRuleId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export function humanizeRuleId(value: string): string {
  const words = value.replaceAll("_", " ").trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "Untitled rule";
}
