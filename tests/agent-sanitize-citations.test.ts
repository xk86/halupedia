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
