import type { DatabaseSync } from "node:sqlite";
import type { RagRuntime } from "../../rag";

/** An article a retrieval tool actually touched during a research pass. These
 *  are collected deterministically (straight from the tool's own DB results,
 *  never from an LLM re-listing them) so the chat's "Sources" are exactly what
 *  the agent pulled into context — with real slugs/titles for correct linking. */
export interface SeenArticle {
  slug: string;
  title: string;
  /** How the article surfaced. `read` is the strongest signal (its content was
   *  pulled into context); the rest are candidates the agent merely found. */
  via: "read" | "search" | "title" | "facts";
  /** Relevance score when the tool ranked it (search only). */
  score?: number;
  /** A one-line summary/why-relevant, when the tool has one. */
  relevance?: string;
}

/** Config knobs for the search/ontology tools, sourced from `AgentConfig`
 *  (see `config/app.toml`'s `[agent]` section). Optional on `AgentToolContext`
 *  — each tool falls back to the same numbers as its own module defaults when
 *  omitted, so existing callers/tests that don't care about these knobs are
 *  unaffected. */
export interface AgentToolConfig {
  searchDefaultLimit?: number;
  searchMaxLimit?: number;
  searchOntologyFactsPerResult?: number;
  ontologyFactsMax?: number;
}

/** Shared read-only handles the retrieval/ranking tools wrap. Deliberately
 *  narrow — the chatbot flow never gets a write-capable tool. */
export interface AgentToolContext {
  db: DatabaseSync;
  rag: RagRuntime;
  /** Fired at the start of every tool call — lets the chat route surface
   *  "searching…" / "reading…" progress events without the tools knowing
   *  anything about streaming or NDJSON. */
  onToolCall?: (tool: string, args: Record<string, unknown>) => void;
  /** Fired for each article a tool surfaces, so references can be built
   *  deterministically from what the agent actually retrieved. */
  onArticleSeen?: (article: SeenArticle) => void;
  toolConfig?: AgentToolConfig;
}
