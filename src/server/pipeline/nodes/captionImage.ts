/**
 * Nodes for the image.caption workflow.
 *
 * This workflow runs once at image ingest time (upload/attach). Its job is
 * purely media-DB work — it does NOT touch the article body.
 *
 * Stage 1 — read.article_and_image
 *   Load article text and image record from their respective DBs.
 *
 * Stage 2 — llm.generate_image_caption
 *   Calls image_description with the raw image attached (vision when available).
 *   Produces: title_slug + canonical description stored in the media DB.
 *
 * Stage 3 — llm.generate_article_caption
 *   Calls image_caption with the description + article excerpt.
 *   Produces: a short per-article caption stored in article_media.caption
 *   (the sidebar sidecar). This is what appears under the image in the
 *   sidepane — it is never inserted into the article markdown body.
 *
 * Stage 4 — write.persist_image_caption
 *   Writes the canonical description (with operation tag "described") to the
 *   media DB revision log, and writes the article caption to article_media.caption.
 *
 * Caption refresh on article update:
 *   The post-process workflow (article.post_process) runs a
 *   llm.generate_sidebar_caption node after every article save. That node
 *   re-generates the per-article caption from the freshly-saved body so the
 *   sidepane caption stays in sync with the article content. See postProcess.ts.
 */

import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps } from "../deps";
import { getArticleByLookup, updateArticleMediaCaption } from "../../db";
import { getMediaById, updateMediaDescription } from "../../mediaDb";

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

// ─── LLM STAGE 2: canonical description ──────────────────────────────────────

export const generateImageCaptionNode = defineNode({
  name: "llm.generate_image_caption",
  kind: "llm",
  description:
    "Generate title_slug and canonical description via the image_description prompt. " +
    "Attaches the downscaled image when the images model supports vision.",
  reads: ["input", "loadedArticle"] as const,
  writes: ["imageCaptionResult"] as const,
  async run({ input, loadedArticle }, deps: PipelineDeps) {
    const imageId = input.imageId ?? "";
    if (!imageId) return { imageCaptionResult: undefined };

    const mediaRecord = deps.mediaDb ? getMediaById(deps.mediaDb, imageId) : null;
    const title = loadedArticle?.title ?? input.requestedTitle ?? imageId;
    const instructions = input.instructions ?? "";

    const rendered = deps.prompts.render("image_description", {
      requested_title: title,
      instructions: instructions.trim() ? `Additional guidance: ${instructions.trim()}` : "",
    });

    const visionImages =
      mediaRecord && deps.llm.supportsVision("images")
        ? [{ mime: mediaRecord.model_mime, b64: mediaRecord.model_b64 }]
        : [];

    try {
      const raw = await deps.llm.chat(
        "images",
        rendered.system,
        rendered.user,
        { images: visionImages.length ? visionImages : undefined },
      );

      const description = raw.replace(/\s+/g, " ").trim();
      if (!description) throw new Error("description response empty");

      // Derive a slug from the first few words of the description.
      const titleSlug = description
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, "")
        .trim()
        .split(/\s+/)
        .slice(0, 6)
        .join("-")
        .slice(0, 80);

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

// ─── LLM STAGE 3: per-article sidepane caption ────────────────────────────────

export const generateArticleCaptionNode = defineNode({
  name: "llm.generate_article_caption",
  kind: "llm",
  description:
    "Generate a short per-article caption from the canonical description + article excerpt. " +
    "Result goes to article_media.caption (the sidepane sidecar) — never into the article body.",
  reads: ["input", "loadedArticle", "imageCaptionResult"] as const,
  writes: ["imageCaptionResult"] as const,
  async run({ input, loadedArticle, imageCaptionResult }, deps: PipelineDeps) {
    if (!imageCaptionResult || !loadedArticle) return { imageCaptionResult };

    const { description } = imageCaptionResult;
    const title = loadedArticle.title ?? input.requestedTitle ?? "";
    const articleExcerpt = (loadedArticle.body ?? "").slice(0, 1500).trim();

    const rendered = deps.prompts.render("image_caption", {
      requested_title: title,
      image_description: description,
      article_excerpt: articleExcerpt,
    });

    try {
      const raw = await deps.llm.chat(
        "images",
        rendered.system,
        rendered.user,
        { jsonMode: true },
      );
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("no JSON in caption response");
      const parsed = JSON.parse(match[0]) as Partial<Record<string, string>>;
      const articleCaption = String(parsed.caption ?? "").replace(/\s+/g, " ").trim();

      return {
        imageCaptionResult: { ...imageCaptionResult, articleCaption: articleCaption || undefined },
      };
    } catch (err) {
      deps.logger.warn("pipeline.article_caption.failed", {
        imageId: input.imageId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { imageCaptionResult };
    }
  },
});

// ─── WRITE STAGE 4: persist description + sidecar caption ────────────────────

export const persistImageCaptionNode = defineNode({
  name: "write.persist_image_caption",
  kind: "write",
  description:
    "Save canonical description (with 'described' revision) to media DB, " +
    "and write articleCaption to article_media.caption sidecar.",
  reads: ["input", "imageCaptionResult"] as const,
  writes: [] as const,
  run({ input, imageCaptionResult }, deps: PipelineDeps) {
    const imageId = input.imageId ?? "";
    const articleSlug = input.slug ?? "";
    if (!imageId || !imageCaptionResult || !deps.mediaDb) return {};

    const { description, articleCaption } = imageCaptionResult;

    if (description) {
      updateMediaDescription(deps.mediaDb, imageId, description, "described");
    }

    if (articleSlug && articleCaption) {
      updateArticleMediaCaption(deps.db, articleSlug, 1, articleCaption);
    }

    deps.logger.info("pipeline.image_description.saved", {
      mediaId: imageId,
      articleSlug,
      hasDescription: Boolean(description),
      hasCaption: Boolean(articleCaption),
      usedVision: deps.llm.supportsVision("images"),
    });

    return {};
  },
});
