import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";

import { loadRuleLibrary } from "../src/server/rules/library";
import { assembleRules } from "../src/server/rules/assemble";

const ROOT = resolve(import.meta.dirname, "..");
const PROMPT_DIR = resolve(ROOT, "config", "prompts");
const library = loadRuleLibrary(resolve(ROOT, "config", "rules"));

test("prompt files import category namespaces and explicitly select their rules", () => {
  for (const file of readdirSync(PROMPT_DIR).filter((name) => name.endsWith(".toml"))) {
    const raw = parse(readFileSync(resolve(PROMPT_DIR, file), "utf8")) as {
      rules?: {
        categories?: unknown;
        rules?: unknown;
        include?: unknown;
        exclude?: unknown;
      };
      local_rule?: unknown;
    };
    if (!raw.rules) continue;

    assert.equal(raw.rules.include, undefined, `${file} uses legacy include selectors`);
    assert.equal(raw.rules.exclude, undefined, `${file} uses legacy exclusions`);
    assert.equal(raw.local_rule, undefined, `${file} keeps rules inline`);
    assert.ok(Array.isArray(raw.rules.categories), `${file} has no category list`);

    const categories = raw.rules.categories as string[];
    const rules = Array.isArray(raw.rules.rules) ? (raw.rules.rules as string[]) : [];
    for (const category of categories) {
      assert.match(category, /^[a-z0-9_]+$/, `${file} has an invalid category`);
    }
    for (const rule of rules) {
      assert.match(rule, /^[a-z0-9_]+\/[a-z0-9_]+$/, `${file} has an invalid rule ref`);
      const resolved = library.rulesByRef.get(rule);
      assert.ok(resolved, `${file} selects unknown rule '${rule}'`);
      assert.ok(
        categories.includes(resolved.category),
        `${file} selects '${rule}' without importing '${resolved.category}'`,
      );
    }
    assert.doesNotThrow(() => assembleRules(library, { categories, rules }), file);
  }
});
