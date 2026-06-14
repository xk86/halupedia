/**
 * Nodes specific to the article.refresh workflow.
 *
 * Refresh re-runs the full context-retrieval pipeline against the *existing*
 * article body and calls `article_refresh` to improve formatting/context.
 * Protected sections are spliced back deterministically after generation.
 *
 * Reuses from articleGeneration.ts:
 *   readArticleNode, readRecentEditHistoryNode, retrieveContextNode,
 *   buildReferenceListNode, extractArticleBodyNode, sanitizeBodyNode,
 *   cleanLinkLabelsNode, deriveIdentityNode, resolveLinksNode,
 *   persistArticleNode
 */

import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps } from "../deps";
import {
  isArticleProtected,
  listIncomingHints,
  listProtectedSections,
} from "../../db";
import {
  formatReferencesForPrompt,
  formatReferencesForPromptText,
} from "../../referenceList";
import { formatIncomingHintsForPrompt } from "../../linkHints";
import { formatRagContextForPrompt } from "../../retrieval";
import {
  normalizeMarkdown,
  renderMarkdown,
  spliceProtectedSections,
  stripTopLevelSections,
} from "../../markdown";
import { parsePartialArticleFrame } from "../../articleFrame";
import { slugify } from "../../slug";
import type { ReferenceListEntry } from "../../types";
import type { ReferenceEntry } from "../state";
import { hashValue } from "../runtime/trace";

function fromStateEntry(
  r: ReferenceEntry,
  revisionId: ReferenceListEntry["revisionId"] = "current",
): ReferenceListEntry {
  return { ...r, revisionId };
}

// ─── READ: check protection + collect protected section ids ──────────────────

export const readProtectionNode = defineNode({
  name: "read.protection",
  kind: "read",
  description: "Load protection state for the article (whole-article and per-section locks).",
  reads: ["input"] as const,
  writes: ["isProtected", "protectedSectionIds"] as const,
  run({ input }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    if (!slug) return { isProtected: false, protectedSectionIds: [] };
    return {
      isProtected: isArticleProtected(deps.db, slug),
      protectedSectionIds: listProtectedSections(deps.db, slug).map((s) => s.sectionId),
    };
  },
});

// ─── TRANSFORM: render article_refresh prompt ────────────────────────────────

export const renderRefreshPromptNode = defineNode({
  name: "transform.render_refresh_prompt",
  kind: "transform",
  description: "Render the article_refresh prompt with current body + retrieved context.",
  reads: [
    "input",
    "loadedArticle",
    "references",
    "retrievedContext",
    "headlineImageContext",
  ] as const,
  writes: ["renderedPrompt"] as const,
  run({ input, loadedArticle, references, retrievedContext, headlineImageContext }, deps: PipelineDeps) {
    const slug = input.slug ?? "";
    const title = loadedArticle?.title ?? input.requestedTitle ?? slug;
    const currentBody = loadedArticle
      ? stripTopLevelSections(loadedArticle.body, ["References", "See also"])
      : "";
    const refs = (references ?? []).map((r) => fromStateEntry(r, "current"));

    const hints = listIncomingHints(deps.db, slugify(slug));
    const linkHints = formatIncomingHintsForPrompt(hints, slugify(slug), deps.runtime.app.rag.prompt_link_hints_max);
    const subtleMode = deps.runtime.prompts.rewriteModes?.subtle?.prompt ?? "";

    const rendered = deps.prompts.render("article_refresh", {
      slug: slugify(slug),
      requested_title: title,
      current_article: currentBody,
      link_hints: linkHints,
      rewrite_mode: subtleMode,
      references_list: formatReferencesForPrompt(refs),
      references_prompt_text: formatReferencesForPromptText(
        refs,
        deps.runtime.app.rag.prompt_ref_content_min_score,
        deps.runtime.app.rag.prompt_ref_content_top_k,
      ),
      rag_context: formatRagContextForPrompt(
        retrievedContext?.sourceArticles ?? [],
        deps.runtime.app.rag.prompt_context_max_chars,
      ) || "(none)",
      related_titles: (retrievedContext?.ragTitles ?? []).map((t) => `- ${t}`).join("\n"),
      article_excerpt: "",
      parent_comment: "",
      selected_text: "",
      edit_instructions: "",
      headline_image: headlineImageContext ?? "",
    });
    return { renderedPrompt: rendered };
  },
});

// ─── LLM: call refresh model ─────────────────────────────────────────────────

export const callRefreshModelNode = defineNode({
  name: "llm.refresh_article",
  kind: "llm",
  description: "Call article_refresh model (streams when onProgress set).",
  reads: ["renderedPrompt", "isProtected"] as const,
  writes: ["llmOutput"] as const,
  async run({ renderedPrompt, isProtected }, deps: PipelineDeps) {
    if (isProtected) {
      throw new Error("llm.refresh_article: article is protected, should have been skipped");
    }
    if (!renderedPrompt) throw new Error("llm.refresh_article: missing renderedPrompt");
    const role = renderedPrompt.role ?? "heavy";
    const startedAt = Date.now();
    let text: string;
    let finishReason = "stop";
    let ttftMs: number | undefined;

    if (deps.onProgress) {
      const result = await deps.llm.streamChat(
        role,
        renderedPrompt.system,
        renderedPrompt.user,
        (_delta, accumulated) => {
          const partial = parsePartialArticleFrame(accumulated);
          if (!partial || !deps.onProgress) return;
          const preview = normalizeMarkdown(partial);
          deps.onProgress(renderMarkdown(preview), preview);
        },
        { thinking: renderedPrompt.thinking },
      );
      text = result.content;
      finishReason = result.finishReason;
      ttftMs = result.ttftMs;
    } else {
      text = await deps.llm.chat(role, renderedPrompt.system, renderedPrompt.user, {
        thinking: renderedPrompt.thinking,
        jsonMode: renderedPrompt.json,
      });
    }

    return {
      llmOutput: {
        promptKey: renderedPrompt.key,
        text,
        finishReason,
        durationMs: Date.now() - startedAt,
        ...(ttftMs === undefined ? {} : { ttftMs }),
        contentHash: hashValue(text),
      },
    };
  },
});

// ─── TRANSFORM: pass stored body through when the article is protected ───────

export const useStoredBodyForProtectedRefreshNode = defineNode({
  name: "transform.use_stored_body_for_protected_refresh",
  kind: "transform",
  description: "Carry the existing article body forward when protected refresh skips the LLM.",
  reads: ["loadedArticle", "isProtected"] as const,
  writes: ["rawArticleBody"] as const,
  run({ loadedArticle, isProtected }) {
    if (!isProtected) return {};
    return { rawArticleBody: loadedArticle?.body ?? "" };
  },
});

// ─── TRANSFORM: splice protected sections back ───────────────────────────────

export const spliceProtectedSectionsNode = defineNode({
  name: "transform.splice_protected_sections",
  kind: "transform",
  description: "Re-insert protected sections that were excluded from LLM generation.",
  reads: ["articleBody", "protectedSectionIds", "loadedArticle"] as const,
  writes: ["articleBody"] as const,
  run({ articleBody, protectedSectionIds, loadedArticle }) {
    const ids = protectedSectionIds ?? [];
    if (ids.length === 0) return { articleBody };
    const originalBody = loadedArticle
      ? stripTopLevelSections(loadedArticle.body, ["References", "See also"])
      : "";
    return {
      articleBody: spliceProtectedSections(articleBody ?? "", ids, originalBody),
    };
  },
});
