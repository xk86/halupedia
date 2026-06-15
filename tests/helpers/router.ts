// Test helper: build an OpenAICompatRouter from the old positional
// (chat, light, embeddings, logger?, images?) role configs that predate named
// hosts. Synthesizes a host per distinct base_url so tests don't have to spell
// out the [llm.host.*] graph.
import { OpenAICompatRouter } from "../../src/server/llm";
import type { ChatConfig, EmbeddingsConfig, HostConfig, LlmConfig } from "../../src/server/types";
import type { Logger } from "../../src/server/logger";

type RoleLike = {
  base_url: string;
  api_key: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  top_k?: number;
  top_p?: number;
  min_p?: number;
  request_timeout_ms?: number;
};
type EmbLike = { enabled: boolean; base_url: string; api_key: string; model: string; request_timeout_ms?: number };

export function makeRouter(
  chat: RoleLike,
  light: RoleLike,
  embeddings: EmbLike,
  logger?: Logger,
  images?: RoleLike,
): OpenAICompatRouter {
  const hosts: Record<string, HostConfig> = {};
  const hostId = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url || "default";
    }
  };
  const reg = (r: { base_url: string; api_key: string }): string[] => {
    const id = hostId(r.base_url);
    if (!hosts[id]) {
      hosts[id] = { id, base_url: r.base_url, api_key: r.api_key, max_in_flight: 4, pref: 0, blacklist: [] };
    }
    return [id];
  };
  const role = (r: RoleLike): ChatConfig => ({
    hosts: reg(r),
    base_url: r.base_url,
    api_key: r.api_key,
    model: r.model,
    temperature: r.temperature ?? 1,
    max_tokens: r.max_tokens ?? 2400,
    ...(r.top_k !== undefined ? { top_k: r.top_k } : {}),
    ...(r.top_p !== undefined ? { top_p: r.top_p } : {}),
    ...(r.min_p !== undefined ? { min_p: r.min_p } : {}),
    request_timeout_ms: r.request_timeout_ms ?? 180_000,
  });

  const chatCfg = role(chat);
  const lightCfg = role(light);
  const imagesCfg = images ? role(images) : undefined;
  const embCfg: EmbeddingsConfig = embeddings.base_url
    ? {
        enabled: embeddings.enabled,
        hosts: reg(embeddings),
        base_url: embeddings.base_url,
        api_key: embeddings.api_key,
        model: embeddings.model,
        request_timeout_ms: embeddings.request_timeout_ms ?? 2_000,
      }
    : {
        enabled: embeddings.enabled,
        hosts: chatCfg.hosts,
        base_url: chatCfg.base_url,
        api_key: chatCfg.api_key,
        model: embeddings.model,
        request_timeout_ms: embeddings.request_timeout_ms ?? 2_000,
      };

  const llm: LlmConfig = { hosts, chat: chatCfg, light: lightCfg, images: imagesCfg, embeddings: embCfg };
  return logger ? new OpenAICompatRouter(llm, logger) : new OpenAICompatRouter(llm);
}
