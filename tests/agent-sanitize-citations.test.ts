import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeCitations } from "../src/server/agent/chatAgent";

test("sanitizeCitations strips bracket-only pseudo-citations", () => {
  const input =
    "Bingus are drones [Summary]. They caused ecological devastation [Source], per official reports [Reference].";
  const output = sanitizeCitations(input);
  assert.doesNotMatch(output, /\[Summary\]|\[Source\]|\[Reference\]/);
  assert.match(output, /Bingus are drones\./);
  assert.match(output, /ecological devastation,/);
});

test("sanitizeCitations leaves real markdown links untouched", () => {
  const input = "See [Bingus](ref:bingus) and [New Alexandria](halu:new-alexandria \"a city\") for details.";
  assert.equal(sanitizeCitations(input), input);
});

test("sanitizeCitations is case-insensitive and handles plurals", () => {
  const input = "It spread quickly [sources]. Multiple reports agree [citations].";
  const output = sanitizeCitations(input);
  assert.doesNotMatch(output, /\[sources\]|\[citations\]/i);
});

test("sanitizeCitations collapses the whitespace left behind", () => {
  const output = sanitizeCitations("A sentence ends here [Summary]. Another follows.");
  assert.equal(output, "A sentence ends here. Another follows.");
});

test("sanitizeCitations strips a bare kebab-slug bracket", () => {
  const input =
    "These protocols exceed conventional diagnostics [advanced-testing-procedures]. More detail follows.";
  const output = sanitizeCitations(input);
  assert.doesNotMatch(output, /\[advanced-testing-procedures\]/);
  assert.match(output, /diagnostics\. More detail follows\./);
});

test("sanitizeCitations leaves a single-word bracket alone (not slug-shaped)", () => {
  const input = "The term is used loosely [sic] in older sources.";
  assert.equal(sanitizeCitations(input), input);
});

test("sanitizeCitations strips a real link to the excluded self-slug", () => {
  const input =
    "These systems exceed conventional diagnostics [Advanced testing procedures](ref:advanced-testing-procedures). More detail follows.";
  const output = sanitizeCitations(input, "advanced-testing-procedures");
  assert.doesNotMatch(output, /advanced-testing-procedures/);
  assert.match(output, /diagnostics\. More detail follows\./);
});

test("sanitizeCitations with a selfSlug leaves other real links alone", () => {
  const input = "See [Bingus](ref:bingus) for details.";
  assert.equal(sanitizeCitations(input, "advanced-testing-procedures"), input);
});

test("sanitizeCitations unwraps a citation whose paren was never closed", () => {
  const input =
    "Materials and systems [advanced-testing-procedures](ref:advanced-testing-procedurestest, which lists them as a related procedure [Test test](ref:test-test), and so on.";
  const output = sanitizeCitations(input);
  assert.doesNotMatch(output, /\(ref:advanced-testing-procedurestest/);
  assert.match(output, /^Materials and systems advanced-testing-procedures, which lists/);
  assert.match(output, /\[Test test\]\(ref:test-test\)/);
});
