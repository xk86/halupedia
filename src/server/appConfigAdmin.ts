import type { AppConfig } from "./types";
import { setTomlTableValue, type TomlValue } from "./tomlEdit";

export type AppConfigFieldKind = "boolean" | "number" | "string" | "select" | "secret";

export interface AppConfigFieldDefinition {
  table: string;
  key: string;
  label: string;
  description: string;
  kind: AppConfigFieldKind;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  restartRequired?: boolean;
}

export interface AppConfigSectionDefinition {
  id: string;
  title: string;
  description: string;
  fields: AppConfigFieldDefinition[];
}

const field = (
  table: string,
  key: string,
  label: string,
  description: string,
  kind: AppConfigFieldKind,
  extra: Partial<AppConfigFieldDefinition> = {},
): AppConfigFieldDefinition => ({ table, key, label, description, kind, ...extra });

export const APP_CONFIG_SECTIONS: AppConfigSectionDefinition[] = [
  {
    id: "server-storage",
    title: "Server & storage",
    description: "Network binding and durable database locations.",
    fields: [
      field("server", "host", "Host", "Address the HTTP server binds to.", "string", { restartRequired: true }),
      field("server", "port", "Port", "Port the HTTP server listens on.", "number", { min: 1, max: 65535, step: 1, restartRequired: true }),
      field("storage", "database_path", "Article database", "SQLite file containing articles and graph data.", "string", { restartRequired: true }),
    ],
  },
  {
    id: "retrieval",
    title: "Search & retrieval",
    description: "Result limits, relevance thresholds, reference traversal, and prompt context budgets.",
    fields: [
      field("search", "limit", "Search results", "Default number of search results.", "number", { min: 1, step: 1 }),
      field("rag", "enabled", "Enable retrieval", "Use the local retrieval index during generation.", "boolean"),
      field("rag", "max_results", "RAG results", "Maximum retrieval results admitted before reference processing.", "number", { min: 0, step: 1 }),
      field("rag", "min_score", "RAG minimum score", "Minimum vector relevance score.", "number", { min: 0, max: 1, step: 0.01 }),
      field("rag", "reference_max_results", "Reference RAG results", "Maximum newly discovered vector references.", "number", { min: 0, step: 1 }),
      field("rag", "reference_min_score", "Reference minimum score", "Minimum relevance for vector reference candidates.", "number", { min: 0, max: 1, step: 0.01 }),
      field("rag", "max_references", "Maximum references", "Hard cap for non-pinned article references.", "number", { min: 0, step: 1 }),
      field("rag", "reference_recursive_depth", "Traversal depth", "Graph expansion depth for references and backlinks.", "number", { min: 0, step: 1 }),
      field("rag", "reference_recursive_max_per_article", "Traversal fan-out", "Maximum candidates pulled from each traversed article per direction.", "number", { min: 0, step: 1 }),
      field("rag", "reference_recursive_article_limit", "Recursive article cap", "Total recursively discovered articles admitted after ranking.", "number", { min: 0, step: 1 }),
      field("rag", "reference_cull_min_score", "Cull minimum score", "Global score floor after the reference pool is assembled.", "number", { min: 0, max: 1, step: 0.01 }),
      field("rag", "reference_cull_top_k", "Cull top K", "Maximum cull-eligible references after scoring; zero disables the cap.", "number", { min: 0, step: 1 }),
      field("rag", "prompt_ref_content_min_score", "Prompt-content score", "Minimum score for including a reference's text in prompts.", "number", { min: 0, max: 1, step: 0.01 }),
      field("rag", "prompt_ref_content_top_k", "Prompt-content top K", "Maximum scored reference bodies in prompts; zero disables the cap.", "number", { min: 0, step: 1 }),
      field("rag", "prompt_link_hints_max", "Incoming link hints", "Maximum deduplicated incoming hints in a prompt.", "number", { min: 0, step: 1 }),
      field("rag", "prompt_context_max_chars", "Prompt context characters", "Hard character budget for retrieved prompt context.", "number", { min: 0, step: 100 }),
      field("rag", "refresh_context_max_chars", "Refresh context characters", "Retrieved-context character budget for refreshes.", "number", { min: 0, step: 100 }),
      field("rag", "refresh_context_max_articles", "Refresh context articles", "Maximum full article sources in refresh context.", "number", { min: 0, step: 1 }),
      field("rag", "refresh_related_titles_max", "Refresh related titles", "Maximum related-topic suggestions in refresh prompts.", "number", { min: 0, step: 1 }),
      field("rag", "ontology_llm_extraction", "LLM ontology extraction", "Run model-assisted ontology extraction during indexing.", "boolean"),
      field("rag", "ontology_facts_per_retrieved_article", "Facts per retrieved article", "Canonical per-article ontology-fact allowance in retrieval.", "number", { min: 0, step: 1 }),
    ],
  },
  {
    id: "generation-world",
    title: "Generation & world",
    description: "Generation concurrency, homepage cadence, and fictional calendar settings.",
    fields: [
      field("generation", "max_in_flight", "Concurrent generations", "Full article workflows admitted at once.", "number", { min: 1, step: 1 }),
      field("homepage", "rotation_hours", "Homepage rotation", "Hours between featured-article rotations.", "number", { min: 0, step: 1 }),
      field("random_page", "inspiration_count", "Random inspirations", "Candidate titles sampled for random generation.", "number", { min: 1, step: 1 }),
      field("world", "epoch_real_time", "Real-time epoch", "ISO timestamp anchoring the fictional calendar.", "string"),
      field("world", "epoch_day", "Epoch day", "In-universe day number at the epoch.", "number", { min: 1, step: 1 }),
      field("world", "epoch_date", "Epoch date", "Displayed fictional date at the epoch.", "string"),
      field("world", "calendar_name", "Calendar name", "Display name for the fictional calendar.", "string"),
    ],
  },
  {
    id: "agents",
    title: "Research agents",
    description: "Chat roles, recursion ceilings, and tool result budgets.",
    fields: [
      field("agent", "enabled", "Enable agents", "Enable the article chat and research workflow.", "boolean"),
      field("agent", "chat_role", "Chat role", "Model role used by the chat orchestrator.", "select", { options: ["heavy", "light"] }),
      field("agent", "research_role", "Research role", "Model role used by the research subagent.", "select", { options: ["heavy", "light"] }),
      field("agent", "chat_recursion_limit", "Chat recursion", "Maximum chat-orchestrator loop iterations.", "number", { min: 1, step: 1 }),
      field("agent", "research_recursion_limit", "Research recursion", "Maximum research-subagent loop iterations.", "number", { min: 1, step: 1 }),
      field("agent", "search_default_limit", "Default search limit", "Default article count returned to research tools.", "number", { min: 1, step: 1 }),
      field("agent", "search_max_limit", "Maximum search limit", "Hard ceiling for tool-requested search results.", "number", { min: 1, step: 1 }),
      field("agent", "search_ontology_facts_per_result", "Facts per search result", "Ontology facts inlined with each search result.", "number", { min: 0, step: 1 }),
      field("agent", "search_ontology_quota", "Ontology quota", "Reserved ontology-fact slots in reference search.", "number", { min: 0, step: 1 }),
      field("agent", "ontology_facts_max", "Ontology fact maximum", "Hard cap for a single ontology-fact tool call.", "number", { min: 0, step: 1 }),
    ],
  },
  {
    id: "observability-media",
    title: "Tracing & media",
    description: "Pipeline trace retention and locally stored media limits.",
    fields: [
      field("pipeline.trace", "enabled", "Enable tracing", "Record structural pipeline traces.", "boolean"),
      field("pipeline.trace", "database_path", "Trace database", "Separate SQLite file for pipeline traces.", "string", { restartRequired: true }),
      field("pipeline.trace", "level", "Trace detail", "Amount of node data recorded per workflow.", "select", { options: ["off", "quiet", "normal", "debug", "trace"] }),
      field("pipeline.trace", "retention_days", "Trace retention", "Days to retain traces; zero disables pruning.", "number", { min: 0, step: 1 }),
      field("images", "model_max_edge", "Model image edge", "Maximum thumbnail edge sent to vision models.", "number", { min: 1, step: 1 }),
      field("images", "jpeg_quality", "JPEG quality", "Thumbnail JPEG quality.", "number", { min: 1, max: 100, step: 1 }),
      field("images", "max_bytes", "Maximum image bytes", "Maximum accepted image upload or fetch size.", "number", { min: 1, step: 1024 }),
      field("images", "fetch_timeout_ms", "Fetch timeout", "Remote image fetch timeout in milliseconds.", "number", { min: 1, step: 100 }),
      field("images", "media_database_path", "Media database", "SQLite file containing media metadata and bytes.", "string", { restartRequired: true }),
      field("images", "allow_private_hosts", "Allow private image hosts", "Permit image fetches from private network addresses.", "boolean"),
    ],
  },
  {
    id: "test-runtime",
    title: "Test runtime",
    description: "Defaults used by the local test harness.",
    fields: [
      field("tests", "database_path", "Test database", "SQLite database used by tests.", "string"),
      field("tests", "llm_base_url", "Test LLM URL", "OpenAI-compatible endpoint used by tests.", "string"),
      field("tests", "llm_api_key", "Test LLM API key", "Credential used by the test endpoint.", "secret"),
      field("tests", "llm_model", "Test LLM model", "Model name used by tests.", "string"),
    ],
  },
];

const FIELD_BY_PATH = new Map(
  APP_CONFIG_SECTIONS.flatMap((section) => section.fields).map((definition) => [
    `${definition.table}.${definition.key}`,
    definition,
  ]),
);

function valueAtPath(config: AppConfig, table: string, key: string): TomlValue {
  let value: unknown = config;
  for (const segment of table.split(".")) {
    value = (value as Record<string, unknown>)[segment];
  }
  return (value as Record<string, TomlValue>)[key];
}

export function appConfigAdminPayload(config: AppConfig) {
  return {
    sections: APP_CONFIG_SECTIONS.map((section) => ({
      ...section,
      fields: section.fields.map((definition) => ({
        ...definition,
        value: definition.kind === "secret" ? "" : valueAtPath(config, definition.table, definition.key),
        configured: definition.kind === "secret" ? Boolean(valueAtPath(config, definition.table, definition.key)) : true,
      })),
    })),
  };
}

export function updateAppConfigToml(source: string, path: string, value: unknown): string {
  const definition = FIELD_BY_PATH.get(path);
  if (!definition) throw new Error(`unknown app config field: ${path}`);

  let normalized: TomlValue;
  if (definition.kind === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
    normalized = value;
  } else if (definition.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
    if (definition.min !== undefined && value < definition.min) throw new Error(`${path} must be at least ${definition.min}`);
    if (definition.max !== undefined && value > definition.max) throw new Error(`${path} must be at most ${definition.max}`);
    normalized = definition.step !== undefined && definition.step >= 1 ? Math.floor(value) : value;
  } else {
    if (typeof value !== "string") throw new Error(`${path} must be a string`);
    if (definition.kind === "select" && !definition.options?.includes(value)) throw new Error(`${path} is not an allowed option`);
    if (definition.kind === "secret" && value.length === 0) throw new Error(`${path} cannot be blank`);
    normalized = value;
  }

  return setTomlTableValue(source, definition.table, definition.key, normalized);
}
