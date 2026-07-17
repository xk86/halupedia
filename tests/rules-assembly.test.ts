import test from "node:test";
import assert from "node:assert/strict";

import { buildRuleLibrary, parseRuleFile } from "../src/server/rules/library";
import { assembleRules, RuleSelectorError } from "../src/server/rules/assemble";
import type { CategoryDef, RuleLibrary } from "../src/server/rules/types";

const CATS: CategoryDef[] = [
  { id: "tone", title: "Tone rules", description: "Voice and phrasing.", order: 20 },
  { id: "canon", title: "Canon rules", description: "World consistency.", order: 10 },
  { id: "formatting", title: "Formatting helpers", description: "Output shape.", order: 30 },
];

function makeLibrary(): RuleLibrary {
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

[[rule]]
id = "no_whimsy"
category = "tone"
tier = 3
text = "Avoid whimsical prose."

[[rule]]
id = "references_are_gospel"
category = "canon"
tier = 1
text = "References and edit instructions are gospel."

[[rule]]
id = "vibe_wins"
category = "canon"
tier = 1
text = "Where the vibe conflicts with a default, the vibe wins."

[[rule]]
id = "single_h1"
category = "formatting"
tier = 2
text = "Begin with a single level-1 heading."

[[rule]]
id = "no_footnotes"
category = "formatting"
tier = 2
text = "Do not use footnotes."
`);
  return buildRuleLibrary(CATS, rules);
}

// ─── assembleRules: basic composition ───────────────────────────────────────

test("importing a category namespace does not enable its rules", () => {
  const library = makeLibrary();
  const result = assembleRules(library, { categories: ["tone"], rules: [] });
  assert.deepEqual(result.included, []);
  assert.equal(result.text, "");
});

test("explicit rules must belong to an imported category namespace", () => {
  const library = makeLibrary();
  assert.throws(
    () =>
      assembleRules(library, {
        categories: ["canon"],
        rules: ["tone/never_hedge"],
      }),
    /requires imported category 'tone'/,
  );
});

test("explicitly selected rules assemble from an imported namespace", () => {
  const library = makeLibrary();
  const result = assembleRules(library, {
    categories: ["tone"],
    rules: ["tone/never_hedge"],
  });
  assert.deepEqual(result.included.map((rule) => rule.ref), ["tone/never_hedge"]);
});

test("assembleRules composes rules tier-major, tier 1 first", () => {
  const library = makeLibrary();
  const result = assembleRules(library, {
    categories: ["tone", "canon"],
    rules: [
      "tone/never_hedge",
      "tone/confident",
      "tone/no_whimsy",
      "canon/references_are_gospel",
      "canon/vibe_wins",
    ],
  });
  const tierOneIdx = result.text.indexOf("Tier 1");
  const tierTwoIdx = result.text.indexOf("Tier 2");
  const tierThreeIdx = result.text.indexOf("Tier 3");
  assert.ok(tierOneIdx >= 0 && tierTwoIdx > tierOneIdx && tierThreeIdx > tierTwoIdx);
  assert.match(result.text, /- References and edit instructions are gospel\./);
  assert.match(result.text, /- Never hedge or disclaim\./);
});

test("assembleRules renders structured examples as nested blockquotes", () => {
  const rules = parseRuleFile(`
[[rule]]
id = "worked"
category = "tone"
tier = 2
text = "Use direct prose."

[[rule.examples]]
description = "When revising a hedge"
text = "The council approved the measure."
`);
  const result = assembleRules(buildRuleLibrary(CATS, rules), {
    categories: ["tone"],
    rules: ["tone/worked"],
  });
  assert.match(result.text, /- Use direct prose\.\n  > \*\*Example — When revising a hedge\*\*/);
  assert.match(result.text, /  > The council approved the measure\./);
});

test("assembleRules sorts within a tier by category order", () => {
  const library = makeLibrary();
  // formatting (order 30) and canon (order 10) both have tier-2 or tier-1
  // rules; canon's tier-1 rule should render before tone's tier-1 rule
  // since canon.order (10) < tone.order (20).
  const result = assembleRules(library, {
    categories: ["tone", "canon"],
    rules: [
      "tone/never_hedge",
      "tone/confident",
      "tone/no_whimsy",
      "canon/references_are_gospel",
      "canon/vibe_wins",
    ],
  });
  const canonIdx = result.text.indexOf("gospel");
  const toneIdx = result.text.indexOf("Never hedge");
  assert.ok(canonIdx < toneIdx);
});

test("assembleRules omits tiers with no included rules", () => {
  const library = makeLibrary();
  const result = assembleRules(library, { categories: ["tone"], rules: ["tone/no_whimsy"] });
  assert.doesNotMatch(result.text, /Tier 1/);
  assert.doesNotMatch(result.text, /Tier 2/);
  assert.match(result.text, /Tier 3/);
});

test("assembleRules reports per-tier counts", () => {
  const library = makeLibrary();
  const result = assembleRules(library, {
    categories: ["tone", "canon", "formatting"],
    rules: [
      "tone/never_hedge",
      "tone/confident",
      "tone/no_whimsy",
      "canon/references_are_gospel",
      "canon/vibe_wins",
      "formatting/single_h1",
      "formatting/no_footnotes",
    ],
  });
  assert.deepEqual(result.tierCounts, { 1: 3, 2: 3, 3: 1, 4: 0 });
});

// ─── wildcard and exclusion selectors ───────────────────────────────────────

test("a category wildcard selects every rule in that category", () => {
  const library = makeLibrary();
  const result = assembleRules(library, { categories: ["canon"], rules: ["canon/*"] });
  assert.deepEqual(
    result.included.map((r) => r.ref).sort(),
    ["canon/references_are_gospel", "canon/vibe_wins"],
  );
});

test("a category wildcard requires its category to be imported", () => {
  const library = makeLibrary();
  assert.throws(
    () => assembleRules(library, { categories: ["tone"], rules: ["canon/*"] }),
    /requires imported category 'canon'/,
  );
});

test("'*' in categories imports every namespace in the library", () => {
  const library = makeLibrary();
  const result = assembleRules(library, { categories: ["*"], rules: ["canon/*", "formatting/*"] });
  assert.deepEqual(
    result.included.map((r) => r.ref).sort(),
    ["canon/references_are_gospel", "canon/vibe_wins", "formatting/no_footnotes", "formatting/single_h1"],
  );
});

test("a '!' selector excludes one rule from a wildcard-selected set", () => {
  const library = makeLibrary();
  const result = assembleRules(library, {
    categories: ["tone"],
    rules: ["tone/*", "!tone/no_whimsy"],
  });
  assert.doesNotMatch(result.text, /whimsical/);
  assert.match(result.text, /Never hedge/);
  assert.equal(result.included.length, 2);
});

test("a '!' wildcard excludes every rule in a category", () => {
  const library = makeLibrary();
  const result = assembleRules(library, {
    categories: ["tone", "canon"],
    rules: ["tone/*", "canon/*", "!canon/*"],
  });
  assert.deepEqual(result.included.map((r) => r.category), ["tone", "tone", "tone"]);
});

test("excluding a rule that inclusion never selected is an error, not a no-op", () => {
  const library = makeLibrary();
  assert.throws(
    () =>
      assembleRules(library, {
        categories: ["tone", "canon"],
        rules: ["tone/never_hedge", "!canon/vibe_wins"],
      }),
    /excluded rule 'canon\/vibe_wins' was not included by any selector/,
  );
});

test("exclusion order in the rules list doesn't matter — it always applies after inclusion", () => {
  const library = makeLibrary();
  const result = assembleRules(library, {
    categories: ["tone"],
    rules: ["!tone/no_whimsy", "tone/*"],
  });
  assert.equal(result.included.length, 2);
  assert.doesNotMatch(result.text, /whimsical/);
});

test("an invalid rule selector string is rejected", () => {
  const library = makeLibrary();
  assert.throws(
    () => assembleRules(library, { categories: ["tone"], rules: ["Tone!!"] }),
    RuleSelectorError,
  );
});

// ─── category descriptions in assembled text ────────────────────────────────

test("assembled text includes each category's title and description once per tier group", () => {
  const library = makeLibrary();
  const result = assembleRules(library, {
    categories: ["tone", "canon"],
    rules: ["tone/never_hedge", "canon/references_are_gospel"],
  });
  assert.match(result.text, /\*\*Canon rules\*\* — World consistency\./);
  assert.match(result.text, /\*\*Tone rules\*\* — Voice and phrasing\./);
});

test("a local rule's category heading uses its synthetic description", () => {
  const library = makeLibrary();
  const result = assembleRules(
    library,
    { categories: [], rules: [] },
    { promptKey: "p", localRules: [{ id: "x", tier: 1, text: "Local rule text." }] },
  );
  assert.match(result.text, /\*\*This prompt\*\* — Rules authored only for this prompt/);
});

// ─── local + runtime (vibe) rules ───────────────────────────────────────────

test("assembleRules merges local rules under a synthetic category", () => {
  const library = makeLibrary();
  const result = assembleRules(
    library,
    { categories: ["tone"], rules: ["tone/never_hedge"] },
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
    { categories: [], rules: [] },
    { promptKey: "a", localRules: [{ id: "x", tier: 1, text: "A's rule." }] },
  );
  const b = assembleRules(
    library,
    { categories: [], rules: [] },
    { promptKey: "b", localRules: [{ id: "x", tier: 1, text: "B's rule." }] },
  );
  assert.equal(a.included[0]?.ref, "local/a__x");
  assert.equal(b.included[0]?.ref, "local/b__x");
});

test("assembleRules merges runtime (vibe) rules under a synthetic category", () => {
  const library = makeLibrary();
  const result = assembleRules(
    library,
    { categories: ["tone"], rules: ["tone/never_hedge"] },
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
    { categories: ["tone"], rules: ["tone/never_hedge", "tone/confident", "tone/no_whimsy"] },
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
  const rules = parseRuleFile(`
[[rule]]
id = "base"
category = "tone"
tier = 2
text = "Base rule."

[[rule]]
id = "stronger"
category = "tone"
tier = 2
text = "Stronger rule."
overrides = ["tone/base"]
`);
  const library = buildRuleLibrary(CATS, rules);
  const result = assembleRules(library, {
    categories: ["tone"],
    rules: ["tone/base", "tone/stronger"],
  });
  assert.deepEqual(result.included.map((r) => r.ref), ["tone/stronger"]);
  assert.deepEqual(result.dropped, [{ ref: "tone/base", supersededBy: "tone/stronger" }]);
});

test("assembleRules records a conflict (keeps both) for a mutual override pair", () => {
  const rules = parseRuleFile(`
[[rule]]
id = "a"
category = "tone"
tier = 1
text = "A wins."
overrides = ["tone/b"]

[[rule]]
id = "b"
category = "tone"
tier = 1
text = "B wins."
overrides = ["tone/a"]
`);
  const library = buildRuleLibrary(CATS, rules);
  const result = assembleRules(library, { categories: ["tone"], rules: ["tone/a", "tone/b"] });
  assert.deepEqual(result.included.map((r) => r.ref).sort(), ["tone/a", "tone/b"]);
  assert.equal(result.dropped.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(new Set([result.conflicts[0]!.a, result.conflicts[0]!.b]), new Set(["tone/a", "tone/b"]));
});

test("assembleRules override does not affect a rule not selected into this prompt", () => {
  const rules = parseRuleFile(`
[[rule]]
id = "base"
category = "tone"
tier = 2
text = "Base rule."

[[rule]]
id = "stronger"
category = "tone"
tier = 2
text = "Stronger rule."
overrides = ["tone/base"]
`);
  const library = buildRuleLibrary(CATS, rules);
  // Only "base" selected — "stronger" (and its override) never enters the set.
  const result = assembleRules(library, { categories: ["tone"], rules: ["tone/base"] });
  assert.deepEqual(result.included.map((r) => r.ref), ["tone/base"]);
  assert.equal(result.dropped.length, 0);
});

// ─── hash stability ──────────────────────────────────────────────────────────

test("assembleRules hash is stable for the same resolved set and changes when content changes", () => {
  const library = makeLibrary();
  const a = assembleRules(library, { categories: ["tone"], rules: ["tone/never_hedge"] });
  const b = assembleRules(library, { categories: ["tone"], rules: ["tone/never_hedge"] });
  assert.equal(a.hash, b.hash);

  const c = assembleRules(library, {
    categories: ["tone", "canon"],
    rules: ["tone/never_hedge", "canon/references_are_gospel", "canon/vibe_wins"],
  });
  assert.notEqual(a.hash, c.hash);
});

test("assembleRules hash is independent of rules-list order (same resolved set)", () => {
  const library = makeLibrary();
  const a = assembleRules(library, {
    categories: ["tone", "canon"],
    rules: [
      "tone/never_hedge",
      "tone/confident",
      "tone/no_whimsy",
      "canon/references_are_gospel",
      "canon/vibe_wins",
    ],
  });
  const b = assembleRules(library, {
    categories: ["canon", "tone"],
    rules: [
      "canon/references_are_gospel",
      "canon/vibe_wins",
      "tone/never_hedge",
      "tone/confident",
      "tone/no_whimsy",
    ],
  });
  assert.equal(a.hash, b.hash);
});
