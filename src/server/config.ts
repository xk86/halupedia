import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "smol-toml";
import type { AppConfig, LlmConfig, PromptConfig } from "./types";

const ROOT = process.cwd();

function readToml<T>(path: string): T {
  const raw = readFileSync(resolve(ROOT, path), "utf8");
  return parse(raw) as T;
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
      max_results: app.rag?.max_results ?? 4,
      chunk_size: app.rag?.chunk_size ?? 500,
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
    embeddings: {
      enabled: llm.embeddings?.enabled ?? false,
      base_url: llm.embeddings?.base_url ?? llm.chat?.base_url ?? "http://127.0.0.1:11434/v1",
      api_key: llm.embeddings?.api_key ?? llm.chat?.api_key ?? "local",
      model: llm.embeddings?.model ?? "local-embed-model",
    },
  };
}

export function loadConfig() {
  const app = withDefaults(readToml<Partial<AppConfig>>("config/app.toml"));
  const llmFile = readToml<{ llm?: Partial<LlmConfig> }>("config/llm.toml");
  const llm = withLlmDefaults(llmFile.llm ?? {});
  const prompts = readToml<PromptConfig>("config/prompts.toml");
  mkdirSync(dirname(resolve(ROOT, app.storage.database_path)), { recursive: true });
  return { app, llm, prompts };
}
