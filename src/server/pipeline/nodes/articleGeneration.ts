/**
 * Node set for the article-generation workflow.
 *
 * Every node:
 *   - declares its `reads` and `writes` exactly (enforced by `defineNode`),
 *   - performs a single, named transformation,
 *   - returns a `patch` of the declared write fields — never mutates state,
 *   - and is independently unit-testable by passing a stub deps bag.
 *
 * Where legacy logic lives in `src/server/*` we delegate via narrow function
 * calls; the long-term direction is to inline the logic here so that each
 * node is self-contained and the graph is the single source of truth.
 */

import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps } from "../deps";
import { loadArticle } from "../../article";
import {
  listArticleRevisions,
  saveArticle,
  saveArticleReferences,
  saveArticleSeeAlso,
  getLatestArticleReferences,
  getArticleByLookup,
  getArticleHeadlineMedia,
  getArticleInfobox,
  getArticleVibe,
  type IncomingHint,
  listIncomingHints,
} from "../../db";
import { getMediaById } from "../../mediaDb";
import {
  excludeBlacklistedSources,
  formatRagContextForPrompt,
  formatRelatedTitlesForPrompt,
  retrieveContext as retrieveContextLegacy,
  retrieveDirectArticleContext,
  mergeRetrievedContextPackets,
} from "../../retrieval";
import {
  buildReferenceList,
  convertExistingArticleLinksToRefs,
  findBodyReferencedArticles,
  linkReferences,
  loadPriorReferenceList,

  formatReferencesForPromptText,
} from "../../referenceList";
import {
  cleanLinkLabels,
  extractInternalLinks,
  extractTitle,
  extractDisplayTitle,
  ensureLeadingTitleHeading,
  fixSlugVisibleText,
  markdownToPlainText,
  normalizeMarkdown,
  renderMarkdown,
  stripFootnoteArtifacts,
  stripSelfLinks,
  stripTopLevelSections,
  summaryMarkdownFromArticle,
} from "../../markdown";
import {
  normalizeCanonicalTitle,
  slugify,
  titleToWikiSegment,
} from "../../slug";
import { normalizeMarkdownLinks } from "../../text/linkNormalize";
import { formatIncomingHintsForPrompt } from "../../linkHints";
import { extractRefLinksAsInternalLinks } from "../../referenceList";
import {
  parseArticleFrameOutput,
  parsePartialArticleFrame,
} from "../../articleFrame";
import type {
  ReferenceList,
  ReferenceListEntry,
  ArticleRecord,
} from "../../types";
import type { ReferenceEntry } from "../state";
import { hashValue } from "../runtime/trace";

// ─── READ nodes ──────────────────────────────────────────────────────────────

export const readArticleNode = defineNode({
  name: "read.article",
  kind: "read",
  description: "Load the requested article (if any) from the article DB.",
  reads: ["input"] as const,
  writes: ["loadedArticle"] as const,
  run({ input }, deps: PipelineDeps) {
    if (!input.slug) return { loadedArticle: null };
    const article = loadArticle(deps.db, input.slug);
    if (!article) return { loadedArticle: null };
    return {
      loadedArticle: {
        slug: article.slug,
        canonicalSlug: article.canonicalSlug,
        title: article.title,
        body: article.body,
        summary: article.summary,
        generatedAt: article.generatedAt,
      },
    };
  },
});

export const readRecentEditHistoryNode = defineNode({
  name: "read.edit_history",
  kind: "read",
  description: "Format the two most recent edit revisions for prompt context.",
  reads: ["input"] as const,
  writes: ["recentEditHistory"] as const,
  run({ input }, deps: PipelineDeps) {
    if (input.includeRecentEditHistory !== true) {
      return { recentEditHistory: "" };
    }
    if (!input.slug) return { recentEditHistory: "" };
    const revisions = listArticleRevisions(deps.db, input.slug);
    const recent = revisions
      .filter((r) => r.instructions && r.instructions.trim().length > 0)
      .slice(0, 2)
      .reverse();
    if (recent.length === 0) return { recentEditHistory: "" };
    return {
      recentEditHistory: recent
        .map(
          (r, i) =>
            `${i + 1}. ${new Date(r.createdAt).toISOString()} (${r.operation}): ${r.instructions.replace(/\s+/g, " ").trim()}`,
        )
        .join("\n"),
    };
  },
});

export const readArticleVibeNode = defineNode({
  name: "read.article_vibe",
  kind: "read",
  description:
    "Load the article's canonical vibe (human-authored ground truth). Never RAG'd.",
  reads: ["input"] as const,
  writes: ["articleVibe"] as const,
  run({ input }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    if (!slug) return { articleVibe: "" };
    return { articleVibe: getArticleVibe(deps.db, slug) };
  },
});

export const retrieveContextNode = defineNode({
  name: "read.retrieve_context",
  kind: "read",
  description:
    "Run RAG retrieval against article_chunks; merge direct-reference context.",
  reads: ["input", "loadedArticle"] as const,
  writes: ["retrievedContext"] as const,
  async run({ input, loadedArticle }, deps: PipelineDeps) {
    const slug = input.slug ?? "";
    const rag = deps.runtime.app.rag;
    const useEmbeddings =
      rag.enabled && deps.runtime.llm.embeddings.enabled;

    const hints: IncomingHint[] = slug
      ? listIncomingHints(deps.db, slug)
      : [];
    const hintStrings = hints.map((h) => h.hiddenHint);
    const queryOverride = loadedArticle
      ? [
          loadedArticle.title || input.requestedTitle || slug,
          loadedArticle.body.slice(0, 500),
        ].filter(Boolean).join("\n\n")
      : input.requestedTitle || slug;

    const primary = await retrieveContextLegacy(
      deps.db,
      deps.llm,
      slug,
      hintStrings,
      rag.enabled,
      rag.mode,
      rag.max_results,
      rag.min_score,
      useEmbeddings,
      deps.logger,
      queryOverride,
      { enabled: rag.summary_cap_enabled, chars: rag.summary_cap_chars },
    );

    const referencedSlugs = hints
      .map((h) => slugify(h.sourceSlug))
      .filter(Boolean);
    const direct = referencedSlugs.length
      ? retrieveDirectArticleContext(
          deps.db,
          slug,
          referencedSlugs,
          rag.mode,
          rag.max_results,
          deps.logger,
          {
            maxChunksPerArticle: rag.direct_chunks_per_article,
            summaryCap: { enabled: rag.summary_cap_enabled, chars: rag.summary_cap_chars },
          },
        )
      : { context: "", relatedTitles: [], sourceArticles: [] };

    const merged = mergeRetrievedContextPackets(primary, direct);

    return {
      retrievedContext: excludeBlacklistedSources(deps.db, slug, {
        sourceArticles: merged.sourceArticles.map((s) => ({
          slug: s.slug,
          title: s.title,
          content: s.content,
          score: s.score,
        })),
        ragTitles: merged.relatedTitles,
        backlinks: hints.map((h) => ({
          slug: h.sourceSlug,
          title: h.sourceTitle,
        })),
        embedding: merged.embedding,
      }, input.blacklistSlugs ?? []),
    };
  },
});

export const buildReferenceListNode = defineNode({
  name: "transform.build_reference_list",
  kind: "transform",
  description:
    "Construct the sidecar reference list algorithmically from RAG sources + prior refs + user inputs.",
  reads: ["input", "retrievedContext"] as const,
  writes: ["references", "priorReferences"] as const,
  run({ input, retrievedContext }, deps: PipelineDeps) {
    const slug = input.slug ?? "";
    if (!slug) return { references: [], priorReferences: [] };

    const pinnedSet = new Set((input.pinnedSlugs ?? []).map(slugify).filter(Boolean));
    const selectedReferenceSet = input.selectedReferenceSlugs
      ? new Set(input.selectedReferenceSlugs.map(slugify).filter(Boolean))
      : null;

    const ragSources = (retrievedContext?.sourceArticles ?? []).filter((s) =>
      selectedReferenceSet ? selectedReferenceSet.has(s.slug) : true,
    );

    const priorRefsRaw = loadPriorReferenceList(deps.db, slug) ?? [];
    const priorRefs = selectedReferenceSet
      ? priorRefsRaw.filter((r) => selectedReferenceSet.has(r.slug) || r.pinned)
      : priorRefsRaw;

    // Only slugs the user added in THIS request count as user additions. The
    // editor panel re-sends the whole reference list, so a selected slug that is
    // already a saved prior ref was added in an earlier run — it flows through
    // priorReferences and gets reranked. Pinned slugs are always kept here so
    // their pin is (re)applied even when they were already a prior ref.
    const priorSlugSet = new Set(priorRefs.map((r) => r.slug));
    const freshUserSlugs = (input.userReferenceSlugs ?? []).filter((raw) => {
      const s = slugify(raw);
      return pinnedSet.has(s) || !priorSlugSet.has(s);
    });

    const refs: ReferenceList = buildReferenceList(
      deps.db,
      {
        articleSlug: slug,
        ragSources,
        priorReferences: priorRefs,
        userAdditions: slugsToUserAdditions(deps.db, freshUserSlugs, pinnedSet),
        blacklistSlugs: input.blacklistSlugs ?? [],
        revisionId: "current",
        config: deps.runtime.app.rag,
      },
      deps.logger,
    );

    return {
      references: refs.map(toStateEntry),
      priorReferences: priorRefs.map(toStateEntry),
      // pinned tagging happens inside buildReferenceList already; pinnedSet
      // here is only used to influence persisting pinned bits downstream.
      ...({} as Record<string, never>),
    };
  },
});

export const useRawMarkdownInputNode = defineNode({
  name: "transform.use_raw_markdown_input",
  kind: "transform",
  description:
    "Use caller-provided markdown as the raw body for deterministic save workflows.",
  reads: ["input", "loadedArticle"] as const,
  writes: ["rawArticleBody", "articleSummary"] as const,
  run({ input, loadedArticle }) {
    const raw = input.rawMarkdown ?? "";
    if (!raw.trim()) {
      throw new Error("raw markdown input is empty");
    }
    return {
      rawArticleBody: raw,
      articleSummary:
        input.workflow === "article.add_link"
          ? loadedArticle?.summary ?? ""
          : undefined,
    };
  },
});

function toStateEntry(r: ReferenceListEntry): ReferenceEntry {
  return {
    slug: r.slug,
    title: r.title,
    content: r.content,
    kind: r.kind,
    pinned: r.pinned,
    score: r.score,
    source: r.source,
  };
}

function fromStateEntry(
  r: ReferenceEntry,
  revisionId: ReferenceListEntry["revisionId"] = "current",
): ReferenceListEntry {
  return {
    slug: r.slug,
    title: r.title,
    content: r.content,
    kind: r.kind,
    pinned: r.pinned,
    score: r.score,
    source: r.source,
    revisionId,
  };
}

function slugsToUserAdditions(
  db: PipelineDeps["db"],
  slugs: string[],
  pinnedSet: ReadonlySet<string>,
): ReferenceListEntry[] {
  const seen = new Set<string>();
  const refs: ReferenceListEntry[] = [];
  for (const raw of slugs) {
    const slug = slugify(raw);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const article = getArticleByLookup(db, slug);
    if (!article) continue;
    refs.push({
      slug: article.slug,
      title: article.title,
      content: article.summaryMarkdown || summaryMarkdownFromArticle(article.markdown),
      kind: "summary",
      source: pinnedSet.has(article.slug) ? "pinned" : "user",
      pinned: pinnedSet.has(article.slug),
      revisionId: "current",
    });
  }
  return refs;
}

// ─── READ: headline image context ────────────────────────────────────────────

export const readHeadlineImageNode = defineNode({
  name: "read.headline_image",
  kind: "read",
  description:
    "Load the current article's headline image description from article_media + media DB. " +
    "Kept for media-specific workflows; article text prompts do not consume it.",
  reads: ["input"] as const,
  writes: ["headlineImageContext"] as const,
  run({ input }, deps: PipelineDeps) {
    const slug = input.slug ?? "";
    if (!slug || !deps.mediaDb) return { headlineImageContext: "" };

    const headlineMedia = getArticleHeadlineMedia(deps.db, slug);
    if (!headlineMedia) return { headlineImageContext: "" };

    const record = getMediaById(deps.mediaDb, headlineMedia.mediaId);
    if (!record || !record.description) return { headlineImageContext: "" };

    const caption = headlineMedia.caption || record.description;
    const lines = [
      `This article has a headline image attached:`,
      `  Slug: img:${record.id}`,
      `  Description: ${record.description}`,
      `  Caption: ${caption}`,
    ];
    return { headlineImageContext: lines.join("\n") };
  },
});

export const readInfoboxRefsNode = defineNode({
  name: "read.infobox_refs",
  kind: "read",
  description:
    "Scan the article's infobox values for ref:slug links and merge the referenced " +
    "articles into the reference list. This ensures sidebar-linked articles are also " +
    "included in the prompt context and the references sidecar.",
  reads: ["input", "references"] as const,
  writes: ["references"] as const,
  run({ input, references }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    if (!slug) return { references };

    const infobox = getArticleInfobox(deps.db, slug);
    if (!infobox) return { references };

    const existing = new Set((references ?? []).map((r) => r.slug));
    const toAdd: ReferenceEntry[] = [];

    const REF_RE = /\[([^\]]+)\]\(ref:([a-z0-9-]+)\)/g;
    const allValues = [
      infobox.subtitle ?? "",
      ...(infobox.groups ?? []).flatMap((g) => (g.rows ?? []).map((r) => String(r.value ?? ""))),
    ];

    for (const val of allValues) {
      let m: RegExpExecArray | null;
      REF_RE.lastIndex = 0;
      while ((m = REF_RE.exec(val)) !== null) {
        const refSlug = m[2];
        if (existing.has(refSlug)) continue;
        const article = getArticleByLookup(deps.db, refSlug);
        if (!article) continue;
        existing.add(refSlug);
        toAdd.push({
          slug: article.slug,
          title: article.title,
          content: article.summaryMarkdown ?? summaryMarkdownFromArticle(article.markdown),
          kind: "summary",
          pinned: false,
          source: "body",
        });
      }
    }

    if (toAdd.length === 0) return { references };
    return { references: [...(references ?? []), ...toAdd] };
  },
});

/**
 * Wrap the article vibe in a canonical-source block, or "" when empty. The
 * block is framed as human-authored ground truth so generation treats it as
 * fact rather than a suggestion. Empty vibe leaves no dangling header.
 */
export function formatArticleVibeForPrompt(vibe: string | undefined): string {
  const trimmed = (vibe ?? "").trim();
  if (!trimmed) return "";
  return [
    "Canonical source for this article (human-authored ground truth — treat as",
    "fact; do not contradict or hedge against it):",
    "",
    trimmed,
  ].join("\n");
}

// ─── LLM nodes ───────────────────────────────────────────────────────────────

export const renderArticlePromptNode = defineNode({
  name: "transform.render_article_prompt",
  kind: "transform",
  description: "Render the `article` prompt with all prepared variables.",
  reads: [
    "input",
    "references",
    "retrievedContext",
    "recentEditHistory",
    "articleVibe",
  ] as const,
  writes: ["renderedPrompt"] as const,
  run(
    { input, references, retrievedContext, recentEditHistory, articleVibe },
    deps: PipelineDeps,
  ) {
    const refs = (references ?? []).map((r) =>
      fromStateEntry(r, "current"),
    );
    const linkHints = (retrievedContext?.backlinks ?? [])
      .slice(0, deps.runtime.app.rag.prompt_link_hints_max)
      .map((b) => `- [${b.title}](halu:${b.slug})`)
      .join("\n");

    const rendered = deps.prompts.render("article", {
      slug: input.slug ?? "",
      requested_title: input.requestedTitle ?? "",
      references_prompt_text: formatReferencesForPromptText(
        refs,
        deps.runtime.app.rag.prompt_ref_content_min_score,
        deps.runtime.app.rag.prompt_ref_content_top_k,
      ),
      rag_context: formatRagContextForPrompt(
        retrievedContext?.sourceArticles ?? [],
        deps.runtime.app.rag.prompt_context_max_chars,
      ),
      related_titles: formatRelatedTitlesForPrompt(
        retrievedContext?.ragTitles ?? [],
        retrievedContext?.sourceArticles ?? [],
      ),
      recent_edit_history: recentEditHistory ?? "",
      link_hints: linkHints || "(none)",
      article_vibe: formatArticleVibeForPrompt(articleVibe),
    });
    return { renderedPrompt: rendered };
  },
});

export const callArticleModelNode = defineNode({
  name: "llm.generate_article",
  kind: "llm",
  description: "Call the configured chat model with the rendered prompt (streams when onProgress set).",
  reads: ["renderedPrompt"] as const,
  writes: ["llmOutput"] as const,
  async run({ renderedPrompt }, deps: PipelineDeps) {
    if (!renderedPrompt) {
      throw new Error("llm.generate_article: renderedPrompt missing");
    }
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
          const partialBody = parsePartialArticleFrame(accumulated);
          if (!partialBody || !deps.onProgress) return;
          const preview = normalizeMarkdown(partialBody);
          deps.onProgress(renderMarkdown(preview), preview);
        },
        {
          thinking: renderedPrompt.thinking,
          ...(deps.onReasoningDelta ? { onReasoningDelta: deps.onReasoningDelta } : {}),
        },
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

// ─── Deterministic transform nodes ───────────────────────────────────────────

export const extractArticleBodyNode = defineNode({
  name: "transform.extract_body",
  kind: "transform",
  description:
    "Parse LLM frame output (---body marker) into prose-only markdown. Used-refs section is ignored — refs are built from body scan instead.",
  reads: ["llmOutput"] as const,
  writes: ["rawArticleBody"] as const,
  run({ llmOutput }, deps: PipelineDeps) {
    if (!llmOutput) {
      throw new Error("transform.extract_body: llmOutput missing");
    }
    const { body } = parseArticleFrameOutput(llmOutput.text, undefined, undefined, deps.logger);
    // Truncated response + trivially short body = don't save garbage over a good article.
    if (llmOutput.finishReason === "length" && body.length < 100) {
      throw new Error(`transform.extract_body: LLM response truncated (finish_reason=length, body_chars=${body.length}); aborting to preserve existing article`);
    }
    return { rawArticleBody: body };
  },
});

const USED_REFS_HEADING_ALIASES = [
  "References",
  "See also",
  "Used References",
  "Used Refs",
  "References Used",
  "Refs Used",
  "Reference List",
  "Sources",
  "Bibliography",
];

const PRESERVE_EXISTING_ARTICLE_SLUG_WORKFLOWS = new Set([
  "article.rewrite",
  "article.refresh",
  "article.raw_save",
  "article.add_link",
]);

export const sanitizeBodyNode = defineNode({
  name: "transform.sanitize_body",
  kind: "transform",
  description:
    "Strip metadata sections, footnote artifacts, slug-like labels, fences.",
  reads: ["rawArticleBody"] as const,
  writes: ["articleBody"] as const,
  run({ rawArticleBody }) {
    const raw = rawArticleBody ?? "";
    const normalized = normalizeMarkdown(raw);
    const sanitized = fixSlugVisibleText(
      stripFootnoteArtifacts(
        stripTopLevelSections(normalized, USED_REFS_HEADING_ALIASES),
      ),
    );
    return { articleBody: sanitized };
  },
});

export const cleanLinkLabelsNode = defineNode({
  name: "transform.clean_link_labels",
  kind: "transform",
  description:
    "Strip embedded link-syntax artifacts from visible label text (e.g. 'Label (halu:slug)' → 'Label').",
  reads: ["articleBody"] as const,
  writes: ["articleBody"] as const,
  run({ articleBody }) {
    return { articleBody: cleanLinkLabels(articleBody ?? "") };
  },
});

export const deriveIdentityNode = defineNode({
  name: "transform.derive_identity",
  kind: "transform",
  description:
    "Compute canonical slug/title and optional display title from sanitized body.",
  reads: ["articleBody", "input"] as const,
  writes: ["canonicalSlug", "canonicalTitle", "displayTitle"] as const,
  run({ articleBody, input }) {
    const requestedTitle = input.requestedTitle ?? "";
    const requestedSlug = slugify(input.slug ?? "");
    const body = articleBody ?? "";
    const requestedCanonicalTitle = normalizeCanonicalTitle(requestedTitle);
    const rawDisplayTitle = extractDisplayTitle(body);
    const resolvedTitle = normalizeCanonicalTitle(
      extractTitle(body, requestedTitle),
    );
    if (PRESERVE_EXISTING_ARTICLE_SLUG_WORKFLOWS.has(input.workflow)) {
      const rawDisplayPlainTitle = rawDisplayTitle
        ? normalizeCanonicalTitle(extractTitle(`# ${rawDisplayTitle}`, requestedTitle))
        : "";
      return {
        canonicalSlug: input.slug?.trim() || requestedSlug,
        canonicalTitle: requestedCanonicalTitle,
        displayTitle:
          rawDisplayTitle && rawDisplayPlainTitle === requestedCanonicalTitle
            ? rawDisplayTitle
            : undefined,
      };
    }
    // Promote LLM-suggested title only if it's a strict refinement of the
    // requested slug AND contains non-ASCII characters (the legacy
    // `shouldPromoteResolvedTitle` heuristic preserved verbatim).
    const resolvedSlug = slugify(resolvedTitle);
    const promote =
      resolvedSlug &&
      resolvedSlug !== requestedSlug &&
      resolvedSlug.startsWith(`${requestedSlug}-`) &&
      /[^\x00-\x7F]/.test(resolvedSlug);
    const canonicalTitle = promote ? resolvedTitle : requestedCanonicalTitle;
    const canonicalSlug = slugify(canonicalTitle) || requestedSlug;
    const rawDisplayPlainTitle = rawDisplayTitle
      ? normalizeCanonicalTitle(extractTitle(`# ${rawDisplayTitle}`, requestedTitle))
      : "";
    const displayTitle =
      rawDisplayTitle && rawDisplayPlainTitle === requestedCanonicalTitle
        ? rawDisplayTitle
        : undefined;
    return { canonicalSlug, canonicalTitle, displayTitle };
  },
});

export const resolveLinksNode = defineNode({
  name: "transform.resolve_links",
  kind: "transform",
  description:
    "Resolve ref:/halu: links, link exact title mentions, convert existing-article halu→ref, strip self-links.",
  reads: ["articleBody", "references", "canonicalSlug", "canonicalTitle"] as const,
  writes: ["finalArticleBody", "references"] as const,
  run({ articleBody, references, canonicalSlug, canonicalTitle }, deps: PipelineDeps) {
    let body = articleBody ?? "";
    const refs = (references ?? []).map((r) => fromStateEntry(r, "current"));
    const slug = canonicalSlug ?? "";

    // Enforce that the article opens with the canonical title as its H1 (the
    // model sometimes leads with prose or a bold restatement). Done before link
    // resolution so the title line participates in the same self-link strip pass.
    if (canonicalTitle) {
      body = ensureLeadingTitleHeading(body, canonicalTitle);
    }

    body = normalizeMarkdownLinks(body, "article").markdown;
    body = linkReferences(body, refs, slug, deps.db);
    body = convertExistingArticleLinksToRefs(deps.db, body, slug);
    body = stripSelfLinks(body, slug);

    const mergedRefs = new Map<string, ReferenceEntry>();
    for (const ref of references ?? []) {
      mergedRefs.set(ref.slug, ref);
    }
    for (const ref of findBodyReferencedArticles(deps.db, body, slug)) {
      if (!mergedRefs.has(ref.slug)) {
        mergedRefs.set(ref.slug, toStateEntry(ref));
      }
    }

    return { finalArticleBody: body, references: [...mergedRefs.values()] };
  },
});

// ─── LLM: summary generation ─────────────────────────────────────────────────

export const generateSummaryNode = defineNode({
  name: "llm.generate_summary",
  kind: "llm",
  description: "Generate the article summary via the article_summary prompt.",
  reads: ["finalArticleBody", "canonicalTitle", "input"] as const,
  writes: ["articleSummary"] as const,
  async run({ finalArticleBody, canonicalTitle, input }, deps: PipelineDeps) {
    const body = finalArticleBody ?? "";
    if (!body) return { articleSummary: "" };
    const trimmed = stripTopLevelSections(body, ["References", "See also"]).slice(
      0,
      12_000,
    );
    const rendered = deps.prompts.render("article_summary", {
      slug: slugify(input.slug ?? ""),
      requested_title: canonicalTitle ?? input.requestedTitle ?? "",
      current_article: trimmed,
      previous_summary: "(none)",
      summary_feedback: "(none)",
      article_excerpt: trimmed,
      full_article: trimmed,
    });
    const summaryRole = rendered.role ?? "heavy";
    try {
      const raw = await deps.llm.chat(summaryRole, rendered.system, rendered.user, {
        thinking: rendered.thinking,
        jsonMode: rendered.json,
      });
      return { articleSummary: raw.trim() };
    } catch (err) {
      deps.logger.warn("pipeline.summary.fallback", {
        slug: input.slug ?? "",
        error: err instanceof Error ? err.message : String(err),
      });
      return { articleSummary: summaryMarkdownFromArticle(body) };
    }
  },
});

// ─── Validation ──────────────────────────────────────────────────────────────

export const validateBodyNode = defineNode({
  name: "validate.body_invariants",
  kind: "validate",
  description:
    "Assert body has no References/See-also sections and matches subject.",
  reads: ["finalArticleBody", "input", "canonicalSlug"] as const,
  writes: ["validationIssues"] as const,
  run({ finalArticleBody, input, canonicalSlug }) {
    const issues = [];
    const body = finalArticleBody ?? "";
    if (/^#{2,6}\s+(references|see also):?\s*#*\s*$/im.test(body)) {
      issues.push({
        code: "metadata_section_in_body",
        severity: "error" as const,
        message:
          "Body markdown contains a References/See-also section; metadata must be sidecar.",
      });
    }
    if (!body.trim()) {
      issues.push({
        code: "empty_body",
        severity: "error" as const,
        message: "Final body markdown is empty.",
      });
    }
    const requestedSlug = slugify(input.slug ?? "");
    if (canonicalSlug && requestedSlug && canonicalSlug !== requestedSlug) {
      // Not necessarily an error — sometimes the LLM legitimately disambiguates
      // a non-ASCII title — but worth surfacing as info.
      issues.push({
        code: "canonical_slug_changed",
        severity: "info" as const,
        message: `Canonical slug differs from requested (${requestedSlug} → ${canonicalSlug}).`,
      });
    }
    return { validationIssues: issues };
  },
});

// ─── Write ───────────────────────────────────────────────────────────────────

export const persistArticleNode = defineNode({
  name: "write.persist_article",
  kind: "write",
  description:
    "Save body, sidecar references, sidecar see-also, summary; insert revision row.",
  reads: [
    "input",
    "finalArticleBody",
    "references",
    "seeAlso",
    "articleSummary",
    "canonicalSlug",
    "canonicalTitle",
    "displayTitle",
  ] as const,
  writes: ["persistedAt"] as const,
  run(
    {
      input,
      finalArticleBody,
      references,
      seeAlso,
      articleSummary,
      canonicalSlug,
      canonicalTitle,
      displayTitle,
    },
    deps: PipelineDeps,
  ) {
    const slug = canonicalSlug ?? slugify(input.slug ?? "");
    if (!slug) throw new Error("write.persist_article: missing slug");
    const title = canonicalTitle ?? input.requestedTitle ?? slug;
    const body = finalArticleBody ?? "";
    const now = Date.now();
    const html = renderMarkdown(body);
    const plainText = markdownToPlainText(body);

    const haluLinks = extractInternalLinks(body);
    const haluSlugs = new Set(haluLinks.map((l) => l.targetSlug));
    const refLinks = extractRefLinksAsInternalLinks(deps.db, body, slug).filter(
      (l) => !haluSlugs.has(l.targetSlug),
    );
    const links = [...haluLinks, ...refLinks];

    const record: ArticleRecord = {
      slug,
      canonicalSlug: slug,
      title,
      displayTitle,
      markdown: body,
      html,
      summaryMarkdown:
        articleSummary?.trim() || summaryMarkdownFromArticle(body),
      plain_text: plainText,
      generated_at: now,
    };

    const aliases = Array.from(new Set([slug, slugify(input.slug ?? slug)]));
    saveArticle(deps.db, record, links, aliases, {
      operation: revisionOperationForInput(input),
      instructions: input.instructions ?? "",
    });

    const refs = (references ?? []).map((r) => ({
      slug: r.slug,
      title: r.title,
      content: r.content,
      kind: r.kind,
      pinned: r.pinned,
      score: r.score,
      source: r.source,
      revisionId: "current" as const,
    }));
    saveArticleReferences(deps.db, slug, now, refs);

    if (seeAlso && seeAlso.length > 0) {
      saveArticleSeeAlso(
        deps.db,
        slug,
        now,
        seeAlso.map((s) => ({ slug: s.slug, title: s.title, hint: s.hint })),
      );
    }

    deps.logger.info("pipeline.persist.ok", {
      slug,
      title,
      links: links.length,
      refs: refs.length,
      see_also: seeAlso?.length ?? 0,
      html_chars: html.length,
      // url surfaced so the trace UI can deeplink to the rendered article
      url: `/wiki/${titleToWikiSegment(normalizeCanonicalTitle(title))}`,
    });

    return { persistedAt: now };
  },
});

function revisionOperationForInput(input: { workflow: string; selectedText?: string; targetSectionId?: string }): string {
  if (input.workflow === "article.generate") return "generate";
  if (input.workflow === "article.refresh") return "refresh-context-rewrite";
  if (input.workflow === "article.raw_save") return "raw-edit";
  if (input.workflow === "article.add_link") return "add-link";
  if (input.workflow === "article.rewrite") {
    if (input.selectedText) return "selection-edit";
    if (input.targetSectionId) return "section-rewrite";
    return "rewrite";
  }
  return input.workflow;
}
