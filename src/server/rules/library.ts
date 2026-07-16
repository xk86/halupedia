import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse } from "smol-toml";
import type { Logger } from "../logger";
import type { RuleCategoryFile, RuleDef, RuleLibrary, RuleTier } from "./types";
import { RULE_TIERS } from "./types";

const CATEGORY_RE = /^[a-z][a-z0-9_]*$/;
const ID_RE = /^[a-z][a-z0-9_]*$/;
const REF_RE = /^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/;

export class RuleLibraryError extends Error {}

/**
 * Parse one category TOML file's already-loaded content into a
 * `RuleCategoryFile`. Pure — does no filesystem IO — so it can be unit
 * tested with in-memory TOML strings the same way `tomlEdit.ts` is.
 */
export function parseRuleCategoryFile(
  source: string,
  category: string,
): RuleCategoryFile {
  if (!CATEGORY_RE.test(category)) {
    throw new RuleLibraryError(
      `rule category '${category}' must be lowercase snake_case`,
    );
  }
  const raw = parse(source) as {
    label?: string;
    order?: number;
    rule?: Array<{
      id?: string;
      tier?: number;
      text?: string;
      overrides?: string[];
    }>;
  };

  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label : category;
  const order = typeof raw.order === "number" ? raw.order : 0;

  const seenIds = new Set<string>();
  const rules: RuleDef[] = (raw.rule ?? []).map((entry, index) => {
    const id = entry.id;
    if (typeof id !== "string" || !ID_RE.test(id)) {
      throw new RuleLibraryError(
        `rule category '${category}': rule at index ${index} has an invalid or missing id`,
      );
    }
    if (seenIds.has(id)) {
      throw new RuleLibraryError(
        `rule category '${category}': duplicate rule id '${id}'`,
      );
    }
    seenIds.add(id);

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
      tier: entry.tier as RuleTier,
      text,
      ...(overrides && overrides.length > 0 ? { overrides } : {}),
    };
  });

  return { category, label, order, rules };
}

/**
 * Merge parsed category files into a `RuleLibrary`, validating that every
 * `overrides` ref points to a rule that actually exists somewhere in the
 * library and that the override graph has no cycles. This is a *load-time*
 * check across the whole static library — cross-file forward references
 * (a rule in `tone.toml` overriding one in `canon.toml`) are expected and
 * fine; only dangling refs and cycles are errors.
 */
export function buildRuleLibrary(categoryFiles: RuleCategoryFile[]): RuleLibrary {
  const categories = new Map<string, RuleCategoryFile>();
  const rulesByRef = new Map<string, import("./types").ResolvedRule>();

  let sequence = 0;
  for (const file of categoryFiles) {
    if (categories.has(file.category)) {
      throw new RuleLibraryError(`duplicate rule category '${file.category}'`);
    }
    categories.set(file.category, file);
    for (const rule of file.rules) {
      const ref = `${file.category}/${rule.id}`;
      rulesByRef.set(ref, {
        ...rule,
        ref,
        category: file.category,
        categoryLabel: file.label,
        categoryOrder: file.order,
        source: "library",
        sequence: sequence++,
      });
    }
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

/** Load every `*.toml` file in `dir` as a rule category and build the library.
 *  Filename (minus extension) becomes the category id, matching the existing
 *  prompt-loading convention in `config.ts`. */
export function loadRuleLibrary(dir: string, logger?: Logger): RuleLibrary {
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".toml")).sort()
    : [];
  const categoryFiles = files.map((file) => {
    const category = basename(file, ".toml");
    const source = readFileSync(resolve(dir, file), "utf8");
    return parseRuleCategoryFile(source, category);
  });
  const library = buildRuleLibrary(categoryFiles);
  logger?.info("rules.library_loaded", {
    categories: categoryFiles.length,
    rules: library.rulesByRef.size,
  });
  return library;
}
