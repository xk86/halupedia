/**
 * Rule library types.
 *
 * A "rule" is a single Markdown bullet plus metadata: how hard it is to break
 * (`tier`), which category it belongs to (`category`, e.g. "tone",
 * "formatting" — see `categories.toml`), and, optionally, which other rule(s)
 * it supersedes when both are selected for the same prompt (`overrides`).
 * Library rules live in `config/rules/*.toml` and are addressed globally as
 * `category/id`. Category is an explicit field on each rule, not derived
 * from which file it happens to live in — `config/rules/categories.toml` is
 * the catalog of valid category ids, with the plain title/description a UI
 * (the admin rule picker) shows for each.
 *
 * Tier is "how hard is this rule" — 1 never breaks, 4 is a suggestion. It is
 * a separate axis from category: category is "what kind of concern is this"
 * (tone vs. formatting vs. linking), tier is "how strictly must it be obeyed".
 * `overrides` is a third, separate axis — "which rule does this one
 * replace" — so a normal-strength rule (e.g. a per-article vibe rule) can
 * still displace a tier-2 default without being demoted to a suggestion
 * itself.
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

/** One entry from `config/rules/categories.toml`'s `[[category]]` array —
 *  the catalog of valid category ids plus the plain title/description a UI
 *  shows for each. */
export interface CategoryDef {
  /** Lowercase snake_case id — what a rule's own `category` field and a
   *  selector's `category` segment refer to. */
  id: string;
  /** Plain display name, e.g. "Tone rules". */
  title: string;
  /** One or two sentences explaining what kind of concern this category
   *  covers — shown in the admin rule picker. */
  description: string;
  /** Secondary sort key: within the same tier, lower `order` sorts first. */
  order: number;
}

/** A single rule as authored in a rule TOML file (or inline as a
 *  prompt-local rule). Not yet qualified with a ref.
 *
 *  `category` is required for a library rule (validated against
 *  `categories.toml` at load time) but optional for a prompt-local or
 *  runtime (vibe) rule — those get a synthetic default category assigned by
 *  `assembleRules` if omitted, since they aren't part of the shared catalog. */
export interface RuleDef {
  id: string;
  category?: string;
  tier: RuleTier;
  /** Markdown bullet body — no leading "- ", no trailing newline. */
  text: string;
  /** Structured worked examples rendered as explanatory nested blockquotes. */
  examples?: RuleExample[];
  /** Fully-qualified refs ("category/id") this rule supersedes when both
   *  would otherwise be included in the same assembled prompt. */
  overrides?: string[];
}

export interface RuleExample {
  /** Condition or context that explains when the example applies. */
  description: string;
  /** Quoted Markdown example body. */
  text: string;
}

/** One category from `categories.toml`, plus every library rule declaring
 *  that category (via its own `category` field, from any rule file). */
export interface RuleCategory extends CategoryDef {
  rules: RuleDef[];
}

export type RuleSource = "library" | "local" | "runtime";

/** A rule fully qualified with its category and where it came from. */
export interface ResolvedRule extends RuleDef {
  /** "category/id" — globally unique. */
  ref: string;
  category: string;
  categoryTitle: string;
  categoryOrder: number;
  source: RuleSource;
  /** Stable index for tie-breaking sort order within tier+category. */
  sequence: number;
}

export interface RuleLibrary {
  categories: Map<string, RuleCategory>;
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
