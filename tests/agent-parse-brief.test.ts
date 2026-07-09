import test from "node:test";
import assert from "node:assert/strict";
import { parseBrief } from "../src/server/agent/researchSubagent";

test("parseBrief strips a stray markdown heading marker from a reference title", () => {
  const brief = parseBrief(
    JSON.stringify({
      summary: "Bingus are experimental drones.",
      references: [{ slug: "bingus", title: "# Bingus", relevance: "primary subject" }],
    }),
  );
  assert.equal(brief.references[0].title, "Bingus");
});

test("parseBrief leaves an already-clean title untouched", () => {
  const brief = parseBrief(
    JSON.stringify({ summary: "x", references: [{ slug: "bingus", title: "Bingus" }] }),
  );
  assert.equal(brief.references[0].title, "Bingus");
});

test("parseBrief falls back to raw text as the summary on invalid JSON", () => {
  const brief = parseBrief("not json");
  assert.equal(brief.summary, "not json");
  assert.deepEqual(brief.references, []);
});

test("parseBrief drops malformed reference entries but keeps valid ones", () => {
  const brief = parseBrief(
    JSON.stringify({
      summary: "x",
      references: [
        { slug: "ok", title: "Ok" },
        { slug: 123, title: "Bad slug type" },
        { title: "Missing slug" },
      ],
    }),
  );
  assert.equal(brief.references.length, 1);
  assert.equal(brief.references[0].slug, "ok");
});
