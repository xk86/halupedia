import test from "node:test";
import assert from "node:assert/strict";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";
import type { LlmRouter } from "../src/server/llm";
import { HalupediaChatModel, type AgentLlmCallTrace } from "../src/server/agent/HalupediaChatModel";

function fakeRouter(response: string): LlmRouter & { lastCall?: { system: string; user: string; jsonSchema?: unknown } } {
  const router = {
    lastCall: undefined as { system: string; user: string; jsonSchema?: unknown } | undefined,
    async chat(_role: "heavy" | "light" | "images", system: string, user: string, options?: { jsonSchema?: Record<string, unknown> }) {
      router.lastCall = { system, user, jsonSchema: options?.jsonSchema };
      return response;
    },
    async streamChat() {
      throw new Error("not exercised in this test");
    },
    async embed() {
      throw new Error("not exercised in this test");
    },
    supportsVision() {
      return false;
    },
    async probeConnections() {},
  };
  return router;
}

const searchTool = tool(async () => "ok", {
  name: "search_articles",
  description: "Ranked semantic search.",
  schema: z.object({ query: z.string() }),
});

test("without bound tools, _generate returns the raw response as plain content", async () => {
  const router = fakeRouter("Solana is a blockchain network.");
  const model = new HalupediaChatModel({
    llmRouter: router,
    role: "heavy",
    systemPrompt: "You are a helpful assistant.",
  });
  const result = await model.invoke([new HumanMessage("What is Solana?")]);
  assert.equal(result.content, "Solana is a blockchain network.");
  assert.equal(router.lastCall?.jsonSchema, undefined);
  assert.match(router.lastCall?.system ?? "", /You are a helpful assistant\./);
});

test("bindTools switches into envelope mode and parses a tool call", async () => {
  const router = fakeRouter(
    JSON.stringify({ thought: "need data", action: { tool: "search_articles", args: { query: "solana" } } }),
  );
  const base = new HalupediaChatModel({
    llmRouter: router,
    role: "light",
    systemPrompt: "You are a research subagent.",
  });
  const bound = base.bindTools([searchTool]);
  const result = await bound.invoke([new HumanMessage("What is Solana?")]);

  assert.equal(result.tool_calls?.length, 1);
  assert.equal(result.tool_calls?.[0].name, "search_articles");
  assert.deepEqual(result.tool_calls?.[0].args, { query: "solana" });
  assert.ok(router.lastCall?.jsonSchema, "expected a jsonSchema-constrained call");
  assert.match(router.lastCall?.system ?? "", /search_articles/);
});

test("bindTools parses a final-answer turn with no tool call", async () => {
  const router = fakeRouter(JSON.stringify({ thought: "done", final: "Solana is a blockchain." }));
  const base = new HalupediaChatModel({
    llmRouter: router,
    role: "light",
    systemPrompt: "You are a research subagent.",
  });
  const bound = base.bindTools([searchTool]);
  const result = await bound.invoke([new HumanMessage("What is Solana?")]);
  assert.equal(result.tool_calls?.length ?? 0, 0);
  assert.equal(result.content, "Solana is a blockchain.");
});

test("onLlmCall fires once per _generate call with prompt/response captured", async () => {
  const router = fakeRouter("An answer.");
  const calls: AgentLlmCallTrace[] = [];
  const model = new HalupediaChatModel({
    llmRouter: router,
    role: "heavy",
    systemPrompt: "System prompt text.",
    onLlmCall: (call) => calls.push(call),
  });
  await model.invoke([new HumanMessage("Question?")]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].response, "An answer.");
  assert.match(calls[0].system, /System prompt text\./);
  assert.match(calls[0].user, /Question\?/);
});
