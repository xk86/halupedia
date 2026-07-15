export interface ServerConfig {
  host: string;
  port: number;
}

export interface StorageConfig {
  database_path: string;
}

export interface SearchConfig {
  limit: number;
}

export interface RagConfig {
  enabled: boolean;
  max_results: number;
  min_score: number;
  /**
   * Maximum number of candidate references to keep after ranking.
   * The reference list is built from RAG sources (summaries + chunks);
   * this trims the long tail. Pinned references do NOT count toward this cap.
   */
  reference_max_results: number;
  /**
   * Minimum relevancy score for a reference candidate to survive pruning.
   * Independent of `min_score` so reference selectivity can be tuned without
   * affecting the general RAG pipeline.
   */
  reference_min_score: number;
  /**
   * Hard ceiling on total references attached to an article. Pinned entries
   * always survive regardless of this cap. Default 50.
   */
  max_references: number;
  /**
   * Minimum relevancy score for a reference to have its content included in
   * the prompt JSON. Below this threshold the ref still appears in the list
   * (so the LLM can link to it) but its content field is omitted, keeping
   * the prompt size manageable. Pinned references always include content.
   * Set to 0 to include content for all refs; set to 1 to include none.
   */
  prompt_ref_content_min_score: number;
  /**
   * Maximum number of refs that get their content included in the prompt JSON,
   * selected from the highest-scoring eligible refs after the min_score filter.
   * Pinned refs are always included and do not count against this cap.
   * Set to 0 to disable the cap.
   */
  prompt_ref_content_top_k: number;
  /** How far to traverse persisted reference sidecars from candidate refs. */
  reference_recursive_depth: number;
  /**
   * Traversal fan-out safety limit: maximum sidecar refs pulled from a single
   * traversed article per depth step. This bounds how fast the frontier can
   * grow — it is NOT the total number of recursively-discovered articles
   * admitted to the final reference list (see `reference_recursive_article_limit`
   * for that).
   */
  reference_recursive_max_per_article: number;
  /**
   * Hard cap on the total number of recursively-discovered articles admitted
   * to the reference list, applied after ranking all recursive candidates by
   * score (descending, stable slug tie-break) and independent of
   * `reference_cull_top_k` (which also covers fresh RAG hits and reranked
   * priors). Distinct from `reference_recursive_max_per_article`, which only
   * bounds per-parent fan-out during traversal.
   */
  reference_recursive_article_limit: number;
  /**
   * Global cull applied after full assembly (RAG + recursive + prior-save).
   * Only entries with a finite rankScore are eligible (rag, inherited, floor,
   * prior). Pinned, user-added, and body-linked refs are always exempt.
   *
   * reference_cull_min_score: drop cull-eligible refs below this relevancy.
   * reference_cull_top_k: after the score floor, keep only the top-K by score.
   *   Set to 0 to disable the top-K cut (score floor still applies).
   */
  reference_cull_min_score: number;
  reference_cull_top_k: number;
  /** Maximum incoming link hints included in generation/rewrite prompts. */
  prompt_link_hints_max: number;
  /**
   * Hard character budget for the retrieved-context block of a prompt.
   * Entries past the budget are dropped whole (never mid-entry).
   */
  prompt_context_max_chars: number;
  /**
   * Refresh-specific context caps. Refresh improves an existing article rather
   * than writing a new one, so it gets a much tighter budget than generation —
   * otherwise a wall of low-relevance corpus chunks can drown a short article
   * and the model rewrites it into a summary of the context. See
   * config/prompts/article_refresh.toml for the matching prompt framing.
   */
  refresh_context_max_chars: number;
  /** Max sources given a full content block in refresh's retrieved-context. */
  refresh_context_max_articles: number;
  /** Max "suggested related topics" listed in refresh prompts. */
  refresh_related_titles_max: number;
  /**
   * When true, the ontology indexer runs a light-model extraction pass over the
   * article prose (in addition to deterministic infobox extraction) to propose
   * on-vocabulary entities and typed relations. Runs in the background reindex
   * drainer and is cached by article content + vocabulary hash, so the model is
   * only called when the article or the vocabulary changes.
   */
  ontology_llm_extraction: boolean;
  /**
   * Canonical per-article cap on ontology facts admitted into retrieval
   * evidence: at most this many ranked ontology facts survive for any single
   * article's contribution to a retrieval result, so one fact-dense article
   * can't crowd another's facts out of a shared result set. Applies across
   * every retrieval profile, unlike the `[agent]` ontology limits, which are
   * presentation caps specific to the chat research tools.
   */
  ontology_facts_per_retrieved_article: number;
}

/**
 * The kind of underlying data backing a reference entry.
 * - "summary": pulled from an article's summary_markdown (database-cached)
 * - "chunk":   pulled from the RAG store via retrieval
 *
 * Not shown to the user; used for internal ranking, debugging, and ensuring
 * we never round-trip reference content through an LLM.
 */
export type ReferenceKind = "summary" | "chunk";

/**
 * Where an in-memory reference candidate came from.
 *
 * This is intentionally debug/provenance metadata. The durable invariant is
 * still the validated slug in the sidecar reference list.
 */
export type ReferenceSource =
  | "body"
  | "user"
  | "prior"
  | "rag"
  | "recursive"
  /**
   * Recursively discovered via a backlink edge (an already-admitted article
   * references THIS candidate's parent), as opposed to "recursive", which is
   * discovered via the parent's own forward sidecar reference list. Ranked,
   * capped, and culled identically to "recursive" — this tag exists purely so
   * logs/debug tooling can explain which graph direction surfaced a candidate.
   */
  | "backlink"
  | "pinned";

/**
 * Sentinel revision identifiers used in-memory only. These MUST NEVER be
 * persisted to the database. Positive integers refer to actual rows in
 * `article_revisions`.
 *
 * - "initial":       attached when the article was first created
 * - "current":       attached during the in-progress generation/edit (no rev id yet)
 * - "pinned-by-user": user explicitly pinned via the editor UI
 */
export type ReferenceRevisionId =
  | number
  | "initial"
  | "current"
  | "pinned-by-user";

/**
 * Sole canonical representation of an article reference.
 *
 * The reference list is a pure-data structure constructed algorithmically
 * from RAG retrieval, user pins, and previously-saved references. It is
 * NEVER produced or modified by an LLM. The rendered "References" section
 * in an article is just `entries.map(e => markdown-link(e.slug, e.title))`.
 *
 * Because every link is built from a validated slug, references are exempt
 * from the link-repair pass and must never be fed back through a language
 * model — they are metadata, not article body.
 */
export interface ReferenceListEntry {
  /** Canonical article slug; doubles as the entry's primary id. */
  slug: string;
  /** Human-readable title used to render the link label. */
  title: string;
  /** The actual reference text (summary or chunk). Used for RAG context. */
  content: string;
  /** What kind of source produced this entry (internal only). */
  kind: ReferenceKind;
  /** True when the user explicitly pinned this reference in the editor. */
  pinned: boolean;
  /** Revision the reference was first attached on. Sentinels never hit the DB. */
  revisionId: ReferenceRevisionId;
  /** Ranking score (debug only). */
  score?: number;
  /** Candidate provenance (debug/UI only; older persisted rows may omit it). */
  source?: ReferenceSource;
  /**
   * Whether the article body actually links to this reference via ref:slug.
   * Derived at load time by scanning the body — never persisted separately.
   * Unlinked refs (provided to the LLM but not cited) are shown greyed/in
   * parentheses in the References section rather than as numbered footnotes.
   */
  linked?: boolean;
}

/** Type alias to make pipeline intent obvious at call sites. */
export type ReferenceList = ReferenceListEntry[];

export interface HomepageConfig {
  rotation_hours: number;
}

export interface WorldConfig {
  epoch_real_time: string;
  epoch_day: number;
  epoch_date: string;
  calendar_name: string;
}

export interface RandomPageConfig {
  inspiration_count: number;
}

export interface GenerationConfig {
  /** Max full article-generation workflows allowed to run at once. Extra cache
   *  misses wait in the app queue so trace duration measures generation work,
   *  not time spent waiting for another article to finish. */
  max_in_flight: number;
}

export interface TestConfig {
  database_path: string;
  llm_base_url: string;
  llm_api_key: string;
  llm_model: string;
}

export type PipelineTraceLevel = "off" | "quiet" | "normal" | "debug" | "trace";

export interface PipelineTraceConfig {
  /**
   * Master switch for structural pipeline tracing. When false, the runtime
   * skips all trace recording entirely — no DB opened, no overhead.
   */
  enabled: boolean;
  /**
   * SQLite path for pipeline traces. Intentionally a SEPARATE database from
   * the article DB so trace churn never contends with article reads and so
   * traces can be archived/pruned/wiped independently.
   */
  database_path: string;
  /**
   * Verbosity of recorded trace data:
   *   - off:    do not record anything (equivalent to enabled=false)
   *   - quiet:  one row per run + node name/timing only
   *   - normal: + warnings, finish reasons, hashes, validation results
   *   - debug:  + full state diffs (added/removed/changed keys)
   *   - trace:  + full inputs/outputs as captured by each node
   */
  level: PipelineTraceLevel;
  /**
   * Days to keep a trace before pruning. 0 disables pruning.
   */
  retention_days: number;
}

export interface PipelineConfig {
  trace: PipelineTraceConfig;
}

/** Config for the LangGraph-based chat/research agents (`src/server/agent/`). */
export interface AgentConfig {
  enabled: boolean;
  /** LLM role the chat orchestrator uses for its control turns and final answer. */
  chat_role: "heavy" | "light";
  /** LLM role the research subagent uses for its retrieve/rank/read loop. */
  research_role: "heavy" | "light";
  /** Hard cap on chat-orchestrator loop iterations (it mostly delegates). */
  chat_recursion_limit: number;
  /** Hard cap on research-subagent loop iterations. */
  research_recursion_limit: number;
  /** Default number of results `search_articles` returns when the caller
   *  doesn't specify `limit`. */
  search_default_limit: number;
  /** Hard ceiling on `search_articles`' `limit` argument, regardless of what
   *  the caller (or a hallucinating model) asks for. */
  search_max_limit: number;
  /** Ontology facts inlined per article in `search_articles`' results — a
   *  quick digest alongside prose, distinct from `get_ontology_facts`' full
   *  per-entity list. */
  search_ontology_facts_per_result: number;
  /** Reserved slots for ontology_fact evidence in the `reference_search` RAG
   *  profile (used by `search_articles`), so structured world data can't get
   *  crowded out of a busy result set by prose hits that scored marginally
   *  higher. See `ontologyQuota` / `DEFAULT_PROFILES` in `rag/retriever.ts`. */
  search_ontology_quota: number;
  /** Hard cap on fact triples returned by a single `get_ontology_facts` call
   *  (the deep-dive tool for one entity's complete fact list). */
  ontology_facts_max: number;
}

export interface ImagesConfig {
  model_max_edge: number;
  jpeg_quality: number;
  max_bytes: number;
  fetch_timeout_ms: number;
  media_database_path: string;
  allow_private_hosts: boolean;
  generation: ImageGenerationConfig;
}

export type ImageGenerationBackend = "openai" | "ollama";

export interface ImageGenerationConfig {
  enabled: boolean;
  auto_generate_for_new_articles: boolean;
  auto_generate_for_featured_article: boolean;
  homepage_auto_image_max_attempts: number;
  auto_preset_multipass: boolean;
  backend: ImageGenerationBackend;
  aspect_ratios: Record<string, ImageAspectRatioConfig>;
  openai: OpenAIImageGenerationConfig;
  ollama: OllamaImageGenerationConfig;
}

export interface ImageAspectRatioConfig {
  label: string;
  size: string;
  selection_when?: string;
}

export interface OpenAIImageGenerationConfig {
  base_url: string;
  api_key: string;
  model: string;
  size: string;
  quality: string;
  output_format: string;
  output_compression: number;
  timeout_ms: number;
}

export interface OllamaImageGenerationConfig {
  base_url: string;
  model: string;
  width: number;
  height: number;
  steps: number;
  timeout_ms: number;
}

/** Config for the scheduled ontology-suggestion auto-review pipeline and its
 *  extraction-catch-up dependency (`src/server/pipeline/scheduler.ts`). */
export interface OntologyReviewConfig {
  /** Master switch; all four schedules no-op when false. */
  enabled: boolean;
  /** How often the enqueue schedule tops up the review queue. */
  enqueue_interval_minutes: number;
  /** Articles added per enqueue pass, when the queue is empty. */
  enqueue_batch: number;
  /** How often the run schedule claims and reviews one queued article. */
  run_interval_minutes: number;
  /** Relation labels longer than this many words auto-fail. */
  key_max_words: number;
  /** How often the enqueue schedule tops up the extraction catch-up queue. */
  extract_enqueue_interval_minutes: number;
  /** Articles added per extraction enqueue pass, when the queue is empty. */
  extract_enqueue_batch: number;
  /** How often the run schedule claims and extracts one queued article. */
  extract_run_interval_minutes: number;
}

export interface AppConfig {
  server: ServerConfig;
  storage: StorageConfig;
  search: SearchConfig;
  rag: RagConfig;
  homepage: HomepageConfig;
  world: WorldConfig;
  random_page: RandomPageConfig;
  generation: GenerationConfig;
  tests: TestConfig;
  pipeline: PipelineConfig;
  images: ImagesConfig;
  agent: AgentConfig;
  ontology_review: OntologyReviewConfig;
}

/** A named LLM backend. Hosts own the connection, the queue depth, and the
 *  fallback ordering; roles reference hosts by id. */
export interface HostConfig {
  id: string;
  base_url: string;
  api_key: string;
  /** Max concurrent requests in flight against this host at once. Requests beyond
   *  this wait in our own queue (no socket, no timeout clock) instead of piling
   *  into the backend's queue. The queue is keyed by host, so every role sharing
   *  the host shares one bound. */
  max_in_flight: number;
  /** Fallback preference — lower is more preferred. When a role's preferred hosts
   *  are saturated, a waiting request spills onto the next eligible host ordered
   *  by this value. */
  pref: number;
  /** Models we refuse to run on this host. Excluded when the capability map is
   *  built at startup probe, so the host never appears as a candidate for them. */
  blacklist: string[];
}

export interface ChatConfig {
  /** Ordered preferred host ids for this role (most preferred first). The
   *  scheduler falls back to any other host whose probed model set includes
   *  `model`, ordered by host `pref`. */
  hosts: string[];
  model: string;
  temperature: number;
  max_tokens: number;
  /** Optional native Ollama generation options. Unset values use model defaults. */
  num_ctx?: number;
  repeat_last_n?: number;
  repeat_penalty?: number;
  seed?: number;
  draft_num_predict?: number;
  /** Optional sampler params. Sent top-level (like Ollama's `think`/`format`
   *  extensions) only when set, so an unset value leaves the backend default
   *  untouched. */
  top_k?: number;
  top_p?: number;
  min_p?: number;
  /** Abort a non-streaming chat after this long; for streaming, abort when no
   *  token arrives for this long (idle timeout). Guards against the endpoint
   *  hanging on undici's 5-minute default. */
  request_timeout_ms: number;
  /** Resolved primary-host endpoint (first preferred host). For trace/metadata
   *  display and legacy callers; the scheduler is authoritative for the host a
   *  given call actually runs on. */
  base_url: string;
  api_key: string;
}

export interface EmbeddingsConfig {
  enabled: boolean;
  /** Ordered preferred host ids. See {@link ChatConfig.hosts}. */
  hosts: string[];
  model: string;
  /** Abort an embeddings request after this long. */
  request_timeout_ms: number;
  /** Resolved primary-host endpoint. See {@link ChatConfig.base_url}. */
  base_url: string;
  api_key: string;
}

export interface LlmInvocationMetadata {
  requestedRole: "heavy" | "light" | "images";
  resolvedRole: "heavy" | "light" | "images";
  configKey: "llm.chat" | "llm.light" | "llm.images";
  model: string;
  baseUrl: string;
  host: string;
  temperature: number;
  maxTokens: number;
  numCtx?: number;
  topK?: number;
  topP?: number;
  minP?: number;
}

export interface LlmConfig {
  /** Named backends keyed by id, referenced by roles via their `hosts` lists. */
  hosts: Record<string, HostConfig>;
  chat: ChatConfig;
  light: ChatConfig;
  /** Dedicated vision model for image captioning. Falls back to light if unset. */
  images?: ChatConfig;
  embeddings: EmbeddingsConfig;
}

export interface PromptTemplate {
  system: string;
  user: string;
  model?: "heavy" | "light";
  thinking?: boolean;
  /** Request JSON-mode output from the LLM for this prompt. */
  json?: boolean;
}

export interface RewriteMode {
  label: string;
  prompt: string;
}

export interface PromptConfig {
  prompts: Record<string, PromptTemplate>;
  shared: Record<string, PromptTemplate>;
  rewriteModes: Record<string, RewriteMode>;
}

export interface SeeAlsoCandidate {
  slug: string;
  hint: string;
}

export interface LinkSuggestion {
  description: string;
  slug: string;
}

export interface ArticleRecord {
  slug: string;
  canonicalSlug: string;
  title: string;
  displayTitle?: string;
  markdown: string;
  html: string;
  summaryMarkdown?: string;
  plain_text: string;
  generated_at: number;
  isDisambiguation?: boolean;
}

export interface DisambiguationEntry {
  title: string;
  description: string;
}

export interface PagePayload {
  cached: boolean;
  redirectedFrom?: string;
  canonicalPath?: string;
  article: ArticleRecord;
  sections?: ArticleSection[];
  backlinks: {
    existing: BacklinkItem[];
    unwritten: BacklinkItem[];
  };
  referenceStatus?: {
    missing: Array<{ slug: string; title: string }>;
    unformatted: Array<{ slug: string; title: string }>;
    hasReferencesSection: boolean;
  };
}

export interface ParsedInternalLink {
  targetSlug: string;
  visibleLabel: string;
  hiddenHint: string;
}

export interface BacklinkItem {
  slug: string;
  title: string;
  visibleLabel: string;
  hiddenHint: string;
  summaryMarkdown?: string;
  createdAt: number;
}

export interface ArticleRevision {
  id: number;
  articleSlug: string;
  title: string;
  markdown: string;
  html: string;
  summaryMarkdown: string;
  plain_text: string;
  headlineMediaId: string | null;
  headlineMediaCaption: string | null;
  generatedAt: number;
  createdAt: number;
  operation: string;
  instructions: string;
  revertedFromRevisionId: number | null;
}

export interface HomepageFact {
  slug: string;
  title: string;
  fact: string;
}

export interface HomepageNewsHeadline {
  text: string;
  summary: string;
  slug?: string;
}

export interface HomepageNews {
  slug: string;
  title: string;
  worldDate: string;
  worldDay: number;
  generatorVersion?: string;
  summaryMarkdown: string;
  headlines: HomepageNewsHeadline[];
  imageId?: string;
  imageCaption?: string;
}

export interface HomepagePayload {
  featured: {
    slug: string;
    title: string;
    summaryMarkdown: string;
  } | null;
  todaysNews?: HomepageNews | null;
  didYouKnow: HomepageFact[];
  generatedAt: number;
  expiresAt: number;
}

export interface ArticleSection {
  id: string;
  title: string;
}
