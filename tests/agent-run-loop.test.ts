import test from "node:test";
import assert from "node:assert/strict";
import { GraphRecursionError } from "@langchain/langgraph";
import { HumanMessage, AIMessage, type BaseMessage } from "@langchain/core/messages";
import { runAgentLoop } from "../src/server/agent/runAgentLoop";

function fakeAgent(states: Array<{ messages: BaseMessage[] }>, failAfter?: number) {
  return {
    async stream() {
      let i = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (failAfter !== undefined && i >= failAfter) {
                throw new GraphRecursionError("Recursion limit of 4 reached without hitting a stop condition.");
              }
              if (i >= states.length) return { done: true, value: undefined };
              const value = states[i];
              i += 1;
              return { done: false, value };
            },
          };
        },
      };
    },
  };
}

test("runAgentLoop returns the final state when the loop completes normally", async () => {
  const input = { messages: [new HumanMessage("hi")] };
  const finalState = { messages: [...input.messages, new AIMessage("done")] };
  const agent = fakeAgent([finalState]);

  const result = await runAgentLoop(agent, input, 4);
  assert.equal(result.hitRecursionLimit, false);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages.at(-1)?.content, "done");
});

test("runAgentLoop falls back to the last known messages on GraphRecursionError", async () => {
  const input = { messages: [new HumanMessage("hi")] };
  const partialState = {
    messages: [...input.messages, new AIMessage({ content: "", tool_calls: [{ id: "1", name: "research", args: {}, type: "tool_call" as const }] })],
  };
  const agent = fakeAgent([partialState], 1);

  const result = await runAgentLoop(agent, input, 4);
  assert.equal(result.hitRecursionLimit, true);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages, partialState.messages);
});

test("runAgentLoop falls back to the input messages if it fails before any state is emitted", async () => {
  const input = { messages: [new HumanMessage("hi")] };
  const agent = fakeAgent([], 0);

  const result = await runAgentLoop(agent, input, 4);
  assert.equal(result.hitRecursionLimit, true);
  assert.equal(result.messages, input.messages);
});

test("runAgentLoop rethrows errors that are not GraphRecursionError", async () => {
  const input = { messages: [new HumanMessage("hi")] };
  const agent = {
    async stream() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw new Error("boom");
            },
          };
        },
      };
    },
  };

  await assert.rejects(() => runAgentLoop(agent, input, 4), /boom/);
});
