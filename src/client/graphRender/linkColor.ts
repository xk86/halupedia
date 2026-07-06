import { fadeTowardNeutral, mixOkLch } from "./okLch";

/**
 * Resolve a link's gradient color from its endpoint node colors, looked up
 * by id rather than through the graph library's resolved node references.
 *
 * 3d-force-graph only replaces a link's raw `source`/`target` string ids with
 * live node object references once the link-force runs its first tick. A
 * link's mesh (and its baked-in material color) is built before that
 * resolution happens on a fresh mount, so reading `link.source.color` there
 * falls back to the neutral tone — and since nothing re-triggers a repaint
 * once the ids resolve, it never recovers. Looking colors up by id sidesteps
 * that timing race entirely.
 */
export function resolveGradientLinkColor(
  sourceId: string,
  targetId: string | null,
  neutral: string,
  colorById: Map<string, string>,
  intensity: number,
): string {
  const sourceColor = colorById.get(sourceId);
  const targetColor = targetId ? colorById.get(targetId) : undefined;
  if (!sourceColor || !targetColor) return neutral;
  const blended = mixOkLch(sourceColor, targetColor, 0.5);
  return fadeTowardNeutral(blended, neutral, intensity);
}
