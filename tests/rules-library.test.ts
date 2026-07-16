import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import {
  buildRuleLibrary,
  loadRuleLibrary,
  parseRuleCategoryFile,
  RuleLibraryError,
} from "../src/server/rules/library";

test("parseRuleCategoryFile parses label, order, and rules", () => {
  const file = parseRuleCategoryFile(
    `
label = "Tone rules"
order = 20

[[rule]]
id = "never_hedge"
tier = 1
text = "Never hedge or disclaim."

[[rule]]
id = "confident"
tier = 2
text = "Be confident and plain."
`,
    "tone",
  );
  assert.equal(file.category, "tone");
  assert.equal(file.label, "Tone rules");
  assert.equal(file.order, 20);
  assert.deepEqual(file.rules, [
    { id: "never_hedge", tier: 1, text: "Never hedge or disclaim." },
    { id: "confident", tier: 2, text: "Be confident and plain." },
  ]);
});

test("parseRuleCategoryFile defaults label to category and order to 0", () => {
  const file = parseRuleCategoryFile(
    `
[[rule]]
id = "a"
tier = 3
text = "Something."
`,
    "misc",
  );
  assert.equal(file.label, "misc");
  assert.equal(file.order, 0);
});

test("parseRuleCategoryFile rejects an invalid category name", () => {
  assert.throws(
    () => parseRuleCategoryFile(`[[rule]]\nid = "a"\ntier = 1\ntext = "x"`, "Bad-Name"),
    RuleLibraryError,
  );
});

test("parseRuleCategoryFile rejects a missing/invalid rule id", () => {
  assert.throws(
    () => parseRuleCategoryFile(`[[rule]]\ntier = 1\ntext = "x"`, "tone"),
    RuleLibraryError,
  );
  assert.throws(
    () => parseRuleCategoryFile(`[[rule]]\nid = "Bad Id"\ntier = 1\ntext = "x"`, "tone"),
    RuleLibraryError,
  );
});

test("parseRuleCategoryFile rejects a duplicate id within one category", () => {
  assert.throws(
    () =>
      parseRuleCategoryFile(
        `
[[rule]]
id = "dup"
tier = 1
text = "one"

[[rule]]
id = "dup"
tier = 2
text = "two"
`,
        "tone",
      ),
    /duplicate rule id 'dup'/,
  );
});

test("parseRuleCategoryFile rejects an invalid tier", () => {
  assert.throws(
    () => parseRuleCategoryFile(`[[rule]]\nid = "a"\ntier = 5\ntext = "x"`, "tone"),
    /tier must be one of/,
  );
});

test("parseRuleCategoryFile rejects empty rule text", () => {
  assert.throws(
    () => parseRuleCategoryFile(`[[rule]]\nid = "a"\ntier = 1\ntext = ""`, "tone"),
    /text must be non-empty/,
  );
});

test("parseRuleCategoryFile rejects a malformed overrides ref", () => {
  assert.throws(
    () =>
      parseRuleCategoryFile(
        `[[rule]]\nid = "a"\ntier = 1\ntext = "x"\noverrides = ["not-a-ref"]`,
        "tone",
      ),
    /not a valid 'category\/id' ref/,
  );
});

test("buildRuleLibrary indexes rules by 'category/id' ref", () => {
  const tone = parseRuleCategoryFile(
    `[[rule]]\nid = "a"\ntier = 1\ntext = "Tone A."`,
    "tone",
  );
  const canon = parseRuleCategoryFile(
    `[[rule]]\nid = "b"\ntier = 2\ntext = "Canon B."`,
    "canon",
  );
  const library = buildRuleLibrary([tone, canon]);
  assert.equal(library.rulesByRef.get("tone/a")?.text, "Tone A.");
  assert.equal(library.rulesByRef.get("canon/b")?.text, "Canon B.");
  assert.equal(library.categories.size, 2);
});

test("buildRuleLibrary rejects a duplicate category", () => {
  const tone1 = parseRuleCategoryFile(`[[rule]]\nid = "a"\ntier = 1\ntext = "x"`, "tone");
  const tone2 = parseRuleCategoryFile(`[[rule]]\nid = "b"\ntier = 1\ntext = "y"`, "tone");
  assert.throws(() => buildRuleLibrary([tone1, tone2]), /duplicate rule category 'tone'/);
});

test("buildRuleLibrary rejects a dangling override ref", () => {
  const tone = parseRuleCategoryFile(
    `[[rule]]\nid = "a"\ntier = 1\ntext = "x"\noverrides = ["canon/missing"]`,
    "tone",
  );
  assert.throws(() => buildRuleLibrary([tone]), /overrides unknown rule 'canon\/missing'/);
});

test("buildRuleLibrary allows a forward-reference override across files", () => {
  const tone = parseRuleCategoryFile(
    `[[rule]]\nid = "a"\ntier = 1\ntext = "x"\noverrides = ["canon/b"]`,
    "tone",
  );
  const canon = parseRuleCategoryFile(`[[rule]]\nid = "b"\ntier = 2\ntext = "y"`, "canon");
  assert.doesNotThrow(() => buildRuleLibrary([tone, canon]));
});

test("buildRuleLibrary allows a direct mutual override pair (resolved as a conflict at assembly time, not a load error)", () => {
  const tone = parseRuleCategoryFile(
    `
[[rule]]
id = "a"
tier = 1
text = "x"
overrides = ["tone/b"]

[[rule]]
id = "b"
tier = 1
text = "y"
overrides = ["tone/a"]
`,
    "tone",
  );
  assert.doesNotThrow(() => buildRuleLibrary([tone]));
});

test("buildRuleLibrary rejects a self-override", () => {
  const tone = parseRuleCategoryFile(
    `[[rule]]\nid = "a"\ntier = 1\ntext = "x"\noverrides = ["tone/a"]`,
    "tone",
  );
  assert.throws(() => buildRuleLibrary([tone]), /override cycle detected/);
});

test("buildRuleLibrary detects a longer override cycle", () => {
  const tone = parseRuleCategoryFile(
    `
[[rule]]
id = "a"
tier = 1
text = "x"
overrides = ["tone/b"]

[[rule]]
id = "b"
tier = 1
text = "y"
overrides = ["tone/c"]

[[rule]]
id = "c"
tier = 1
text = "z"
overrides = ["tone/a"]
`,
    "tone",
  );
  assert.throws(() => buildRuleLibrary([tone]), /override cycle detected/);
});

// ─── the real config/rules directory ────────────────────────────────────────
//
// A smoke test over the actual shipped library: it must load without any
// validation error (unique ids, no dangling overrides, no cycles) and every
// category file this repo ships must be present. This is what catches a
// typo'd `overrides` ref or a duplicate id introduced by a future edit to
// config/rules/*.toml, since those errors would otherwise only surface at
// server startup.

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
    "tips",
    "tone",
  ];
  assert.deepEqual([...library.categories.keys()].sort(), expected);
});
