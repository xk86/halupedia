import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRuleRefRenames,
  renameRuleSelector,
} from "../src/server/rules/admin";
import { buildRuleLibrary } from "../src/server/rules/library";
import type { CategoryDef, RuleDef } from "../src/server/rules/types";

const categories: CategoryDef[] = [
  { id: "tone", title: "Tone", description: "Voice rules.", order: 10 },
];

test("rule id renames update dependent overrides before library validation", () => {
  const rules: RuleDef[] = [
    { id: "new_name", category: "tone", tier: 1, text: "Renamed." },
    {
      id: "dependent",
      category: "tone",
      tier: 2,
      text: "Depends on the renamed rule.",
      overrides: ["tone/old_name"],
    },
  ];

  const renamed = applyRuleRefRenames(
    rules,
    new Map([["tone/old_name", "tone/new_name"]]),
  );

  assert.deepEqual(renamed[1]?.overrides, ["tone/new_name"]);
  assert.doesNotThrow(() => buildRuleLibrary(categories, renamed));
});

test("rule id renames update exact prompt selectors and preserve selector operators", () => {
  const renames = new Map([["tone/old_name", "tone/new_name"]]);

  assert.equal(renameRuleSelector("tone/old_name", renames), "tone/new_name");
  assert.equal(renameRuleSelector("!tone/old_name", renames), "!tone/new_name");
  assert.equal(renameRuleSelector("tone/*", renames), "tone/*");
  assert.equal(renameRuleSelector("canon/other", renames), "canon/other");
});
