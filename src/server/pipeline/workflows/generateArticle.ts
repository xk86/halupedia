/**
 * Article-generation workflow.
 *
 * The graph is declared as a flat list of edges. Each node is defined in
 * `nodes/articleGeneration.ts`; this file is wiring only — read it to know
 * exactly what happens during a generation, in order. Nothing about a
 * generation runs that isn't listed here.
 *
 * Conventional shape of every workflow:
 *
 *   reads → transforms (incl. prompt render) → llm → transforms → validate → write
 *
 * Anything else is a smell. Adding a new step means adding a node above and
 * an edge below — no helper module owns a hidden side effect.
 */

import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import {
  readArticleNode,
  readRecentEditHistoryNode,
  readHeadlineImageNode,
  retrieveContextNode,
  buildReferenceListNode,
  renderArticlePromptNode,
  callArticleModelNode,
  extractArticleBodyNode,
  sanitizeBodyNode,
  cleanLinkLabelsNode,
  deriveIdentityNode,
  resolveLinksNode,
  generateSummaryNode,
  validateBodyNode,
  persistArticleNode,
} from "../nodes/articleGeneration";

export const generateArticleWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "article.generate",
  description: "Generate a brand-new article from a slug + title.",
  edges: [
    { node: readArticleNode },
    { node: readRecentEditHistoryNode },
    { node: readHeadlineImageNode },
    { node: retrieveContextNode },
    { node: buildReferenceListNode },
    { node: renderArticlePromptNode },
    { node: callArticleModelNode },
    { node: extractArticleBodyNode },
    { node: sanitizeBodyNode },
    { node: cleanLinkLabelsNode },
    { node: deriveIdentityNode },
    { node: resolveLinksNode },
    { node: generateSummaryNode },
    { node: validateBodyNode },
    { node: persistArticleNode },
  ],
};
