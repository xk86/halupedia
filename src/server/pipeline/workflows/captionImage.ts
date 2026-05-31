/**
 * image.caption workflow.
 *
 * Generates a title slug, canonical description, and per-article caption for
 * a just-uploaded image. Runs after ingest so the upload route returns fast.
 *
 * Works with text-only models (falls back to article-context-only generation)
 * and upgrades to multimodal automatically when the configured light model
 * supports vision.
 *
 * Input fields required:
 *   slug      — article slug (for article context + article_media update)
 *   imageId   — the media DB id to caption
 */

import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import {
  loadArticleAndImageNode,
  generateImageCaptionNode,
  persistImageCaptionNode,
} from "../nodes/captionImage";

export const captionImageWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "image.caption",
  description:
    "Generate title slug, canonical description, and article caption for an uploaded image. " +
    "Uses vision when available; falls back to article-context text generation.",
  edges: [
    { node: loadArticleAndImageNode },
    { node: generateImageCaptionNode },
    { node: persistImageCaptionNode },
  ],
};
