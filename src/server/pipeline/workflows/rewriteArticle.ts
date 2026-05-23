/**
 * Article rewrite workflow.
 *
 * Supports full, section, and selection rewrites. Context retrieval branches
 * based on whether the caller provides explicit slugs, enables RAG, or lets
 * the pipeline use automatic backlink context.
 *
 * Protected articles: the LLM call is skipped; the existing body passes
 * through unchanged so post-processing still runs.
 */

import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import type { PipelineState } from "../state";
import {
  extractArticleBodyNode,
  readRecentEditHistoryNode,
  sanitizeBodyNode,
  cleanLinkLabelsNode,
  deriveIdentityNode,
  resolveLinksNode,
  persistArticleNode,
} from "../nodes/articleGeneration";
import {
  readArticleForRewriteNode,
  retrieveContextForRewriteNode,
  buildRewriteReferenceListNode,
  renderRewritePromptNode,
  callRewriteModelNode,
  spliceRewriteResultNode,
} from "../nodes/rewrite";
import {
  readProtectionNode,
  spliceProtectedSectionsNode,
} from "../nodes/refresh";
import { validateBodyNode } from "../nodes/articleGeneration";

const skipIfProtected = (state: PipelineState) => state.isProtected !== true;

export const rewriteArticleWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "article.rewrite",
  description: "Rewrite article (full/section/selection) with optional RAG context.",
  edges: [
    { node: readArticleForRewriteNode },
    { node: retrieveContextForRewriteNode },
    { node: buildRewriteReferenceListNode },
    { node: readRecentEditHistoryNode },
    { node: renderRewritePromptNode,  when: skipIfProtected },
    { node: callRewriteModelNode,     when: skipIfProtected },
    { node: extractArticleBodyNode,   when: skipIfProtected },
    { node: spliceRewriteResultNode },
    { node: sanitizeBodyNode },
    { node: cleanLinkLabelsNode },
    { node: spliceProtectedSectionsNode },
    { node: deriveIdentityNode },
    { node: resolveLinksNode },
    { node: validateBodyNode },
    { node: persistArticleNode },
  ],
};
