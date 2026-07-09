/**
 * LangChain `BaseChatModel` adapter over the existing `LlmRouter`.
 *
 * Why a custom adapter instead of `@langchain/ollama`'s `ChatOllama`: the
 * router already owns host-pool load balancing, failover, and the
 * `heavy`/`light` role split (`src/server/llm.ts`). Routing agent calls
 * through it keeps one code path to the model instead of a second one that
 * bypasses the scheduler.
 *
 * Tool use: local Ollama-compatible models don't reliably support native
 * function-calling, so `bindTools` doesn't forward LangChain's `tools` param
 * to the backend. Instead it switches this model into "envelope mode" —
 * `_generate` renders the bound tools' catalog into the system prompt and
 * constrains the response via `LlmRouter`'s `jsonSchema` structured-output
 * option (`protocol.ts`), then parses the JSON into the `tool_calls` shape
 * LangGraph's prebuilt ReAct agent expects. This makes `createReactAgent`
 * work unmodified against local models.
 */
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { LlmRole, LlmRouter } from "../llm";
import {
  buildEnvelopeJsonSchema,
  ENVELOPE_INSTRUCTIONS,
  envelopeStepToAIMessage,
  parseEnvelopeStep,
  renderToolCatalog,
  renderTranscript,
} from "./protocol";

export type ChatLlmRole = Exclude<LlmRole, "images" | "embeddings">;

/** One LLM call's prompt/response, handed to `traceSink` for the agent
 *  tracing harness to fold into a `pipeline_nodes` row (see `trace.ts`). */
export interface AgentLlmCallTrace {
  role: ChatLlmRole;
  system: string;
  user: string;
  response: string;
  durationMs: number;
}

export interface HalupediaChatModelFields extends BaseChatModelParams {
  llmRouter: LlmRouter;
  role: ChatLlmRole;
  /** Static system-prompt text (already {{shared_*}}-expanded) prepended to
   *  every call, ahead of the tool catalog / envelope instructions. */
  systemPrompt: string;
  /** Called once per underlying LLM call — the tracing harness uses this to
   *  surface every turn's prompt/response in the admin traces view. */
  onLlmCall?: (call: AgentLlmCallTrace) => void;
}

export class HalupediaChatModel extends BaseChatModel {
  private readonly llmRouter: LlmRouter;
  private readonly role: ChatLlmRole;
  private readonly systemPrompt: string;
  private readonly onLlmCall?: (call: AgentLlmCallTrace) => void;
  private boundTools: StructuredToolInterface[] = [];

  constructor(fields: HalupediaChatModelFields) {
    super(fields);
    this.llmRouter = fields.llmRouter;
    this.role = fields.role;
    this.systemPrompt = fields.systemPrompt;
    this.onLlmCall = fields.onLlmCall;
  }

  _llmType(): string {
    return "halupedia-chat-model";
  }

  /** Returns a clone bound to these tools — matches the shape
   *  `createReactAgent` expects from a `bindTools`-capable model. */
  bindTools(tools: StructuredToolInterface[]): HalupediaChatModel {
    const clone = new HalupediaChatModel({
      llmRouter: this.llmRouter,
      role: this.role,
      systemPrompt: this.systemPrompt,
      onLlmCall: this.onLlmCall,
    });
    clone.boundTools = tools;
    return clone;
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const systemMessage = messages.find((m) => m.getType() === "system");
    const systemPreamble = [
      this.systemPrompt,
      systemMessage ? contentText(systemMessage.content) : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const hasTools = this.boundTools.length > 0;
    const system = hasTools
      ? `${systemPreamble}\n\nTools available:\n${renderToolCatalog(this.boundTools)}\n\n${ENVELOPE_INSTRUCTIONS}`
      : systemPreamble;
    const user = renderTranscript(messages);

    const startedAt = Date.now();
    const raw = await this.llmRouter.chat(
      this.role,
      system,
      user,
      hasTools ? { jsonSchema: buildEnvelopeJsonSchema(this.boundTools) } : {},
    );
    this.onLlmCall?.({
      role: this.role,
      system,
      user,
      response: raw,
      durationMs: Date.now() - startedAt,
    });

    const message = hasTools
      ? envelopeStepToAIMessage(parseEnvelopeStep(raw))
      : new AIMessage(raw);

    return {
      generations: [
        {
          message,
          text: typeof message.content === "string" ? message.content : "",
        },
      ],
    };
  }
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
