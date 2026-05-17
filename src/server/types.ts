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

export type RagMode = "summary" | "full";

export interface RagConfig {
  enabled: boolean;
  mode: RagMode;
  max_results: number;
  chunk_size: number;
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
}

/**
 * The kind of underlying data backing a reference entry.
 * - "summary": pulled from an article's summary_markdown (database-cached)
 * - "chunk":   pulled from article_chunks via RAG
 *
 * Not shown to the user; used for internal ranking, debugging, and ensuring
 * we never round-trip reference content through an LLM.
 */
export type ReferenceKind = "summary" | "chunk";

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
}

/** Type alias to make pipeline intent obvious at call sites. */
export type ReferenceList = ReferenceListEntry[];

export interface HomepageConfig {
  rotation_hours: number;
}

export interface RandomPageConfig {
  inspiration_count: number;
}

export interface TestConfig {
  database_path: string;
  llm_base_url: string;
  llm_api_key: string;
  llm_model: string;
}

export interface AppConfig {
  server: ServerConfig;
  storage: StorageConfig;
  search: SearchConfig;
  rag: RagConfig;
  homepage: HomepageConfig;
  random_page: RandomPageConfig;
  tests: TestConfig;
}

export interface ChatConfig {
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
  max_tokens: number;
}

export interface EmbeddingsConfig {
  enabled: boolean;
  base_url: string;
  api_key: string;
  model: string;
}

export interface LlmConfig {
  chat: ChatConfig;
  light: ChatConfig;
  embeddings: EmbeddingsConfig;
}

export interface PromptTemplate {
  system: string;
  user: string;
  model?: "heavy" | "light";
  thinking?: boolean;
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
  title: string;
  hint: string;
}

export interface LinkSuggestion {
  title: string;
  hint: string;
}

export interface LinkSelectionSuggestion {
  selected_text: string;
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

export interface HomepagePayload {
  featured: {
    slug: string;
    title: string;
    summaryMarkdown: string;
  } | null;
  didYouKnow: HomepageFact[];
  generatedAt: number;
  expiresAt: number;
}

export interface ArticleSection {
  id: string;
  title: string;
}
