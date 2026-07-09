/**
 * JSON action-envelope protocol for driving LangGraph's tool-calling loop on
 * local Ollama-compatible models, which don't reliably support native
 * function/tool-calling.
 *
 * Each control turn asks the model for exactly one of:
 *   - `{ thought, action: { tool, args } }`  — call one tool, keep looping
 *   - `{ thought, final }`                    — stop, `final` is the answer
 *
 * The turn is constrained via `LlmRouter`'s `jsonSchema` structured-output
 * option (stronger than free-form JSON mode on local models), so parsing is a
 * straightforward `JSON.parse` with a bit of tolerance for stray whitespace.
 */
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { randomUUID } from "node:crypto";

export interface EnvelopeStep {
  thought?: string;
  action?: { tool: string; args?: Record<string, unknown> };
  final?: string;
}

/** JSON Schema passed as `ChatOptions.jsonSchema` when tools are bound. */
export function buildEnvelopeJsonSchema(
  tools: readonly StructuredToolInterface[],
): Record<string, unknown> {
  const toolNames = tools.map((t) => t.name);
  return {
    type: "object",
    properties: {
      thought: { type: "string" },
      action: {
        type: "object",
        properties: {
          tool: { type: "string", enum: toolNames },
          args: { type: "object" },
        },
        required: ["tool"],
      },
      final: { type: "string" },
    },
  };
}

/** Human-readable tool catalog appended to the system prompt so the model
 *  knows what each tool does and what arguments it takes. */
export function renderToolCatalog(
  tools: readonly StructuredToolInterface[],
): string {
  return tools
    .map((t) => {
      let schemaText = "{}";
      try {
        schemaText = JSON.stringify(toJsonSchema(t.schema));
      } catch {
        // Best-effort; a tool with an unrepresentable schema still gets listed.
      }
      return `- ${t.name}(${schemaText}): ${t.description}`;
    })
    .join("\n");
}

export const ENVELOPE_INSTRUCTIONS = `
Respond with exactly one JSON object per turn, matching this shape:
  { "thought": "<your reasoning, one or two sentences>",
    "action": { "tool": "<tool name>", "args": { ... } } }
or, once you have enough information:
  { "thought": "<your reasoning>", "final": "<your final answer>" }
Never include both "action" and "final" in the same turn. Never call the same
tool with the same arguments twice in a row. Output only the JSON object, no
other text.`;

/** Render the LangGraph message history as a single transcript string —
 *  `HalupediaChatModel` hands this to `LlmRouter.chat` as the `user` turn
 *  since the router only accepts a flat system+user pair, not a message
 *  array. Kept in reading order so the model sees the whole conversation. */
export function renderTranscript(messages: readonly BaseMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const kind = message.getType();
    if (kind === "system") continue; // folded into the system prompt separately
    if (kind === "human") {
      lines.push(`User: ${contentText(message.content)}`);
    } else if (kind === "ai") {
      const ai = message as AIMessage;
      if (ai.tool_calls?.length) {
        const call = ai.tool_calls[0];
        lines.push(
          `Assistant: [called ${call.name} with ${JSON.stringify(call.args ?? {})}]`,
        );
      } else {
        lines.push(`Assistant: ${contentText(ai.content)}`);
      }
    } else if (kind === "tool") {
      lines.push(`Tool result: ${contentText(message.content)}`);
    }
  }
  lines.push("Respond with your next action as JSON.");
  return lines.join("\n\n");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part === "object" && part && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
      )
      .join("");
  }
  return "";
}

/** Parse one model turn into an envelope step. Tolerates a model that wraps
 *  the JSON in prose or code fences — extracts the first `{...}` block. */
export function parseEnvelopeStep(raw: string): EnvelopeStep {
  const trimmed = raw.trim();
  const jsonText = extractJsonObject(trimmed) ?? trimmed;
  try {
    const parsed = JSON.parse(jsonText) as EnvelopeStep;
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch {
    // fall through to the plain-text fallback below
  }
  // The model didn't emit valid JSON — treat its raw text as the final
  // answer rather than aborting the whole loop over a formatting slip.
  return { final: trimmed };
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

/** Convert a parsed envelope step into the AIMessage LangGraph expects —
 *  `tool_calls` non-empty routes to the ToolNode; empty ends the loop. */
export function envelopeStepToAIMessage(step: EnvelopeStep): AIMessage {
  if (step.action?.tool) {
    return new AIMessage({
      content: step.thought ?? "",
      tool_calls: [
        {
          id: randomUUID(),
          name: step.action.tool,
          args: step.action.args ?? {},
          type: "tool_call",
        },
      ],
    });
  }
  return new AIMessage({ content: step.final ?? step.thought ?? "" });
}
