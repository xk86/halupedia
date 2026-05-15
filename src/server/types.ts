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
  chunk_size: number;
}

export interface AppConfig {
  server: ServerConfig;
  storage: StorageConfig;
  search: SearchConfig;
  rag: RagConfig;
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
  embeddings: EmbeddingsConfig;
}

export interface PromptTemplate {
  system: string;
  user: string;
}

export interface PromptConfig {
  prompts: Record<string, PromptTemplate>;
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
  markdown: string;
  html: string;
  plain_text: string;
  generated_at: number;
}

export interface PagePayload {
  cached: boolean;
  redirectedFrom?: string;
  canonicalPath?: string;
  article: ArticleRecord;
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
  createdAt: number;
}
