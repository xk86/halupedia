import { Agent } from "undici";
import type { ChatConfig, EmbeddingsConfig, LlmInvocationMetadata } from "./types";
import { createConsoleLogger, type Logger, truncateForLog } from "./logger";

// undici's fetch enforces its own headersTimeout/bodyTimeout (300s each by
// default). Those fire independently of our AbortSignal/idle timers, so a
// request that's merely queued behind other work on a busy host dies on undici's
// clock long before the timeout we configured — and reports as a transport
// "fetch failed" rather than a timeout. We own request lifetime explicitly
// (AbortSignal.timeout for non-stream, the idle-reset controller for stream), so
// disable undici's internal request timers and let our logic be the single
// source of truth. connectTimeout still guards a genuinely dead host.
const llmDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** fetch() pinned to {@link llmDispatcher}. The `dispatcher` option is a Node/
 *  undici extension absent from the lib's RequestInit type, so it's injected
 *  here behind a cast rather than at every call site. */
function llmFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, dispatcher: llmDispatcher } as RequestInit);
}

/**
 * A fair FIFO counting semaphore bounding how many requests we hand a single
 * host at once. Permits are acquired *before* fetch() so excess work waits in
 * our own in-memory queue — no open socket, no timeout clock running — instead
 * of stampeding the backend's queue, where it would burn its timeout budget
 * idling for a slot it can't see.
 */
class HostGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(readonly permits: number) {}

  async acquire(): Promise<() => void> {
    // When at capacity we park; the releasing call hands its permit straight to
    // us without ever lowering `active`, so there's no window for a fresh
    // acquire() to slip in and oversubscribe the host.
    if (this.active >= this.permits) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

// One gate per host, shared across roles — heavy/light/images/embeddings that
// target the same backend contend for the same memory and must be bounded
// together. The first config to register a host fixes its permit count (heavy
// chat is constructed first, so its cap wins for a shared host).
const hostGates = new Map<string, HostGate>();
function hostGateFor(baseUrl: string, permits: number): HostGate {
  const host = hostForBaseUrl(baseUrl);
  let gate = hostGates.get(host);
  if (!gate) {
    gate = new HostGate(Math.max(1, permits));
    hostGates.set(host, gate);
  }
  return gate;
}

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
  /** Internal trace hook: called with the model's reasoning/thinking text when
   *  the API returns it in a separate field (Ollama `reasoning_content`/
   *  `thinking`, OpenAI `reasoning`). Used by the pipeline tracer to surface
   *  chain-of-thought; never set by feature code. */
  onReasoning?: (reasoning: string) => void;
  /** Internal trace hook: called as reasoning/thinking text streams in, with the
   *  incremental delta and the full accumulated reasoning so far. Used to surface
   *  live chain-of-thought in the admin generation view; never set by feature code. */
  onReasoningDelta?: (delta: string, accumulated: string) => void;
}

/** Pull the separated reasoning/thinking text out of a chat message, across
 *  the field names different OpenAI-compatible backends use. */
function extractReasoning(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  const candidate =
    message.reasoning_content ?? message.reasoning ?? message.thinking;
  return typeof candidate === "string" ? candidate : "";
}

/** Unified LLM interface. Role (heavy/light) is the first argument to every
 *  generative call so callers never need to hold two separate client handles. */
export interface LlmRouter {
  chat(role: "heavy" | "light" | "images", system: string, user: string, options?: ChatOptions): Promise<string>;
  /** Resolved non-secret model metadata for trace/UI display. */
  metadataFor?(role: "heavy" | "light" | "images"): LlmInvocationMetadata;
  /** True when the model at the given role accepted a test vision payload at startup. */
  supportsVision(role: "heavy" | "light" | "images"): boolean;
  streamChat(
    role: "heavy" | "light",
    system: string,
    user: string,
    onChunk: (delta: string, accumulated: string) => void,
    options?: ChatOptions,
  ): Promise<{ content: string; finishReason: string; ttftMs?: number }>;
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

/**
 * Node's `fetch` collapses transport failures into a bare "fetch failed";
 * the real reason (ECONNRESET, socket hang up, ETIMEDOUT, DNS, TLS) lives in
 * `error.cause`. Unwrap it so logs and surfaced errors say what actually broke.
 */
function describeFetchError(err: unknown): { message: string; cause: string; code: string } {
  if (!(err instanceof Error)) return { message: String(err), cause: "", code: "" };
  // `cause` can nest (undici wraps the socket error). Walk to the innermost.
  let cause: unknown = (err as { cause?: unknown }).cause;
  let code = (err as { code?: string }).code ?? "";
  let causeMsg = "";
  let depth = 0;
  while (cause && depth < 5) {
    if (cause instanceof Error) {
      causeMsg = cause.message;
      code = (cause as { code?: string }).code ?? code;
      const next = (cause as { cause?: unknown }).cause;
      if (!next || next === cause) break;
      cause = next;
    } else {
      causeMsg = String(cause);
      break;
    }
    depth += 1;
  }
  return { message: err.message, cause: causeMsg, code };
}

/** One-line human summary of a fetch failure for error messages. */
function fetchErrorSummary(err: unknown): string {
  const { message, cause, code } = describeFetchError(err);
  return [code, cause || message].filter(Boolean).join(": ") || "unknown error";
}

// undici surfaces its own timeouts as a "fetch failed" TypeError whose real
// reason — code and message — lives on the nested cause, not on the top-level
// error. List the codes so we recognize a queue/transport timeout as a timeout
// even though our own AbortSignal never fired.
const UNDICI_TIMEOUT_CODES = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** True when an error is a timeout — our AbortSignal.timeout()/AbortController
 *  abort, or one of undici's internal request timeouts buried on the cause. */
function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (
    err.name === "TimeoutError" ||
    err.name === "AbortError" ||
    (err as { code?: string }).code === "ABORT_ERR"
  ) {
    return true;
  }
  // describeFetchError walks the cause chain undici nests the real reason under;
  // the top-level message is just "fetch failed" and never matches on its own.
  const { message, cause, code } = describeFetchError(err);
  return UNDICI_TIMEOUT_CODES.has(code) || /abort|timeout|timed out/i.test(`${message} ${cause}`);
}

// Emit an in-flight progress heartbeat at most this often while streaming, so a
// long generation shows it's alive (and how far along) instead of going dark.
const STREAM_HEARTBEAT_MS = 5_000;

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
  private readonly chatGate: HostGate;
  private readonly embedGate: HostGate;

  constructor(
    private readonly chatConfig: ChatConfig,
    private readonly embeddingsConfig: EmbeddingsConfig,
    private readonly logger: Logger,
    private readonly role: ChatLlmRole,
  ) {
    this.chatGate = hostGateFor(chatConfig.base_url, chatConfig.max_in_flight);
    this.embedGate = hostGateFor(embeddingsConfig.base_url, embeddingsConfig.max_in_flight);
  }

  async chat(system: string, user: string, options: ChatOptions = {}): Promise<string> {
    const startedAt = Date.now();
    const url = `${this.chatConfig.base_url.replace(/\/$/, "")}/chat/completions`;
    this.logger.info("llm.chat_request", chatRequestFields(this.role, this.chatConfig, system.length + user.length, options));
    const timeoutMs = this.chatConfig.request_timeout_ms ?? 180_000;
    // Wait for a host slot before starting the request clock — queue time must
    // not count against the timeout.
    const release = await this.chatGate.acquire();
    try {
    let response: Response;
    try {
      response = await llmFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.chatConfig.api_key}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
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
    } catch (err) {
      const timedOut = isTimeoutError(err);
      const detail = describeFetchError(err);
      this.logger.error("llm.chat_request_failed", {
        role: this.role,
        model: this.chatConfig.model,
        url,
        duration_ms: Date.now() - startedAt,
        timed_out: timedOut,
        timeout_ms: timeoutMs,
        error: detail.message,
        cause: detail.cause,
        code: detail.code,
      });
      const reason = timedOut ? `timed out after ${timeoutMs}ms` : fetchErrorSummary(err);
      throw new Error(`chat request to ${this.chatConfig.model} failed: ${reason}`, { cause: err });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.logger.error("llm.chat_error", llmErrorFields(this.role, this.chatConfig.model, response.status, text));
      throw new Error(`chat completion failed: ${response.status} ${text.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      id?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      choices?: Array<{ finish_reason?: string | null; message?: Record<string, unknown> }>;
    };
    const content = (json.choices?.[0]?.message?.content as string | undefined)?.trim();
    const reasoning = extractReasoning(json.choices?.[0]?.message);
    if (reasoning) options.onReasoning?.(reasoning);
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
    } finally {
      release();
    }
  }

  async streamChat(
    system: string,
    user: string,
    onChunk: (delta: string, accumulated: string) => void,
    options: ChatOptions = {},
  ): Promise<{ content: string; finishReason: string; ttftMs?: number }> {
    const startedAt = Date.now();
    const url = `${this.chatConfig.base_url.replace(/\/$/, "")}/chat/completions`;
    this.logger.info("llm.stream_request", chatRequestFields(this.role, this.chatConfig, system.length + user.length, options));
    // Idle-based abort: fires when no token has arrived for request_timeout_ms,
    // covering both a hung connection (no headers) and a mid-stream stall. The
    // timer is reset on every chunk so a healthy long generation is never cut.
    const idleMs = this.chatConfig.request_timeout_ms ?? 180_000;
    const idleController = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => idleController.abort(new Error(`idle timeout: no tokens for ${idleMs}ms`)),
        idleMs,
      );
      idleTimer.unref?.();
    };
    const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); };
    // Wait for a host slot before arming the idle clock or opening a socket —
    // queue time must not register as an idle stall.
    const release = await this.chatGate.acquire();
    armIdle();
    try {
    let response: Response;
    try {
      response = await llmFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.chatConfig.api_key}`,
        },
        signal: idleController.signal,
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
    } catch (err) {
      clearIdle();
      const timedOut = isTimeoutError(err) || idleController.signal.aborted;
      const detail = describeFetchError(err);
      this.logger.error("llm.stream_request_failed", {
        role: this.role,
        model: this.chatConfig.model,
        url,
        duration_ms: Date.now() - startedAt,
        timed_out: timedOut,
        timeout_ms: idleMs,
        error: detail.message,
        cause: detail.cause,
        code: detail.code,
      });
      const reason = timedOut ? `timed out after ${idleMs}ms with no response` : fetchErrorSummary(err);
      throw new Error(`chat stream request to ${this.chatConfig.model} failed: ${reason}`, { cause: err });
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      this.logger.error("llm.stream_error", llmErrorFields(this.role, this.chatConfig.model, response.status, text));
      throw new Error(`chat stream failed: ${response.status} ${text.slice(0, 300)}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";
    let reasoning = "";
    let finishReason = "unknown";
    let chunkCount = 0;
    let firstTokenMs = 0;
    let lastChunkAt = Date.now();
    let lastHeartbeatAt = Date.now();
    const markFirstToken = () => {
      if (firstTokenMs !== 0) return;
      firstTokenMs = Date.now() - startedAt;
      this.logger.info("llm.stream_first_token", {
        role: this.role,
        model: this.chatConfig.model,
        ttft_ms: firstTokenMs,
      });
    };
    const reader = response.body.getReader();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // Progress arrived — reset the idle deadline.
        armIdle();
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
                  delta?: Record<string, unknown>;
                  message?: Record<string, unknown>;
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
          // Reasoning/thinking arrives as its own delta field on thinking models.
          const reasoningDelta =
            extractReasoning(choice?.delta) || extractReasoning(choice?.message);
          if (reasoningDelta) {
            reasoning += reasoningDelta;
            // Chain-of-thought counts toward time-to-first-token: on thinking
            // models the model is "producing" from the first reasoning token,
            // long before the first content token. TTFT measured at first
            // content would otherwise report the whole reasoning phase as latency.
            markFirstToken();
            options.onReasoningDelta?.(reasoningDelta, reasoning);
          }
          const delta =
            ((choice?.delta?.content ?? choice?.message?.content) as string | undefined) ?? "";
          if (!delta) continue;
          chunkCount += 1;
          const now = Date.now();
          lastChunkAt = now;
          markFirstToken();
          accumulated += delta;
          // Periodic in-flight heartbeat so a long/streaming run is visibly
          // alive and we can see how far it got if it later dies.
          if (now - lastHeartbeatAt >= STREAM_HEARTBEAT_MS) {
            lastHeartbeatAt = now;
            this.logger.info("llm.stream_progress", {
              role: this.role,
              model: this.chatConfig.model,
              elapsed_ms: now - startedAt,
              chunks: chunkCount,
              content_chars: accumulated.length,
              reasoning_chars: reasoning.length,
            });
          }
          onChunk(delta, accumulated);
        }
      }
    } catch (err) {
      const detail = describeFetchError(err);
      const now = Date.now();
      const idleTimedOut = idleController.signal.aborted || isTimeoutError(err);
      this.logger.error("llm.stream_interrupted", {
        role: this.role,
        model: this.chatConfig.model,
        elapsed_ms: now - startedAt,
        since_last_chunk_ms: now - lastChunkAt,
        idle_timeout: idleTimedOut,
        timeout_ms: idleMs,
        chunks: chunkCount,
        content_chars: accumulated.length,
        reasoning_chars: reasoning.length,
        error: detail.message,
        cause: detail.cause,
        code: detail.code,
        preview: truncateForLog(accumulated.slice(-240), 240),
      });
      // Surface what we got before the stream died — the trace/admin pane uses
      // these to show the partial output of an interrupted generation.
      const why = idleTimedOut ? `idle timeout after ${idleMs}ms` : fetchErrorSummary(err);
      const wrapped = new Error(
        `chat stream from ${this.chatConfig.model} interrupted after ${chunkCount} chunks / ${accumulated.length} chars: ${why}`,
        { cause: err },
      );
      (wrapped as { partialContent?: string }).partialContent = accumulated;
      (wrapped as { partialReasoning?: string }).partialReasoning = reasoning;
      throw wrapped;
    } finally {
      clearIdle();
    }

    const content = accumulated.trim();
    if (reasoning.trim()) options.onReasoning?.(reasoning.trim());
    const durationMs = Date.now() - startedAt;
    this.logger.info("llm.stream_response", {
      ...chatResultFields(this.role, this.chatConfig, {
        finishReason,
        durationMs,
        completionChars: content.length,
      }),
      ttft_ms: firstTokenMs,
      chunks: chunkCount,
      reasoning_chars: reasoning.length,
    });
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
    return { content, finishReason, ttftMs: firstTokenMs || undefined };
    } finally {
      release();
    }
  }

  async embed(input: string[]): Promise<number[][]> {
    if (!this.embeddingsConfig.enabled || input.length === 0) {
      return [];
    }

    const startedAt = Date.now();
    const url = `${this.embeddingsConfig.base_url.replace(/\/$/, "")}/embeddings`;
    const timeoutMs = this.embeddingsConfig.request_timeout_ms ?? 60_000;
    this.logger.info("llm.embed_request", embedRequestFields(this.embeddingsConfig, input.length));
    const release = await this.embedGate.acquire();
    try {
    let response: Response;
    try {
      response = await llmFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.embeddingsConfig.api_key}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: this.embeddingsConfig.model,
          input,
        }),
      });
    } catch (err) {
      const timedOut = isTimeoutError(err);
      const detail = describeFetchError(err);
      this.logger.error("llm.embed_request_failed", {
        role: "embeddings",
        model: this.embeddingsConfig.model,
        url,
        duration_ms: Date.now() - startedAt,
        timed_out: timedOut,
        timeout_ms: timeoutMs,
        error: detail.message,
        cause: detail.cause,
        code: detail.code,
      });
      const reason = timedOut ? `timed out after ${timeoutMs}ms` : fetchErrorSummary(err);
      throw new Error(`embeddings request to ${this.embeddingsConfig.model} failed: ${reason}`, { cause: err });
    }

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
    } finally {
      release();
    }
  }

  async probeEndpoint(role: LlmRole, baseUrl: string, apiKey: string): Promise<void> {
    const url = `${baseUrl.replace(/\/$/, "")}/models`;
    this.logger.info("llm.probe_start", { role, url });
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        this.logger.warn("llm.probe_failed", { role, status: response.status, body: truncateForLog(text, 220) });
        return;
      }
      this.logger.info("llm.probe_ok", { role, body: truncateForLog(text, 220) });
    } catch (error) {
      const detail = describeFetchError(error);
      this.logger.warn("llm.probe_error", {
        role,
        timed_out: isTimeoutError(error),
        timeout_ms: 10_000,
        error: detail.message,
        cause: detail.cause,
        code: detail.code,
      });
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

function hostForBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
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

  metadataFor(role: "heavy" | "light" | "images"): LlmInvocationMetadata {
    const config =
      role === "heavy"
        ? this.heavyChatConfig
        : role === "images" && this.imagesChatConfig
          ? this.imagesChatConfig
          : this.lightChatConfig;
    const resolvedRole =
      role === "images" && !this.imagesChatConfig ? "light" : role;
    const configKey =
      role === "heavy"
        ? "llm.chat"
        : role === "images" && this.imagesChatConfig
          ? "llm.images"
          : "llm.light";
    return {
      requestedRole: role,
      resolvedRole,
      configKey,
      model: config.model,
      baseUrl: config.base_url,
      host: hostForBaseUrl(config.base_url),
      temperature: config.temperature,
      maxTokens: config.max_tokens,
    };
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
  ): Promise<{ content: string; finishReason: string; ttftMs?: number }> {
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
