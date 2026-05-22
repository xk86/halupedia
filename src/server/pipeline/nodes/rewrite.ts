/**
 * Nodes specific to the article.rewrite workflow.
 *
 * A rewrite can be:
 *   - full rewrite     (no sectionId, no selectedText)
 *   - section rewrite  (sectionId set)
 *   - selection edit   (selectionRange set)
 *
 * Context retrieval branches:
 *   - explicit slugs provided → direct lookup, skip RAG
 *   - ragEnabled + ragQuery   → semantic RAG query
 *   - automatic               → backlinks + prior refs
 */

import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps } from "../deps";
import {
  getArticleByLookup,
  listIncomingHints,
  listProtectedSections,
} from "../../db";
import {
  buildReferenceList,
  loadPriorReferenceList,
  formatReferencesForPrompt,
  formatReferencesForPromptJson,
  extractRefLinksAsInternalLinks,
} from "../../referenceList";
import { formatIncomingHintsForPrompt } from "../../linkHints";
import {
  articleSectionMarkdown,
  extractInternalLinks,
  stripTopLevelSections,
} from "../../markdown";
import {
  retrieveContext as retrieveContextLegacy,
  retrieveDirectArticleContext,
  mergeRetrievedContextPackets,
} from "../../retrieval";
import {
  findSelectionRangeInMarkdown,
} from "../../selectionUtils";
import { slugify } from "../../slug";
import type { ReferenceListEntry } from "../../types";
import type { ReferenceEntry, RetrievedContext } from "../state";
import { hashValue } from "../runtime/trace";

function toStateEntry(r: ReferenceListEntry): ReferenceEntry {
  return {
    slug: r.slug, title: r.title, content: r.content,
    kind: r.kind, pinned: r.pinned, score: r.score, source: r.source,
  };
}

function fromStateEntry(r: ReferenceEntry, revisionId: ReferenceListEntry["revisionId"] = "current"): ReferenceListEntry {
  return { ...r, revisionId };
}

// ─── READ: load article + compute section/selection ──────────────────────────

export const readArticleForRewriteNode = defineNode({
  name: "read.article_for_rewrite",
  kind: "read",
  description: "Load article, find selection/section range, check protection.",
  reads: ["input"] as const,
  writes: [
    "loadedArticle",
    "isProtected",
    "protectedSectionIds",
    "selectedMarkdown",
    "selectionRange",
    "sectionId",
  ] as const,
  run({ input }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    if (!slug) return { loadedArticle: null };

    const record = getArticleByLookup(deps.db, slug);
    if (!record) return { loadedArticle: null };

    const bodyOnly = stripTopLevelSections(record.markdown, ["References", "See also"]);
    const sectionId = (input.instructions?.match(/^sectionId:(\S+)/) ?? [])[1] ?? "";
    // Selection text is passed via a convention in instructions for now;
    // the route handler will encode it. TODO: dedicated state field.
    const selectedTextMatch = input.instructions?.match(/^selectedText:(.+?)(?:\|instructions:|$)/s);
    const selectedText = selectedTextMatch ? selectedTextMatch[1].trim() : "";

    let selectionRange = null;
    if (selectedText) {
      selectionRange = findSelectionRangeInMarkdown(record.markdown, selectedText);
    }

    const selectedMarkdown = selectionRange
      ? record.markdown.slice(selectionRange.start, selectionRange.end)
      : sectionId
        ? articleSectionMarkdown(record.markdown, sectionId)
        : bodyOnly;

    return {
      loadedArticle: {
        slug: record.slug,
        canonicalSlug: record.canonicalSlug,
        title: record.title,
        body: record.markdown,
        summary: record.summaryMarkdown ?? "",
        generatedAt: record.generated_at,
      },
      isProtected: !input.instructions?.includes("isManualEdit:true") &&
        !sectionId &&
        !selectedText &&
        deps.db.prepare("SELECT 1 FROM article_protection WHERE slug = ? AND is_active = 1").get(slug) != null,
      protectedSectionIds: listProtectedSections(deps.db, slug).map((s) => s.sectionId),
      selectedMarkdown,
      selectionRange: selectionRange ?? null,
      sectionId: sectionId || undefined,
    };
  },
});

// ─── READ: context retrieval for rewrite (branches on explicit/rag/auto) ────

export const retrieveContextForRewriteNode = defineNode({
  name: "read.retrieve_context_for_rewrite",
  kind: "read",
  description: "Retrieve context: explicit slugs → direct lookup; ragEnabled → semantic; auto → backlinks.",
  reads: ["input", "loadedArticle"] as const,
  writes: ["retrievedContext"] as const,
  async run({ input, loadedArticle }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    const rag = deps.runtime.app.rag;
    const useEmbeddings = rag.enabled && deps.runtime.llm.embeddings.enabled;

    // Decode rewrite-specific options from instructions encoding.
    const explicitSlugs = (input.pinnedSlugs ?? []);
    const ragEnabled = input.instructions?.includes("ragEnabled:true") ?? false;
    const ragQueryMatch = input.instructions?.match(/ragQuery:([^\|]+)/);
    const ragQuery = ragQueryMatch ? ragQueryMatch[1].trim() : "";
    const instructionsText = input.instructions?.replace(/^selectedText:.+?\|instructions:/s, "")
      .replace(/ragEnabled:true|ragQuery:[^\|]+|isManualEdit:true|sectionId:\S+/g, "")
      .trim() ?? "";

    const hints = listIncomingHints(deps.db, slug);
    const backlinkSlugs = [...new Set(hints.map((h) => h.sourceSlug).filter(Boolean))];
    const priorRefs = loadPriorReferenceList(deps.db, slug) ?? [];
    const priorSlugs = priorRefs.map((r) => r.slug);

    let retrieved: RetrievedContext;

    if (explicitSlugs.length > 0) {
      // User-selected refs: load directly, merge with prior refs for continuity.
      const allDirect = [...new Set([...explicitSlugs, ...priorSlugs])];
      const direct = retrieveDirectArticleContext(deps.db, slug, allDirect, rag.mode, rag.max_results, deps.logger);
      retrieved = {
        sourceArticles: direct.sourceArticles.map((s) => ({ ...s })),
        ragTitles: direct.relatedTitles,
        backlinks: backlinkSlugs.map((s) => {
          const a = getArticleByLookup(deps.db, s);
          return { slug: s, title: a?.title ?? s };
        }),
      };
    } else if (ragEnabled) {
      const query = ragQuery || instructionsText;
      const hintStrings = hints.map((h) => h.hiddenHint);
      const packet = await retrieveContextLegacy(
        deps.db, deps.heavyLlm, slug,
        query ? [query] : hintStrings,
        rag.enabled, rag.mode, rag.max_results, rag.min_score,
        useEmbeddings, deps.logger, query || undefined,
      );
      retrieved = {
        sourceArticles: packet.sourceArticles,
        ragTitles: packet.relatedTitles,
        backlinks: backlinkSlugs.map((s) => {
          const a = getArticleByLookup(deps.db, s);
          return { slug: s, title: a?.title ?? s };
        }),
      };
    } else {
      // Auto: backlinks + hint-based retrieval.
      const hintStrings = hints.map((h) => h.hiddenHint);
      const queryOverride = [loadedArticle?.title ?? "", loadedArticle?.body.slice(0, 500) ?? ""].filter(Boolean).join("\n\n");
      const primary = await retrieveContextLegacy(
        deps.db, deps.heavyLlm, slug, hintStrings,
        rag.enabled, rag.mode, rag.max_results, rag.min_score,
        useEmbeddings, deps.logger, queryOverride,
      );
      const direct = backlinkSlugs.length
        ? retrieveDirectArticleContext(deps.db, slug, backlinkSlugs, rag.mode, rag.max_results, deps.logger)
        : { context: "", relatedTitles: [], sourceArticles: [] };
      const merged = mergeRetrievedContextPackets(primary, direct);
      retrieved = {
        sourceArticles: merged.sourceArticles,
        ragTitles: merged.relatedTitles,
        backlinks: backlinkSlugs.map((s) => {
          const a = getArticleByLookup(deps.db, s);
          return { slug: s, title: a?.title ?? s };
        }),
      };
    }

    return { retrievedContext: retrieved };
  },
});

// ─── TRANSFORM: build reference list for rewrite prompt ──────────────────────

export const buildRewriteReferenceListNode = defineNode({
  name: "transform.build_rewrite_reference_list",
  kind: "transform",
  description: "Build reference list for the rewrite prompt, preserving prior refs for partial edits.",
  reads: ["input", "loadedArticle", "retrievedContext", "selectionRange", "sectionId"] as const,
  writes: ["references"] as const,
  run({ input, loadedArticle, retrievedContext, selectionRange, sectionId }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    if (!slug) return { references: [] };

    const explicitSlugs = (input.pinnedSlugs ?? []).map(slugify).filter(Boolean);
    const pinnedSet = new Set(explicitSlugs);
    const blacklistSlugs = (input.blacklistSlugs ?? []).map(slugify).filter(Boolean);
    const isPartial = !!(selectionRange || sectionId);
    const priorRefs = loadPriorReferenceList(deps.db, slug) ?? [];
    const priorSlugs = priorRefs.map((r) => r.slug);
    const newExplicit = explicitSlugs.filter((s) => !priorSlugs.includes(s));
    const effectiveExplicit = isPartial
      ? [...new Set([...priorSlugs, ...newExplicit])]
      : explicitSlugs;

    const refs = buildReferenceList(
      deps.db,
      {
        articleSlug: slug,
        ragSources: (retrievedContext?.sourceArticles ?? []),
        priorReferences: isPartial ? priorRefs : (loadPriorReferenceList(deps.db, slug) ?? []),
        userAdditions: effectiveExplicit.map((s) => {
          const a = getArticleByLookup(deps.db, s);
          if (!a) return null;
          return {
            slug: a.slug, title: a.title,
            content: a.summaryMarkdown ?? "",
            kind: "summary" as const,
            pinned: pinnedSet.has(s),
            revisionId: "current" as const,
            source: "user" as const,
          };
        }).filter(Boolean) as ReferenceListEntry[],
        blacklistSlugs: isPartial ? [] : blacklistSlugs,
        revisionId: "current",
        config: deps.runtime.app.rag,
      },
      deps.logger,
    );

    return { references: refs.map(toStateEntry) };
  },
});

// ─── TRANSFORM: render article_rewrite prompt ────────────────────────────────

export const renderRewritePromptNode = defineNode({
  name: "transform.render_rewrite_prompt",
  kind: "transform",
  description: "Render the article_rewrite prompt for the selected text/section/full body.",
  reads: [
    "input",
    "loadedArticle",
    "selectedMarkdown",
    "references",
    "retrievedContext",
    "rewriteMode",
  ] as const,
  writes: ["renderedPrompt"] as const,
  run(
    { input, loadedArticle, selectedMarkdown, references, retrievedContext, rewriteMode },
    deps: PipelineDeps,
  ) {
    const slug = slugify(input.slug ?? "");
    const title = loadedArticle?.title ?? input.requestedTitle ?? slug;
    const refs = (references ?? []).map((r) => fromStateEntry(r, "current"));
    const hints = listIncomingHints(deps.db, slug);
    const modeName = rewriteMode ?? "default";
    const modePrompt = deps.runtime.prompts.rewriteModes?.[modeName]?.prompt ?? "";

    // Extract the actual instructions, stripping any encoded rewrite options.
    const instructionsRaw = input.instructions ?? "";
    const instructions = instructionsRaw
      .replace(/^selectedText:.+?\|instructions:/s, "")
      .replace(/ragEnabled:true|ragQuery:[^\|]+|isManualEdit:true|sectionId:\S+|rewriteMode:\S+/g, "")
      .trim();

    const rendered = deps.prompts.render("article_rewrite", {
      slug,
      requested_title: title,
      current_article: loadedArticle
        ? stripTopLevelSections(loadedArticle.body, ["References", "See also"])
        : "",
      selected_text: selectedMarkdown ?? "",
      edit_instructions: instructions,
      rewrite_mode: modePrompt,
      link_hints: formatIncomingHintsForPrompt(hints, slug),
      references_list: formatReferencesForPrompt(refs),
      references_json: formatReferencesForPromptJson(
        refs,
        deps.runtime.app.rag.prompt_ref_content_min_score,
        deps.runtime.app.rag.prompt_ref_content_top_k,
      ),
      rag_context: (retrievedContext?.sourceArticles ?? [])
        .map((s) => `## ${s.title}\n${s.content}`).join("\n\n") || "(none)",
      related_titles: (retrievedContext?.ragTitles ?? []).map((t) => `- ${t}`).join("\n"),
      article_excerpt: selectedMarkdown?.slice(0, 2000) ?? "",
      parent_comment: "",
    });
    return { renderedPrompt: rendered };
  },
});

// ─── LLM: call rewrite model ─────────────────────────────────────────────────

export const callRewriteModelNode = defineNode({
  name: "llm.rewrite_article",
  kind: "llm",
  description: "Call the article_rewrite model for the selected scope.",
  reads: ["renderedPrompt"] as const,
  writes: ["llmOutput"] as const,
  async run({ renderedPrompt }, deps: PipelineDeps) {
    if (!renderedPrompt) throw new Error("llm.rewrite_article: missing renderedPrompt");
    const client = renderedPrompt.role === "light" ? deps.lightLlm : deps.heavyLlm;
    const startedAt = Date.now();
    const text = await client.chat(renderedPrompt.system, renderedPrompt.user, {
      thinking: renderedPrompt.thinking,
      jsonMode: renderedPrompt.json,
    });
    return {
      llmOutput: {
        promptKey: renderedPrompt.key,
        text,
        finishReason: "stop",
        durationMs: Date.now() - startedAt,
        contentHash: hashValue(text),
      },
    };
  },
});

// ─── TRANSFORM: splice result back into full article for partial rewrites ────

export const spliceRewriteResultNode = defineNode({
  name: "transform.splice_rewrite_result",
  kind: "transform",
  description: "For section/selection rewrites, splice the generated fragment back into the full article.",
  reads: [
    "rawArticleBody",
    "loadedArticle",
    "selectionRange",
    "sectionId",
  ] as const,
  writes: ["rawArticleBody"] as const,
  run({ rawArticleBody, loadedArticle, selectionRange, sectionId }) {
    const generated = rawArticleBody ?? "";
    const fullMarkdown = loadedArticle?.body ?? "";

    if (selectionRange) {
      // Selection edit: replace the selected range in the full markdown.
      const spliced =
        fullMarkdown.slice(0, selectionRange.start) +
        generated +
        fullMarkdown.slice(selectionRange.end);
      return { rawArticleBody: spliced };
    }

    if (sectionId) {
      // Section rewrite: replace just the named section.
      const { replaceArticleSection } = require("../../markdown");
      return {
        rawArticleBody: replaceArticleSection(fullMarkdown, sectionId, generated),
      };
    }

    // Full rewrite — generated body replaces the whole article.
    return { rawArticleBody: generated };
  },
});
