/**
 * Utility workflows for one-off operations that don't fit the main article flows.
 */

import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import {
  readArticleForSummaryNode,
  generateSummaryNode,
  persistSummaryNode,
} from "../nodes/utilityNodes";

export const regenerateSummaryWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "regenerate.summary",
  description: "Regenerate article summary via LLM.",
  edges: [{ node: readArticleForSummaryNode }, { node: generateSummaryNode }, { node: persistSummaryNode }],
};
