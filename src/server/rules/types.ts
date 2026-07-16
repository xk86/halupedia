/**
 * Rule library types.
 *
 * A "rule" is a single Markdown bullet plus metadata: how hard it is to break
 * (`tier`) and, optionally, which other rule(s) it supersedes when both are
 * selected for the same prompt (`overrides`). Rules live in category files
 * under `config/rules/*.toml` and are addressed globally as `category/id`.
 *
 * Tier is "how hard is this rule" — 1 never breaks, 4 is a suggestion.
 * `overrides` is a separate axis — "which rule does this one replace" — so a
 * normal-strength rule (e.g. a per-article vibe rule) can still displace a
 * tier-2 default without being demoted to a suggestion itself.
 */

export type RuleTier = 1 | 2 | 3 | 4;

export const RULE_TIERS: readonly RuleTier[] = [1, 2, 3, 4];

/** Display heading for each tier when rendering an assembled prompt. Naming is
 *  provisional — swap the strings here, nothing else needs to change. */
export const TIER_LABELS: Record<RuleTier, string> = {
  1: "Tier 1 — Never break",
  2: "Tier 2 — Required",
  3: "Tier 3 — Default",
  4: "Tier 4 — Suggested",
};

/** A single rule as authored in a category TOML file (or inline as a
 *  prompt-local rule). Not yet qualified with a category/ref. */
export interface RuleDef {
  id: string;
  tier: RuleTier;
  /** Markdown bullet body — no leading "- ", no trailing newline. */
  text: string;
  /** Fully-qualified refs ("category/id") this rule supersedes when both
   *  would otherwise be included in the same assembled prompt. */
  overrides?: string[];
}

/** One `config/rules/<category>.toml` file after parsing. */
export interface RuleCategoryFile {
  /** Filename stem; also the category id used in refs and selectors. */
  category: string;
  /** Display label, e.g. "Tone rules", "Formatting helpers". */
  label: string;
  /** Secondary sort key: within the same tier, lower `order` sorts first. */
  order: number;
  rules: RuleDef[];
}

export type RuleSource = "library" | "local" | "runtime";

/** A rule fully qualified with its category and where it came from. */
export interface ResolvedRule extends RuleDef {
  /** "category/id" — globally unique. */
  ref: string;
  category: string;
  categoryLabel: string;
  categoryOrder: number;
  source: RuleSource;
  /** Stable index for tie-breaking sort order within tier+category. */
  sequence: number;
}

export interface RuleLibrary {
  categories: Map<string, RuleCategoryFile>;
  rulesByRef: Map<string, ResolvedRule>;
}

/** A prompt's rule selection, as declared in its own TOML under `[rules]`. */
export interface RuleSpec {
  /** Selector strings: "category", "category@N", "category@N-M", "category/id". */
  include: string[];
  exclude?: string[];
}

export interface DroppedRule {
  ref: string;
  /** The ref of the rule whose `overrides` caused this one to be dropped. */
  supersededBy: string;
}

/** Two included rules each claim to override the other; both are kept and
 *  this is recorded so the conflict is visible in the trace/log rather than
 *  silently resolved by input order. */
export interface OverrideConflict {
  a: string;
  b: string;
}

export interface AssembledRuleEntry {
  ref: string;
  tier: RuleTier;
  category: string;
  source: RuleSource;
}

export interface AssembledRules {
  /** Formatted Markdown: tier-major sections, each a heading + bullet list. */
  text: string;
  included: AssembledRuleEntry[];
  dropped: DroppedRule[];
  conflicts: OverrideConflict[];
  tierCounts: Record<RuleTier, number>;
  /** Stable hash over the resolved rule set (refs + text) — use in place of
   *  a hash of the raw template so drift detection still works once prompt
   *  text is assembled rather than static. */
  hash: string;
}
