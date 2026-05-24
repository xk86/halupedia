/**
 * Nodes for one-off utility workflows (currently: regenerate summary).
 * Preview and reference-search endpoints are simple inline handlers — they
 * don't benefit from pipeline orchestration.
 */

import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps } from "../deps";
import { getArticleByLookup } from "../../db";
import { renderTemplate } from "../../prompts";
import { stripTopLevelSections, summaryMarkdownFromArticle } from "../../markdown";
import { slugify } from "../../slug";
import { updateArticleSummary } from "../../db";
import { normalizeSummaryMarkdown, summaryLooksLikeLeadCopy } from "../../summary";

export const readArticleForSummaryNode = defineNode({
  name: "summary.read.article",
  kind: "read",
  reads: ["input"] as const,
  writes: ["loadedArticle"] as const,
  run({ input }, deps: PipelineDeps) {
    const inputData = input as any;
    const article = getArticleByLookup(deps.db, inputData.slug);
    if (!article) {
      throw new Error(`article not found: ${inputData.slug}`);
    }
    return {
      loadedArticle: {
        slug: article.slug,
        canonicalSlug: article.canonicalSlug,
        title: article.title,
        body: article.markdown,
        summary: article.summaryMarkdown || "",
        generatedAt: article.generated_at,
      },
    };
  },
});

export const generateSummaryNode = defineNode({
  name: "summary.llm.generate",
  kind: "llm",
  reads: ["loadedArticle"] as const,
  writes: ["articleSummary"] as const,
  run: async ({ loadedArticle }, deps: PipelineDeps) => {
    const article = loadedArticle as any;
    const entry = deps.prompts.get("article_summary");
    const prompt = entry.resolved;
    const role = prompt.model ?? "heavy";
    const currentArticle = stripTopLevelSections(article.body, ["References", "See also"]).slice(0, 12000);

    let previousSummary = "(none)";
    let summaryFeedback = "(none)";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await deps.llm.chat(
        role,
        prompt.system,
        renderTemplate(prompt.user, {
          slug: slugify(article.title),
          requested_title: article.title,
          current_article: currentArticle,
          previous_summary: previousSummary,
          summary_feedback: summaryFeedback,
          article_excerpt: currentArticle,
          rag_context: "",
          link_hints: "",
          related_titles: "",
          parent_comment: "",
          selected_text: "",
          edit_instructions: "",
          full_article: currentArticle,
        }),
        { thinking: prompt.thinking, jsonMode: prompt.json },
      );

      const summary = normalizeSummaryMarkdown(raw);
      if (summary && !summaryLooksLikeLeadCopy(summary, article.body)) {
        deps.logger.debug("regenerate_summary.generated", { slug: article.slug, length: summary.length });
        return { articleSummary: summary };
      }
      previousSummary = summary || raw.replace(/\s+/g, " ").trim().slice(0, 360) || "(empty)";
      summaryFeedback = "too_similar_to_lead";
    }

    const fallback = summaryMarkdownFromArticle(article.body);
    deps.logger.debug("regenerate_summary.generated", { slug: article.slug, length: fallback.length });
    return { articleSummary: fallback };
  },
});

export const persistSummaryNode = defineNode({
  name: "summary.write.persist",
  kind: "write",
  reads: ["loadedArticle", "articleSummary"] as const,
  writes: ["persistedAt"] as const,
  run({ loadedArticle, articleSummary }, deps: PipelineDeps) {
    const article = loadedArticle as any;
    const updated = updateArticleSummary(deps.db, article.slug, articleSummary || "", {
      updateRevisionGeneratedAt: article.generatedAt,
    });

    if (!updated) {
      throw new Error(`failed to update summary for ${article.slug}`);
    }

    deps.logger.info("regenerate_summary.persisted", {
      slug: article.slug,
      summary_length: (articleSummary || "").length,
    });

    return { persistedAt: Date.now() };
  },
});
