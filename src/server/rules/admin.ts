import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { replaceTomlArrayTables } from "../tomlEdit";
import { tomlMultilineValue } from "../promptEditor";
import { buildRuleLibrary, parseCategoriesFile, parseRuleFile } from "./library";
import type { CategoryDef, RuleDef } from "./types";

const ROOT = process.cwd();
const RULES_DIR = resolve(ROOT, "config", "rules");
const CATEGORIES_PATH = resolve(RULES_DIR, "categories.toml");

export interface RuleAdminState {
  categories: CategoryDef[];
  rules: RuleDef[];
}

export function readRuleAdminState(): RuleAdminState {
  const categories = parseCategoriesFile(readFileSync(CATEGORIES_PATH, "utf8"));
  const rules = readdirSync(RULES_DIR)
    .filter((file) => file.endsWith(".toml") && file !== "categories.toml")
    .sort()
    .flatMap((file) => parseRuleFile(readFileSync(resolve(RULES_DIR, file), "utf8")));
  return { categories, rules };
}

export function writeRuleAdminState(state: RuleAdminState): void {
  buildRuleLibrary(state.categories, state.rules);

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
  for (const rule of state.rules) {
    const ref = `${rule.category}/${rule.id}`;
    const file = priorFileByRef.get(ref) ?? `${rule.category}.toml`;
    const list = byFile.get(file) ?? [];
    list.push(rule);
    byFile.set(file, list);
  }

  const categorySource = existsSync(CATEGORIES_PATH) ? readFileSync(CATEGORIES_PATH, "utf8") : "";
  writeFileSync(
    CATEGORIES_PATH,
    replaceTomlArrayTables(categorySource, "category", state.categories.map(renderCategoryToml)),
  );

  for (const file of new Set([...files, ...byFile.keys()])) {
    const path = resolve(RULES_DIR, file);
    const source = existsSync(path) ? readFileSync(path, "utf8") : "";
    writeFileSync(path, replaceTomlArrayTables(source, "rule", (byFile.get(file) ?? []).map(renderRuleToml)));
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
