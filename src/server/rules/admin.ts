import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { replaceTomlArrayTables } from "../tomlEdit";
import { listPromptFiles, readPromptFile, tomlMultilineValue, writePromptFile } from "../promptEditor";
import { buildRuleLibrary, parseCategoriesFile, parseRuleFile } from "./library";
import type { CategoryDef, RuleDef } from "./types";

const ROOT = process.cwd();
const RULES_DIR = resolve(ROOT, "config", "rules");
const CATEGORIES_PATH = resolve(RULES_DIR, "categories.toml");

export interface RuleAdminState {
  categories: CategoryDef[];
  rules: RuleDef[];
}

export interface RuleRefRename {
  from: string;
  to: string;
}

export function renameRuleSelector(selector: string, renames: ReadonlyMap<string, string>): string {
  const excluded = selector.startsWith("!");
  const ref = excluded ? selector.slice(1) : selector;
  const renamed = renames.get(ref);
  return renamed ? `${excluded ? "!" : ""}${renamed}` : selector;
}

export function applyRuleRefRenames(
  rules: readonly RuleDef[],
  renames: ReadonlyMap<string, string>,
): RuleDef[] {
  return rules.map((rule) => {
    if (!rule.overrides?.length) return rule;
    const overrides = rule.overrides.map((ref) => renames.get(ref) ?? ref);
    return overrides.some((ref, index) => ref !== rule.overrides![index])
      ? { ...rule, overrides }
      : rule;
  });
}

export function readRuleAdminState(): RuleAdminState {
  const categories = parseCategoriesFile(readFileSync(CATEGORIES_PATH, "utf8"));
  const rules = readdirSync(RULES_DIR)
    .filter((file) => file.endsWith(".toml") && file !== "categories.toml")
    .sort()
    .flatMap((file) => parseRuleFile(readFileSync(resolve(RULES_DIR, file), "utf8")));
  return { categories, rules };
}

export function writeRuleAdminState(
  state: RuleAdminState,
  renames: readonly RuleRefRename[] = [],
): void {
  const priorState = readRuleAdminState();
  const renameMap = validateRuleRefRenames(renames, priorState.rules, state.rules);
  const renamedState = {
    categories: state.categories,
    rules: applyRuleRefRenames(state.rules, renameMap),
  };
  buildRuleLibrary(renamedState.categories, renamedState.rules);
  writePromptRuleRefRenames(renameMap);

  const files = readdirSync(RULES_DIR)
    .filter((file) => file.endsWith(".toml") && file !== "categories.toml")
    .sort();
  const priorFileByRef = new Map<string, string>();
  for (const file of files) {
    for (const rule of parseRuleFile(readFileSync(resolve(RULES_DIR, file), "utf8"))) {
      priorFileByRef.set(`${rule.category}/${rule.id}`, file);
    }
  }

  const byFile = new Map<string, RuleDef[]>();
  const priorRefByNewRef = new Map([...renameMap].map(([from, to]) => [to, from]));
  for (const rule of renamedState.rules) {
    const ref = `${rule.category}/${rule.id}`;
    const priorRef = priorRefByNewRef.get(ref);
    const file = priorFileByRef.get(ref) ?? (priorRef ? priorFileByRef.get(priorRef) : undefined) ?? `${rule.category}.toml`;
    const list = byFile.get(file) ?? [];
    list.push(rule);
    byFile.set(file, list);
  }

  const categorySource = existsSync(CATEGORIES_PATH) ? readFileSync(CATEGORIES_PATH, "utf8") : "";
  writeFileSync(
    CATEGORIES_PATH,
    replaceTomlArrayTables(categorySource, "category", renamedState.categories.map(renderCategoryToml)),
  );

  for (const file of new Set([...files, ...byFile.keys()])) {
    const path = resolve(RULES_DIR, file);
    const source = existsSync(path) ? readFileSync(path, "utf8") : "";
    writeFileSync(path, replaceTomlArrayTables(source, "rule", (byFile.get(file) ?? []).map(renderRuleToml)));
  }
}

function validateRuleRefRenames(
  renames: readonly RuleRefRename[],
  priorRules: readonly RuleDef[],
  nextRules: readonly RuleDef[],
): Map<string, string> {
  const priorRefs = new Set(priorRules.map((rule) => `${rule.category}/${rule.id}`));
  const nextRefs = new Set(nextRules.map((rule) => `${rule.category}/${rule.id}`));
  const renameMap = new Map<string, string>();
  for (const rename of renames) {
    if (!priorRefs.has(rename.from)) throw new Error(`cannot rename unknown rule '${rename.from}'`);
    if (nextRefs.has(rename.from)) {
      throw new Error(`cannot rename '${rename.from}' because it still exists in the submitted library`);
    }
    if (!nextRefs.has(rename.to)) {
      throw new Error(`renamed rule '${rename.to}' is missing from the submitted library`);
    }
    renameMap.set(rename.from, rename.to);
  }
  return renameMap;
}

function writePromptRuleRefRenames(renames: ReadonlyMap<string, string>): void {
  if (renames.size === 0) return;
  const promptFiles = listPromptFiles();
  for (const scope of ["runnable", "shared"] as const) {
    for (const meta of promptFiles[scope]) {
      const prompt = readPromptFile(scope, meta.key);
      if (!prompt) continue;
      const rules = prompt.rules
        ? {
            ...prompt.rules,
            ...(prompt.rules.rules
              ? { rules: prompt.rules.rules.map((selector) => renameRuleSelector(selector, renames)) }
              : {}),
          }
        : undefined;
      const localRules = applyRuleRefRenames(prompt.localRules ?? [], renames);
      const changed =
        JSON.stringify(rules) !== JSON.stringify(prompt.rules) ||
        JSON.stringify(localRules) !== JSON.stringify(prompt.localRules ?? []);
      if (!changed) continue;
      const error = writePromptFile(
        scope,
        prompt.key,
        prompt.system,
        prompt.user,
        rules,
        prompt.localRules ? localRules : undefined,
      );
      if (error) throw new Error(error.error);
    }
  }
}

function renderCategoryToml(category: CategoryDef): string {
  return [
    "[[category]]",
    `id = ${JSON.stringify(category.id)}`,
    `title = ${JSON.stringify(category.title)}`,
    `description = ${JSON.stringify(category.description)}`,
    `order = ${category.order}`,
  ].join("\n");
}

function renderRuleToml(rule: RuleDef): string {
  const lines = [
    "[[rule]]",
    `id = ${JSON.stringify(rule.id)}`,
    `category = ${JSON.stringify(rule.category)}`,
    `tier = ${rule.tier}`,
    `text = ${tomlMultilineValue(rule.text)}`,
  ];
  if (rule.overrides?.length) {
    lines.push(`overrides = [${rule.overrides.map((ref) => JSON.stringify(ref)).join(", ")}]`);
  }
  for (const example of rule.examples ?? []) {
    lines.push(
      "",
      "[[rule.examples]]",
      `description = ${JSON.stringify(example.description)}`,
      `text = ${tomlMultilineValue(example.text)}`,
    );
  }
  return lines.join("\n");
}
