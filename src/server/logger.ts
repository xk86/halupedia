export function logSection(title: string, lines: string[]) {
  console.log(`[halupedia] ${title}`);
  for (const line of lines) {
    console.log(`[halupedia]   ${line}`);
  }
}

export function truncateForLog(value: string, limit = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}
