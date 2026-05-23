/**
 * Deterministic article save workflows.
 *
 * These paths do not ask a model for article prose. They still run through the
 * same normalization, reference resolution, validation, persistence, and trace
 * machinery as generated articles.
 */

import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import {
  readArticleNode,
  useRawMarkdownInputNode,
  buildReferenceListNode,
  sanitizeBodyNode,
  cleanLinkLabelsNode,
  deriveIdentityNode,
  resolveLinksNode,
  validateBodyNode,
  persistArticleNode,
} from "../nodes/articleGeneration";

const edges = [
  { node: readArticleNode },
  { node: useRawMarkdownInputNode },
  { node: buildReferenceListNode },
  { node: sanitizeBodyNode },
  { node: cleanLinkLabelsNode },
  { node: deriveIdentityNode },
  { node: resolveLinksNode },
  { node: validateBodyNode },
  { node: persistArticleNode },
];

export const rawSaveArticleWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "article.raw_save",
  description: "Save caller-provided markdown without LLM prose generation.",
  edges,
};

export const addLinkArticleWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "article.add_link",
  description: "Persist deterministic markdown produced by the add-link route.",
  edges,
};
