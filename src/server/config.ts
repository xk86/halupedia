import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse } from "smol-toml";
import type { AppConfig, HostConfig, ImagesConfig, LlmConfig, PromptConfig, PromptTemplate, RewriteMode } from "./types";
import { validateOpenAIImageSize } from "./imageAspectRatios";
import { OPTIONAL_OLLAMA_PARAMETER_KEYS, type OptionalOllamaParameterKey } from "../ollamaOptions";

const ROOT = process.cwd();

function readToml<T>(path: string): T {
  const configPath = resolve(ROOT, path);
  const examplePath = resolve(ROOT, `${path}.example`);
  const raw = readFileSync(existsSync(configPath) ? configPath : examplePath, "utf8");
  return parse(raw) as T;
}

function loadPromptFiles(dir: string, runnable: boolean) {
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".toml"))
    : [];
  const prompts: Record<string, PromptTemplate> = {};
  let rewriteModes: Record<string, RewriteMode> = {};
  for (const file of files) {
    const key = basename(file, ".toml");
    const raw = parse(readFileSync(resolve(dir, file), "utf8")) as {
      system?: string;
      user?: string;
      model?: "heavy" | "light";
      thinking?: boolean;
      json?: boolean;
      modes?: Record<string, RewriteMode>;
    };
    prompts[key] = {
      system: raw.system ?? "",
      user: raw.user ?? "",
      ...(runnable
        ? {
            model:
              raw.model === "light"
                ? "light"
                : raw.model === "heavy"
                  ? "heavy"
                  : undefined,
            thinking: raw.thinking ?? false,
            json: raw.json ?? false,
          }
        : {}),
    };
    if (raw.modes) {
      rewriteModes = { ...rewriteModes, ...raw.modes };
    }
  }
  return { prompts, rewriteModes };
}

function loadPromptConfig(dir: string): PromptConfig {
  const absDir = resolve(ROOT, dir);
  const runnable = loadPromptFiles(absDir, true);
  const shared = loadPromptFiles(resolve(absDir, "shared"), false);
  return {
    prompts: runnable.prompts,
    shared: shared.prompts,
    rewriteModes: {
      ...shared.rewriteModes,
      ...runnable.rewriteModes,
    },
  };
}

function withDefaults(app: Partial<AppConfig>): AppConfig {
  const rawAspectRatios = app.images?.generation?.aspect_ratios ?? {};
  const aspectRatios = Object.fromEntries(
    Object.entries(rawAspectRatios).filter(([, option]) => {
      if (!option || typeof option.size !== "string") return false;
      return !validateOpenAIImageSize(option.size);
    }),
  );
  return {
    server: {
      host: app.server?.host ?? "127.0.0.1",
      port: app.server?.port ?? 8787,
    },
    storage: {
      database_path: app.storage?.database_path ?? "data/halupedia.sqlite",
    },
    search: {
      limit: app.search?.limit ?? 20,
    },
    rag: {
      enabled: app.rag?.enabled ?? false,
      mode: app.rag?.mode === "summary" ? "summary" : "full",
      max_results: app.rag?.max_results ?? 4,
      chunk_size: app.rag?.chunk_size ?? 500,
      min_score: app.rag?.min_score ?? 0.2,
      summary_cap_enabled: app.rag?.summary_cap_enabled ?? true,
      summary_cap_chars: app.rag?.summary_cap_chars ?? 3600,
      reference_max_results: app.rag?.reference_max_results ?? 8,
      reference_min_score: app.rag?.reference_min_score ?? 0.4,
      max_references: app.rag?.max_references ?? 50,
      reference_recursive_depth: app.rag?.reference_recursive_depth ?? 2,
      reference_recursive_max_per_article: app.rag?.reference_recursive_max_per_article ?? 3,
      reference_cull_min_score: app.rag?.reference_cull_min_score ?? 0.3,
      reference_cull_top_k: app.rag?.reference_cull_top_k ?? 20,
      prompt_ref_content_min_score: app.rag?.prompt_ref_content_min_score ?? 0.5,
      prompt_ref_content_top_k: app.rag?.prompt_ref_content_top_k ?? 6,
      direct_chunks_per_article: app.rag?.direct_chunks_per_article ?? 3,
      prompt_link_hints_max: app.rag?.prompt_link_hints_max ?? 12,
      prompt_context_max_chars: app.rag?.prompt_context_max_chars ?? 24_000,
      refresh_context_max_chars: app.rag?.refresh_context_max_chars ?? 4_000,
      refresh_context_max_articles: app.rag?.refresh_context_max_articles ?? 4,
      refresh_related_titles_max: app.rag?.refresh_related_titles_max ?? 6,
    },
    homepage: {
      rotation_hours: app.homepage?.rotation_hours ?? 4,
    },
    world: {
      epoch_real_time: app.world?.epoch_real_time ?? "2026-01-01T00:00:00.000Z",
      epoch_day: Math.max(1, Math.floor(app.world?.epoch_day ?? 1)),
      epoch_date: app.world?.epoch_date ?? "2026-01-01",
      era_pivot_date: app.world?.era_pivot_date ?? "2000-01-01",
      calendar_name: app.world?.calendar_name ?? "Halu Era",
    },
    random_page: {
      inspiration_count: app.random_page?.inspiration_count ?? 12,
    },
    generation: {
      max_in_flight: Math.max(1, Math.floor(app.generation?.max_in_flight ?? 1)),
    },
    tests: {
      database_path: app.tests?.database_path ?? "halupedia.sqlite",
      llm_base_url: app.tests?.llm_base_url ?? "http://127.0.0.1:11434/v1",
      llm_api_key: app.tests?.llm_api_key ?? "ollama",
      llm_model: app.tests?.llm_model ?? "gemma4",
    },
    pipeline: {
      trace: {
        enabled: app.pipeline?.trace?.enabled ?? true,
        database_path:
          app.pipeline?.trace?.database_path ?? "data/halupedia-traces.sqlite",
        level: app.pipeline?.trace?.level ?? "normal",
        retention_days: app.pipeline?.trace?.retention_days ?? 14,
      },
    },
    images: {
      model_max_edge: (app.images as Partial<ImagesConfig> | undefined)?.model_max_edge ?? 256,
      jpeg_quality: (app.images as Partial<ImagesConfig> | undefined)?.jpeg_quality ?? 70,
      max_bytes: (app.images as Partial<ImagesConfig> | undefined)?.max_bytes ?? 15 * 1024 * 1024,
      fetch_timeout_ms: (app.images as Partial<ImagesConfig> | undefined)?.fetch_timeout_ms ?? 10_000,
      media_database_path: (app.images as Partial<ImagesConfig> | undefined)?.media_database_path ?? "data/halupedia-media.sqlite",
      allow_private_hosts: (app.images as Partial<ImagesConfig> | undefined)?.allow_private_hosts ?? false,
      generation: {
        enabled: app.images?.generation?.enabled ?? false,
        auto_generate_for_new_articles: app.images?.generation?.auto_generate_for_new_articles ?? false,
        auto_generate_for_featured_article: app.images?.generation?.auto_generate_for_featured_article ?? false,
        auto_preset_multipass: app.images?.generation?.auto_preset_multipass ?? false,
        backend: app.images?.generation?.backend === "ollama" ? "ollama" : "openai",
        aspect_ratios: aspectRatios,
        openai: {
          base_url: app.images?.generation?.openai?.base_url ?? "https://api.openai.com/v1",
          api_key: app.images?.generation?.openai?.api_key ?? "",
          model: app.images?.generation?.openai?.model ?? "gpt-image-2",
          size: app.images?.generation?.openai?.size ?? "1088x624",
          quality: app.images?.generation?.openai?.quality ?? "low",
          output_format: app.images?.generation?.openai?.output_format ?? "jpeg",
          output_compression: app.images?.generation?.openai?.output_compression ?? 70,
          timeout_ms: app.images?.generation?.openai?.timeout_ms ?? 120_000,
        },
        ollama: {
          base_url: app.images?.generation?.ollama?.base_url ?? "http://127.0.0.1:11434",
          model: app.images?.generation?.ollama?.model ?? "x/z-image-turbo",
          width: app.images?.generation?.ollama?.width ?? 1088,
          height: app.images?.generation?.ollama?.height ?? 624,
          steps: app.images?.generation?.ollama?.steps ?? 20,
          timeout_ms: app.images?.generation?.ollama?.timeout_ms ?? 120_000,
        },
      },
    },
  };
}

// Default per-host concurrency caps. Conservative: a single local Ollama box
// typically runs only a handful of parallel slots, and anything past that just
// queues inside the backend where it can time out waiting its turn. Tune per
// host in config (a beefier box can take more) via `max_in_flight`.
const DEFAULT_CHAT_MAX_IN_FLIGHT = 4;
const DEFAULT_EMBED_MAX_IN_FLIGHT = 8;
// Default fallback preference for a host that doesn't set one — high (least
// preferred) so explicitly-ranked hosts win.
const DEFAULT_HOST_PREF = 100;
const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";

// Raw (pre-resolution) shapes as they appear in llm.toml: roles may reference
// hosts via `hosts`/`host`, or carry a legacy inline `base_url`.
interface RawHost {
  base_url?: string;
  api_key?: string;
  max_in_flight?: number;
  pref?: number;
  blacklist?: string[];
}
interface RawRole {
  hosts?: string[];
  host?: string;
  base_url?: string;
  api_key?: string;
  max_in_flight?: number;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  num_predict?: number;
  num_ctx?: number;
  repeat_last_n?: number;
  repeat_penalty?: number;
  seed?: number;
  draft_num_predict?: number;
  top_k?: number;
  top_p?: number;
  min_p?: number;
  request_timeout_ms?: number;
}
interface RawEmbeddings extends RawRole {
  enabled?: boolean;
}
interface RawLlm {
  host?: Record<string, RawHost>;
  chat?: RawRole;
  light?: RawRole;
  images?: RawRole;
  embeddings?: RawEmbeddings;
}

/** Host id synthesized from a legacy inline base_url (e.g. "cat-desktop:11434"). */
function synthHostId(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function withLlmDefaults(raw: RawLlm): LlmConfig {
  const hosts: Record<string, HostConfig> = {};

  const upsertHost = (id: string, partial: RawHost, fallbackMaxInFlight: number): HostConfig => {
    const existing = hosts[id];
    const host: HostConfig = {
      id,
      base_url: partial.base_url ?? existing?.base_url ?? DEFAULT_BASE_URL,
      api_key: partial.api_key ?? existing?.api_key ?? "local",
      max_in_flight: partial.max_in_flight ?? existing?.max_in_flight ?? fallbackMaxInFlight,
      pref: partial.pref ?? existing?.pref ?? DEFAULT_HOST_PREF,
      blacklist: (partial.blacklist ?? existing?.blacklist ?? []).map(String),
    };
    hosts[id] = host;
    return host;
  };

  // 1. Explicit named hosts.
  for (const [id, h] of Object.entries(raw.host ?? {})) {
    upsertHost(id, h ?? {}, DEFAULT_CHAT_MAX_IN_FLIGHT);
  }

  // Resolve a role's ordered host ids, registering an implicit host for a legacy
  // inline base_url so old configs keep working with zero migration.
  const resolveHosts = (
    role: RawRole | undefined,
    fallbackMaxInFlight: number,
    inherit: string[],
  ): string[] => {
    if (role?.hosts?.length) return role.hosts.map(String);
    if (role?.host) return [String(role.host)];
    if (role?.base_url) {
      const id = synthHostId(role.base_url);
      upsertHost(
        id,
        { base_url: role.base_url, api_key: role.api_key, max_in_flight: role.max_in_flight },
        fallbackMaxInFlight,
      );
      return [id];
    }
    return inherit;
  };

  // Endpoint of the first preferred host that actually exists, for trace/legacy display.
  const primary = (ids: string[]): { base_url: string; api_key: string } => {
    const host = ids.map((id) => hosts[id]).find(Boolean);
    return { base_url: host?.base_url ?? DEFAULT_BASE_URL, api_key: host?.api_key ?? "local" };
  };

  // Optional generation params: kept only when set (so an unset value leaves the
  // backend default alone), inheriting down the chat → light → images chain.
  const generationOptions = (...roles: (RawRole | undefined)[]): Partial<Record<OptionalOllamaParameterKey, number>> => {
    const pick = (key: OptionalOllamaParameterKey) => {
      for (const r of roles) if (typeof r?.[key] === "number") return r[key];
      return undefined;
    };
    const out: Partial<Record<OptionalOllamaParameterKey, number>> = {};
    for (const key of OPTIONAL_OLLAMA_PARAMETER_KEYS) {
      const value = pick(key);
      if (value !== undefined) out[key] = value;
    }
    return out;
  };

  let chatHosts = resolveHosts(raw.chat, DEFAULT_CHAT_MAX_IN_FLIGHT, []);
  if (chatHosts.length === 0) {
    upsertHost(synthHostId(DEFAULT_BASE_URL), {}, DEFAULT_CHAT_MAX_IN_FLIGHT);
    chatHosts = [synthHostId(DEFAULT_BASE_URL)];
  }
  const lightHosts = resolveHosts(raw.light, DEFAULT_CHAT_MAX_IN_FLIGHT, chatHosts);
  const imagesHosts = resolveHosts(raw.images, DEFAULT_CHAT_MAX_IN_FLIGHT, lightHosts);
  const embHosts = resolveHosts(raw.embeddings, DEFAULT_EMBED_MAX_IN_FLIGHT, chatHosts);

  return {
    hosts,
    chat: {
      hosts: chatHosts,
      ...primary(chatHosts),
      model: raw.chat?.model ?? "local-model",
      temperature: raw.chat?.temperature ?? 0.8,
      max_tokens: raw.chat?.num_predict ?? raw.chat?.max_tokens ?? 2400,
      ...generationOptions(raw.chat),
      request_timeout_ms: raw.chat?.request_timeout_ms ?? 180_000,
    },
    light: {
      hosts: lightHosts,
      ...primary(lightHosts),
      model: raw.light?.model ?? raw.chat?.model ?? "local-model",
      temperature: raw.light?.temperature ?? raw.chat?.temperature ?? 0.8,
      max_tokens: raw.light?.num_predict ?? raw.light?.max_tokens ?? raw.chat?.num_predict ?? raw.chat?.max_tokens ?? 2400,
      ...generationOptions(raw.light, raw.chat),
      request_timeout_ms: raw.light?.request_timeout_ms ?? raw.chat?.request_timeout_ms ?? 180_000,
    },
    images: raw.images
      ? {
          hosts: imagesHosts,
          ...primary(imagesHosts),
          model: raw.images.model ?? raw.light?.model ?? raw.chat?.model ?? "local-model",
          temperature: raw.images.temperature ?? raw.light?.temperature ?? raw.chat?.temperature ?? 0.8,
          max_tokens: raw.images.num_predict ?? raw.images.max_tokens ?? raw.light?.num_predict ?? raw.light?.max_tokens ?? raw.chat?.num_predict ?? raw.chat?.max_tokens ?? 2400,
          ...generationOptions(raw.images, raw.light, raw.chat),
          request_timeout_ms:
            raw.images.request_timeout_ms ?? raw.light?.request_timeout_ms ?? raw.chat?.request_timeout_ms ?? 180_000,
        }
      : undefined,
    embeddings: {
      enabled: raw.embeddings?.enabled ?? false,
      hosts: embHosts,
      ...primary(embHosts),
      model: raw.embeddings?.model ?? "local-embed-model",
      request_timeout_ms: raw.embeddings?.request_timeout_ms ?? 2_000,
    },
  };
}

export function loadConfig() {
  const app = withDefaults(readToml<Partial<AppConfig>>("config/app.toml"));
  const llmFile = readToml<{ llm?: RawLlm }>("config/llm.toml");
  const llm = withLlmDefaults(llmFile.llm ?? {});
  const prompts = loadPromptConfig("config/prompts");
  mkdirSync(dirname(resolve(ROOT, app.storage.database_path)), {
    recursive: true,
  });
  return { app, llm, prompts };
}
