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
}
