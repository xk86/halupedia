import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import type { Logger } from "../logger";
import type { CategoryDef, ResolvedRule, RuleCategory, RuleDef, RuleLibrary, RuleTier } from "./types";
import { RULE_TIERS } from "./types";

const CATEGORY_RE = /^[a-z][a-z0-9_]*$/;
const ID_RE = /^[a-z][a-z0-9_]*$/;
const REF_RE = /^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/;
const CATEGORIES_FILE = "categories.toml";

export class RuleLibraryError extends Error {}

/**
 * Parse `config/rules/categories.toml`'s `[[category]]` array into
 * `CategoryDef[]` — the catalog of valid category ids plus the plain
 * title/description a UI shows for each. Pure — no filesystem IO.
 */
export function parseCategoriesFile(source: string): CategoryDef[] {
  const raw = parse(source) as {
    category?: Array<{ id?: string; title?: string; description?: string; order?: number }>;
  };
  const seen = new Set<string>();
  return (raw.category ?? []).map((entry, index) => {
    const id = entry.id;
    if (typeof id !== "string" || !CATEGORY_RE.test(id)) {
      throw new RuleLibraryError(
        `categories.toml: category at index ${index} has an invalid or missing id`,
      );
    }
    if (seen.has(id)) {
      throw new RuleLibraryError(`categories.toml: duplicate category id '${id}'`);
    }
    seen.add(id);
    const title = typeof entry.title === "string" && entry.title.trim() ? entry.title : id;
    const description = typeof entry.description === "string" ? entry.description.trim() : "";
    const order = typeof entry.order === "number" ? entry.order : 0;
    return { id, title, description, order };
  });
}

/**
 * Parse one rule TOML file's already-loaded content into `RuleDef[]`. Each
 * `[[rule]]` entry declares its own `category` — this function has no
 * knowledge of the category catalog, so it validates the field's *shape*
 * (lowercase snake_case) but not that it's a real, declared category; that
 * cross-check happens once in `buildRuleLibrary`, which has both the rules
 * and the catalog in hand. Pure — no filesystem IO — so it can be unit
 * tested with in-memory TOML strings the same way `tomlEdit.ts` is.
 */
export function parseRuleFile(source: string): RuleDef[] {
  const raw = parse(source) as {
    rule?: Array<{
      id?: string;
      category?: string;
      tier?: number;
      text?: string;
      overrides?: string[];
    }>;
  };

  return (raw.rule ?? []).map((entry, index) => {
    const id = entry.id;
    if (typeof id !== "string" || !ID_RE.test(id)) {
      throw new RuleLibraryError(`rule at index ${index} has an invalid or missing id`);
    }
    const category = entry.category;
    if (typeof category !== "string" || !CATEGORY_RE.test(category)) {
      throw new RuleLibraryError(`rule '${id}': missing or invalid category`);
    }
    if (!RULE_TIERS.includes(entry.tier as RuleTier)) {
      throw new RuleLibraryError(
        `rule '${category}/${id}': tier must be one of ${RULE_TIERS.join(", ")}, got ${JSON.stringify(entry.tier)}`,
      );
    }
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (!text) {
      throw new RuleLibraryError(`rule '${category}/${id}': text must be non-empty`);
    }
    const overrides = Array.isArray(entry.overrides)
      ? entry.overrides.filter((ref): ref is string => typeof ref === "string")
      : undefined;
    if (overrides) {
      for (const ref of overrides) {
        if (!REF_RE.test(ref)) {
          throw new RuleLibraryError(
            `rule '${category}/${id}': overrides entry '${ref}' is not a valid 'category/id' ref`,
          );
        }
      }
    }
    return {
      id,
      category,
      tier: entry.tier as RuleTier,
      text,
      ...(overrides && overrides.length > 0 ? { overrides } : {}),
    };
  });
}

/**
 * Merge a category catalog and a flat list of rules (each declaring its own
 * `category`) into a `RuleLibrary`, validating that every rule's category is
 * a real, declared one, every `overrides` ref points to a rule that actually
 * exists, and the override graph has no cycles. This is a *load-time* check
 * across the whole static library — cross-file forward references (a rule
 * authored in one file overriding one authored in another) are expected and
 * fine; only unknown categories, dangling refs, and cycles are errors.
 */
export function buildRuleLibrary(categoryDefs: CategoryDef[], rules: RuleDef[]): RuleLibrary {
  const categories = new Map<string, RuleCategory>();
  for (const def of categoryDefs) {
    if (categories.has(def.id)) {
      throw new RuleLibraryError(`duplicate category id '${def.id}'`);
    }
    categories.set(def.id, { ...def, rules: [] });
  }

  const rulesByRef = new Map<string, ResolvedRule>();
  let sequence = 0;
  for (const rule of rules) {
    const category = categories.get(rule.category!);
    if (!category) {
      throw new RuleLibraryError(
        `rule '${rule.category}/${rule.id}': unknown category '${rule.category}' — declare it in categories.toml`,
      );
    }
    const ref = `${rule.category}/${rule.id}`;
    if (rulesByRef.has(ref)) {
      throw new RuleLibraryError(`duplicate rule id '${ref}'`);
    }
    const resolved: ResolvedRule = {
      ...rule,
      category: rule.category!,
      ref,
      categoryTitle: category.title,
      categoryOrder: category.order,
      source: "library",
      sequence: sequence++,
    };
    rulesByRef.set(ref, resolved);
    category.rules.push(rule);
  }

  // Dangling override refs.
  for (const rule of rulesByRef.values()) {
    for (const overrideRef of rule.overrides ?? []) {
      if (!rulesByRef.has(overrideRef)) {
        throw new RuleLibraryError(
          `rule '${rule.ref}' overrides unknown rule '${overrideRef}'`,
        );
      }
    }
  }

  // Cycle detection over the static override graph (DFS with a recursion
  // stack). A direct mutual pair (A overrides B and B overrides A) is *not*
  // rejected here — that's a legitimate way to declare two mutually
  // exclusive alternatives, and `assembleRules` resolves it as a recorded
  // conflict (both kept) if a prompt ever selects both. Anything longer
  // (A -> B -> C -> A) can't be a deliberate pairwise declaration and is
  // rejected as an authoring mistake. Runtime/vibe rules are not part of the
  // static library and aren't covered by this check.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const ref of rulesByRef.keys()) color.set(ref, WHITE);

  const visit = (ref: string, path: string[]): void => {
    color.set(ref, GRAY);
    const rule = rulesByRef.get(ref)!;
    for (const next of rule.overrides ?? []) {
      const nextColor = color.get(next);
      if (nextColor === GRAY) {
        const isDirectMutualPair = path.length >= 2 && path[path.length - 2] === next;
        if (isDirectMutualPair) continue;
        throw new RuleLibraryError(
          `override cycle detected: ${[...path, next].join(" -> ")}`,
        );
      }
      if (nextColor === WHITE) visit(next, [...path, next]);
    }
    color.set(ref, BLACK);
  };
  for (const ref of rulesByRef.keys()) {
    if (color.get(ref) === WHITE) visit(ref, [ref]);
  }

  return { categories, rulesByRef };
}

/**
 * Load `categories.toml` plus every other `*.toml` file in `dir` (each
 * containing `[[rule]]` entries that declare their own `category`) and build
 * the library. Filename no longer determines category — any rule file may
 * contain rules for any declared category — but the existing convention of
 * one file per category is kept for authoring ergonomics.
 */
export function loadRuleLibrary(dir: string, logger?: Logger): RuleLibrary {
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".toml")).sort()
    : [];

  const categoriesFile = files.includes(CATEGORIES_FILE) ? CATEGORIES_FILE : undefined;
  if (files.length > 0 && !categoriesFile) {
    throw new RuleLibraryError(`${dir}: missing ${CATEGORIES_FILE}`);
  }
  const categoryDefs = categoriesFile
    ? parseCategoriesFile(readFileSync(resolve(dir, categoriesFile), "utf8"))
    : [];

  const rules = files
    .filter((f) => f !== CATEGORIES_FILE)
    .flatMap((file) => parseRuleFile(readFileSync(resolve(dir, file), "utf8")));

  const library = buildRuleLibrary(categoryDefs, rules);
  logger?.info("rules.library_loaded", {
    categories: categoryDefs.length,
    rules: library.rulesByRef.size,
  });
  return library;
}
