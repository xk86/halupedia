// Single source of truth for every scalar `config/app.toml` key: its default
// value, how a raw TOML value is coerced/clamped, and (optionally) how it is
// presented in the admin "Application configuration" tab.
//
// To wire up a brand-new config key: add one descriptor below with a
// `default`. It is picked up by `resolveConfigTable` (used by
// `withDefaults` in config.ts) automatically. To also expose it in the
// admin Config tab, add a `ui` block — widget kind is inferred from the
// default's type (boolean -> checkbox, number -> input/slider, string ->
// text) unless `ui.kind` overrides it (needed for "select" and "secret").
//
// Deliberately NOT covered here: `llm.toml`, prompt files, and
// `images.generation.*` (nested objects with their own richer editors in
// the Models/Prompts/Images tabs).

export type ConfigFieldKind = "boolean" | "number" | "string" | "select" | "secret";

export interface ConfigFieldUi {
  section: string;
  label: string;
  description: string;
  kind?: ConfigFieldKind;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  restartRequired?: boolean;
}

export interface ConfigDescriptor<T = unknown> {
  table: string;
  key: string;
  default: T;
  /** Applied to the raw TOML value (or the default, if unset) — used for
   *  clamping/rounding/ternary-style legacy defaulting. */
  coerce?: (value: T) => T;
  /** Presence marks this field as included in the admin Config tab. */
  ui?: ConfigFieldUi;
}

export interface ConfigSectionMeta {
  id: string;
  title: string;
  description: string;
}

export const CONFIG_SECTIONS: ConfigSectionMeta[] = [
  {
    id: "server-storage",
    title: "Server & storage",
    description: "Network binding and durable database locations.",
  },
  {
    id: "retrieval",
    title: "Search & retrieval",
    description: "Result limits, relevance thresholds, reference traversal, and prompt context budgets.",
  },
  {
    id: "generation-world",
    title: "Generation & world",
    description: "Generation concurrency, homepage cadence, and fictional calendar settings.",
  },
  {
    id: "agents",
    title: "Research agents",
    description: "Chat roles, recursion ceilings, and tool result budgets.",
  },
  {
    id: "ontology-review",
    title: "Ontology review",
    description: "Scheduled auto-review of pending ontology suggestions: enqueue cadence, per-run batch size, and format rules.",
  },
  {
    id: "observability-media",
    title: "Tracing & media",
    description: "Pipeline trace retention and locally stored media limits.",
  },
  {
    id: "test-runtime",
    title: "Test runtime",
    description: "Defaults used by the local test harness.",
  },
];

const atLeast1Int = (value: number) => Math.max(1, Math.floor(value));
const atLeast1 = (value: number) => Math.max(1, value);

function d<T>(
  table: string,
  key: string,
  defaultValue: T,
  options: { coerce?: (value: T) => T; ui?: ConfigFieldUi } = {},
): ConfigDescriptor {
  return { table, key, default: defaultValue, ...options } as ConfigDescriptor;
}

export const CONFIG_DESCRIPTORS: ConfigDescriptor[] = [
  // -- server-storage --
  d("server", "host", "127.0.0.1", {
    ui: { section: "server-storage", label: "Host", description: "Address the HTTP server binds to.", restartRequired: true },
  }),
  d("server", "port", 8787, {
    ui: { section: "server-storage", label: "Port", description: "Port the HTTP server listens on.", min: 1, max: 65535, step: 1, restartRequired: true },
  }),
  d("storage", "database_path", "data/halupedia.sqlite", {
    ui: { section: "server-storage", label: "Article database", description: "SQLite file containing articles and graph data.", restartRequired: true },
  }),

  // -- retrieval --
  d("search", "limit", 20, {
    ui: { section: "retrieval", label: "Search results", description: "Default number of search results.", min: 1, step: 1 },
  }),
  d("rag", "enabled", false, {
    ui: { section: "retrieval", label: "Enable retrieval", description: "Use the local retrieval index during generation." },
  }),
  d("rag", "max_results", 4, {
    ui: { section: "retrieval", label: "RAG results", description: "Maximum retrieval results admitted before reference processing.", min: 0, step: 1 },
  }),
  d("rag", "min_score", 0.2, {
    ui: { section: "retrieval", label: "RAG minimum score", description: "Minimum vector relevance score.", min: 0, max: 1, step: 0.01 },
  }),
  d("rag", "reference_max_results", 8, {
    ui: { section: "retrieval", label: "Reference RAG results", description: "Maximum newly discovered vector references.", min: 0, step: 1 },
  }),
  d("rag", "reference_min_score", 0.4, {
    ui: { section: "retrieval", label: "Reference minimum score", description: "Minimum relevance for vector reference candidates.", min: 0, max: 1, step: 0.01 },
  }),
  d("rag", "max_references", 50, {
    ui: { section: "retrieval", label: "Maximum references", description: "Hard cap for non-pinned article references.", min: 0, step: 1 },
  }),
  d("rag", "reference_recursive_depth", 2, {
    ui: { section: "retrieval", label: "Traversal depth", description: "Graph expansion depth for references and backlinks.", min: 0, step: 1 },
  }),
  d("rag", "reference_recursive_max_per_article", 3, {
    ui: { section: "retrieval", label: "Traversal fan-out", description: "Maximum candidates pulled from each traversed article per direction.", min: 0, step: 1 },
  }),
  d("rag", "reference_recursive_article_limit", 25, {
    ui: { section: "retrieval", label: "Recursive article cap", description: "Total recursively discovered articles admitted after ranking.", min: 0, step: 1 },
  }),
  d("rag", "reference_cull_min_score", 0.3, {
    ui: { section: "retrieval", label: "Cull minimum score", description: "Global score floor after the reference pool is assembled.", min: 0, max: 1, step: 0.01 },
  }),
  d("rag", "reference_cull_top_k", 20, {
    ui: { section: "retrieval", label: "Cull top K", description: "Maximum cull-eligible references after scoring; zero disables the cap.", min: 0, step: 1 },
  }),
  d("rag", "prompt_ref_content_min_score", 0.5, {
    ui: { section: "retrieval", label: "Prompt-content score", description: "Minimum score for including a reference's text in prompts.", min: 0, max: 1, step: 0.01 },
  }),
  d("rag", "prompt_ref_content_top_k", 6, {
    ui: { section: "retrieval", label: "Prompt-content top K", description: "Maximum scored reference bodies in prompts; zero disables the cap.", min: 0, step: 1 },
  }),
  d("rag", "prompt_link_hints_max", 12, {
    ui: { section: "retrieval", label: "Incoming link hints", description: "Maximum deduplicated incoming hints in a prompt.", min: 0, step: 1 },
  }),
  d("rag", "prompt_context_max_chars", 24_000, {
    ui: { section: "retrieval", label: "Prompt context characters", description: "Hard character budget for retrieved prompt context.", min: 0, step: 100 },
  }),
  d("rag", "refresh_context_max_chars", 4_000, {
    ui: { section: "retrieval", label: "Refresh context characters", description: "Retrieved-context character budget for refreshes.", min: 0, step: 100 },
  }),
  d("rag", "refresh_context_max_articles", 4, {
    ui: { section: "retrieval", label: "Refresh context articles", description: "Maximum full article sources in refresh context.", min: 0, step: 1 },
  }),
  d("rag", "refresh_related_titles_max", 6, {
    ui: { section: "retrieval", label: "Refresh related titles", description: "Maximum related-topic suggestions in refresh prompts.", min: 0, step: 1 },
  }),
  d("rag", "ontology_llm_extraction", false, {
    ui: { section: "retrieval", label: "LLM ontology extraction", description: "Run model-assisted ontology extraction during indexing." },
  }),
  d("rag", "ontology_facts_per_retrieved_article", 8, {
    ui: { section: "retrieval", label: "Facts per retrieved article", description: "Canonical per-article ontology-fact allowance in retrieval.", min: 0, step: 1 },
  }),

  // -- generation-world --
  d("generation", "max_in_flight", 1, {
    coerce: atLeast1Int,
    ui: { section: "generation-world", label: "Concurrent generations", description: "Full article workflows admitted at once.", min: 1, step: 1 },
  }),
  d("homepage", "rotation_hours", 4, {
    ui: { section: "generation-world", label: "Homepage rotation", description: "Hours between featured-article rotations.", min: 0, step: 1 },
  }),
  d("random_page", "inspiration_count", 12, {
    ui: { section: "generation-world", label: "Random inspirations", description: "Candidate titles sampled for random generation.", min: 1, step: 1 },
  }),
  d("world", "epoch_real_time", "2026-01-01T00:00:00.000Z", {
    ui: { section: "generation-world", label: "Real-time epoch", description: "ISO timestamp anchoring the fictional calendar." },
  }),
  d("world", "epoch_day", 1, {
    coerce: atLeast1Int,
    ui: { section: "generation-world", label: "Epoch day", description: "In-universe day number at the epoch.", min: 1, step: 1 },
  }),
  d("world", "epoch_date", "2000-01-01", {
    ui: { section: "generation-world", label: "Epoch date", description: "Displayed fictional date at the epoch." },
  }),
  d("world", "calendar_name", "Halu Era", {
    ui: { section: "generation-world", label: "Calendar name", description: "Display name for the fictional calendar." },
  }),

  // -- agents --
  d("agent", "enabled", true, {
    ui: { section: "agents", label: "Enable agents", description: "Enable the article chat and research workflow." },
  }),
  d("agent", "chat_role", "heavy", {
    coerce: (value) => (value === "light" ? "light" : "heavy"),
    ui: { section: "agents", label: "Chat role", description: "Model role used by the chat orchestrator.", kind: "select", options: ["heavy", "light"] },
  }),
  d("agent", "research_role", "light", {
    coerce: (value) => (value === "heavy" ? "heavy" : "light"),
    ui: { section: "agents", label: "Research role", description: "Model role used by the research subagent.", kind: "select", options: ["heavy", "light"] },
  }),
  d("agent", "chat_recursion_limit", 4, {
    ui: { section: "agents", label: "Chat recursion", description: "Maximum chat-orchestrator loop iterations.", min: 1, step: 1 },
  }),
  d("agent", "research_recursion_limit", 8, {
    ui: { section: "agents", label: "Research recursion", description: "Maximum research-subagent loop iterations.", min: 1, step: 1 },
  }),
  d("agent", "search_default_limit", 10, {
    ui: { section: "agents", label: "Default search limit", description: "Default article count returned to research tools.", min: 1, step: 1 },
  }),
  d("agent", "search_max_limit", 25, {
    ui: { section: "agents", label: "Maximum search limit", description: "Hard ceiling for tool-requested search results.", min: 1, step: 1 },
  }),
  d("agent", "search_ontology_facts_per_result", 20, {
    ui: { section: "agents", label: "Facts per search result", description: "Ontology facts inlined with each search result — a count cap, not a score filter; each fact keeps its own relevance score.", min: 0, step: 1 },
  }),
  d("agent", "search_ontology_quota", 5, {
    ui: { section: "agents", label: "Ontology quota", description: "Reserved ontology-fact slots in reference search.", min: 0, step: 1 },
  }),
  d("agent", "search_ontology_facts_per_article", 20, {
    ui: { section: "agents", label: "Facts fetched per article (search)", description: "Reference-search-only override of the canonical per-article ontology-fact retrieval cap, so chat's fact density can be raised without affecting article generation.", min: 0, step: 1 },
  }),
  d("agent", "ontology_facts_max", 50, {
    ui: { section: "agents", label: "Ontology fact maximum", description: "Hard cap for a single ontology-fact tool call — a count cap, not a score filter; each fact keeps its own confidence score.", min: 0, step: 1 },
  }),

  // -- ontology-review --
  d("ontology_review", "enabled", true, {
    ui: { section: "ontology-review", label: "Enable auto-review", description: "Run the scheduled ontology-suggestion review pipeline." },
  }),
  d("ontology_review", "enqueue_interval_minutes", 15, {
    coerce: atLeast1,
    ui: { section: "ontology-review", label: "Enqueue interval", description: "Minutes between review-queue top-ups, when the queue is empty.", min: 1, step: 1 },
  }),
  d("ontology_review", "enqueue_batch", 10, {
    coerce: atLeast1Int,
    ui: { section: "ontology-review", label: "Enqueue batch", description: "Articles added per top-up.", min: 1, step: 1 },
  }),
  d("ontology_review", "run_interval_minutes", 5, {
    coerce: atLeast1,
    ui: { section: "ontology-review", label: "Run interval", description: "Minutes between each reviewed article.", min: 1, step: 1 },
  }),
  d("ontology_review", "key_max_words", 6, {
    coerce: atLeast1Int,
    ui: { section: "ontology-review", label: "Max label words", description: "Relation labels longer than this many words auto-fail.", min: 1, step: 1 },
  }),
  d("ontology_review", "extract_enqueue_interval_minutes", 15, {
    coerce: atLeast1,
    ui: { section: "ontology-review", label: "Extraction enqueue interval", description: "Minutes between extraction-catch-up queue top-ups, when the queue is empty.", min: 1, step: 1 },
  }),
  d("ontology_review", "extract_enqueue_batch", 10, {
    coerce: atLeast1Int,
    ui: { section: "ontology-review", label: "Extraction enqueue batch", description: "Articles added per extraction top-up.", min: 1, step: 1 },
  }),
  d("ontology_review", "extract_run_interval_minutes", 5, {
    coerce: atLeast1,
    ui: { section: "ontology-review", label: "Extraction run interval", description: "Minutes between each extracted article.", min: 1, step: 1 },
  }),

  // -- observability-media --
  d("pipeline.trace", "enabled", true, {
    ui: { section: "observability-media", label: "Enable tracing", description: "Record structural pipeline traces." },
  }),
  d("pipeline.trace", "database_path", "data/halupedia-traces.sqlite", {
    ui: { section: "observability-media", label: "Trace database", description: "Separate SQLite file for pipeline traces.", restartRequired: true },
  }),
  d("pipeline.trace", "level", "normal", {
    ui: { section: "observability-media", label: "Trace detail", description: "Amount of node data recorded per workflow.", kind: "select", options: ["off", "quiet", "normal", "debug", "trace"] },
  }),
  d("pipeline.trace", "retention_days", 14, {
    ui: { section: "observability-media", label: "Trace retention", description: "Days to retain traces; zero disables pruning.", min: 0, step: 1 },
  }),
  d("images", "model_max_edge", 256, {
    ui: { section: "observability-media", label: "Model image edge", description: "Maximum thumbnail edge sent to vision models.", min: 1, step: 1 },
  }),
  d("images", "jpeg_quality", 70, {
    ui: { section: "observability-media", label: "JPEG quality", description: "Thumbnail JPEG quality.", min: 1, max: 100, step: 1 },
  }),
  d("images", "max_bytes", 15 * 1024 * 1024, {
    ui: { section: "observability-media", label: "Maximum image bytes", description: "Maximum accepted image upload or fetch size.", min: 1, step: 1024 },
  }),
  d("images", "fetch_timeout_ms", 10_000, {
    ui: { section: "observability-media", label: "Fetch timeout", description: "Remote image fetch timeout in milliseconds.", min: 1, step: 100 },
  }),
  d("images", "media_database_path", "data/halupedia-media.sqlite", {
    ui: { section: "observability-media", label: "Media database", description: "SQLite file containing media metadata and bytes.", restartRequired: true },
  }),
  d("images", "allow_private_hosts", false, {
    ui: { section: "observability-media", label: "Allow private image hosts", description: "Permit image fetches from private network addresses." },
  }),

  // -- test-runtime --
  d("tests", "database_path", "halupedia.sqlite", {
    ui: { section: "test-runtime", label: "Test database", description: "SQLite database used by tests." },
  }),
  d("tests", "llm_base_url", "http://127.0.0.1:11434/v1", {
    ui: { section: "test-runtime", label: "Test LLM URL", description: "OpenAI-compatible endpoint used by tests." },
  }),
  d("tests", "llm_api_key", "ollama", {
    ui: { section: "test-runtime", label: "Test LLM API key", description: "Credential used by the test endpoint.", kind: "secret" },
  }),
  d("tests", "llm_model", "gemma4", {
    ui: { section: "test-runtime", label: "Test LLM model", description: "Model name used by tests." },
  }),
];

function getPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (acc, segment) => (acc as Record<string, unknown> | undefined)?.[segment],
    source,
  );
}

/** Resolves every descriptor under `table` against a raw (possibly partial)
 *  app-config tree, applying defaults and coercion. Used to build each
 *  `AppConfig` sub-object from a single declarative list. */
export function resolveConfigTable<T>(app: unknown, table: string): T {
  const source = getPath(app, table) as Record<string, unknown> | undefined;
  const result: Record<string, unknown> = {};
  for (const descriptor of CONFIG_DESCRIPTORS) {
    if (descriptor.table !== table) continue;
    const raw = source?.[descriptor.key];
    const value = raw === undefined ? descriptor.default : raw;
    result[descriptor.key] = descriptor.coerce ? descriptor.coerce(value) : value;
  }
  return result as unknown as T;
}

function inferKind(defaultValue: unknown): ConfigFieldKind {
  if (typeof defaultValue === "boolean") return "boolean";
  if (typeof defaultValue === "number") return "number";
  return "string";
}

export function configFieldKind(descriptor: ConfigDescriptor): ConfigFieldKind {
  return descriptor.ui?.kind ?? inferKind(descriptor.default);
}
