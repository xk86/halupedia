import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse } from "smol-toml";
import type {
  AgentConfig,
  AppConfig,
  GenerationConfig,
  HomepageConfig,
  HostConfig,
  ImagesConfig,
  LlmConfig,
  OntologyReviewConfig,
  PipelineTraceConfig,
  PromptConfig,
  PromptTemplate,
  RagConfig,
  RandomPageConfig,
  RewriteMode,
  SearchConfig,
  ServerConfig,
  StorageConfig,
  TestConfig,
  WorldConfig,
} from "./types";
import { validateOpenAIImageSize } from "./imageAspectRatios";
import { OPTIONAL_OLLAMA_PARAMETER_KEYS, type OptionalOllamaParameterKey } from "../ollamaOptions";
import { resolveConfigTable } from "./configSchema";
import { loadRuleLibrary } from "./rules/library";
import { RULE_TIERS, type RuleDef, type RuleSpec, type RuleTier } from "./rules/types";

const ROOT = process.cwd();

function readToml<T>(path: string): T {
  const configPath = resolve(ROOT, path);
  const examplePath = resolve(ROOT, `${path}.example`);
  const raw = readFileSync(existsSync(configPath) ? configPath : examplePath, "utf8");
  return parse(raw) as T;
}

/** Parse a prompt file's `[[local_rule]]` array-of-tables into `RuleDef[]`,
 *  validating each entry the same way `config/rules/*.toml` category rules
 *  are validated (see `rules/library.ts`) — a malformed local rule should
 *  fail loudly at startup, not silently render as an empty bullet. */
function parseLocalRules(
  key: string,
  entries: Array<{ id?: string; tier?: number; text?: string; overrides?: string[] }> | undefined,
): RuleDef[] | undefined {
  if (!entries || entries.length === 0) return undefined;
  return entries.map((entry) => {
    if (typeof entry.id !== "string" || !entry.id) {
      throw new Error(`prompt '${key}': local_rule is missing an id`);
    }
    if (!RULE_TIERS.includes(entry.tier as RuleTier)) {
      throw new Error(
        `prompt '${key}': local_rule '${entry.id}' has an invalid tier (must be one of ${RULE_TIERS.join(", ")})`,
      );
    }
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (!text) {
      throw new Error(`prompt '${key}': local_rule '${entry.id}' has empty text`);
    }
    const overrides = Array.isArray(entry.overrides)
      ? entry.overrides.filter((ref): ref is string => typeof ref === "string")
      : undefined;
    return {
      id: entry.id,
      tier: entry.tier as RuleTier,
      text,
      ...(overrides && overrides.length > 0 ? { overrides } : {}),
    };
  });
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
      rules?: { include?: string[]; exclude?: string[] };
      local_rule?: Array<{ id?: string; tier?: number; text?: string; overrides?: string[] }>;
    };
    const rules: RuleSpec | undefined = raw.rules
      ? {
          include: Array.isArray(raw.rules.include) ? raw.rules.include : [],
          ...(Array.isArray(raw.rules.exclude) && raw.rules.exclude.length > 0
            ? { exclude: raw.rules.exclude }
            : {}),
        }
      : undefined;
    const localRules = parseLocalRules(key, raw.local_rule);
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
            ...(rules ? { rules } : {}),
            ...(localRules ? { localRules } : {}),
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
  const ruleLibrary = loadRuleLibrary(resolve(ROOT, "config", "rules"));
  return {
    prompts: runnable.prompts,
    shared: shared.prompts,
    rewriteModes: {
      ...shared.rewriteModes,
      ...runnable.rewriteModes,
    },
    ruleLibrary,
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
    server: resolveConfigTable<ServerConfig>(app, "server"),
    storage: resolveConfigTable<StorageConfig>(app, "storage"),
    search: resolveConfigTable<SearchConfig>(app, "search"),
    rag: resolveConfigTable<RagConfig>(app, "rag"),
    homepage: resolveConfigTable<HomepageConfig>(app, "homepage"),
    world: resolveConfigTable<WorldConfig>(app, "world"),
    random_page: resolveConfigTable<RandomPageConfig>(app, "random_page"),
    generation: resolveConfigTable<GenerationConfig>(app, "generation"),
    tests: resolveConfigTable<TestConfig>(app, "tests"),
    pipeline: {
      trace: resolveConfigTable<PipelineTraceConfig>(app, "pipeline.trace"),
    },
    ontology_review: resolveConfigTable<OntologyReviewConfig>(app, "ontology_review"),
    agent: resolveConfigTable<AgentConfig>(app, "agent"),
    images: {
      ...resolveConfigTable<Omit<ImagesConfig, "generation">>(app, "images"),
      generation: {
        enabled: app.images?.generation?.enabled ?? false,
        auto_generate_for_new_articles: app.images?.generation?.auto_generate_for_new_articles ?? false,
        auto_generate_for_featured_article: app.images?.generation?.auto_generate_for_featured_article ?? false,
        homepage_auto_image_max_attempts: Math.max(
          0,
          Math.floor(app.images?.generation?.homepage_auto_image_max_attempts ?? 3),
        ),
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
