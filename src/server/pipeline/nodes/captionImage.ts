/**
 * Nodes for the image.caption workflow.
 *
 * Works with any configured model: when the LLM router reports vision support
 * for the light role, the downscaled model image is attached as a multimodal
 * input. When it does not, the prompt falls back to article context alone —
 * the result is still useful (slug, in-universe description, caption).
 */

import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps } from "../deps";
import { getArticleByLookup } from "../../db";
import { getMediaById, updateMediaDescription } from "../../mediaDb";
import { slugify } from "../../slug";
import { stripTopLevelSections } from "../../markdown";

// ─── READ ─────────────────────────────────────────────────────────────────────

export const loadArticleAndImageNode = defineNode({
  name: "read.article_and_image",
  kind: "read",
  description: "Load article text + image model_b64 from their respective DBs.",
  reads: ["input"] as const,
  writes: ["loadedArticle"] as const,
  run({ input }, deps: PipelineDeps) {
    const articleSlug = input.slug ?? "";
    const imageId = input.imageId ?? "";
    if (!articleSlug || !imageId) return { loadedArticle: null };

    const article = getArticleByLookup(deps.db, articleSlug);
    if (!article) return { loadedArticle: null };

    return {
      loadedArticle: {
        slug: article.slug,
        canonicalSlug: article.canonicalSlug,
        title: article.title,
        body: article.markdown,
        summary: article.summaryMarkdown ?? "",
        generatedAt: article.generated_at,
      },
    };
  },
});

// ─── LLM ─────────────────────────────────────────────────────────────────────

export const generateImageCaptionNode = defineNode({
  name: "llm.generate_image_caption",
  kind: "llm",
  description:
    "Generate title_slug and description via the image_description prompt. " +
    "Attaches the downscaled image when the light model supports vision. " +
    "Description is image-centric (what the image shows), not article-context-driven.",
  reads: ["input", "loadedArticle"] as const,
  writes: ["imageCaptionResult"] as const,
  async run({ input, loadedArticle }, deps: PipelineDeps) {
    const imageId = input.imageId ?? "";
    if (!imageId) return { imageCaptionResult: undefined };

    const mediaRecord = deps.mediaDb ? getMediaById(deps.mediaDb, imageId) : null;
    const title = loadedArticle?.title ?? input.requestedTitle ?? imageId;
    const instructions = input.instructions ?? "";

    // image_description prompt: image-centric, uses title for universe grounding only.
    const rendered = deps.prompts.render("image_description", {
      requested_title: title,
      instructions: instructions.trim() ? `Additional guidance: ${instructions.trim()}` : "",
    });

    const visionImages =
      mediaRecord && deps.llm.supportsVision("light")
        ? [{ mime: mediaRecord.model_mime, b64: mediaRecord.model_b64 }]
        : [];

    try {
      const raw = await deps.llm.chat(
        rendered.role ?? "light",
        rendered.system,
        rendered.user,
        { jsonMode: true, images: visionImages.length ? visionImages : undefined },
      );
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("no JSON in description response");
      const parsed = JSON.parse(match[0]) as Partial<Record<string, string>>;

      const titleSlug = String(parsed.title_slug ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
      const description = String(parsed.description ?? "").replace(/\s+/g, " ").trim();

      if (!titleSlug && !description) throw new Error("description response missing fields");

      return { imageCaptionResult: { titleSlug, description } };
    } catch (err) {
      deps.logger.warn("pipeline.image_description.failed", {
        imageId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { imageCaptionResult: undefined };
    }
  },
});

// ─── WRITE ────────────────────────────────────────────────────────────────────

export const persistImageCaptionNode = defineNode({
  name: "write.persist_image_caption",
  kind: "write",
  description:
    "Save canonical description to media DB. " +
    "Rename logic is intentionally absent — renaming only happens at initial ingest " +
    "(via attachAndCaption in index.ts) so description regeneration never clobbers existing slugs.",
  reads: ["input", "imageCaptionResult"] as const,
  writes: [] as const,
  run({ input, imageCaptionResult }, deps: PipelineDeps) {
    const imageId = input.imageId ?? "";
    const articleSlug = input.slug ?? "";
    if (!imageId || !imageCaptionResult || !deps.mediaDb) return {};

    const { description } = imageCaptionResult;

    if (description) {
      updateMediaDescription(deps.mediaDb, imageId, description);
    }

    deps.logger.info("pipeline.image_description.saved", {
      mediaId: imageId,
      articleSlug,
      hasDescription: Boolean(description),
      usedVision: deps.llm.supportsVision("light"),
    });

    return {};
  },
});
