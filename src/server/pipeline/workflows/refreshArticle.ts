/**
 * Article refresh workflow.
 *
 * Retrieves fresh context, calls article_refresh to improve body, splices
 * back any protected sections, normalises/saves, then fires post_process.
 *
 * Protected articles: the LLM call is skipped (when predicate on
 * callRefreshModelNode); extractArticleBodyNode falls back to the stored
 * body so the rest of the pipeline still runs clean.
 */

import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import type { PipelineState } from "../state";
import {
  readArticleNode,
  readRecentEditHistoryNode,
  retrieveContextNode,
  buildReferenceListNode,
  extractArticleBodyNode,
  sanitizeBodyNode,
  cleanLinkLabelsNode,
  deriveIdentityNode,
  resolveLinksNode,
  persistArticleNode,
} from "../nodes/articleGeneration";
import {
  readProtectionNode,
  renderRefreshPromptNode,
  callRefreshModelNode,
  useStoredBodyForProtectedRefreshNode,
  spliceProtectedSectionsNode,
} from "../nodes/refresh";

const skipIfProtected = (state: PipelineState) => state.isProtected !== true;
const onlyIfProtected = (state: PipelineState) => state.isProtected === true;

export const refreshArticleWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "article.refresh",
  description: "Refresh article body against retrieved context; splice protected sections.",
  edges: [
    { node: readArticleNode },
    { node: readRecentEditHistoryNode },
    { node: readProtectionNode },
    { node: retrieveContextNode },
    { node: buildReferenceListNode },
    { node: renderRefreshPromptNode, when: skipIfProtected },
    { node: callRefreshModelNode,    when: skipIfProtected },
    { node: extractArticleBodyNode,  when: skipIfProtected },
    { node: useStoredBodyForProtectedRefreshNode, when: onlyIfProtected },
    { node: sanitizeBodyNode },
    { node: cleanLinkLabelsNode },
    { node: spliceProtectedSectionsNode },
    { node: deriveIdentityNode },
    { node: resolveLinksNode },
    { node: persistArticleNode },
  ],
};
