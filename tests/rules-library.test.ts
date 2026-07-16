import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import {
  buildRuleLibrary,
  loadRuleLibrary,
  parseCategoriesFile,
  parseRuleFile,
  RuleLibraryError,
} from "../src/server/rules/library";

const CATS = [
  { id: "tone", title: "Tone rules", description: "Voice and phrasing.", order: 20 },
  { id: "canon", title: "Canon rules", description: "World consistency.", order: 10 },
];

test("parseCategoriesFile parses id, title, description, and order", () => {
  const cats = parseCategoriesFile(`
[[category]]
id = "tone"
title = "Tone rules"
description = "Voice and phrasing."
order = 20
`);
  assert.deepEqual(cats, [
    { id: "tone", title: "Tone rules", description: "Voice and phrasing.", order: 20 },
  ]);
});

test("parseCategoriesFile defaults title to id, description to empty, order to 0", () => {
  const cats = parseCategoriesFile(`[[category]]\nid = "misc"`);
  assert.deepEqual(cats, [{ id: "misc", title: "misc", description: "", order: 0 }]);
});

test("parseCategoriesFile rejects an invalid or missing id", () => {
  assert.throws(() => parseCategoriesFile(`[[category]]\nid = "Bad-Name"`), RuleLibraryError);
  assert.throws(() => parseCategoriesFile(`[[category]]\ntitle = "x"`), RuleLibraryError);
});

test("parseCategoriesFile rejects a duplicate category id", () => {
  assert.throws(
    () => parseCategoriesFile(`[[category]]\nid = "tone"\n\n[[category]]\nid = "tone"`),
    /duplicate category id 'tone'/,
  );
});

test("parseRuleFile parses id, category, tier, text, and overrides", () => {
  const rules = parseRuleFile(`
[[rule]]
id = "never_hedge"
category = "tone"
tier = 1
text = "Never hedge or disclaim."

[[rule]]
id = "confident"
category = "tone"
tier = 2
text = "Be confident and plain."
overrides = ["canon/vague"]
`);
  assert.deepEqual(rules, [
    { id: "never_hedge", category: "tone", tier: 1, text: "Never hedge or disclaim." },
    {
      id: "confident",
      category: "tone",
      tier: 2,
      text: "Be confident and plain.",
      overrides: ["canon/vague"],
    },
  ]);
});

test("parseRuleFile rejects a missing/invalid rule id", () => {
  assert.throws(
    () => parseRuleFile(`[[rule]]\ncategory = "tone"\ntier = 1\ntext = "x"`),
    RuleLibraryError,
  );
  assert.throws(
    () => parseRuleFile(`[[rule]]\nid = "Bad Id"\ncategory = "tone"\ntier = 1\ntext = "x"`),
    RuleLibraryError,
  );
});

test("parseRuleFile rejects a missing/invalid category", () => {
  assert.throws(
    () => parseRuleFile(`[[rule]]\nid = "a"\ntier = 1\ntext = "x"`),
    /missing or invalid category/,
  );
  assert.throws(
    () => parseRuleFile(`[[rule]]\nid = "a"\ncategory = "Bad-Name"\ntier = 1\ntext = "x"`),
    /missing or invalid category/,
  );
});

test("parseRuleFile rejects an invalid tier", () => {
  assert.throws(
    () => parseRuleFile(`[[rule]]\nid = "a"\ncategory = "tone"\ntier = 5\ntext = "x"`),
    /tier must be one of/,
  );
});

test("parseRuleFile rejects empty rule text", () => {
  assert.throws(
    () => parseRuleFile(`[[rule]]\nid = "a"\ncategory = "tone"\ntier = 1\ntext = ""`),
    /text must be non-empty/,
  );
});

test("parseRuleFile rejects a malformed overrides ref", () => {
  assert.throws(
    () =>
      parseRuleFile(
        `[[rule]]\nid = "a"\ncategory = "tone"\ntier = 1\ntext = "x"\noverrides = ["not-a-ref"]`,
      ),
    /not a valid 'category\/id' ref/,
  );
});

test("buildRuleLibrary indexes rules by 'category/id' ref and groups them under their declared category", () => {
  const rules = parseRuleFile(`
[[rule]]
id = "a"
category = "tone"
tier = 1
text = "Tone A."

[[rule]]
id = "b"
category = "canon"
tier = 2
text = "Canon B."
`);
  const library = buildRuleLibrary(CATS, rules);
  assert.equal(library.rulesByRef.get("tone/a")?.text, "Tone A.");
  assert.equal(library.rulesByRef.get("canon/b")?.text, "Canon B.");
  assert.equal(library.categories.size, 2);
  assert.equal(library.categories.get("tone")?.title, "Tone rules");
  assert.deepEqual(
    library.categories.get("tone")?.rules.map((r) => r.id),
    ["a"],
  );
});

test("buildRuleLibrary allows rules for the same category from multiple 'files' (multiple parseRuleFile calls)", () => {
  const fromFileA = parseRuleFile(`[[rule]]\nid = "a"\ncategory = "tone"\ntier = 1\ntext = "x"`);
  const fromFileB = parseRuleFile(`[[rule]]\nid = "b"\ncategory = "tone"\ntier = 1\ntext = "y"`);
  const library = buildRuleLibrary(CATS, [...fromFileA, ...fromFileB]);
  assert.deepEqual(
    library.categories.get("tone")?.rules.map((r) => r.id).sort(),
    ["a", "b"],
  );
});

test("buildRuleLibrary rejects a duplicate category id in the catalog", () => {
  assert.throws(
    () => buildRuleLibrary([...CATS, { id: "tone", title: "dup", description: "", order: 0 }], []),
    /duplicate category id 'tone'/,
  );
});

test("buildRuleLibrary rejects a rule whose category isn't declared in the catalog", () => {
  const rules = parseRuleFile(`[[rule]]\nid = "a"\ncategory = "unknown"\ntier = 1\ntext = "x"`);
  assert.throws(() => buildRuleLibrary(CATS, rules), /unknown category 'unknown'/);
});

test("buildRuleLibrary rejects a duplicate rule id within one category", () => {
  const rules = parseRuleFile(`
[[rule]]
id = "dup"
category = "tone"
tier = 1
text = "one"

[[rule]]
id = "dup"
category = "tone"
tier = 2
text = "two"
`);
  assert.throws(() => buildRuleLibrary(CATS, rules), /duplicate rule id 'tone\/dup'/);
});

test("buildRuleLibrary rejects a dangling override ref", () => {
  const rules = parseRuleFile(
    `[[rule]]\nid = "a"\ncategory = "tone"\ntier = 1\ntext = "x"\noverrides = ["canon/missing"]`,
  );
  assert.throws(() => buildRuleLibrary(CATS, rules), /overrides unknown rule 'canon\/missing'/);
});

test("buildRuleLibrary allows a forward-reference override across categories", () => {
  const rules = parseRuleFile(`
[[rule]]
id = "a"
category = "tone"
tier = 1
text = "x"
overrides = ["canon/b"]

[[rule]]
id = "b"
category = "canon"
tier = 2
text = "y"
`);
  assert.doesNotThrow(() => buildRuleLibrary(CATS, rules));
});

test("buildRuleLibrary allows a direct mutual override pair (resolved as a conflict at assembly time, not a load error)", () => {
  const rules = parseRuleFile(`
[[rule]]
id = "a"
category = "tone"
tier = 1
text = "x"
overrides = ["tone/b"]

[[rule]]
id = "b"
category = "tone"
tier = 1
text = "y"
overrides = ["tone/a"]
`);
  assert.doesNotThrow(() => buildRuleLibrary(CATS, rules));
});

test("buildRuleLibrary rejects a self-override", () => {
  const rules = parseRuleFile(
    `[[rule]]\nid = "a"\ncategory = "tone"\ntier = 1\ntext = "x"\noverrides = ["tone/a"]`,
  );
  assert.throws(() => buildRuleLibrary(CATS, rules), /override cycle detected/);
});

test("buildRuleLibrary detects a longer override cycle", () => {
  const rules = parseRuleFile(`
[[rule]]
id = "a"
category = "tone"
tier = 1
text = "x"
overrides = ["tone/b"]

[[rule]]
id = "b"
category = "tone"
tier = 1
text = "y"
overrides = ["tone/c"]

[[rule]]
id = "c"
category = "tone"
tier = 1
text = "z"
overrides = ["tone/a"]
`);
  assert.throws(() => buildRuleLibrary(CATS, rules), /override cycle detected/);
});

// ─── the real config/rules directory ────────────────────────────────────────
//
// A smoke test over the actual shipped library: it must load without any
// validation error (unique ids, no dangling overrides, no cycles, every
// rule's category declared) and every category this repo ships must be
// present. This is what catches a typo'd `overrides` ref, a duplicate id, or
// an undeclared category introduced by a future edit to config/rules/*.toml,
// since those errors would otherwise only surface at server startup.

const REPO_RULES_DIR = resolve(import.meta.dirname, "..", "config", "rules");

test("the real config/rules directory loads without validation errors", () => {
  const library = loadRuleLibrary(REPO_RULES_DIR);
  assert.ok(library.rulesByRef.size > 0);
});

test("the real config/rules directory has the expected categories", () => {
  const library = loadRuleLibrary(REPO_RULES_DIR);
  const expected = [
    "canon",
    "content_policy",
    "formatting",
    "link_selection",
    "linking",
    "lists",
    "output_contract",
    "revision",
    "tips",
    "tone",
  ];
  assert.deepEqual([...library.categories.keys()].sort(), expected);
});

test("every category in the real config/rules directory has a non-empty title and description", () => {
  const library = loadRuleLibrary(REPO_RULES_DIR);
  for (const cat of library.categories.values()) {
    assert.ok(cat.title.trim().length > 0, `category '${cat.id}' has an empty title`);
    assert.ok(cat.description.trim().length > 0, `category '${cat.id}' has an empty description`);
  }
});
