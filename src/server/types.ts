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
}

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
