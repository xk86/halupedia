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
  const capped = maxHints > 0 ? hints.slice(0, maxHints) : hints;
  return capped
    .map((h) => {
      const label = h.visibleLabel || h.sourceTitle;
      return `- ${buildHaluLink(label, normalizedTarget, h.hiddenHint)}`;
    })
    .join("\n");
}
