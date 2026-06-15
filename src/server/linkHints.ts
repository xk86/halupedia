import type { IncomingHint } from "./db";
import { buildHaluLink } from "./markdown";
import { slugify } from "./slug";

export function formatIncomingHintsForPrompt(
  hints: IncomingHint[],
  targetSlug: string,
  /** Cap on hints included — heavily-backlinked articles can have hundreds,
   *  which alone can blow the model's context budget. 0 = no cap. */
  maxHints = 0,
): string {
  if (!hints.length) return "(none yet)";
  const normalizedTarget = slugify(targetSlug);
  const seen = new Set<string>();
  const deduped: IncomingHint[] = [];
  for (const h of hints) {
    const label = h.visibleLabel || h.sourceTitle;
    const key = `${slugify(label)}\0${h.hiddenHint.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(h);
  }
  const capped = maxHints > 0 ? deduped.slice(0, maxHints) : deduped;
  return capped
    .map((h) => {
      const label = h.visibleLabel || h.sourceTitle;
      return `- ${buildHaluLink(label, normalizedTarget, h.hiddenHint)}`;
    })
    .join("\n");
}
