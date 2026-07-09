import test from "node:test";
import assert from "node:assert/strict";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  buildEnvelopeJsonSchema,
  envelopeStepToAIMessage,
  parseEnvelopeStep,
  renderToolCatalog,
  renderTranscript,
} from "../src/server/agent/protocol";

function makeTool(name: string, description: string) {
  return tool(async () => "ok", {
    name,
    description,
    schema: z.object({ query: z.string() }),
  });
}

test("buildEnvelopeJsonSchema enumerates tool names", () => {
  const tools = [makeTool("search_articles", "search"), makeTool("read_article", "read")];
  const schema = buildEnvelopeJsonSchema(tools);
  const action = (schema.properties as Record<string, unknown>).action as {
    properties: { tool: { enum: string[] } };
  };
  assert.deepEqual(action.properties.tool.enum, ["search_articles", "read_article"]);
});

test("renderToolCatalog lists every tool's name and description", () => {
  const tools = [makeTool("search_articles", "Ranked semantic search.")];
  const catalog = renderToolCatalog(tools);
  assert.match(catalog, /search_articles/);
  assert.match(catalog, /Ranked semantic search\./);
});

test("parseEnvelopeStep parses a tool-call turn", () => {
  const step = parseEnvelopeStep(
    JSON.stringify({ thought: "need more info", action: { tool: "search_articles", args: { query: "solana" } } }),
  );
  assert.equal(step.action?.tool, "search_articles");
  assert.deepEqual(step.action?.args, { query: "solana" });
});

test("parseEnvelopeStep parses a final-answer turn", () => {
  const step = parseEnvelopeStep(JSON.stringify({ thought: "done", final: "Solana is a blockchain." }));
  assert.equal(step.final, "Solana is a blockchain.");
});

test("parseEnvelopeStep tolerates prose wrapped around the JSON", () => {
  const step = parseEnvelopeStep(
    `Sure, here's my answer:\n\`\`\`json\n${JSON.stringify({ final: "Answer." })}\n\`\`\``,
  );
  assert.equal(step.final, "Answer.");
});

test("parseEnvelopeStep falls back to treating unparseable text as the final answer", () => {
  const step = parseEnvelopeStep("I cannot produce JSON right now, sorry.");
  assert.equal(step.final, "I cannot produce JSON right now, sorry.");
  assert.equal(step.action, undefined);
});

test("envelopeStepToAIMessage produces tool_calls for an action step", () => {
  const message = envelopeStepToAIMessage({
    thought: "searching",
    action: { tool: "search_articles", args: { query: "solana" } },
  });
  assert.equal(message.tool_calls?.length, 1);
  assert.equal(message.tool_calls?.[0].name, "search_articles");
  assert.deepEqual(message.tool_calls?.[0].args, { query: "solana" });
});

test("envelopeStepToAIMessage produces no tool_calls for a final step", () => {
  const message = envelopeStepToAIMessage({ thought: "done", final: "The answer." });
  assert.equal(message.tool_calls?.length ?? 0, 0);
  assert.equal(message.content, "The answer.");
});

test("renderTranscript renders human/tool-call/tool-result turns in order, skipping system", () => {
  const messages = [
    new HumanMessage("What is Solana?"),
    new AIMessage({
      content: "",
      tool_calls: [{ id: "1", name: "search_articles", args: { query: "solana" }, type: "tool_call" }],
    }),
    new ToolMessage({ content: "- Solana (slug: solana): a blockchain." }, "1", "search_articles"),
  ];
  const transcript = renderTranscript(messages);
  assert.match(transcript, /User: What is Solana\?/);
  assert.match(transcript, /called search_articles with \{"query":"solana"\}/);
  assert.match(transcript, /Tool result: - Solana \(slug: solana\): a blockchain\./);
});
