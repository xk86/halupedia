import { createHash } from "node:crypto";
import { RuleSelectorError } from "./selector";
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

/** A prompt-local rule, or a per-article (vibe) rule supplied at render time.
 *  Neither lives in the static library; both are merged in at assembly. */
export interface RuntimeRuleInput extends RuleDef {
  categoryTitle?: string;
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

function qualifyRuntimeRule(
  rule: RuntimeRuleInput,
  opts: {
    source: "local" | "runtime";
    defaultCategory: string;
    defaultCategoryTitle: string;
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
    categoryOrder: opts.defaultOrder,
    source: opts.source,
    sequence: opts.sequence,
  };
}

/**
 * Assemble one prompt's rule set. `categories` imports namespaces but does not
 * select their rules; every authored shared rule must be explicitly listed in
 * `rules`, resolved against the static library. Merge in local and runtime
 * (vibe) rules, drop any rule superseded by another included rule's
 * `overrides`, then sort tier-major (tier 1 first) and render as Markdown.
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
  const importedCategories = new Set(spec.categories ?? []);
  for (const category of importedCategories) {
    if (!library.categories.has(category)) {
      throw new RuleSelectorError(`unknown imported rule category '${category}'`);
    }
  }
  for (const ref of spec.rules ?? []) {
    const rule = library.rulesByRef.get(ref);
    if (!rule) throw new RuleSelectorError(`unknown selected rule '${ref}'`);
    if (!importedCategories.has(rule.category)) {
      throw new RuleSelectorError(
        `selected rule '${ref}' requires imported category '${rule.category}'`,
      );
    }
    resolved.set(rule.ref, rule);
  }

  let sequence = 100_000;
  for (const rule of options.localRules ?? []) {
    const qualified = qualifyRuntimeRule(rule, {
      source: "local",
      defaultCategory: "local",
      defaultCategoryTitle: "This prompt",
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
      defaultOrder: RUNTIME_CATEGORY_ORDER,
      sequence: sequence++,
    });
    resolved.set(qualified.ref, qualified);
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

/** Render already-sorted, already-filtered rules as tier-major Markdown. */
export function formatRulesMarkdown(rules: readonly ResolvedRule[]): string {
  const sections: string[] = [];
  for (const tier of [1, 2, 3, 4] as const) {
    const tierRules = rules.filter((rule) => rule.tier === tier);
    if (tierRules.length === 0) continue;
    const bullets = tierRules.map(formatRuleMarkdown).join("\n");
    sections.push(`## ${TIER_LABELS[tier]}\n${bullets}`);
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
