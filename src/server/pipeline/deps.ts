/**
 * Typed dependency bags for pipeline nodes.
 *
 * Every node receives a `deps` object whose shape is *narrowly* declared by
 * the node itself — a node that only needs the light LLM cannot accidentally
 * reach for the heavy one. Workflows aggregate these per-node deps into a
 * single bag that the runtime passes to each node.
 *
 * Why type them here instead of inside the node files?
 *
 *   - Keeps node modules free of imports they don't actually use.
 *   - Centralizes the small number of system handles so we don't grow a
 *     parallel DI container.
 *   - Makes the test harness's job trivial: pass a `WorkflowDeps` with
 *     mocked entries for the keys the workflow under test exercises.
 */

import type { DatabaseSync } from "node:sqlite";
import type { LlmRouter } from "../llm";
import type { Logger } from "../logger";
import type { loadConfig } from "../config";
import type { PromptRegistry } from "./prompts/registry";

export interface PipelineDeps {
  db: DatabaseSync;
  /** Media database (separate SQLite for image blobs). Optional so test
   *  harnesses that don't exercise image paths can omit it. */
  mediaDb?: DatabaseSync;
  llm: LlmRouter;
  prompts: PromptRegistry;
  logger: Logger;
  runtime: ReturnType<typeof loadConfig>;
  /**
   * Optional streaming progress callback. When set, LLM call nodes use
   * `streamChat` instead of `chat` and fire this on each partial body
   * (rendered HTML + raw markdown), enabling live preview on the client.
   */
  onProgress?: (html: string, markdown: string) => void;
  /**
   * Optional live chain-of-thought callback. When set, LLM call nodes forward
   * the model's reasoning/thinking text as it streams in (delta + accumulated).
   * Used to surface live CoT in the admin generation queue; never used by
   * article rendering.
   */
  onReasoningDelta?: (delta: string, accumulated: string) => void;
  /**
   * Optional sidecar push callback. Called by post-process write nodes when
   * they update sidecar data (infobox, caption, summary, see-also) so any
   * client subscribed to the article's /api/article/:slug/live stream receives
   * the update immediately without polling.
   */
  onSidecarUpdate?: (slug: string, event: SidecarUpdateEvent) => void;
  /**
   * Optional bridge for the article.image_generate workflow. Kept as a
   * dependency hook so the node reuses the server's media ingest, caption,
   * sidecar, and provider configuration logic instead of duplicating it.
   */
  generateArticleImageAttachment?: (
    slug: string,
    replace?: boolean,
    presetKey?: string,
  ) => Promise<{
    mediaId: string;
    isNew: boolean;
    width: number;
    height: number;
    backend: string;
    model: string;
    presetKey?: string;
    revisedPrompt?: string;
  }>;
}

export type SidecarUpdateEvent =
  | { type: "infobox"; infobox: unknown }
  | { type: "caption"; caption: string; mediaId: string }
  | { type: "article"; article: unknown }
  /** Fired during LLM streaming in post-process nodes; partial may be undefined for JSON nodes. */
  | { type: "generating"; node: string; partial?: string };
