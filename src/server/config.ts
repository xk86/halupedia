import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse } from "smol-toml";
import type { AppConfig, LlmConfig, PromptConfig, PromptTemplate, RewriteMode } from "./types";

const ROOT = process.cwd();

function readToml<T>(path: string): T {
  const raw = readFileSync(resolve(ROOT, path), "utf8");
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
    },
    homepage: {
      rotation_hours: app.homepage?.rotation_hours ?? 4,
    },
    random_page: {
      inspiration_count: app.random_page?.inspiration_count ?? 12,
    },
    tests: {
      database_path: app.tests?.database_path ?? "halupedia.sqlite",
      llm_base_url: app.tests?.llm_base_url ?? "http://localhost:11434/v1",
      llm_api_key: app.tests?.llm_api_key ?? "ollama",
      llm_model: app.tests?.llm_model ?? "gemma4",
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
    },
    embeddings: {
      enabled: llm.embeddings?.enabled ?? false,
      base_url:
        llm.embeddings?.base_url ??
        llm.chat?.base_url ??
        "http://127.0.0.1:11434/v1",
      api_key: llm.embeddings?.api_key ?? llm.chat?.api_key ?? "local",
      model: llm.embeddings?.model ?? "local-embed-model",
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
