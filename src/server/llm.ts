import { Agent } from "undici";
import type { ChatConfig, EmbeddingsConfig, HostConfig, LlmConfig, LlmInvocationMetadata } from "./types";
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

// How long to skip a host after it fails a request, so a flapping backend isn't
// handed fresh work ahead of healthy hosts. Tunable.
const HOST_COOLDOWN_MS = 15_000;
// Max distinct hosts a single request will try before giving up.
const HOST_RETRY_CAP = 4;

/** Resolved connection for the host a single request was routed to. */
export interface HostEndpoint {
  hostId: string;
  baseUrl: string;
  apiKey: string;
}

interface HostState {
  id: string;
  baseUrl: string;
  apiKey: string;
  permits: number;
  active: number;
  pref: number;
  blacklist: Set<string>;
  /** Probed model ids, or null when the probe failed/was unsupported — in which
   *  case the host is assumed able to serve any non-blacklisted model rather than
   *  being excluded outright. */
  models: Set<string> | null;
  cooldownUntil: number;
}

interface Waiter {
  candidates: string[];
  tried: Set<string>;
  resolve: (slot: { hostId: string; release: () => void }) => void;
}

/** Thrown when no configured host can serve a role's model. */
export class NoEligibleHostError extends Error {}

/** Drop Ollama's implicit `:latest` tag so "gemma4" and "gemma4:latest" compare equal. */
function normalizeModelId(model: string): string {
  return model.endsWith(":latest") ? model.slice(0, -":latest".length) : model;
}

/**
 * Routes each request to a host. A request prefers its role's configured hosts,
 * then spills onto any other host whose probed model set includes the model
 * (ordered by host `pref`) when the preferred ones are saturated, cooling down,
 * or lack the model. Each host's queue is unbounded — callers wait indefinitely
 * for a slot rather than being dropped — and a host that fails a dispatch is put
 * on a short cooldown so the request re-queues onto the next eligible host.
 *
 * Permits are acquired *before* fetch() (i.e. before any timeout clock arms), so
 * queue time never counts against a request's timeout budget.
 */
export class HostScheduler {
  private readonly hosts = new Map<string, HostState>();
  private readonly waiters: Waiter[] = [];

  constructor(private readonly logger: Logger) {}

  /** (Re)apply host connection + queue-depth config, preserving in-flight counts
   *  and probed capabilities across reloads so the UI can retune live. */
  configure(hostConfigs: HostConfig[]): void {
    const seen = new Set<string>();
    for (const cfg of hostConfigs) {
      seen.add(cfg.id);
      const existing = this.hosts.get(cfg.id);
      if (existing) {
        existing.baseUrl = cfg.base_url;
        existing.apiKey = cfg.api_key;
        existing.pref = cfg.pref;
        existing.blacklist = new Set(cfg.blacklist);
        existing.permits = Math.max(1, cfg.max_in_flight);
      } else {
        this.hosts.set(cfg.id, {
          id: cfg.id,
          baseUrl: cfg.base_url,
          apiKey: cfg.api_key,
          permits: Math.max(1, cfg.max_in_flight),
          active: 0,
          pref: cfg.pref,
          blacklist: new Set(cfg.blacklist),
          models: null,
          cooldownUntil: 0,
        });
      }
    }
    for (const id of [...this.hosts.keys()]) {
      if (!seen.has(id)) this.hosts.delete(id);
    }
    this.pump(); // a permit increase may admit parked waiters
  }

  setCapabilities(hostId: string, models: Set<string> | null): void {
    const state = this.hosts.get(hostId);
    if (state) state.models = models;
  }

  endpoints(): HostEndpoint[] {
    return [...this.hosts.values()].map((s) => ({ hostId: s.id, baseUrl: s.baseUrl, apiKey: s.apiKey }));
  }

  snapshot(): Array<{
    id: string;
    baseUrl: string;
    permits: number;
    active: number;
    pref: number;
    blacklist: string[];
    models: string[] | null;
    online: boolean;
  }> {
    return [...this.hosts.values()].map((s) => ({
      id: s.id,
      baseUrl: s.baseUrl,
      permits: s.permits,
      active: s.active,
      pref: s.pref,
      blacklist: [...s.blacklist],
      models: s.models ? [...s.models] : null,
      online: s.models !== null,
    }));
  }

  private usable(state: HostState, model: string): boolean {
    if (state.blacklist.has(model)) return false;
    if (state.models === null) return true; // unprobed — assume capable
    if (state.models.has(model)) return true;
    // Tolerate Ollama's implicit `:latest` tag: config "gemma4" matches a probed
    // "gemma4:latest" and vice versa.
    const nm = normalizeModelId(model);
    for (const probed of state.models) {
      if (normalizeModelId(probed) === nm) return true;
    }
    return false;
  }

  /** Ordered candidate host ids: role-preferred (in listed order) first, then any
   *  other eligible host by ascending pref. */
  candidates(preferredHosts: string[], model: string): string[] {
    const eligible = (id: string) => {
      const s = this.hosts.get(id);
      return !!s && this.usable(s, model);
    };
    const preferred = preferredHosts.filter((id, i) => eligible(id) && preferredHosts.indexOf(id) === i);
    const rest = [...this.hosts.keys()]
      .filter((id) => !preferred.includes(id) && eligible(id))
      .sort((a, b) => this.hosts.get(a)!.pref - this.hosts.get(b)!.pref || a.localeCompare(b));
    return [...preferred, ...rest];
  }

  async dispatch<T>(
    roleLabel: string,
    preferredHosts: string[],
    model: string,
    exec: (endpoint: HostEndpoint) => Promise<T>,
  ): Promise<T> {
    const candidates = this.candidates(preferredHosts, model);
    if (candidates.length === 0) {
      throw new NoEligibleHostError(`no configured host can serve model "${model}" for role ${roleLabel}`);
    }
    const tried = new Set<string>();
    let lastErr: unknown;
    const cap = Math.min(candidates.length, HOST_RETRY_CAP);
    for (let attempt = 0; attempt < cap; attempt++) {
      const slot = await this.acquireAny(candidates, tried);
      const state = this.hosts.get(slot.hostId)!;
      try {
        const result = await exec({ hostId: state.id, baseUrl: state.baseUrl, apiKey: state.apiKey });
        slot.release();
        return result;
      } catch (err) {
        slot.release();
        tried.add(slot.hostId);
        state.cooldownUntil = Date.now() + HOST_COOLDOWN_MS;
        setTimeout(() => this.pump(), HOST_COOLDOWN_MS).unref?.();
        this.pump();
        lastErr = err;
        const remaining = candidates.filter((c) => !tried.has(c));
        // Mid-stream failures set `noFailover` — restarting would replay a
        // partial generation, so we surface them instead of retrying elsewhere.
        const noFailover = (err as { noFailover?: boolean }).noFailover === true;
        if (remaining.length === 0 || noFailover) break;
        this.logger.warn("llm.host_failover", {
          role: roleLabel,
          model,
          failed_host: slot.hostId,
          remaining: remaining.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    throw lastErr ?? new Error(`all hosts failed for role ${roleLabel}`);
  }

  private tryAcquire(candidates: string[], tried: Set<string>): { hostId: string; release: () => void } | null {
    const now = Date.now();
    for (const id of candidates) {
      if (tried.has(id)) continue;
      const s = this.hosts.get(id);
      if (!s || s.cooldownUntil > now) continue;
      if (s.active < s.permits) {
        s.active += 1;
        return { hostId: id, release: this.makeRelease(s) };
      }
    }
    return null;
  }

  private makeRelease(state: HostState): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.active -= 1;
      this.pump();
    };
  }

  private acquireAny(candidates: string[], tried: Set<string>): Promise<{ hostId: string; release: () => void }> {
    const immediate = this.tryAcquire(candidates, tried);
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      this.waiters.push({ candidates, tried, resolve });
    });
  }

  /** Admit parked waiters (oldest first) onto any candidate that now has a free
   *  slot. Called on every release, permit increase, and cooldown expiry. */
  private pump(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const w = this.waiters[i];
      const got = this.tryAcquire(w.candidates, w.tried);
      if (got) {
        this.waiters.splice(i, 1);
        w.resolve(got);
      } else {
        i += 1;
      }
    }
  }
}

/** Fetch the model ids a host serves (OpenAI-compatible `GET /models`). Returns
 *  null when the host is unreachable or the endpoint is unsupported, so callers
 *  can treat capabilities as "unknown" rather than "none". */
export async function fetchHostModels(
  baseUrl: string,
  apiKey: string,
  logger?: Logger,
): Promise<string[] | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  try {
    const response = await llmFetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger?.warn("llm.models_probe_failed", { url, status: response.status });
      return null;
    }
    const json = (await response.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  } catch (error) {
    const detail = describeFetchError(error);
    logger?.warn("llm.models_probe_error", { url, error: detail.message, cause: detail.cause, code: detail.code });
    return null;
  }
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

/** Ollama's native chat endpoint, derived by stripping the OpenAI `/v1` suffix
 *  from the configured base URL. We route chat here (rather than
 *  `/v1/chat/completions`) so sampler params under `options` — top_k, min_p —
 *  are honored, not just the OpenAI-mapped subset. */
function ollamaChatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "")}/api/chat`;
}

/** Native /api/chat messages. Images attach as base64 strings on the user turn
 *  (Ollama's shape), not OpenAI `image_url` content blocks. */
function nativeMessages(system: string, user: string, images?: ChatImageAttachment[]) {
  const userMsg: { role: "user"; content: string; images?: string[] } = { role: "user", content: user };
  if (images?.length) userMsg.images = images.map((img) => img.b64);
  return [{ role: "system" as const, content: system }, userMsg];
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
// Executes chat/stream/embed against whatever host the scheduler picks for the
// role. Holds role params (model, temperature, timeouts); the endpoint
// (base_url, api_key) is supplied per call.
class OpenAICompatClient {
  constructor(
    private readonly chatConfig: ChatConfig,
    private readonly embeddingsConfig: EmbeddingsConfig,
    private readonly logger: Logger,
    private readonly role: ChatLlmRole,
  ) {}

  /** Native /api/chat `options`: generation params. Sampler params are included
   *  only when configured, so an unset value leaves the backend default alone. */
  private nativeOptions(): Record<string, number> {
    const c = this.chatConfig;
    return {
      temperature: c.temperature,
      num_predict: c.max_tokens,
      ...(c.top_k !== undefined ? { top_k: c.top_k } : {}),
      ...(c.top_p !== undefined ? { top_p: c.top_p } : {}),
      ...(c.min_p !== undefined ? { min_p: c.min_p } : {}),
    };
  }

  async chat(endpoint: HostEndpoint, system: string, user: string, options: ChatOptions = {}): Promise<string> {
    const startedAt = Date.now();
    const url = ollamaChatUrl(endpoint.baseUrl);
    this.logger.info("llm.chat_request", { ...chatRequestFields(this.role, this.chatConfig, system.length + user.length, options), host: endpoint.hostId });
    const timeoutMs = this.chatConfig.request_timeout_ms ?? 180_000;
    let response: Response;
    try {
      response = await llmFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${endpoint.apiKey}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: this.chatConfig.model,
          messages: nativeMessages(system, user, options.images),
          stream: false,
          think: options.thinking ?? false,
          ...(options.jsonMode ? { format: "json" } : {}),
          options: this.nativeOptions(),
        }),
      });
    } catch (err) {
      const timedOut = isTimeoutError(err);
      const detail = describeFetchError(err);
      this.logger.error("llm.chat_request_failed", {
        role: this.role,
        host: endpoint.hostId,
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

    // Parse tolerantly: native /api/chat (`message`, `done_reason`, eval counts)
    // or an OpenAI-shaped response (`choices[0].message`, `usage`).
    const json = (await response.json()) as {
      message?: Record<string, unknown>;
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      choices?: Array<{ finish_reason?: string | null; message?: Record<string, unknown> }>;
    };
    const message = json.message ?? json.choices?.[0]?.message;
    const content = (message?.content as string | undefined)?.trim();
    const reasoning = extractReasoning(message);
    if (reasoning) options.onReasoning?.(reasoning);
    const finishReason = json.done_reason ?? json.choices?.[0]?.finish_reason ?? "unknown";
    const durationMs = Date.now() - startedAt;
    const totalTokens =
      json.usage?.total_tokens ??
      (json.eval_count !== undefined ? (json.prompt_eval_count ?? 0) + json.eval_count : undefined);
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
        prompt_tokens: json.usage?.prompt_tokens ?? json.prompt_eval_count ?? "?",
        completion_tokens: json.usage?.completion_tokens ?? json.eval_count ?? "?",
        total_tokens: totalTokens ?? "?",
        choices: json.choices?.length ?? (json.message ? 1 : 0),
        content_suffix: truncateForLog((content ?? "").slice(-240), 240),
      });
    }
    if (!content) {
      throw new Error("chat completion returned empty content");
    }
    return content;
  }

  async streamChat(
    endpoint: HostEndpoint,
    system: string,
    user: string,
    onChunk: (delta: string, accumulated: string) => void,
    options: ChatOptions = {},
  ): Promise<{ content: string; finishReason: string; ttftMs?: number }> {
    const startedAt = Date.now();
    const url = ollamaChatUrl(endpoint.baseUrl);
    this.logger.info("llm.stream_request", { ...chatRequestFields(this.role, this.chatConfig, system.length + user.length, options), host: endpoint.hostId });
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
    armIdle();
    let response: Response;
    try {
      response = await llmFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${endpoint.apiKey}`,
        },
        signal: idleController.signal,
        body: JSON.stringify({
          model: this.chatConfig.model,
          messages: nativeMessages(system, user, options.images),
          stream: true,
          think: options.thinking ?? false,
          ...(options.jsonMode ? { format: "json" } : {}),
          options: this.nativeOptions(),
        }),
      });
    } catch (err) {
      clearIdle();
      const timedOut = isTimeoutError(err) || idleController.signal.aborted;
      const detail = describeFetchError(err);
      this.logger.error("llm.stream_request_failed", {
        role: this.role,
        host: endpoint.hostId,
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
          if (!line) continue;
          // Tolerate both native /api/chat NDJSON (one JSON object per line) and
          // OpenAI SSE (`data: {…}` / `data: [DONE]`).
          let payload = line;
          if (line.startsWith("data:")) {
            payload = line.slice(5).trim();
            if (payload === "[DONE]") {
              newlineIndex = -1;
              break;
            }
          }
          let json:
            | {
                done?: boolean;
                done_reason?: string;
                message?: Record<string, unknown>;
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
          // Native carries the chunk under `message`; OpenAI under `delta`.
          const chunkMsg = json?.message ?? choice?.delta ?? choice?.message;
          if (json?.done && json.done_reason) finishReason = json.done_reason;
          else if (choice?.finish_reason) finishReason = choice.finish_reason;
          // Reasoning/thinking arrives as its own field on thinking models.
          const reasoningDelta = extractReasoning(chunkMsg);
          if (reasoningDelta) {
            reasoning += reasoningDelta;
            // Chain-of-thought counts toward time-to-first-token: on thinking
            // models the model is "producing" from the first reasoning token,
            // long before the first content token. TTFT measured at first
            // content would otherwise report the whole reasoning phase as latency.
            markFirstToken();
            options.onReasoningDelta?.(reasoningDelta, reasoning);
          }
          const delta = (chunkMsg?.content as string | undefined) ?? "";
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
        host: endpoint.hostId,
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
      // Once the model has begun producing (any content or reasoning token), a
      // retry on another host would replay a partial generation — so don't fail
      // over. A failure before first token is safe to re-queue elsewhere.
      (wrapped as { noFailover?: boolean }).noFailover = firstTokenMs !== 0;
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
  }

  async embed(endpoint: HostEndpoint, input: string[]): Promise<number[][]> {
    if (!this.embeddingsConfig.enabled || input.length === 0) {
      return [];
    }

    const startedAt = Date.now();
    const url = `${endpoint.baseUrl.replace(/\/$/, "")}/embeddings`;
    const timeoutMs = this.embeddingsConfig.request_timeout_ms ?? 60_000;
    this.logger.info("llm.embed_request", { ...embedRequestFields(this.embeddingsConfig, input.length), host: endpoint.hostId });
    let response: Response;
    try {
      response = await llmFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${endpoint.apiKey}`,
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
        host: endpoint.hostId,
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

/** Production LlmRouter. Holds per-role executors and a {@link HostScheduler}
 *  that routes each call to a host by preference + probed capability. */
export class OpenAICompatRouter implements LlmRouter {
  private readonly scheduler: HostScheduler;
  private readonly heavy: OpenAICompatClient;
  private readonly light: OpenAICompatClient;
  private readonly images: OpenAICompatClient | null;
  private readonly visionSupport = new Map<"heavy" | "light" | "images", boolean>();

  constructor(
    private readonly llm: LlmConfig,
    private readonly logger: Logger = createConsoleLogger(),
  ) {
    this.scheduler = new HostScheduler(logger);
    this.scheduler.configure(Object.values(llm.hosts));
    this.heavy = new OpenAICompatClient(llm.chat, llm.embeddings, logger, "heavy");
    this.light = new OpenAICompatClient(llm.light, llm.embeddings, logger, "light");
    this.images = llm.images
      ? new OpenAICompatClient(llm.images, llm.embeddings, logger, "images")
      : null;
  }

  private client(role: "heavy" | "light" | "images"): OpenAICompatClient {
    if (role === "images") return this.images ?? this.light;
    return role === "light" ? this.light : this.heavy;
  }

  private roleConfig(role: "heavy" | "light" | "images"): ChatConfig {
    if (role === "heavy") return this.llm.chat;
    if (role === "images") return this.llm.images ?? this.llm.light;
    return this.llm.light;
  }

  metadataFor(role: "heavy" | "light" | "images"): LlmInvocationMetadata {
    const config = this.roleConfig(role);
    const resolvedRole = role === "images" && !this.llm.images ? "light" : role;
    const configKey =
      role === "heavy"
        ? "llm.chat"
        : role === "images" && this.llm.images
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
      topK: config.top_k,
      topP: config.top_p,
      minP: config.min_p,
    };
  }

  supportsVision(role: "heavy" | "light" | "images"): boolean {
    return this.visionSupport.get(role) ?? false;
  }

  chat(role: "heavy" | "light" | "images", system: string, user: string, options?: ChatOptions): Promise<string> {
    const cfg = this.roleConfig(role);
    return this.scheduler.dispatch(role, cfg.hosts, cfg.model, (endpoint) =>
      this.client(role).chat(endpoint, system, user, options),
    );
  }

  streamChat(
    role: "heavy" | "light",
    system: string,
    user: string,
    onChunk: (delta: string, accumulated: string) => void,
    options?: ChatOptions,
  ): Promise<{ content: string; finishReason: string; ttftMs?: number }> {
    const cfg = this.roleConfig(role);
    return this.scheduler.dispatch(role, cfg.hosts, cfg.model, (endpoint) =>
      this.client(role).streamChat(endpoint, system, user, onChunk, options),
    );
  }

  embed(input: string[]): Promise<number[][]> {
    if (!this.llm.embeddings.enabled || input.length === 0) return Promise.resolve([]);
    const cfg = this.llm.embeddings;
    return this.scheduler.dispatch("embeddings", cfg.hosts, cfg.model, (endpoint) =>
      this.heavy.embed(endpoint, input),
    );
  }

  /** Live host state (queue depth, in-flight count, probed models) for the admin UI. */
  hostSnapshot(): ReturnType<HostScheduler["snapshot"]> {
    return this.scheduler.snapshot();
  }

  /** Resolved candidate host order for a role — the order the scheduler would try. */
  candidatesFor(role: "heavy" | "light" | "images" | "embeddings"): string[] {
    const cfg = role === "embeddings" ? this.llm.embeddings : this.roleConfig(role);
    return this.scheduler.candidates(cfg.hosts, cfg.model);
  }

  async probeConnections(): Promise<void> {
    // Build the capability map: probe each host's served model list. Hosts that
    // don't answer are marked unknown (null) — assumed able to serve any
    // non-blacklisted model rather than excluded — so a transient probe miss
    // doesn't strand a role with no candidates.
    for (const ep of this.scheduler.endpoints()) {
      const models = await fetchHostModels(ep.baseUrl, ep.apiKey, this.logger);
      this.scheduler.setCapabilities(ep.hostId, models ? new Set(models) : null);
      this.logger.info("llm.host_capabilities", {
        host: ep.hostId,
        online: models !== null,
        models: models?.length ?? 0,
      });
    }
    if (!this.llm.embeddings.enabled) {
      this.logger.info("llm.embed_disabled", { role: "embeddings" });
    }
    // Probe vision support via provider capabilities (Ollama POST /api/show),
    // against each role's primary host. Falls back to false when unsupported.
    for (const role of ["light", "heavy"] as const) {
      const cfg = this.roleConfig(role);
      const hasVision = await probeVisionSupport(cfg.base_url, cfg.api_key, cfg.model, this.logger);
      this.visionSupport.set(role, hasVision);
      this.logger.info("llm.vision_capability", { role, model: cfg.model, vision: hasVision });
    }
    if (this.llm.images) {
      const cfg = this.llm.images;
      const hasVision = await probeVisionSupport(cfg.base_url, cfg.api_key, cfg.model, this.logger);
      this.visionSupport.set("images", hasVision);
      this.logger.info("llm.vision_capability", { role: "images", model: cfg.model, vision: hasVision });
      if (!hasVision) {
        this.logger.warn("llm.images_no_vision", {
          model: cfg.model,
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
