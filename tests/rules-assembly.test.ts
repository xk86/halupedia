import test from "node:test";
import assert from "node:assert/strict";

import { buildRuleLibrary, parseRuleCategoryFile } from "../src/server/rules/library";
import { assembleRules } from "../src/server/rules/assemble";
import { parseSelector, resolveSelectors, RuleSelectorError } from "../src/server/rules/selector";
import type { RuleLibrary } from "../src/server/rules/types";

function makeLibrary(): RuleLibrary {
  const tone = parseRuleCategoryFile(
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

[[rule]]
id = "no_whimsy"
tier = 3
text = "Avoid whimsical prose."
`,
    "tone",
  );
  const canon = parseRuleCategoryFile(
    `
label = "Canon rules"
order = 10

[[rule]]
id = "references_are_gospel"
tier = 1
text = "References and edit instructions are gospel."

[[rule]]
id = "vibe_wins"
tier = 1
text = "Where the vibe conflicts with a default, the vibe wins."
`,
    "canon",
  );
  const formatting = parseRuleCategoryFile(
    `
label = "Formatting helpers"
order = 30

[[rule]]
id = "single_h1"
tier = 2
text = "Begin with a single level-1 heading."

[[rule]]
id = "no_footnotes"
tier = 2
text = "Do not use footnotes."
`,
    "formatting",
  );
  return buildRuleLibrary([tone, canon, formatting]);
}

// ─── selector parsing ───────────────────────────────────────────────────────

test("parseSelector parses a bare category selector", () => {
  assert.deepEqual(parseSelector("tone"), { category: "tone" });
});

test("parseSelector parses a single-tier selector", () => {
  assert.deepEqual(parseSelector("tone@1"), { category: "tone", tierMin: 1, tierMax: 1 });
});

test("parseSelector parses a tier-range selector", () => {
  assert.deepEqual(parseSelector("tone@1-2"), { category: "tone", tierMin: 1, tierMax: 2 });
});

test("parseSelector parses a single-rule selector", () => {
  assert.deepEqual(parseSelector("tone/confident"), { category: "tone", id: "confident" });
});

test("parseSelector rejects a descending tier range", () => {
  assert.throws(() => parseSelector("tone@3-1"), RuleSelectorError);
});

test("parseSelector rejects garbage", () => {
  assert.throws(() => parseSelector("Tone!!"), RuleSelectorError);
});

// ─── selector resolution ────────────────────────────────────────────────────

test("resolveSelectors resolves a whole category", () => {
  const library = makeLibrary();
  const rules = resolveSelectors(library, ["canon"]);
  assert.deepEqual(
    rules.map((r) => r.ref).sort(),
    ["canon/references_are_gospel", "canon/vibe_wins"],
  );
});

test("resolveSelectors resolves a single tier within a category", () => {
  const library = makeLibrary();
  const rules = resolveSelectors(library, ["tone@2"]);
  assert.deepEqual(rules.map((r) => r.ref), ["tone/confident"]);
});

test("resolveSelectors resolves a single rule", () => {
  const library = makeLibrary();
  const rules = resolveSelectors(library, ["tone/no_whimsy"]);
  assert.deepEqual(rules.map((r) => r.ref), ["tone/no_whimsy"]);
});

test("resolveSelectors dedupes overlapping selectors", () => {
  const library = makeLibrary();
  const rules = resolveSelectors(library, ["tone", "tone/confident"]);
  assert.equal(rules.length, 3);
});

test("resolveSelectors throws on an unknown category", () => {
  const library = makeLibrary();
  assert.throws(() => resolveSelectors(library, ["nonexistent"]), /unknown rule category/);
});

test("resolveSelectors throws on an unknown rule id", () => {
  const library = makeLibrary();
  assert.throws(() => resolveSelectors(library, ["tone/nope"]), /unknown rule 'tone\/nope'/);
});

// ─── assembleRules: basic composition ───────────────────────────────────────

test("assembleRules composes rules tier-major, tier 1 first", () => {
  const library = makeLibrary();
  const result = assembleRules(library, { include: ["tone", "canon"] });
  const tierOneIdx = result.text.indexOf("Tier 1");
  const tierTwoIdx = result.text.indexOf("Tier 2");
  const tierThreeIdx = result.text.indexOf("Tier 3");
  assert.ok(tierOneIdx >= 0 && tierTwoIdx > tierOneIdx && tierThreeIdx > tierTwoIdx);
  assert.match(result.text, /- References and edit instructions are gospel\./);
  assert.match(result.text, /- Never hedge or disclaim\./);
});

test("assembleRules sorts within a tier by category order", () => {
  const library = makeLibrary();
  // formatting (order 30) and canon (order 10) both have tier-2 or tier-1
  // rules; canon's tier-1 rule should render before tone's tier-1 rule
  // since canon.order (10) < tone.order (20).
  const result = assembleRules(library, { include: ["tone", "canon"] });
  const canonIdx = result.text.indexOf("gospel");
  const toneIdx = result.text.indexOf("Never hedge");
  assert.ok(canonIdx < toneIdx);
});

test("assembleRules omits tiers with no included rules", () => {
  const library = makeLibrary();
  const result = assembleRules(library, { include: ["tone@3"] });
  assert.doesNotMatch(result.text, /Tier 1/);
  assert.doesNotMatch(result.text, /Tier 2/);
  assert.match(result.text, /Tier 3/);
});

test("assembleRules exclude removes a specific rule from a wide include", () => {
  const library = makeLibrary();
  const result = assembleRules(library, {
    include: ["tone"],
    exclude: ["tone/no_whimsy"],
  });
  assert.doesNotMatch(result.text, /whimsical/);
  assert.match(result.text, /Never hedge/);
  assert.equal(result.included.length, 2);
});

test("assembleRules exclude is a no-op when the rule wasn't included", () => {
  const library = makeLibrary();
  const result = assembleRules(library, {
    include: ["tone@1"],
    exclude: ["canon/vibe_wins"],
  });
  assert.equal(result.included.length, 1);
});

test("assembleRules reports per-tier counts", () => {
  const library = makeLibrary();
  const result = assembleRules(library, { include: ["tone", "canon", "formatting"] });
  assert.deepEqual(result.tierCounts, { 1: 3, 2: 3, 3: 1, 4: 0 });
});

// ─── local + runtime (vibe) rules ───────────────────────────────────────────

test("assembleRules merges local rules under a synthetic category", () => {
  const library = makeLibrary();
  const result = assembleRules(
    library,
    { include: ["tone@1"] },
    {
      promptKey: "article_summary",
      localRules: [{ id: "similarity_feedback", tier: 2, text: "Rewrite if too similar to lead." }],
    },
  );
  assert.match(result.text, /Rewrite if too similar to lead\./);
  const local = result.included.find((r) => r.source === "local");
  assert.equal(local?.ref, "local/article_summary__similarity_feedback");
});

test("assembleRules namespaces local rules per prompt so ids can't collide", () => {
  const library = makeLibrary();
  const a = assembleRules(
    library,
    { include: [] },
    { promptKey: "a", localRules: [{ id: "x", tier: 1, text: "A's rule." }] },
  );
  const b = assembleRules(
    library,
    { include: [] },
    { promptKey: "b", localRules: [{ id: "x", tier: 1, text: "B's rule." }] },
  );
  assert.equal(a.included[0]?.ref, "local/a__x");
  assert.equal(b.included[0]?.ref, "local/b__x");
});

test("assembleRules merges runtime (vibe) rules under a synthetic category", () => {
  const library = makeLibrary();
  const result = assembleRules(
    library,
    { include: ["tone@1"] },
    { runtimeRules: [{ id: "custom_setting", tier: 2, text: "The Soviet Union still exists." }] },
  );
  assert.match(result.text, /The Soviet Union still exists\./);
  const runtime = result.included.find((r) => r.source === "runtime");
  assert.equal(runtime?.category, "vibe");
});

test("assembleRules allows a runtime rule to override a library default", () => {
  const library = makeLibrary();
  const result = assembleRules(
    library,
    { include: ["tone"] },
    {
      runtimeRules: [
        {
          id: "embrace_whimsy",
          tier: 3,
          text: "This article is deliberately whimsical.",
          overrides: ["tone/no_whimsy"],
        },
      ],
    },
  );
  assert.doesNotMatch(result.text, /Avoid whimsical prose\./);
  assert.match(result.text, /deliberately whimsical/);
  assert.deepEqual(result.dropped, [
    { ref: "tone/no_whimsy", supersededBy: "vibe/embrace_whimsy" },
  ]);
});

// ─── override resolution ────────────────────────────────────────────────────

test("assembleRules drops a rule superseded by another included rule's overrides", () => {
  const tone = parseRuleCategoryFile(
    `
[[rule]]
id = "base"
tier = 2
text = "Base rule."

[[rule]]
id = "stronger"
tier = 2
text = "Stronger rule."
overrides = ["tone/base"]
`,
    "tone",
  );
  const library = buildRuleLibrary([tone]);
  const result = assembleRules(library, { include: ["tone"] });
  assert.deepEqual(result.included.map((r) => r.ref), ["tone/stronger"]);
  assert.deepEqual(result.dropped, [{ ref: "tone/base", supersededBy: "tone/stronger" }]);
});

test("assembleRules records a conflict (keeps both) for a mutual override pair", () => {
  const tone = parseRuleCategoryFile(
    `
[[rule]]
id = "a"
tier = 1
text = "A wins."
overrides = ["tone/b"]

[[rule]]
id = "b"
tier = 1
text = "B wins."
overrides = ["tone/a"]
`,
    "tone",
  );
  const library = buildRuleLibrary([tone]);
  const result = assembleRules(library, { include: ["tone"] });
  assert.deepEqual(result.included.map((r) => r.ref).sort(), ["tone/a", "tone/b"]);
  assert.equal(result.dropped.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(new Set([result.conflicts[0]!.a, result.conflicts[0]!.b]), new Set(["tone/a", "tone/b"]));
});

test("assembleRules override does not affect a rule not selected into this prompt", () => {
  const tone = parseRuleCategoryFile(
    `
[[rule]]
id = "base"
tier = 2
text = "Base rule."

[[rule]]
id = "stronger"
tier = 2
text = "Stronger rule."
overrides = ["tone/base"]
`,
    "tone",
  );
  const library = buildRuleLibrary([tone]);
  // Only "base" selected — "stronger" (and its override) never enters the set.
  const result = assembleRules(library, { include: ["tone/base"] });
  assert.deepEqual(result.included.map((r) => r.ref), ["tone/base"]);
  assert.equal(result.dropped.length, 0);
});

// ─── hash stability ──────────────────────────────────────────────────────────

test("assembleRules hash is stable for the same resolved set and changes when content changes", () => {
  const library = makeLibrary();
  const a = assembleRules(library, { include: ["tone@1"] });
  const b = assembleRules(library, { include: ["tone@1"] });
  assert.equal(a.hash, b.hash);

  const c = assembleRules(library, { include: ["tone@1", "canon@1"] });
  assert.notEqual(a.hash, c.hash);
});

test("assembleRules hash is independent of include-list order (same resolved set)", () => {
  const library = makeLibrary();
  const a = assembleRules(library, { include: ["tone", "canon"] });
  const b = assembleRules(library, { include: ["canon", "tone"] });
  assert.equal(a.hash, b.hash);
});
