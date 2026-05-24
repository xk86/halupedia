/**
 * Utility workflows for preview, reference finding, and summary regeneration.
 */

import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import {
  normalizeMarkdownNode,
  validateLinksNode,
  renderHtmlNode,
  compileDiagnosticsNode,
  searchFuzzyNode,
  searchRagNode,
  mergeReferenceResultsNode,
  readArticleForSummaryNode,
  generateSummaryNode,
  persistSummaryNode,
} from "../nodes/utilityNodes";

export const previewMarkdownWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "preview.markdown",
  description: "Preview markdown rendering with link validation.",
  edges: [
    { node: normalizeMarkdownNode },
    { node: validateLinksNode },
    { node: renderHtmlNode },
    { node: compileDiagnosticsNode },
  ],
};

export const findReferencesWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "find.references",
  description: "Find articles by fuzzy matching and RAG search.",
  edges: [{ node: searchFuzzyNode }, { node: searchRagNode }, { node: mergeReferenceResultsNode }],
};

export const regenerateSummaryWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "regenerate.summary",
  description: "Regenerate article summary via LLM.",
  edges: [{ node: readArticleForSummaryNode }, { node: generateSummaryNode }, { node: persistSummaryNode }],
};
