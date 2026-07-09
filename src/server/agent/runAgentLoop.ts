/**
 * Runs a `createReactAgent` graph and always returns whatever message
 * transcript it produced — even if it hits LangGraph's recursion limit
 * without reaching a clean stop.
 *
 * Local models occasionally fail to emit a clean `final` envelope within a
 * tight iteration budget (see `HalupediaChatModel`/`protocol.ts`). Rather
 * than raising the limit or surfacing `GraphRecursionError` to the user, we
 * stream state snapshots and keep the latest one; on a recursion-limit hit
 * we fall back to using that partial transcript — whatever the agent
 * actually found before running out of turns — instead of failing outright.
 * Callers (`chatAgent.ts`, `researchSubagent.ts`) both finish with a
 * non-agentic synthesis step over this transcript, so a slow/confused loop
 * degrades to "answer from what we have" rather than an error.
 */
import { GraphRecursionError } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

interface StreamableAgent {
  stream(
    input: { messages: BaseMessage[] },
    options: { recursionLimit: number; streamMode: "values" },
  ): Promise<AsyncIterable<{ messages: BaseMessage[] }>>;
}

export interface AgentLoopResult {
  messages: BaseMessage[];
  /** True when the loop was cut off by the recursion limit rather than
   *  reaching its own stop condition — the transcript may be incomplete. */
  hitRecursionLimit: boolean;
}

export async function runAgentLoop(
  agent: StreamableAgent,
  input: { messages: BaseMessage[] },
  recursionLimit: number,
): Promise<AgentLoopResult> {
  let messages = input.messages;
  try {
    const stream = await agent.stream(input, {
      recursionLimit,
      streamMode: "values",
    });
    for await (const state of stream) {
      messages = state.messages;
    }
    return { messages, hitRecursionLimit: false };
  } catch (err) {
    if (err instanceof GraphRecursionError) {
      return { messages, hitRecursionLimit: true };
    }
    throw err;
  }
}
