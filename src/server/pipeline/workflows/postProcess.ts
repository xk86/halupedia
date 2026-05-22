/**
 * Post-process workflow — runs asynchronously after any article write.
 *
 * Sequence:
 *   reload → repair links → rebuild refs → re-resolve links
 *   → see-also (LLM) → summary (LLM) → update in place → index RAG
 *
 * The staleness guard in `write.update_article_in_place` ensures a
 * concurrent edit that happened between the triggering save and this
 * workflow completing will cause this pass to abort without overwriting.
 */

import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import {
  reloadSavedArticleNode,
  repairLinksNode,
  rebuildReferenceListNode,
  resolveLinksPostProcessNode,
  generateSeeAlsoNode,
  regenerateSummaryNode,
  updateArticleInPlaceNode,
  indexRagChunksNode,
} from "../nodes/postProcess";

export const postProcessWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "article.post_process",
  description:
    "Async enrichment after any article save: link repair, see-also, summary, RAG index.",
  edges: [
    { node: reloadSavedArticleNode },
    { node: repairLinksNode },
    { node: rebuildReferenceListNode },
    { node: resolveLinksPostProcessNode },
    { node: generateSeeAlsoNode },
    { node: regenerateSummaryNode },
    { node: updateArticleInPlaceNode },
    { node: indexRagChunksNode },
  ],
};
