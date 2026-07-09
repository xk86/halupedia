import test from "node:test";
import assert from "node:assert/strict";
import { renderChatAnswer, unwrapUnclosedCitations } from "../src/server/agent/chatAgent";
import type { ResearchBriefReference } from "../src/server/agent/researchSubagent";

const refs: ResearchBriefReference[] = [
  { slug: "bingus", title: "Bingus" },
  { slug: "extreme-testing", title: "Extreme testing" },
];

test("renderChatAnswer resolves a well-formed citation to a real /wiki/ link", () => {
  const html = renderChatAnswer("See [Bingus](ref:bingus) for details.", refs);
  assert.match(html, /<a href="\/wiki\/Bingus">Bingus<\/a>/);
});

test("renderChatAnswer promotes a bare [Title] bracket naming a known reference", () => {
  const html = renderChatAnswer("A bare [Bingus] mention.", refs);
  assert.match(html, /<a href="\/wiki\/Bingus">Bingus<\/a>/);
});

test("renderChatAnswer unwraps a bare bracket that names no known reference", () => {
  const html = renderChatAnswer("A stray [Summary] artifact.", refs);
  assert.doesNotMatch(html, /\[Summary\]/);
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /A stray Summary artifact\./);
});

test("renderChatAnswer resolves a bracket-less 'Title (ref:slug)' citation", () => {
  const html = renderChatAnswer(
    "Research points to Extreme testing (ref:extreme-testing) here.",
    refs,
  );
  assert.match(html, /<a href="\/wiki\/Extreme_testing">Extreme testing<\/a>/);
  assert.doesNotMatch(html, /\(ref:extreme-testing\)/);
});

test("renderChatAnswer strips a real link back to the excluded self-slug", () => {
  const html = renderChatAnswer("See [Bingus](ref:bingus) for more.", refs, "bingus");
  assert.doesNotMatch(html, /href="\/wiki\/Bingus"/);
  assert.match(html, /See Bingus for more\./);
});

test("renderChatAnswer leaves other links untouched when a different selfSlug is given", () => {
  const html = renderChatAnswer("See [Bingus](ref:bingus) for more.", refs, "extreme-testing");
  assert.match(html, /<a href="\/wiki\/Bingus">Bingus<\/a>/);
});

test("renderChatAnswer unwraps a citation whose closing paren was never written, without touching a later real link", () => {
  const html = renderChatAnswer(
    "Systems [Bingus](ref:bingus-oops, which lists things [Extreme testing](ref:extreme-testing) and so on.",
    refs,
  );
  assert.doesNotMatch(html, /\(ref:bingus-oops/);
  assert.match(html, /Systems Bingus, which lists things/);
  assert.match(html, /<a href="\/wiki\/Extreme_testing">Extreme testing<\/a>/);
});

test("renderChatAnswer renders plain prose with no references untouched", () => {
  const html = renderChatAnswer("Nothing relevant was found.", []);
  assert.match(html, /Nothing relevant was found\./);
});

test("unwrapUnclosedCitations only touches a citation missing its closing paren", () => {
  const wellFormed = "See [Bingus](ref:bingus) for details.";
  assert.equal(unwrapUnclosedCitations(wellFormed), wellFormed);
  const broken = "See [Bingus](ref:bingus, which is a drone.";
  assert.equal(unwrapUnclosedCitations(broken), "See Bingus, which is a drone.");
});
