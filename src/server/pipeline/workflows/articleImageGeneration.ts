import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import {
  generateArticleImageAttachmentNode,
  selectArticleImagePresetNode,
} from "../nodes/articleImageGeneration";

export const articleImageGenerationWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "article.image_generate",
  description: "Generate and attach a headline image for an article.",
  edges: [{ node: selectArticleImagePresetNode }, { node: generateArticleImageAttachmentNode }],
};
