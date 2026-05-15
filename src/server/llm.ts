import type { ChatConfig, EmbeddingsConfig } from "./types";
import { createConsoleLogger, type Logger, truncateForLog } from "./logger";

export interface LlmClient {
  chat(system: string, user: string): Promise<string>;
  streamChat(
    system: string,
    user: string,
    onChunk: (delta: string, accumulated: string) => void
  ): Promise<{ content: string; finishReason: string }>;
  embed(input: string[]): Promise<number[][]>;
  probeConnections(): Promise<void>;
}

export class OpenAICompatClient implements LlmClient {
  constructor(
    private readonly chatConfig: ChatConfig,
    private readonly embeddingsConfig: EmbeddingsConfig,
    private readonly logger: Logger = createConsoleLogger()
  ) {}

  async chat(system: string, user: string): Promise<string> {
    const startedAt = Date.now();
    const url = `${this.chatConfig.base_url.replace(/\/$/, "")}/chat/completions`;
    this.logger.info("llm.chat_request", {
      model: this.chatConfig.model,
      max_tokens: this.chatConfig.max_tokens,
      temperature: this.chatConfig.temperature,
      prompt_chars: system.length + user.length,
    });
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
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.logger.error("llm.chat_error", {
        model: this.chatConfig.model,
        status: response.status,
        body: truncateForLog(text, 300),
      });
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
    this.logger.info("llm.chat_response", {
      model: this.chatConfig.model,
      finish_reason: finishReason,
      duration_ms: durationMs,
      completion_chars: content?.length ?? 0,
      tokens: json.usage?.total_tokens ?? "?",
    });
    if (finishReason === "length") {
      this.logger.warn("llm.chat_truncated", {
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
    onChunk: (delta: string, accumulated: string) => void
  ): Promise<{ content: string; finishReason: string }> {
    const startedAt = Date.now();
    const url = `${this.chatConfig.base_url.replace(/\/$/, "")}/chat/completions`;
    this.logger.info("llm.stream_request", {
      model: this.chatConfig.model,
      max_tokens: this.chatConfig.max_tokens,
      temperature: this.chatConfig.temperature,
      prompt_chars: system.length + user.length,
    });
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
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      this.logger.error("llm.stream_error", {
        model: this.chatConfig.model,
        status: response.status,
        body: truncateForLog(text, 300),
      });
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
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{
              finish_reason?: string | null;
              delta?: { content?: string };
              message?: { content?: string };
            }>;
          };
          const choice = json.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta?.content ?? choice?.message?.content ?? "";
          if (!delta) continue;
          accumulated += delta;
          onChunk(delta, accumulated);
        } catch {
          // Ignore malformed chunks from local providers and continue.
        }
      }
    }

    const content = accumulated.trim();
    const durationMs = Date.now() - startedAt;
    this.logger.info("llm.stream_response", {
      model: this.chatConfig.model,
      finish_reason: finishReason,
      duration_ms: durationMs,
      completion_chars: content.length,
    });
    if (finishReason === "length") {
      this.logger.warn("llm.stream_truncated", {
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
    this.logger.info("llm.embed_request", {
      model: this.embeddingsConfig.model,
      inputs: input.length,
    });
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
      this.logger.error("llm.embed_error", {
        model: this.embeddingsConfig.model,
        status: response.status,
        body: truncateForLog(text, 300),
      });
      throw new Error(`embeddings failed: ${response.status} ${text.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    this.logger.info("llm.embed_response", {
      model: this.embeddingsConfig.model,
      vectors: json.data?.length ?? 0,
      duration_ms: Date.now() - startedAt,
    });
    return (json.data ?? []).map((item) => item.embedding ?? []);
  }

  async probeConnections(): Promise<void> {
    await this.probeEndpoint("chat", this.chatConfig.base_url, this.chatConfig.api_key);
    if (this.embeddingsConfig.enabled) {
      await this.probeEndpoint("embeddings", this.embeddingsConfig.base_url, this.embeddingsConfig.api_key);
    } else {
      this.logger.info("llm.embed_disabled");
    }
  }

  private async probeEndpoint(kind: string, baseUrl: string, apiKey: string): Promise<void> {
    const url = `${baseUrl.replace(/\/$/, "")}/models`;
    this.logger.info("llm.probe_start", { kind, url });
    try {
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        this.logger.warn("llm.probe_failed", {
          kind,
          status: response.status,
          body: truncateForLog(text, 220),
        });
        return;
      }
      this.logger.info("llm.probe_ok", {
        kind,
        body: truncateForLog(text, 220),
      });
    } catch (error) {
      this.logger.warn("llm.probe_error", {
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
