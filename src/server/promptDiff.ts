import DiffMatchPatch from "diff-match-patch";

const dmp = new DiffMatchPatch();

/** Returns a serialized reverse patch (applying it to newText yields oldText). */
export function makeReversePatch(oldText: string, newText: string): string {
  const patches = dmp.patch_make(newText, oldText);
  return dmp.patch_toText(patches);
}

/**
 * Applies a stored patch to text.
 * Returns the resulting text, or null if any hunk failed to apply.
 */
export function applyPatch(patchText: string, text: string): string | null {
  if (!patchText) return text;
  const patches = dmp.patch_fromText(patchText);
  const [result, results] = dmp.patch_apply(patches, text);
  if ((results as boolean[]).some((ok) => !ok)) return null;
  return result;
}
