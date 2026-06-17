import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps } from "../deps";

export const generateArticleImageAttachmentNode = defineNode({
  name: "image.generate_attach",
  kind: "write",
  description: "Generate a headline image, ingest it, and attach it to the article.",
  reads: ["input"] as const,
  writes: ["imageGenerationResult"] as const,
  async run({ input }, deps: PipelineDeps) {
    if (!input.slug) {
      throw new Error("image generation requires an article slug");
    }
    if (!deps.generateArticleImageAttachment) {
      throw new Error("image generation dependency is not wired");
    }
    const result = await deps.generateArticleImageAttachment(
      input.slug,
      input.imageReplace === true,
      input.imagePromptKey,
    );
    return { imageGenerationResult: result };
  },
});
