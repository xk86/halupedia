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
  isArticleProtected,
  listIncomingHints,
  listProtectedSections,
} from "../../db";
import {
  buildReferenceList,
  loadPriorReferenceList,
  formatReferencesForPrompt,
  formatReferencesForPromptText,
} from "../../referenceList";
import { formatIncomingHintsForPrompt } from "../../linkHints";
import {
  articleSectionMarkdown,
  extractInternalLinks,
  replaceArticleSection,
  stripTopLevelSections,
} from "../../markdown";
import {
  excludeBlacklistedSources,
  formatRagContextForPrompt,
  formatRelatedTitlesForPrompt,
  retrieveContext as retrieveContextLegacy,
  retrieveDirectArticleContext,
  mergeRetrievedContextPackets,
} from "../../retrieval";
import { toLegacyView } from "../../rag";
import { buildRagPromptTrace } from "../ragTrace";
import {
  findFuzzyTitleMatchesInEditText,
  findReferencedArticlesInEditText,
} from "../../editReferences";
import {
  normalizeMarkdown,
  renderMarkdown,
} from "../../markdown";
import { parsePartialArticleFrame } from "../../articleFrame";
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
    "rewriteMode",
  ] as const,
  run({ input }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    if (!slug) return { loadedArticle: null };

    const record = getArticleByLookup(deps.db, slug);
    if (!record) return { loadedArticle: null };

    const bodyOnly = stripTopLevelSections(record.markdown, ["References", "See also"]);
    const sectionId = input.targetSectionId ?? "";
    const selectedText = input.selectedText ?? "";

    let selectionRange: { start: number; end: number } | null = null;
    if (selectedText) {
      selectionRange = findSelectionRangeInMarkdown(record.markdown, selectedText);
    }

    const selectedMarkdown = selectionRange
      ? record.markdown.slice(selectionRange.start, selectionRange.end)
      : sectionId
        ? articleSectionMarkdown(record.markdown, sectionId)
        : bodyOnly;

    const isManualEdit = input.isManualEdit === true;
    const isProtected =
      !isManualEdit &&
      !sectionId &&
      !selectedText &&
      isArticleProtected(deps.db, slug);

    return {
      loadedArticle: {
        slug: record.slug,
        canonicalSlug: record.canonicalSlug,
        title: record.title,
        body: record.markdown,
        summary: record.summaryMarkdown ?? "",
        generatedAt: record.generated_at,
      },
      isProtected: !!isProtected,
      protectedSectionIds: listProtectedSections(deps.db, slug).map((s) => s.sectionId),
      selectedMarkdown,
      selectionRange: selectionRange ?? null,
      sectionId: sectionId || undefined,
      rewriteMode: input.rewriteModeName,
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
    const summaryCap = { enabled: rag.summary_cap_enabled, chars: rag.summary_cap_chars };
    const useEmbeddings = rag.enabled && deps.runtime.llm.embeddings.enabled;

    // Decode rewrite-specific options from instructions encoding.
    const explicitSlugs = [...(input.pinnedSlugs ?? []), ...(input.userReferenceSlugs ?? [])];
    const ragEnabled = input.ragEnabled === true;
    const ragQuery = input.ragQuery ?? "";
    // The article vibe is never used as a retrieval query — it is canonical
    // human-authored source, not a search prompt. Retrieval is driven only by
    // an explicit ragQuery (or the auto hints/backlinks branch below).
    const instructionsText = "";

    const hints = listIncomingHints(deps.db, slug);
    const backlinkSlugs = [...new Set(hints.map((h) => h.sourceSlug).filter(Boolean))];
    const priorRefs = loadPriorReferenceList(deps.db, slug) ?? [];
    const priorSlugs = priorRefs.map((r) => r.slug);

    const backlinkEntries = () =>
      backlinkSlugs.map((s) => {
        const a = getArticleByLookup(deps.db, s);
        return { slug: s, title: a?.title ?? s };
      });

    // ---- new LanceDB retrieval path (behind rag.use_lancedb_retrieval) ----
    // Collapses the three legacy branches: the unified retriever fuses semantic,
    // direct, and symbolic paths, so each branch only needs to supply a query
    // and the set of explicitly-referenced (direct) slugs.
    if (rag.use_lancedb_retrieval && deps.rag && useEmbeddings) {
      const hintStrings = hints.map((h) => h.hiddenHint);
      let directSlugs: string[];
      let queryText: string;
      if (explicitSlugs.length > 0) {
        directSlugs = [...new Set([...explicitSlugs, ...priorSlugs])];
        queryText =
          [loadedArticle?.title ?? "", loadedArticle?.body.slice(0, 500) ?? ""]
            .filter(Boolean)
            .join("\n\n") || slug;
      } else if (ragEnabled) {
        const editReferences = findReferencedArticlesInEditText(deps.db, ragQuery, slug);
        const fuzzyTitleMatches = findFuzzyTitleMatchesInEditText(
          deps.db,
          ragQuery,
          slug,
          rag.max_results,
          editReferences.articles.map((a) => a.slug),
        );
        directSlugs = [
          ...new Set([
            ...priorSlugs,
            ...editReferences.articles.map((a) => a.slug),
            ...fuzzyTitleMatches.map((a) => a.slug),
          ]),
        ];
        queryText = (ragQuery || hintStrings.join("\n")) || slug;
      } else {
        directSlugs = backlinkSlugs;
        queryText =
          [loadedArticle?.title ?? "", loadedArticle?.body.slice(0, 500) ?? "", ...hintStrings]
            .filter(Boolean)
            .join("\n") || slug;
      }
      const result = await deps.rag.retrieve({
        targetSlug: slug,
        queryText,
        directSlugs,
        profile: "article_rewrite",
      });
      const view = toLegacyView(result);
      return {
        retrievedContext: excludeBlacklistedSources(
          deps.db,
          slug,
          {
            sourceArticles: view.sourceArticles,
            ragTitles: view.relatedTitles,
            backlinks: backlinkEntries(),
            embedding: view.embedding,
          },
          input.blacklistSlugs ?? [],
        ),
      };
    }

    let retrieved: RetrievedContext;

    if (explicitSlugs.length > 0) {
      // User-selected refs: load directly, merge with prior refs for continuity.
      const allDirect = [...new Set([...explicitSlugs, ...priorSlugs])];
      const direct = retrieveDirectArticleContext(deps.db, slug, allDirect, rag.mode, rag.max_results, deps.logger, { maxChunksPerArticle: rag.direct_chunks_per_article, summaryCap });
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
        deps.db, deps.llm, slug,
        query ? [query] : hintStrings,
        rag.enabled, rag.mode, rag.max_results, rag.min_score,
        useEmbeddings, deps.logger, query || undefined, summaryCap,
      );
      const editReferences = findReferencedArticlesInEditText(
        deps.db,
        `${ragQuery} ${instructionsText}`,
        slug,
      );
      const fuzzyTitleMatches = findFuzzyTitleMatchesInEditText(
        deps.db,
        `${query} ${instructionsText}`,
        slug,
        rag.max_results,
        editReferences.articles.map((a) => a.slug),
      );
      const directSlugs = [
        ...new Set([
          ...priorSlugs,
          ...editReferences.articles.map((a) => a.slug),
          ...fuzzyTitleMatches.map((a) => a.slug),
        ]),
      ];
      const direct = directSlugs.length
        ? retrieveDirectArticleContext(
            deps.db,
            slug,
            directSlugs,
            rag.mode,
            rag.max_results,
            deps.logger,
            { maxChunksPerArticle: rag.direct_chunks_per_article, summaryCap },
          )
        : { context: "", relatedTitles: [], sourceArticles: [] };
      const merged = mergeRetrievedContextPackets(direct, packet);
      retrieved = {
        sourceArticles: merged.sourceArticles,
        ragTitles: merged.relatedTitles,
        backlinks: backlinkSlugs.map((s) => {
          const a = getArticleByLookup(deps.db, s);
          return { slug: s, title: a?.title ?? s };
        }),
        embedding: merged.embedding,
      };
    } else {
      // Auto: backlinks + hint-based retrieval.
      const hintStrings = hints.map((h) => h.hiddenHint);
      const queryOverride = [loadedArticle?.title ?? "", loadedArticle?.body.slice(0, 500) ?? ""].filter(Boolean).join("\n\n");
      const primary = await retrieveContextLegacy(
        deps.db, deps.llm, slug, hintStrings,
        rag.enabled, rag.mode, rag.max_results, rag.min_score,
        useEmbeddings, deps.logger, queryOverride, summaryCap,
      );
      const direct = backlinkSlugs.length
        ? retrieveDirectArticleContext(deps.db, slug, backlinkSlugs, rag.mode, rag.max_results, deps.logger, { maxChunksPerArticle: rag.direct_chunks_per_article, summaryCap })
        : { context: "", relatedTitles: [], sourceArticles: [] };
      const merged = mergeRetrievedContextPackets(primary, direct);
      retrieved = {
        sourceArticles: merged.sourceArticles,
        ragTitles: merged.relatedTitles,
        backlinks: backlinkSlugs.map((s) => {
          const a = getArticleByLookup(deps.db, s);
          return { slug: s, title: a?.title ?? s };
        }),
        embedding: merged.embedding,
      };
    }

    return {
      retrievedContext: excludeBlacklistedSources(
        deps.db,
        slug,
        retrieved,
        input.blacklistSlugs ?? [],
      ),
    };
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

    const pinnedSet = new Set((input.pinnedSlugs ?? []).map(slugify).filter(Boolean));
    const explicitSlugs = [...(input.pinnedSlugs ?? []), ...(input.userReferenceSlugs ?? [])].map(slugify).filter(Boolean);
    const blacklistSlugs = (input.blacklistSlugs ?? []).map(slugify).filter(Boolean);
    const isPartial = !!(selectionRange || sectionId);
    const priorRefs = loadPriorReferenceList(deps.db, slug) ?? [];
    const priorSlugs = priorRefs.map((r) => r.slug);
    const newExplicit = explicitSlugs.filter((s) => !priorSlugs.includes(s));
    // For a full rewrite, only refs the user added THIS request (or pinned)
    // count as user additions — already-saved priors flow through
    // priorReferences and get reranked. Partial (section/selection) edits keep
    // the full prior set so refs anchored outside the edited region survive.
    const newOrPinned = explicitSlugs.filter((s) => pinnedSet.has(s) || !priorSlugs.includes(s));
    const effectiveExplicit = isPartial
      ? [...new Set([...priorSlugs, ...newExplicit])]
      : newOrPinned;

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
        // Blocked refs are excluded in all edit modes — partial edits included
        // (they previously dropped the blacklist, letting blocked refs return).
        blacklistSlugs,
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
    "selectionRange",
    "sectionId",
    "references",
    "retrievedContext",
    "rewriteMode",
    "recentEditHistory",
    "articleVibe",
  ] as const,
  writes: ["renderedPrompt", "ragPromptTrace"] as const,
  run({ input, loadedArticle, selectedMarkdown, selectionRange, sectionId, references, retrievedContext, rewriteMode, recentEditHistory, articleVibe }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    const title = loadedArticle?.title ?? input.requestedTitle ?? slug;
    const refs = (references ?? []).map((r) => fromStateEntry(r, "current"));
    const hints = listIncomingHints(deps.db, slug);
    const requestedMode = rewriteMode ?? input.rewriteModeName ?? "aggressive";
    const modePrompt =
      deps.runtime.prompts.rewriteModes?.[requestedMode]?.prompt ??
      deps.runtime.prompts.rewriteModes?.aggressive?.prompt ??
      "";
    // The article vibe (human-authored canonical source) is the rewrite
    // instruction: the model conforms the article to it at the chosen
    // magnitude. Per-edit free-text instructions no longer exist.
    const instructions = (articleVibe ?? "").trim();

    // For partial edits (section or selection), feed only the targeted fragment
    // as current_article so the model returns just that fragment. For full rewrites,
    // pass the whole body as usual.
    const isPartial = !!(selectionRange || sectionId);
    const currentArticle = isPartial
      ? (selectedMarkdown ?? "")
      : loadedArticle
        ? stripTopLevelSections(loadedArticle.body, ["References", "See also"])
        : "";
    // Scope-specific constraints: fragment-return rules only appear for
    // partial edits — including them on whole-article rewrites primed the
    // model to sometimes return a fragment. Text lives in TOML (shared/
    // rewrite_scope_*.toml); code only selects which one applies.
    const scopeRules =
      deps.runtime.prompts.shared[isPartial ? "rewrite_scope_partial" : "rewrite_scope_full"]
        ?.system ?? "";

    const linkHints = formatIncomingHintsForPrompt(hints, slug, deps.runtime.app.rag.prompt_link_hints_max);
    const referencesPromptText = formatReferencesForPromptText(
      refs,
      deps.runtime.app.rag.prompt_ref_content_min_score,
      deps.runtime.app.rag.prompt_ref_content_top_k,
    );
    const ragContext = formatRagContextForPrompt(
      retrievedContext?.sourceArticles ?? [],
      deps.runtime.app.rag.prompt_context_max_chars,
    );
    // Per-section size breakdown — the first thing to look at when
    // llm.stream_request reports an oversized prompt_chars.
    deps.logger.debug("rewrite.prompt_sections", {
      slug,
      current_article_chars: currentArticle.length,
      rag_context_chars: ragContext.length,
      rag_sources: retrievedContext?.sourceArticles?.length ?? 0,
      references_chars: referencesPromptText.length,
      refs: refs.length,
      link_hints_chars: linkHints.length,
      hints_total: hints.length,
    });

    const relatedTitles = formatRelatedTitlesForPrompt(
      retrievedContext?.ragTitles ?? [],
      retrievedContext?.sourceArticles ?? [],
    );

    const rendered = deps.prompts.render("article_rewrite", {
      slug,
      requested_title: title,
      current_article: currentArticle,
      selected_text: selectedMarkdown ?? "",
      edit_instructions: instructions,
      rewrite_mode: modePrompt,
      rewrite_scope_rules: scopeRules.trim(),
      link_hints: linkHints,
      references_list: formatReferencesForPrompt(refs),
      references_prompt_text: referencesPromptText,
      recent_edit_history: recentEditHistory?.trim()
        ? `Recent edit history, oldest to newest:\n${recentEditHistory}`
        : "",
      rag_context: ragContext || "(none)",
      related_titles: relatedTitles,
      article_excerpt: selectedMarkdown?.slice(0, 2000) ?? "",
      parent_comment: "",
    });
    return {
      renderedPrompt: rendered,
      ragPromptTrace: buildRagPromptTrace({
        promptKey: "article_rewrite",
        evidenceContext: ragContext || "(none)",
        linkAllowlist: referencesPromptText,
        relatedTitles,
        linkHints,
        retrievedContext,
      }),
    };
  },
});

// ─── LLM: call rewrite model ─────────────────────────────────────────────────

export const callRewriteModelNode = defineNode({
  name: "llm.rewrite_article",
  kind: "llm",
  description: "Call article_rewrite model (streams when onProgress set).",
  reads: ["renderedPrompt"] as const,
  writes: ["llmOutput"] as const,
  async run({ renderedPrompt }, deps: PipelineDeps) {
    if (!renderedPrompt) throw new Error("llm.rewrite_article: missing renderedPrompt");
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
    "isProtected",
  ] as const,
  writes: ["rawArticleBody"] as const,
  run({ rawArticleBody, loadedArticle, selectionRange, sectionId, isProtected }, deps: PipelineDeps) {
    const generated = rawArticleBody ?? "";
    const fullMarkdown = loadedArticle?.body ?? "";

    if (isProtected) {
      return { rawArticleBody: fullMarkdown };
    }

    if (selectionRange) {
      // Selection edit: the model should return only the replacement fragment.
      // If the model leaked the full article (contains a top-level heading when the
      // selection had none, or is dramatically longer than the selection), extract
      // just the text between the first and last heading-free region as a best
      // effort — otherwise use as-is for simple inline replacements.
      const selectedLen = selectionRange.end - selectionRange.start;
      const looksLikeFullArticle =
        /^#\s/m.test(generated) && selectedLen < generated.length / 2;
      const fragment = looksLikeFullArticle
        ? (() => {
            deps.logger.warn("splice.selection_leak_detected", {
              slug: loadedArticle?.slug,
              selected_len: selectedLen,
              generated_len: generated.length,
            });
            // Strip title heading and top-level sections, return the lead prose.
            return stripTopLevelSections(generated, ["References", "See also"])
              .replace(/^#[^\n]*\n+/, "")
              .trim();
          })()
        : generated;
      const spliced =
        fullMarkdown.slice(0, selectionRange.start) +
        fragment +
        fullMarkdown.slice(selectionRange.end);
      return { rawArticleBody: spliced };
    }

    if (sectionId) {
      // Section rewrite: if the model returned a full article instead of just the
      // section, extract only the target section from the output before splicing.
      const looksLikeFullArticle = /^#\s/m.test(generated);
      const fragment = looksLikeFullArticle
        ? (() => {
            const extracted = articleSectionMarkdown(generated, sectionId);
            if (extracted !== generated) {
              deps.logger.warn("splice.section_leak_detected", {
                slug: loadedArticle?.slug,
                sectionId,
                generated_len: generated.length,
                extracted_len: extracted.length,
              });
            }
            return extracted;
          })()
        : generated;
      return {
        rawArticleBody: replaceArticleSection(fullMarkdown, sectionId, fragment),
      };
    }

    // Full rewrite — generated body replaces the whole article.
    return { rawArticleBody: generated };
  },
});
