import test from "node:test";
import assert from "node:assert/strict";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { ReferenceCollector } from "../src/server/agent/references";
import { buildResearchTrace } from "../src/server/agent/researchSubagent";

test("ReferenceCollector dedupes by slug and keeps the strongest signal", () => {
  const c = new ReferenceCollector();
  // Same article surfaced first by search, then actually read.
  c.add({ slug: "bingus", title: "Bingus", via: "search", score: 0.4, relevance: "a cat" });
  c.add({ slug: "bingus", title: "Bingus", via: "read" });
  c.add({ slug: "florp", title: "Florp", via: "search", score: 0.9 });

  const refs = c.references();
  assert.equal(refs.length, 2);
  // `read` outranks the higher search score, so bingus comes first...
  assert.deepEqual(
    refs.map((r) => r.slug),
    ["bingus", "florp"],
  );
  // ...and the relevance from the earlier search hit is retained.
  assert.equal(refs[0].relevance, "a cat");
});

test("ReferenceCollector ranks equal-signal articles by score and caps the list", () => {
  const c = new ReferenceCollector();
  for (let i = 0; i < 12; i++) {
    c.add({ slug: `a${i}`, title: `A${i}`, via: "search", score: i / 100 });
  }
  const refs = c.references();
  assert.equal(refs.length, 8);
  // Highest score first.
  assert.equal(refs[0].slug, "a11");
});

test("ReferenceCollector yields nothing when no article was touched", () => {
  assert.deepEqual(new ReferenceCollector().references(), []);
});

test("ReferenceCollector strips markdown emphasis from titles", () => {
  const c = new ReferenceCollector();
  c.add({ slug: "extreme-testing", title: "**Extreme testing**", via: "search" });
  c.add({ slug: "heading", title: "# A Heading Title", via: "read" });
  const refs = c.references();
  assert.equal(refs.find((r) => r.slug === "extreme-testing")?.title, "Extreme testing");
  assert.equal(refs.find((r) => r.slug === "heading")?.title, "A Heading Title");
});

test("buildResearchTrace pairs each tool call with its result and closing thought", () => {
  const messages = [
    new HumanMessage("who is bingus"),
    new AIMessage({
      content: "I should search the corpus.",
      tool_calls: [
        { id: "1", name: "search_articles", args: { query: "bingus" }, type: "tool_call" },
      ],
    }),
    new ToolMessage({ content: "- Bingus (slug: bingus, score: 0.80): a cat", tool_call_id: "1" }),
    new AIMessage("Found enough — Bingus is a cat."),
  ];

  const trace = buildResearchTrace(messages);
  assert.equal(trace.length, 2);
  assert.deepEqual(trace[0], {
    thought: "I should search the corpus.",
    tool: "search_articles",
    args: { query: "bingus" },
    result: "- Bingus (slug: bingus, score: 0.80): a cat",
  });
  assert.deepEqual(trace[1], { thought: "Found enough — Bingus is a cat." });
});
