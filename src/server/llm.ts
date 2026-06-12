import type { ChatConfig, EmbeddingsConfig } from "./types";
import { createConsoleLogger, type Logger, truncateForLog } from "./logger";

export type LlmRole = "heavy" | "light" | "images" | "embeddings";
type ChatLlmRole = Exclude<LlmRole, "embeddings">;

export interface ChatImageAttachment {
  mime: string;
  b64: string;
}

export interface ChatOptions {
  thinking?: boolean;
  /** Request JSON-mode output — passes `format:"json"` to the API so the
   *  model is constrained to emit valid JSON. Use for structured-output prompts. */
  jsonMode?: boolean;
  /** Attach images to the user turn (multimodal). OpenAI-compatible format. */
  images?: ChatImageAttachment[];
}

/** Unified LLM interface. Role (heavy/light) is the first argument to every
 *  generative call so callers never need to hold two separate client handles. */
export interface LlmRouter {
  chat(role: "heavy" | "light" | "images", system: string, user: string, options?: ChatOptions): Promise<string>;
  /** True when the model at the given role accepted a test vision payload at startup. */
  supportsVision(role: "heavy" | "light" | "images"): boolean;
  streamChat(
    role: "heavy" | "light",
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

/** Per-role chat/stream client. Internal to this module (exported as a type
 *  only, for signatures like comments.ts). */
export type { OpenAICompatClient };
class OpenAICompatClient {
  constructor(
    private readonly chatConfig: ChatConfig,
    private readonly embeddingsConfig: EmbeddingsConfig,
    private readonly logger: Logger,
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
        ...(options.jsonMode ? {
          format: "json",
          response_format: { type: "json_object" },
        } : {}),
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: options.images?.length
              ? [
                  { type: "text", text: user },
                  ...options.images.map((img) => ({
                    type: "image_url",
                    image_url: { url: `data:${img.mime};base64,${img.b64}` },
                  })),
                ]
              : user,
          },
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
      choices?: Array<{ finish_reason?: string | null; message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content?.trim();
    const finishReason = json.choices?.[0]?.finish_reason ?? "unknown";
    const durationMs = Date.now() - startedAt;
    const totalTokens = json.usage?.total_tokens;
    this.logger.info("llm.chat_response", chatResultFields(this.role, this.chatConfig, {
      finishReason,
      durationMs,
      completionChars: content?.length ?? 0,
      tokens: totalTokens ?? "?",
    }));
    if (finishReason === "length" || finishReason === "unknown" || totalTokens === undefined || /\[[^\]]*\]\($/.test(content ?? "")) {
      this.logger.warn("llm.chat_suspicious_response", {
        role: this.role,
        model: this.chatConfig.model,
        finish_reason: finishReason,
        prompt_tokens: json.usage?.prompt_tokens ?? "?",
        completion_tokens: json.usage?.completion_tokens ?? "?",
        total_tokens: totalTokens ?? "?",
        choices: json.choices?.length ?? 0,
        content_suffix: truncateForLog((content ?? "").slice(-240), 240),
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
        ...(options.jsonMode ? {
          format: "json",
          response_format: { type: "json_object" },
        } : {}),
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

  async probeEndpoint(role: LlmRole, baseUrl: string, apiKey: string): Promise<void> {
    const url = `${baseUrl.replace(/\/$/, "")}/models`;
    this.logger.info("llm.probe_start", { role, url });
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        this.logger.warn("llm.probe_failed", { role, status: response.status, body: truncateForLog(text, 220) });
        return;
      }
      this.logger.info("llm.probe_ok", { role, body: truncateForLog(text, 220) });
    } catch (error) {
      this.logger.warn("llm.probe_error", { role, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * Check whether a model supports vision by querying the provider's capabilities
 * endpoint. Works natively with Ollama via POST /api/show; degrades to false
 * for providers that don't expose this endpoint.
 */
async function probeVisionSupport(
  baseUrl: string,
  apiKey: string,
  model: string,
  logger: Logger,
): Promise<boolean> {
  // Derive the Ollama-native base URL by stripping the /v1 suffix.
  const ollamaBase = baseUrl.replace(/\/v1\/?$/, "");
  try {
    const response = await fetch(`${ollamaBase}/api/show`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const json = await response.json() as Record<string, unknown>;
    // Ollama ≥0.5: top-level capabilities array is the authoritative signal.
    const capabilities = json.capabilities as string[] | undefined;
    if (Array.isArray(capabilities) && capabilities.includes("vision")) return true;
    // Older Ollama: model_info has clip.* keys for vision models.
    const modelInfo = json.model_info as Record<string, unknown> | undefined;
    if (modelInfo && typeof modelInfo === "object") {
      for (const key of Object.keys(modelInfo)) {
        if (key.startsWith("clip.")) return true;
      }
    }
    // Even older: details.families contains "clip" or "mllama".
    const details = json.details as Record<string, unknown> | undefined;
    const families = (details?.families ?? json.families) as string[] | undefined;
    if (Array.isArray(families) && families.some((f) => f === "clip" || f === "mllama")) return true;
    return false;
  } catch {
    logger.info("llm.vision_probe_skipped", { model, reason: "provider endpoint unavailable" });
    return false;
  }
}

/** Production LlmRouter that holds separate heavy, light, and optional images chat clients. */
export class OpenAICompatRouter implements LlmRouter {
  private readonly heavy: OpenAICompatClient;
  private readonly light: OpenAICompatClient;
  private readonly images: OpenAICompatClient | null;
  private readonly visionSupport = new Map<"heavy" | "light" | "images", boolean>();

  constructor(
    private readonly heavyChatConfig: ChatConfig,
    private readonly lightChatConfig: ChatConfig,
    private readonly embeddingsConfig: EmbeddingsConfig,
    private readonly logger: Logger = createConsoleLogger(),
    private readonly imagesChatConfig?: ChatConfig,
  ) {
    this.heavy = new OpenAICompatClient(heavyChatConfig, embeddingsConfig, logger, "heavy");
    this.light = new OpenAICompatClient(lightChatConfig, embeddingsConfig, logger, "light");
    this.images = imagesChatConfig
      ? new OpenAICompatClient(imagesChatConfig, embeddingsConfig, logger, "images")
      : null;
  }

  private client(role: "heavy" | "light" | "images"): OpenAICompatClient {
    if (role === "images") return this.images ?? this.light;
    return role === "light" ? this.light : this.heavy;
  }

  supportsVision(role: "heavy" | "light" | "images"): boolean {
    return this.visionSupport.get(role) ?? false;
  }

  chat(role: "heavy" | "light" | "images", system: string, user: string, options?: ChatOptions): Promise<string> {
    return this.client(role).chat(system, user, options);
  }

  streamChat(
    role: "heavy" | "light",
    system: string,
    user: string,
    onChunk: (delta: string, accumulated: string) => void,
    options?: ChatOptions,
  ): Promise<{ content: string; finishReason: string }> {
    return this.client(role).streamChat(system, user, onChunk, options);
  }

  embed(input: string[]): Promise<number[][]> {
    return this.heavy.embed(input);
  }

  async probeConnections(): Promise<void> {
    await this.heavy.probeEndpoint("heavy", this.heavyChatConfig.base_url, this.heavyChatConfig.api_key);
    await this.light.probeEndpoint("light", this.lightChatConfig.base_url, this.lightChatConfig.api_key);
    if (this.imagesChatConfig) {
      await this.images!.probeEndpoint("images", this.imagesChatConfig.base_url, this.imagesChatConfig.api_key);
    }
    if (this.embeddingsConfig.enabled) {
      await this.heavy.probeEndpoint("embeddings", this.embeddingsConfig.base_url, this.embeddingsConfig.api_key);
    } else {
      this.logger.info("llm.embed_disabled", { role: "embeddings" });
    }
    // Probe vision support via provider capabilities. We try the Ollama-native
    // POST /api/show endpoint (derived by stripping /v1 from the base URL).
    // If the provider is not Ollama or the endpoint is unreachable, we fall back
    // to false rather than making a real chat call.
    for (const role of ["light", "heavy"] as const) {
      const cfg = role === "light" ? this.lightChatConfig : this.heavyChatConfig;
      const hasVision = await probeVisionSupport(cfg.base_url, cfg.api_key, cfg.model, this.logger);
      this.visionSupport.set(role, hasVision);
      this.logger.info("llm.vision_capability", { role, model: cfg.model, vision: hasVision });
    }
    if (this.imagesChatConfig) {
      const hasVision = await probeVisionSupport(
        this.imagesChatConfig.base_url,
        this.imagesChatConfig.api_key,
        this.imagesChatConfig.model,
        this.logger,
      );
      this.visionSupport.set("images", hasVision);
      this.logger.info("llm.vision_capability", { role: "images", model: this.imagesChatConfig.model, vision: hasVision });
      if (!hasVision) {
        this.logger.warn("llm.images_no_vision", {
          model: this.imagesChatConfig.model,
          message: "configured [llm.images] model does not support vision — image descriptions will be text-only",
        });
      }
    } else {
      this.logger.warn("llm.images_no_vision", {
        message: "no [llm.images] model configured — image descriptions will be text-only; add [llm.images] in config/llm.toml",
      });
    }
  }
}
