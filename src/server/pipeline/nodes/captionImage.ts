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
import {
  getMediaById,
  updateMediaDescription,
  updateMediaId,
} from "../../mediaDb";
import { slugify } from "../../slug";
import { stripTopLevelSections } from "../../markdown";
import {
  upsertArticleHeadlineMedia,
  updateArticleMediaCaption,
} from "../../db";

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
    "Generate title_slug, description, and caption via the image_caption prompt. " +
    "Attaches the downscaled image when the light model supports vision.",
  reads: ["input", "loadedArticle"] as const,
  writes: ["imageCaptionResult"] as const,
  async run({ input, loadedArticle }, deps: PipelineDeps) {
    const imageId = input.imageId ?? "";
    if (!imageId) return { imageCaptionResult: undefined };

    const mediaRecord = deps.mediaDb ? getMediaById(deps.mediaDb, imageId) : null;

    const title = loadedArticle?.title ?? input.requestedTitle ?? imageId;
    const excerpt = loadedArticle
      ? stripTopLevelSections(loadedArticle.body, ["References", "See also"]).slice(0, 2000)
      : "";

    const rendered = deps.prompts.render("image_caption", {
      requested_title: title,
      article_excerpt: excerpt,
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
      if (!match) throw new Error("no JSON in caption response");
      const parsed = JSON.parse(match[0]) as Partial<Record<string, string>>;

      const titleSlug = String(parsed.title_slug ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
      const description = String(parsed.description ?? "").replace(/\s+/g, " ").trim();
      const caption = String(parsed.caption ?? "").replace(/\s+/g, " ").trim();

      if (!titleSlug && !description) throw new Error("caption response missing fields");

      return { imageCaptionResult: { titleSlug, description, caption } };
    } catch (err) {
      deps.logger.warn("pipeline.image_caption.failed", {
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
    "Save description to media DB; rename media id to title_slug when available; " +
    "update per-article caption in article_media.",
  reads: ["input", "imageCaptionResult"] as const,
  writes: [] as const,
  run({ input, imageCaptionResult }, deps: PipelineDeps) {
    const imageId = input.imageId ?? "";
    const articleSlug = input.slug ?? "";
    if (!imageId || !imageCaptionResult || !deps.mediaDb) return {};

    const { titleSlug, description, caption } = imageCaptionResult;

    // Update canonical description on the media record.
    if (description) {
      updateMediaDescription(deps.mediaDb, imageId, description);
    }

    // Try to rename the media id to the nice slug (idempotent on collision).
    let finalId = imageId;
    if (titleSlug && titleSlug !== imageId) {
      const renamed = updateMediaId(deps.mediaDb, imageId, titleSlug);
      if (renamed) {
        finalId = titleSlug;
        deps.logger.info("pipeline.image_caption.renamed", {
          from: imageId,
          to: finalId,
        });
        // Keep the article_media reference in sync.
        if (articleSlug) {
          upsertArticleHeadlineMedia(deps.db, articleSlug, finalId, caption || description);
        }
      }
    }

    // Update the per-article visible caption.
    if (articleSlug && caption) {
      updateArticleMediaCaption(deps.db, articleSlug, 1, caption);
    }

    deps.logger.info("pipeline.image_caption.saved", {
      mediaId: finalId,
      articleSlug,
      hasDescription: Boolean(description),
      hasCaption: Boolean(caption),
      usedVision: deps.llm.supportsVision("light") && Boolean(deps.mediaDb ? getMediaById(deps.mediaDb, imageId)?.model_b64 : false),
    });

    return {};
  },
});
