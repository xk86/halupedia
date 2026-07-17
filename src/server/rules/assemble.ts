import { createHash } from "node:crypto";
import { TIER_LABELS } from "./types";
import type {
  AssembledRuleEntry,
  AssembledRules,
  DroppedRule,
  OverrideConflict,
  ResolvedRule,
  RuleDef,
  RuleLibrary,
  RuleSpec,
  RuleTier,
} from "./types";

export class RuleSelectorError extends Error {}

/** A prompt-local rule, or a per-article (vibe) rule supplied at render time.
 *  Neither lives in the static library; both are merged in at assembly. */
export interface RuntimeRuleInput extends RuleDef {
  categoryTitle?: string;
  categoryDescription?: string;
}

/** Parses one `rules` entry: `"category/id"`, `"category/*"`, or either
 *  prefixed with `!` to exclude. See `RuleSpec` for the full syntax. */
const RULE_SELECTOR_RE = /^(!)?([a-z][a-z0-9_]*)\/(\*|[a-z][a-z0-9_]*)$/;

interface ParsedRuleSelector {
  raw: string;
  exclude: boolean;
  category: string;
  /** "*" for a whole-category wildcard, otherwise a single rule id. */
  id: string;
}

function parseRuleSelector(raw: string): ParsedRuleSelector {
  const match = RULE_SELECTOR_RE.exec(raw);
  if (!match) {
    throw new RuleSelectorError(
      `invalid rule selector '${raw}' — expected "category/id", "category/*", or either prefixed with "!"`,
    );
  }
  const [, bang, category, id] = match;
  return { raw, exclude: !!bang, category: category!, id: id! };
}

/** Every rule a selector's category+id addresses, checked against the
 *  imported-namespace set. Throws on an unknown category/rule, exactly as
 *  before — a typo in a selector should fail loudly at load time. */
function expandRuleSelector(
  library: RuleLibrary,
  importedCategories: Set<string>,
  parsed: ParsedRuleSelector,
): ResolvedRule[] {
  if (!importedCategories.has(parsed.category)) {
    throw new RuleSelectorError(
      `selected rule '${parsed.raw}' requires imported category '${parsed.category}'`,
    );
  }
  if (parsed.id === "*") {
    const category = library.categories.get(parsed.category);
    if (!category) {
      throw new RuleSelectorError(`unknown imported rule category '${parsed.category}'`);
    }
    return category.rules.map((rule) => library.rulesByRef.get(`${parsed.category}/${rule.id}`)!);
  }
  const ref = `${parsed.category}/${parsed.id}`;
  const rule = library.rulesByRef.get(ref);
  if (!rule) throw new RuleSelectorError(`unknown selected rule '${ref}'`);
  return [rule];
}

/** `categories` imports namespaces a rule may be selected from; `"*"`
 *  imports every namespace in the library. */
function resolveImportedCategories(library: RuleLibrary, categories: string[]): Set<string> {
  if (categories.includes("*")) {
    return new Set(library.categories.keys());
  }
  for (const category of categories) {
    if (!library.categories.has(category)) {
      throw new RuleSelectorError(`unknown imported rule category '${category}'`);
    }
  }
  return new Set(categories);
}

export interface AssembleOptions {
  /** Rules declared inline in the prompt's own TOML — never selectable from
   *  another prompt. Grouped under a synthetic "local" category by default. */
  localRules?: RuntimeRuleInput[];
  /** Rules supplied at render time (e.g. a per-article vibe). Grouped under
   *  a synthetic "vibe" category by default. */
  runtimeRules?: RuntimeRuleInput[];
  /** Used to namespace local-rule refs so two prompts' local rules with the
   *  same id can't collide ("local/<promptKey>__<id>"). */
  promptKey?: string;
}

const LOCAL_CATEGORY_ORDER = 9_000;
const RUNTIME_CATEGORY_ORDER = 9_500;
const LOCAL_CATEGORY_DESCRIPTION = "Rules authored only for this prompt, not shared with any other.";
const RUNTIME_CATEGORY_DESCRIPTION =
  "This article's own worldbuilding rules, layered on top of the shared defaults.";

function qualifyRuntimeRule(
  rule: RuntimeRuleInput,
  opts: {
    source: "local" | "runtime";
    defaultCategory: string;
    defaultCategoryTitle: string;
    defaultCategoryDescription: string;
    defaultOrder: number;
    namespace?: string;
    sequence: number;
  },
): ResolvedRule {
  const category = rule.category ?? opts.defaultCategory;
  const id = opts.namespace ? `${opts.namespace}__${rule.id}` : rule.id;
  return {
    ...rule,
    id,
    ref: `${category}/${id}`,
    category,
    categoryTitle: rule.categoryTitle ?? opts.defaultCategoryTitle,
    categoryDescription: rule.categoryDescription ?? opts.defaultCategoryDescription,
    categoryOrder: opts.defaultOrder,
    source: opts.source,
    sequence: opts.sequence,
  };
}

/**
 * Assemble one prompt's rule set. `categories` imports namespaces but does not
 * select their rules; `rules` selects from imported namespaces via pathlike
 * selectors (single rule, whole-category wildcard, or either negated to
 * exclude — see `RuleSpec`), resolved against the static library. Merge in
 * local and runtime (vibe) rules, drop any rule superseded by another
 * included rule's `overrides`, then sort tier-major (tier 1 first) and render
 * as Markdown.
 *
 * Override resolution is a single pass over the combined set — it is not
 * transitive. A rule can only drop a rule that is directly named in its own
 * `overrides` list; it does not chase multi-hop chains. Two rules that both
 * claim to override each other are a conflict: neither is dropped, and the
 * conflict is recorded so it's visible rather than resolved by input order.
 */
export function assembleRules(
  library: RuleLibrary,
  spec: RuleSpec,
  options: AssembleOptions = {},
): AssembledRules {
  const resolved = new Map<string, ResolvedRule>();
  const importedCategories = resolveImportedCategories(library, spec.categories ?? []);

  const includeSelectors: ParsedRuleSelector[] = [];
  const excludeSelectors: ParsedRuleSelector[] = [];
  for (const raw of spec.rules ?? []) {
    const parsed = parseRuleSelector(raw);
    (parsed.exclude ? excludeSelectors : includeSelectors).push(parsed);
  }

  for (const parsed of includeSelectors) {
    for (const rule of expandRuleSelector(library, importedCategories, parsed)) {
      resolved.set(rule.ref, rule);
    }
  }

  let sequence = 100_000;
  for (const rule of options.localRules ?? []) {
    const qualified = qualifyRuntimeRule(rule, {
      source: "local",
      defaultCategory: "local",
      defaultCategoryTitle: "This prompt",
      defaultCategoryDescription: LOCAL_CATEGORY_DESCRIPTION,
      defaultOrder: LOCAL_CATEGORY_ORDER,
      namespace: options.promptKey,
      sequence: sequence++,
    });
    resolved.set(qualified.ref, qualified);
  }
  for (const rule of options.runtimeRules ?? []) {
    const qualified = qualifyRuntimeRule(rule, {
      source: "runtime",
      defaultCategory: "vibe",
      defaultCategoryTitle: "Article vibe",
      defaultCategoryDescription: RUNTIME_CATEGORY_DESCRIPTION,
      defaultOrder: RUNTIME_CATEGORY_ORDER,
      sequence: sequence++,
    });
    resolved.set(qualified.ref, qualified);
  }

  // Exclusions apply after every inclusion (static + local + runtime) is
  // resolved, regardless of where in the `rules` list the "!" entry sits.
  // Excluding a rule inclusion never selected is an error, not a no-op — a
  // stale or typo'd exclusion should fail loudly rather than silently do
  // nothing.
  for (const parsed of excludeSelectors) {
    for (const rule of expandRuleSelector(library, importedCategories, parsed)) {
      if (!resolved.delete(rule.ref)) {
        throw new RuleSelectorError(
          `excluded rule '${rule.ref}' was not included by any selector`,
        );
      }
    }
  }

  const dropSet = new Map<string, string>();
  const conflicts: OverrideConflict[] = [];
  const conflictPairs = new Set<string>();
  for (const rule of resolved.values()) {
    for (const targetRef of rule.overrides ?? []) {
      const target = resolved.get(targetRef);
      if (!target || targetRef === rule.ref) continue;
      const mutual = (target.overrides ?? []).includes(rule.ref);
      if (mutual) {
        const pairKey = [rule.ref, targetRef].sort().join("|");
        if (!conflictPairs.has(pairKey)) {
          conflictPairs.add(pairKey);
          conflicts.push({ a: rule.ref, b: targetRef });
        }
        continue;
      }
      if (!dropSet.has(targetRef)) dropSet.set(targetRef, rule.ref);
    }
  }

  const finalRules = [...resolved.values()]
    .filter((rule) => !dropSet.has(rule.ref))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.categoryOrder !== b.categoryOrder) return a.categoryOrder - b.categoryOrder;
      return a.sequence - b.sequence;
    });

  const dropped: DroppedRule[] = [...dropSet.entries()].map(([ref, supersededBy]) => ({
    ref,
    supersededBy,
  }));

  const tierCounts = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<RuleTier, number>;
  for (const rule of finalRules) tierCounts[rule.tier]++;

  const included: AssembledRuleEntry[] = finalRules.map((rule) => ({
    ref: rule.ref,
    tier: rule.tier,
    category: rule.category,
    source: rule.source,
  }));

  return {
    text: formatRulesMarkdown(finalRules),
    included,
    dropped,
    conflicts,
    tierCounts,
    hash: hashRuleSet(finalRules),
  };
}

/**
 * Render already-sorted, already-filtered rules as tier-major Markdown. A
 * legend up front describes every category that appears anywhere in the set
 * (in first-appearance order), so within each tier section a category only
 * needs to be named — it becomes a level-3 heading with no description
 * repeated under it.
 */
export function formatRulesMarkdown(rules: readonly ResolvedRule[]): string {
  const legend: string[] = [];
  const seenCategories = new Set<string>();
  for (const rule of rules) {
    if (seenCategories.has(rule.category)) continue;
    seenCategories.add(rule.category);
    legend.push(
      rule.categoryDescription
        ? `**${rule.categoryTitle}** — ${rule.categoryDescription}`
        : `**${rule.categoryTitle}**`,
    );
  }

  const sections: string[] = [];
  if (legend.length > 0) sections.push(`## Categories\n\n${legend.join("\n\n")}`);

  for (const tier of [1, 2, 3, 4] as const) {
    const tierRules = rules.filter((rule) => rule.tier === tier);
    if (tierRules.length === 0) continue;
    const groups: string[] = [];
    let lastCategory: string | undefined;
    let bullets: string[] = [];
    const flush = () => {
      if (bullets.length > 0) groups.push(bullets.join("\n"));
      bullets = [];
    };
    for (const rule of tierRules) {
      if (rule.category !== lastCategory) {
        flush();
        lastCategory = rule.category;
        groups.push(`### ${rule.categoryTitle}`);
      }
      bullets.push(formatRuleMarkdown(rule));
    }
    flush();
    sections.push(`## ${TIER_LABELS[tier]}\n\n${groups.join("\n\n")}`);
  }
  return sections.join("\n\n");
}

function formatRuleMarkdown(rule: ResolvedRule): string {
  const lines = [`- ${rule.text}`];
  for (const example of rule.examples ?? []) {
    lines.push(`  > **Example — ${example.description}**`, "  >");
    for (const line of example.text.split("\n")) lines.push(`  > ${line}`);
  }
  return lines.join("\n");
}

function hashRuleSet(rules: readonly ResolvedRule[]): string {
  const payload = rules.map((rule) => ({
    ref: rule.ref,
    tier: rule.tier,
    text: rule.text,
    examples: rule.examples ?? [],
  }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}
