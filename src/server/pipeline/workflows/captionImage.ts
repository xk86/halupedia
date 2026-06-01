/**
 * image.caption workflow — runs once at image ingest time.
 *
 * Pipeline stages
 * ───────────────
 * 1. read.article_and_image
 *    Load article markdown + image record (including model_b64 for vision).
 *
 * 2. llm.generate_image_caption  [images model, vision]
 *    Prompt: image_description
 *    Input:  raw image (if vision supported) + article title for universe grounding
 *    Output: title_slug  — kebab-case slug used as the media DB id
 *            description — canonical 1–3 sentence visual description stored in media DB
 *
 * 3. llm.generate_article_caption  [images model, text-only]
 *    Prompt: image_caption
 *    Input:  description (from stage 2) + first ~1500 chars of article body
 *    Output: articleCaption — short (≤12 word) per-article caption for the sidepane
 *
 * 4. write.persist_image_caption
 *    - Writes description to media DB with operation tag "described"
 *    - Writes articleCaption to article_media.caption (the sidebar sidecar)
 *    - Does NOT touch the article markdown body
 *
 * Sidebar caption refresh (on every article update):
 *    The article.post_process workflow runs llm.generate_sidebar_caption after
 *    every article save (generate / rewrite / refresh). That node re-runs
 *    image_caption with the freshly-saved body so the sidepane caption stays
 *    in sync with the article content. See postProcess.ts.
 *
 * Input fields required:
 *   slug    — article slug (for article context + article_media.caption update)
 *   imageId — the media DB id to caption
 */

import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import {
  loadArticleAndImageNode,
  generateImageCaptionNode,
  generateArticleCaptionNode,
  persistImageCaptionNode,
} from "../nodes/captionImage";

export const captionImageWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "image.caption",
  description:
    "Generate canonical description and per-article sidepane caption for an uploaded image. " +
    "Uses vision when available. Does not modify article body.",
  edges: [
    { node: loadArticleAndImageNode },
    { node: generateImageCaptionNode },
    { node: generateArticleCaptionNode },
    { node: persistImageCaptionNode },
  ],
};
