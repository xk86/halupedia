import test from "node:test";
import assert from "node:assert/strict";

import { buildRuleLibrary, parseRuleFile } from "../src/server/rules/library";
import { buildPromptRegistry } from "../src/server/pipeline/prompts/registry";
import type { PromptConfig } from "../src/server/types";

function makeConfig(): PromptConfig {
  const cats = [
    { id: "output_contract", title: "Output contract", description: "Response shape.", order: 50 },
    { id: "tone", title: "Tone rules", description: "Voice and phrasing.", order: 20 },
  ];
  const rules = parseRuleFile(`
[[rule]]
id = "full_input"
category = "output_contract"
tier = 1
text = "The current article field contains the full article."

[[rule]]
id = "partial_input"
category = "output_contract"
tier = 1
text = "The current article field contains only the targeted fragment."

[[rule]]
id = "never_hedge"
category = "tone"
tier = 1
text = "Never hedge or disclaim."
`);
  const ruleLibrary = buildRuleLibrary(cats, rules);

  return {
    prompts: {
      article_rewrite: {
        system: "{{rules}}\n\nBody: {{current_article}}",
        user: "user body",
        rules: { categories: ["tone"] },
      },
    },
    shared: {},
    rewriteModes: {},
    ruleLibrary,
  };
}

test("render() without extraInclude uses the precomputed static rules and trace", () => {
  const registry = buildPromptRegistry(makeConfig());
  const rendered = registry.render("article_rewrite", { current_article: "x" });
  assert.match(rendered.system, /Never hedge or disclaim\./);
  assert.doesNotMatch(rendered.system, /current article field/);
  assert.deepEqual(
    rendered.rulesTrace?.included.map((r) => r.ref),
    ["tone/never_hedge"],
  );
});

test("render() with extraInclude merges static + runtime selectors into one assembled block and trace", () => {
  const registry = buildPromptRegistry(makeConfig());
  const rendered = registry.render(
    "article_rewrite",
    { current_article: "x" },
    { extraInclude: ["output_contract/full_input"] },
  );
  assert.match(rendered.system, /Never hedge or disclaim\./);
  assert.match(rendered.system, /contains the full article/);
  assert.doesNotMatch(rendered.system, /targeted fragment/);
  assert.deepEqual(
    rendered.rulesTrace?.included.map((r) => r.ref).sort(),
    ["output_contract/full_input", "tone/never_hedge"],
  );
});

test("render() with extraInclude does not mutate the entry used by later calls without it", () => {
  const registry = buildPromptRegistry(makeConfig());
  registry.render(
    "article_rewrite",
    { current_article: "x" },
    { extraInclude: ["output_contract/partial_input"] },
  );
  const rendered = registry.render("article_rewrite", { current_article: "x" });
  assert.doesNotMatch(rendered.system, /targeted fragment/);
  assert.deepEqual(
    rendered.rulesTrace?.included.map((r) => r.ref),
    ["tone/never_hedge"],
  );
});

test("render() with extraInclude produces a templateHash that differs from the static-only render", () => {
  const registry = buildPromptRegistry(makeConfig());
  const staticOnly = registry.render("article_rewrite", { current_article: "x" });
  const withExtra = registry.render(
    "article_rewrite",
    { current_article: "x" },
    { extraInclude: ["output_contract/full_input"] },
  );
  assert.notEqual(staticOnly.templateHash, withExtra.templateHash);
});
