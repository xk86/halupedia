import type { ResolvedRule, RuleLibrary, RuleTier } from "./types";

export class RuleSelectorError extends Error {}

export interface ParsedSelector {
  category: string;
  /** Set only for a single-rule selector ("category/id"). */
  id?: string;
  /** Set only for a tier-scoped category selector ("category@N" or "category@N-M"). */
  tierMin?: number;
  tierMax?: number;
}

const CATEGORY_TIER_RE = /^([a-z][a-z0-9_]*)@(\d)(?:-(\d))?$/;
const CATEGORY_ID_RE = /^([a-z][a-z0-9_]*)\/([a-z][a-z0-9_]*)$/;
const CATEGORY_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Parse one selector string. Three forms:
 *   "category"        -> every rule in the category, any tier
 *   "category@N"       -> only tier N in the category
 *   "category@N-M"     -> tiers N..M inclusive in the category
 *   "category/id"      -> exactly one rule
 */
export function parseSelector(selector: string): ParsedSelector {
  const tierMatch = CATEGORY_TIER_RE.exec(selector);
  if (tierMatch) {
    const [, category, minStr, maxStr] = tierMatch;
    const tierMin = Number(minStr);
    const tierMax = maxStr ? Number(maxStr) : tierMin;
    if (tierMin > tierMax) {
      throw new RuleSelectorError(
        `invalid selector '${selector}': tier range must be ascending`,
      );
    }
    return { category: category!, tierMin, tierMax };
  }
  const idMatch = CATEGORY_ID_RE.exec(selector);
  if (idMatch) {
    return { category: idMatch[1]!, id: idMatch[2]! };
  }
  if (CATEGORY_RE.test(selector)) {
    return { category: selector };
  }
  throw new RuleSelectorError(`invalid rule selector '${selector}'`);
}

/**
 * Resolve one selector against the library. Throws if the category (or, for
 * a single-rule selector, the rule) doesn't exist — selectors are written by
 * prompt authors and a typo should fail loudly at load time, not silently
 * select nothing.
 */
export function resolveSelector(
  library: RuleLibrary,
  selector: string,
): ResolvedRule[] {
  const parsed = parseSelector(selector);
  const category = library.categories.get(parsed.category);
  if (!category) {
    throw new RuleSelectorError(
      `selector '${selector}': unknown rule category '${parsed.category}'`,
    );
  }

  if (parsed.id) {
    const ref = `${parsed.category}/${parsed.id}`;
    const rule = library.rulesByRef.get(ref);
    if (!rule) {
      throw new RuleSelectorError(`selector '${selector}': unknown rule '${ref}'`);
    }
    return [rule];
  }

  const inTierRange = (tier: RuleTier) =>
    parsed.tierMin === undefined ||
    (tier >= parsed.tierMin && tier <= (parsed.tierMax as number));

  return category.rules
    .filter((rule) => inTierRange(rule.tier))
    .map((rule) => library.rulesByRef.get(`${parsed.category}/${rule.id}`)!);
}

/** Resolve a list of selectors, deduping by ref while preserving first-seen order. */
export function resolveSelectors(
  library: RuleLibrary,
  selectors: readonly string[],
): ResolvedRule[] {
  const seen = new Map<string, ResolvedRule>();
  for (const selector of selectors) {
    for (const rule of resolveSelector(library, selector)) {
      if (!seen.has(rule.ref)) seen.set(rule.ref, rule);
    }
  }
  return [...seen.values()];
}
