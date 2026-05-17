import type { ChatConfig, EmbeddingsConfig } from "./types";
import { createConsoleLogger, type Logger, truncateForLog } from "./logger";

export type LlmRole = "heavy" | "light" | "embeddings";
type ChatLlmRole = Exclude<LlmRole, "embeddings">;

export interface ChatOptions {
  thinking?: boolean;
}

export interface LlmClient {
  chat(system: string, user: string, options?: ChatOptions): Promise<string>;
  streamChat(
    system: string,
    user: string,
    onChunk: (delta: string, accumulated: string) => void,
    options?: ChatOptions,
  ): Promise<{ content: string; finishReason: string }>;
  embed(input: string[]): Promise<number[][]>;
  probeConnections(): Promise<void>;
}

function chatRequestFields(role: ChatLlmRole, config: ChatConfig, promptChars: number, options: ChatOptions) {
  return {
    role,
    model: config.model,
    max_tokens: config.max_tokens,
    temperature: config.temperature,
    thinking: options.thinking ?? false,
    prompt_chars: promptChars,
  };
}

function chatResultFields(
  role: ChatLlmRole,
  config: ChatConfig,
  fields: {
    finishReason: string;
    durationMs: number;
    completionChars: number;
    tokens?: number | string;
  },
) {
  return {
    role,
    model: config.model,
    finish_reason: fields.finishReason,
    duration_ms: fields.durationMs,
    completion_chars: fields.completionChars,
    ...(fields.tokens === undefined ? {} : { tokens: fields.tokens }),
  };
}

function llmErrorFields(role: LlmRole, model: string, status: number, body: string) {
  return {
    role,
    model,
    status,
    body: truncateForLog(body, 300),
  };
}

function embedRequestFields(config: EmbeddingsConfig, inputCount: number) {
  return {
    role: "embeddings" as const,
    model: config.model,
    inputs: inputCount,
  };
}

function embedResponseFields(config: EmbeddingsConfig, vectorCount: number, durationMs: number) {
  return {
    role: "embeddings" as const,
    model: config.model,
    vectors: vectorCount,
    duration_ms: durationMs,
  };
}

export class OpenAICompatClient implements LlmClient {
  constructor(
    private readonly chatConfig: ChatConfig,
    private readonly embeddingsConfig: EmbeddingsConfig,
    private readonly logger: Logger = createConsoleLogger(),
    private readonly role: ChatLlmRole,
  ) {}

  async chat(system: string, user: string, options: ChatOptions = {}): Promise<string> {
    const startedAt = Date.now();
    const url = `${this.chatConfig.base_url.replace(/\/$/, "")}/chat/completions`;
    this.logger.info("llm.chat_request", chatRequestFields(this.role, this.chatConfig, system.length + user.length, options));
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.chatConfig.api_key}`,
      },
      body: JSON.stringify({
        model: this.chatConfig.model,
        temperature: this.chatConfig.temperature,
        max_tokens: this.chatConfig.max_tokens,
        think: options.thinking ?? false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.logger.error("llm.chat_error", llmErrorFields(this.role, this.chatConfig.model, response.status, text));
      throw new Error(`chat completion failed: ${response.status} ${text.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      id?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content?.trim();
    const finishReason = json.choices?.[0]?.finish_reason ?? "unknown";
    const durationMs = Date.now() - startedAt;
    this.logger.info("llm.chat_response", chatResultFields(this.role, this.chatConfig, {
      finishReason,
      durationMs,
      completionChars: content?.length ?? 0,
      tokens: json.usage?.total_tokens ?? "?",
    }));
    if (finishReason === "length") {
      this.logger.warn("llm.chat_truncated", {
        role: this.role,
        model: this.chatConfig.model,
        preview: truncateForLog(content ?? "", 240),
      });
    }
    if (!content) {
      throw new Error("chat completion returned empty content");
    }
    return content;
  }

  async streamChat(
    system: string,
    user: string,
    onChunk: (delta: string, accumulated: string) => void,
    options: ChatOptions = {},
  ): Promise<{ content: string; finishReason: string }> {
    const startedAt = Date.now();
    const url = `${this.chatConfig.base_url.replace(/\/$/, "")}/chat/completions`;
    this.logger.info("llm.stream_request", chatRequestFields(this.role, this.chatConfig, system.length + user.length, options));
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.chatConfig.api_key}`,
      },
      body: JSON.stringify({
        model: this.chatConfig.model,
        temperature: this.chatConfig.temperature,
        max_tokens: this.chatConfig.max_tokens,
        stream: true,
        think: options.thinking ?? false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      this.logger.error("llm.stream_error", llmErrorFields(this.role, this.chatConfig.model, response.status, text));
      throw new Error(`chat stream failed: ${response.status} ${text.slice(0, 300)}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";
    let finishReason = "unknown";
    const reader = response.body.getReader();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          newlineIndex = -1;
          break;
        }
        let json:
          | {
              choices?: Array<{
                finish_reason?: string | null;
                delta?: { content?: string };
                message?: { content?: string };
              }>;
            }
          | undefined;
        try {
          json = JSON.parse(payload) as typeof json;
        } catch {
          // Ignore malformed chunks from local providers and continue.
          continue;
        }
        const choice = json?.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta?.content ?? choice?.message?.content ?? "";
        if (!delta) continue;
        accumulated += delta;
        onChunk(delta, accumulated);
      }
    }

    const content = accumulated.trim();
    const durationMs = Date.now() - startedAt;
    this.logger.info("llm.stream_response", chatResultFields(this.role, this.chatConfig, {
      finishReason,
      durationMs,
      completionChars: content.length,
    }));
    if (finishReason === "length") {
      this.logger.warn("llm.stream_truncated", {
        role: this.role,
        model: this.chatConfig.model,
        preview: truncateForLog(content, 240),
      });
    }
    if (!content) {
      throw new Error("chat stream returned empty content");
    }
    return { content, finishReason };
  }

  async embed(input: string[]): Promise<number[][]> {
    if (!this.embeddingsConfig.enabled || input.length === 0) {
      return [];
    }

    const startedAt = Date.now();
    const url = `${this.embeddingsConfig.base_url.replace(/\/$/, "")}/embeddings`;
    this.logger.info("llm.embed_request", embedRequestFields(this.embeddingsConfig, input.length));
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.embeddingsConfig.api_key}`,
      },
      body: JSON.stringify({
        model: this.embeddingsConfig.model,
        input,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.logger.error("llm.embed_error", llmErrorFields("embeddings", this.embeddingsConfig.model, response.status, text));
      throw new Error(`embeddings failed: ${response.status} ${text.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    this.logger.info("llm.embed_response", embedResponseFields(this.embeddingsConfig, json.data?.length ?? 0, Date.now() - startedAt));
    return (json.data ?? []).map((item) => item.embedding ?? []);
  }

  async probeConnections(): Promise<void> {
    await this.probeEndpoint(this.role, this.chatConfig.base_url, this.chatConfig.api_key);
    if (this.embeddingsConfig.enabled) {
      await this.probeEndpoint("embeddings", this.embeddingsConfig.base_url, this.embeddingsConfig.api_key);
    } else {
      this.logger.info("llm.embed_disabled", { role: "embeddings" });
    }
  }

  private async probeEndpoint(role: LlmRole, baseUrl: string, apiKey: string): Promise<void> {
    const url = `${baseUrl.replace(/\/$/, "")}/models`;
    this.logger.info("llm.probe_start", { role, url });
    try {
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        this.logger.warn("llm.probe_failed", {
          role,
          status: response.status,
          body: truncateForLog(text, 220),
        });
        return;
      }
      this.logger.info("llm.probe_ok", {
        role,
        body: truncateForLog(text, 220),
      });
    } catch (error) {
      this.logger.warn("llm.probe_error", {
        role,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
