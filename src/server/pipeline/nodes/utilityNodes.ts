/**
 * Utility nodes for preview, reference finding, and summary regeneration.
 * These are simpler operations that don't fit the full article-generation flow.
 */

import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps } from "../deps";
import { getArticleByLookup } from "../../db";
import { normalizeMarkdownLinks } from "../../text/linkNormalize";
import { renderMarkdown } from "../../markdown";
import { findReferencedArticlesInEditText, findFuzzyTitleMatchesInEditText } from "../../editReferences";
import { retrieveContext } from "../../retrieval";
import { renderTemplate } from "../../prompts";
import { stripTopLevelSections, summaryMarkdownFromArticle } from "../../markdown";
import { slugify } from "../../slug";
import { updateArticleSummary } from "../../db";
import { normalizeSummaryMarkdown, summaryLooksLikeLeadCopy } from "../../summary";

// ─── Preview Markdown Nodes ──────────────────────────────────────────────────

export const normalizeMarkdownNode = defineNode({
  name: "preview.normalize.markdown",
  kind: "transform",
  reads: ["input"] as const,
  writes: ["normalizedMarkdown", "normalizedLinks", "diagnosticsFromNormalize"] as const,
  run({ input }, deps: PipelineDeps) {
    const normalized = normalizeMarkdownLinks((input as any).markdown || "", "article");
    return {
      normalizedMarkdown: normalized.markdown,
      normalizedLinks: normalized.links,
      diagnosticsFromNormalize: normalized.diagnostics
        .filter((d: any) => d.severity === "info" || d.severity === "warn" || d.severity === "error")
        .map((d: any) => ({ severity: d.severity as "info" | "warn" | "error", message: d.message })),
    };
  },
});

export const validateLinksNode = defineNode({
  name: "preview.validate.links",
  kind: "read",
  reads: ["input", "normalizedLinks"] as const,
  writes: ["brokenLinks"] as const,
  run({ input, normalizedLinks }, deps: PipelineDeps) {
    const brokenLinks: Array<{ slug: string; reason: string }> = [];
    const checkedSlugs = new Set<string>();
    const inputData = input as any;

    for (const link of normalizedLinks || []) {
      if (link.slug && link.slug !== inputData.slug && !checkedSlugs.has(link.slug)) {
        checkedSlugs.add(link.slug);
        const exists = getArticleByLookup(deps.db, link.slug);
        if (!exists) {
          brokenLinks.push({
            slug: link.slug,
            reason: `no article with slug "${link.slug}"`,
          });
        }
      }
    }

    return { brokenLinks };
  },
});

export const renderHtmlNode = defineNode({
  name: "preview.render.html",
  kind: "transform",
  reads: ["normalizedMarkdown"] as const,
  writes: ["html"] as const,
  run({ normalizedMarkdown }, deps: PipelineDeps) {
    const html = renderMarkdown(normalizedMarkdown || "");
    return { html };
  },
});

export const compileDiagnosticsNode = defineNode({
  name: "preview.compile.diagnostics",
  kind: "transform",
  reads: ["diagnosticsFromNormalize", "brokenLinks"] as const,
  writes: ["diagnostics"] as const,
  run({ diagnosticsFromNormalize, brokenLinks }, deps: PipelineDeps) {
    const diagnostics = [
      ...(diagnosticsFromNormalize || [])
        .filter((d: any) => d.severity === "warn" || d.severity === "error")
        .map((d: any) => ({ severity: d.severity, message: d.message })),
      ...(brokenLinks || []).map((b: any) => ({
        severity: "warn" as const,
        message: `Broken link to "${b.slug}": ${b.reason}`,
      })),
    ];
    return { diagnostics };
  },
});

// ─── Find References Nodes ──────────────────────────────────────────────────

export const searchFuzzyNode = defineNode({
  name: "references.search.fuzzy",
  kind: "read",
  reads: ["input"] as const,
  writes: ["fuzzyMatches"] as const,
  run({ input }, deps: PipelineDeps) {
    const inputData = input as any;
    const fuzzyMatches: any[] = [];
    const seen = new Set<string>();

    if (!inputData.fuzzyTitles?.trim()) {
      return { fuzzyMatches };
    }

    const { articles: matched } = findReferencedArticlesInEditText(
      deps.db,
      inputData.fuzzyTitles,
      inputData.slug,
      10,
    );

    for (const a of matched) {
      const s = a.slug;
      if (s && !seen.has(s)) {
        seen.add(s);
        fuzzyMatches.push({ slug: s, title: a.title, summaryMarkdown: a.summaryMarkdown ?? "" });
      }
    }

    const fuzzy = findFuzzyTitleMatchesInEditText(
      deps.db,
      inputData.fuzzyTitles,
      inputData.slug,
      10,
      matched.map((a) => a.slug),
    );

    for (const a of fuzzy) {
      const s = a.slug;
      if (s && !seen.has(s)) {
        seen.add(s);
        fuzzyMatches.push({ slug: s, title: a.title, summaryMarkdown: a.summaryMarkdown ?? "" });
      }
    }

    return { fuzzyMatches };
  },
});

export const searchRagNode = defineNode({
  name: "references.search.rag",
  kind: "read",
  reads: ["input"] as const,
  writes: ["ragMatches"] as const,
  run: async ({ input }, deps: PipelineDeps) => {
    const inputData = input as any;

    if (!inputData.ragQuery?.trim()) {
      return { ragMatches: [] };
    }

    const retrieved = await retrieveContext(
      deps.db,
      deps.heavyLlm,
      inputData.slug,
      [inputData.ragQuery.trim()],
      deps.runtime.app.rag.enabled,
      deps.runtime.app.rag.mode,
      deps.runtime.app.rag.max_results,
      deps.runtime.app.rag.min_score,
      deps.runtime.llm.embeddings.enabled,
      deps.logger,
      inputData.ragQuery.trim(),
    );

    const ragMatches = retrieved.sourceArticles.map((src: any) => ({
      slug: src.slug,
      title: src.title,
      summaryMarkdown: src.content?.slice(0, 360) ?? "",
    }));

    return { ragMatches };
  },
});

export const mergeReferenceResultsNode = defineNode({
  name: "references.merge.results",
  kind: "transform",
  reads: ["fuzzyMatches", "ragMatches"] as const,
  writes: ["articles"] as const,
  run({ fuzzyMatches, ragMatches }, deps: PipelineDeps) {
    const seen = new Set<string>();
    const articles: any[] = [];

    for (const a of fuzzyMatches || []) {
      if (!seen.has(a.slug)) {
        seen.add(a.slug);
        articles.push(a);
      }
    }

    for (const a of ragMatches || []) {
      if (!seen.has(a.slug)) {
        seen.add(a.slug);
        articles.push(a);
      }
    }

    return { articles };
  },
});

// ─── Regenerate Summary Nodes ───────────────────────────────────────────────

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
    const selectedLlm = prompt.model === "light" ? deps.lightLlm : deps.heavyLlm;
    const currentArticle = stripTopLevelSections(article.body, [
      "References",
      "See also",
    ]).slice(0, 12000);

    let previousSummary = "(none)";
    let summaryFeedback = "(none)";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await selectedLlm.chat(
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
        deps.logger.debug("regenerate_summary.generated", {
          slug: article.slug,
          length: summary.length,
        });
        return { articleSummary: summary };
      }

      previousSummary = summary || raw.replace(/\s+/g, " ").trim().slice(0, 360) || "(empty)";
      summaryFeedback = "too_similar_to_lead";
    }

    const fallback = summaryMarkdownFromArticle(article.body);
    deps.logger.debug("regenerate_summary.generated", {
      slug: article.slug,
      length: fallback.length,
    });
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
      updateRevisionGeneratedAt: article.generated_at,
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
