import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse } from "smol-toml";
import type { AppConfig, ImagesConfig, LlmConfig, PromptConfig, PromptTemplate, RewriteMode } from "./types";

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
      prompt_link_hints_max: app.rag?.prompt_link_hints_max ?? 40,
      prompt_context_max_chars: app.rag?.prompt_context_max_chars ?? 24_000,
    },
    homepage: {
      rotation_hours: app.homepage?.rotation_hours ?? 4,
    },
    random_page: {
      inspiration_count: app.random_page?.inspiration_count ?? 12,
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
    },
  };
}

function withLlmDefaults(llm: Partial<LlmConfig>): LlmConfig {
  return {
    chat: {
      base_url: llm.chat?.base_url ?? "http://127.0.0.1:11434/v1",
      api_key: llm.chat?.api_key ?? "local",
      model: llm.chat?.model ?? "local-model",
      temperature: llm.chat?.temperature ?? 0.8,
      max_tokens: llm.chat?.max_tokens ?? 2400,
      request_timeout_ms: llm.chat?.request_timeout_ms ?? 180_000,
    },
    light: {
      base_url:
        llm.light?.base_url ??
        llm.chat?.base_url ??
        "http://127.0.0.1:11434/v1",
      api_key: llm.light?.api_key ?? llm.chat?.api_key ?? "local",
      model: llm.light?.model ?? llm.chat?.model ?? "local-model",
      temperature: llm.light?.temperature ?? llm.chat?.temperature ?? 0.8,
      max_tokens: llm.light?.max_tokens ?? llm.chat?.max_tokens ?? 2400,
      request_timeout_ms: llm.light?.request_timeout_ms ?? llm.chat?.request_timeout_ms ?? 180_000,
    },
    images: llm.images
      ? {
          base_url: llm.images.base_url ?? llm.light?.base_url ?? llm.chat?.base_url ?? "http://127.0.0.1:11434/v1",
          api_key: llm.images.api_key ?? llm.light?.api_key ?? llm.chat?.api_key ?? "local",
          model: llm.images.model ?? llm.light?.model ?? llm.chat?.model ?? "local-model",
          temperature: llm.images.temperature ?? llm.light?.temperature ?? llm.chat?.temperature ?? 0.8,
          max_tokens: llm.images.max_tokens ?? llm.light?.max_tokens ?? llm.chat?.max_tokens ?? 2400,
          request_timeout_ms: llm.images.request_timeout_ms ?? llm.light?.request_timeout_ms ?? llm.chat?.request_timeout_ms ?? 180_000,
        }
      : undefined,
    embeddings: {
      enabled: llm.embeddings?.enabled ?? false,
      base_url:
        llm.embeddings?.base_url ??
        llm.chat?.base_url ??
        "http://127.0.0.1:11434/v1",
      api_key: llm.embeddings?.api_key ?? llm.chat?.api_key ?? "local",
      model: llm.embeddings?.model ?? "local-embed-model",
      request_timeout_ms: llm.embeddings?.request_timeout_ms ?? 60_000,
    },
  };
}

export function loadConfig() {
  const app = withDefaults(readToml<Partial<AppConfig>>("config/app.toml"));
  const llmFile = readToml<{ llm?: Partial<LlmConfig> }>("config/llm.toml");
  const llm = withLlmDefaults(llmFile.llm ?? {});
  const prompts = loadPromptConfig("config/prompts");
  mkdirSync(dirname(resolve(ROOT, app.storage.database_path)), {
    recursive: true,
  });
  return { app, llm, prompts };
}
