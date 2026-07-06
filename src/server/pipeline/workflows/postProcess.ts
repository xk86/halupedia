/**
 * article.post_process workflow — runs asynchronously after any article write.
 *
 * Pipeline stages
 * ───────────────
 * 1. read.reload_saved_article
 *    Re-loads the article from DB so all subsequent nodes see the final
 *    persisted state, not stale in-memory values.
 *
 * 2. write.repair_links
 *    Deterministic link repair: fixes malformed halu: links, normalises
 *    casing, removes self-links. Light model optional assist.
 *
 * 3. write.rebuild_reference_list
 *    Rebuilds the references sidecar from RAG + body scan (algorithmic).
 *
 * 4. write.resolve_links_post_process
 *    Converts halu: links that now point at existing articles to ref: links.
 *
 * 5. llm.regenerate_summary  [light]  ┐ parallel — different model tiers,
 *    Re-generates the summary_markdown. │ disjoint state writes.
 *    llm.generate_infobox  [heavy, JSON]┘
 *    Generates structured infobox data.
 *
 * 6. llm.generate_see_also  [light]
 *    Suggests see-also slugs using the article title + freshly generated summary.
 *
 * 7. (formerly step 7, now step 8) write.persist_infobox
 *    Prompt: infobox
 *    Input:  article title + first ~6000 chars of body
 *    Output: structured { title, subtitle, groups[] } saved to article_infobox
 *    Runs for every article regardless of whether an image is attached.
 *
 * 8. write.persist_infobox
 *    Saves the infobox JSON to article_infobox sidecar table.
 *
 * 9. write.extract_ontology
 *    Derives deterministic infobox facts and optional cached model candidates.
 *
 * 10. llm.generate_sidebar_caption  [images model, text-only]
 *    Prompt: image_caption
 *    Input:  headline image description (from media DB) + first ~1500 chars of body
 *    Output: short per-article caption written to article_media.caption sidecar
 *    Skipped when the article has no headline image.
 *    This keeps the sidepane caption in sync after every article rewrite/refresh.
 *
 * 11. write.update_article_in_place
 *    Splices the link-repaired body and updated summary back into the DB row.
 *    Staleness guard: aborts if a concurrent edit landed since this pass started.
 *
 * 12. write.index_rag_chunks
 *    Re-indexes article body as RAG chunks. Image descriptions stay out of
 *    article text retrieval.
 *
 * Sidebar rendering:
 *    The sidebar (sidepane) is assembled server-side from two sidecars:
 *      - article_infobox  — structured rows (title, subtitle, key/value groups)
 *      - article_media    — headline image + per-article caption
 *    renderInfoboxHtml() in articleRender.ts combines both into the <aside>
 *    that appears to the right of the article body. The article markdown body
 *    never contains image markdown.
 *
 * Auto-sidebar:
 *    When /api/page/:slug is served for an article that has no infobox yet,
 *    post-process is fired in the background so the sidebar is generated on
 *    first view without requiring a manual refresh.
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
  generateInfoboxNode,
  persistInfoboxNode,
  extractOntologyNode,
  generateSidebarCaptionNode,
} from "../nodes/postProcess";

export const postProcessWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "article.post_process",
  description:
    "Async enrichment after any article save: link repair, see-also, summary, " +
    "infobox generation, sidebar caption refresh, RAG indexing.",
  edges: [
    { node: reloadSavedArticleNode },
    { node: repairLinksNode },
    { node: rebuildReferenceListNode },
    { node: resolveLinksPostProcessNode },
    { node: regenerateSummaryNode, parallel: [generateInfoboxNode] },
    { node: generateSeeAlsoNode },
    { node: persistInfoboxNode },
    { node: extractOntologyNode },
    { node: generateSidebarCaptionNode },
    { node: updateArticleInPlaceNode },
    { node: indexRagChunksNode },
  ],
};
