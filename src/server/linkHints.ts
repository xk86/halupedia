import type { IncomingHint } from "./db";
import { buildHaluLink } from "./markdown";
import { slugify } from "./slug";

export function formatIncomingHintsForPrompt(
  hints: IncomingHint[],
  targetSlug: string,
): string {
  if (!hints.length) return "(none yet)";
  const normalizedTarget = slugify(targetSlug);
  return hints
    .map((h) => {
      const label = h.visibleLabel || h.sourceTitle;
      return `- ${buildHaluLink(label, normalizedTarget, h.hiddenHint)}`;
    })
    .join("\n");
}
