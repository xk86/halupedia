import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import {
  generateArticleImageAttachmentNode,
  judgeArticleImagePresetDefaultNode,
  selectArticleImagePresetNode,
  selectSpecializedArticleImagePresetNode,
} from "../nodes/articleImageGeneration";

export const articleImageGenerationWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "article.image_generate",
  description: "Generate and attach a headline image for an article.",
  edges: [
    { node: selectArticleImagePresetNode },
    {
      node: selectSpecializedArticleImagePresetNode,
      when: (state, deps) =>
        deps.runtime.app.images.generation.auto_preset_multipass &&
        state.input.imagePromptKey === "auto" &&
        state.initialImagePromptKey === "default",
    },
    {
      node: judgeArticleImagePresetDefaultNode,
      when: (state, deps) =>
        deps.runtime.app.images.generation.auto_preset_multipass &&
        state.input.imagePromptKey === "auto" &&
        state.initialImagePromptKey === "default" &&
        Boolean(state.specializedImagePromptKey),
    },
    { node: generateArticleImageAttachmentNode },
  ],
};
