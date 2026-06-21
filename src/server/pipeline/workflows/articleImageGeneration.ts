import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import {
  generateArticleImageAttachmentNode,
  judgeArticleImagePresetFinalNode,
  selectArticleImagePresetNode,
  selectChallengerArticleImagePresetNode,
} from "../nodes/articleImageGeneration";

export const articleImageGenerationWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "article.image_generate",
  description: "Generate and attach a headline image for an article.",
  edges: [
    { node: selectArticleImagePresetNode },
    {
      node: selectChallengerArticleImagePresetNode,
      when: (state, deps) =>
        deps.runtime.app.images.generation.auto_preset_multipass &&
        state.input.imagePromptKey === "auto" &&
        Boolean(state.initialImagePromptKey),
    },
    {
      node: judgeArticleImagePresetFinalNode,
      when: (state, deps) =>
        deps.runtime.app.images.generation.auto_preset_multipass &&
        state.input.imagePromptKey === "auto" &&
        Boolean(state.initialImagePromptKey) &&
        Boolean(state.challengerImagePromptKey),
    },
    { node: generateArticleImageAttachmentNode },
  ],
};
