/**
 * Node set for the article.post_process workflow.
 *
 * Post-processing runs asynchronously after any write workflow completes
 * (generation, refresh, rewrite). It enriches the saved article with:
 *
 *   - LLM-backed malformed-link repair (body only, light model)
 *   - Rebuilt reference sidecar (deterministic, algorithmic)
 *   - See-also suggestions (LLM, with deterministic filtering + retry)
 *   - Article summary (LLM, light model, with fallback)
 *   - RAG chunk re-indexing
 *
 * Staleness guards prevent a concurrent edit from being overwritten by
 * a post-process pass that started before the edit landed.
 */

import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps, SidecarUpdateEvent } from "../deps";
import {
  getArticleByLookup,
  getArticleInfobox,
  listIncomingHints,
  normalizeInfoboxData,
  saveArticleSeeAlso,
  setArticleInfobox,
  getArticleHeadlineMedia,
  updateArticleInPlace,
  updateArticleMediaCaption,
  type InfoboxData,
} from "../../db";
import { getMediaById } from "../../mediaDb";
import {
  buildReferenceList,
  convertExistingArticleLinksToRefs,
  extractRefLinksAsInternalLinks,
  findBodyReferencedArticles,
  linkReferences,
  loadPriorReferenceList,
} from "../../referenceList";
import {
  extractInternalLinks,
  markdownToPlainText,
  renderMarkdown,
  stripSelfLinks,
  stripTopLevelSections,
  summaryMarkdownFromArticle,
} from "../../markdown";
import { normalizeMarkdownLinks } from "../../text/linkNormalize";
import {
  retrieveDirectArticleContext,
  mergeRetrievedContextPackets,
  indexArticleChunks,
  flattenInfoboxForRag,
} from "../../retrieval";
import { slugify } from "../../slug";
import type { ReferenceEntry } from "../state";
import type { ReferenceListEntry } from "../../types";
import { hashValue } from "../runtime/trace";

// ─── helpers ─────────────────────────────────────────────────────────────────

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
  return { ...r, revisionId };
}

// ─── READ: reload the now-saved article ──────────────────────────────────────

export const reloadSavedArticleNode = defineNode({
  name: "read.reload_article",
  kind: "read",
  description: "Reload article from DB after the prior save. Provides staleness guard timestamp.",
  reads: ["input", "persistedAt"] as const,
  writes: ["loadedArticle", "postProcessExpectedGeneratedAt"] as const,
  run({ input, persistedAt }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    if (!slug) return { loadedArticle: null };
    const record = getArticleByLookup(deps.db, slug);
    if (!record) return { loadedArticle: null };
    return {
      loadedArticle: {
        slug: record.slug,
        canonicalSlug: record.canonicalSlug,
        title: record.title,
        body: record.markdown,
        summary: record.summaryMarkdown ?? "",
        generatedAt: record.generated_at,
      },
      postProcessExpectedGeneratedAt: persistedAt ?? record.generated_at,
    };
  },
});

// ─── TRANSFORM: load body for post-process ────────────────────────────────────
// Strips derived metadata sections so downstream nodes only see the editable body.
// LLM link repair belongs to the refresh workflow (single full-body rewrite call).

export const repairLinksNode = defineNode({
  name: "transform.load_body",
  kind: "transform",
  description: "Strip metadata sections (References, See also) from the loaded article body.",
  reads: ["loadedArticle"] as const,
  writes: ["finalArticleBody"] as const,
  run({ loadedArticle }) {
    if (!loadedArticle) return { finalArticleBody: "" };
    const body = stripTopLevelSections(loadedArticle.body, ["References", "See also"]);
    return { finalArticleBody: body };
  },
});

// ─── TRANSFORM: rebuild reference list post-repair ───────────────────────────

export const rebuildReferenceListNode = defineNode({
  name: "transform.rebuild_reference_list",
  kind: "transform",
  description: "Rebuild reference sidecar from body links + prior + RAG after link repair.",
  reads: ["input", "finalArticleBody", "retrievedContext"] as const,
  writes: ["references"] as const,
  run({ input, finalArticleBody, retrievedContext }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    if (!slug || !finalArticleBody) return { references: [] };

    const hints = listIncomingHints(deps.db, slug);
    const backlinkSlugs = [...new Set(hints.map((h) => h.sourceSlug).filter(Boolean))];

    // Include backlink article content even when RAG scored zero.
    const backlinkCtx = backlinkSlugs.length
      ? retrieveDirectArticleContext(
          deps.db,
          slug,
          backlinkSlugs,
          deps.runtime.app.rag.mode,
          deps.runtime.app.rag.max_results,
          deps.logger,
        )
      : { context: "", relatedTitles: [], sourceArticles: [] };

    const ragSources = (retrievedContext?.sourceArticles ?? []);
    const merged = mergeRetrievedContextPackets(
      { context: "", relatedTitles: ragSources.map((s) => s.title), sourceArticles: ragSources },
      backlinkCtx,
    );

    const priorRefs = loadPriorReferenceList(deps.db, slug) ?? [];
    // Auto-derived additions (backlinks, body refs) must not demote a ref the
    // user pinned: additions are merged before prior refs in
    // buildReferenceList, so an unpinned addition for the same slug would win
    // and silently drop the pin on every post-process run.
    const priorPinned = new Set(priorRefs.filter((r) => r.pinned).map((r) => r.slug));

    const bodyRefs = findBodyReferencedArticles(deps.db, finalArticleBody, slug);
    const backlinkAdditions = backlinkSlugs
      .map((s) => getArticleByLookup(deps.db, s))
      .filter(Boolean)
      .map((a) => ({
        slug: a!.slug,
        title: a!.title,
        content: a!.summaryMarkdown ?? "",
        kind: "summary" as const,
        pinned: false,
        revisionId: "current" as const,
        source: "user" as const,
      }));

    const additionsBySlug = new Map<string, ReferenceListEntry>();
    for (const ref of [...backlinkAdditions, ...bodyRefs]) {
      additionsBySlug.set(ref.slug, { ...ref, pinned: ref.pinned || priorPinned.has(ref.slug) });
    }

    const refs = buildReferenceList(
      deps.db,
      {
        articleSlug: slug,
        ragSources: merged.sourceArticles,
        priorReferences: priorRefs,
        userAdditions: Array.from(additionsBySlug.values()),
        blacklistSlugs: input.blacklistSlugs ?? [],
        revisionId: "current",
        config: deps.runtime.app.rag,
      },
      deps.logger,
    );

    return { references: refs.map(toStateEntry) };
  },
});

// ─── TRANSFORM: resolve links against rebuilt refs ────────────────────────────

export const resolveLinksPostProcessNode = defineNode({
  name: "transform.resolve_links_post",
  kind: "transform",
  description: "Re-resolve and convert links against the rebuilt reference list; strip self-links.",
  reads: ["finalArticleBody", "references", "input"] as const,
  writes: ["finalArticleBody"] as const,
  run({ finalArticleBody, references, input }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    let body = normalizeMarkdownLinks(finalArticleBody ?? "", "article").markdown;
    const refs = (references ?? []).map((r) => fromStateEntry(r, "current"));
    body = linkReferences(body, refs, slug, deps.db);
    body = convertExistingArticleLinksToRefs(deps.db, body, slug);
    body = stripSelfLinks(body, slug);
    return { finalArticleBody: body };
  },
});

// ─── LLM: see-also generation ────────────────────────────────────────────────

export const generateSeeAlsoNode = defineNode({
  name: "llm.generate_see_also",
  kind: "llm",
  description: "Generate see-also candidates from article summary + title; filtered to non-existing articles only.",
  reads: ["finalArticleBody", "articleSummary", "canonicalTitle", "input"] as const,
  writes: ["seeAlso"] as const,
  async run({ finalArticleBody, articleSummary, canonicalTitle, input }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    const title = canonicalTitle ?? input.requestedTitle ?? slug;
    const body = finalArticleBody ?? "";
    const summary = articleSummary || body.slice(0, 1500);

    const bodyLinkSlugs = new Set(
      extractInternalLinks(body).map((l) => l.targetSlug),
    );
    const isHaluOnly = (s: string) =>
      s !== slug && !bodyLinkSlugs.has(s) && !getArticleByLookup(deps.db, s);

    const rendered = deps.prompts.render("see_also", {
      requested_title: title,
      article_summary: summary,
    });
    const seeAlsoRole = rendered.role ?? "light";
    try {
      deps.onSidecarUpdate?.(slug, { type: "generating", node: "llm.generate_see_also" });
      const raw = await deps.llm.chat(seeAlsoRole, rendered.system, rendered.user, {
        thinking: rendered.thinking,
        jsonMode: rendered.json,
      });
      const arrayMatch = raw.match(/\[[\s\S]*\]/);
      const objectMatch = raw.match(/\{[\s\S]*\}/);
      let items: Array<{ slug?: string; hint?: string }> = [];
      if (arrayMatch) {
        try { items = JSON.parse(arrayMatch[0]); } catch { /* fall through */ }
      }
      if (!items.length && objectMatch) {
        try { const o = JSON.parse(objectMatch[0]); items = o.items ?? []; } catch { /* fall through */ }
      }
      const valid = items
        .filter((i) => i.slug)
        .map((i) => ({ slug: slugify(i.slug ?? ""), hint: (i.hint ?? "").replace(/\s+/g, " ").trim() }))
        .filter((i) => i.slug && isHaluOnly(i.slug))
        .slice(0, 7);

      return {
        seeAlso: valid.map((c) => ({
          slug: c.slug,
          title: c.slug.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
          hint: c.hint,
        })),
      };
    } catch {
      return { seeAlso: [] };
    }
  },
});

// ─── LLM: summary regeneration ───────────────────────────────────────────────

export const regenerateSummaryNode = defineNode({
  name: "llm.regenerate_summary",
  kind: "llm",
  description: "Regenerate article summary via article_summary prompt (light model preferred).",
  reads: ["finalArticleBody", "canonicalTitle", "input"] as const,
  writes: ["articleSummary"] as const,
  async run({ finalArticleBody, canonicalTitle, input }, deps: PipelineDeps) {
    const body = finalArticleBody ?? "";
    if (!body) return { articleSummary: "" };
    const title = canonicalTitle ?? input.requestedTitle ?? input.slug ?? "";
    const trimmed = stripTopLevelSections(body, ["References", "See also"]).slice(0, 12_000);
    const rendered = deps.prompts.render("article_summary", {
      slug: slugify(input.slug ?? ""),
      requested_title: title,
      current_article: trimmed,
      previous_summary: "(none)",
      summary_feedback: "(none)",
      article_excerpt: trimmed,
      full_article: trimmed,
    });
    const articleSlug = slugify(input.slug ?? "");
    const summaryRole = rendered.role ?? "heavy";
    try {
      deps.onSidecarUpdate?.(articleSlug, { type: "generating", node: "llm.regenerate_summary" });
      const { content: raw } = await deps.llm.streamChat(
        summaryRole, rendered.system, rendered.user,
        (_delta, accumulated) => {
          deps.onSidecarUpdate?.(articleSlug, { type: "generating", node: "llm.regenerate_summary", partial: accumulated });
        },
        { thinking: rendered.thinking, jsonMode: rendered.json },
      );
      return { articleSummary: raw.trim() };
    } catch {
      return { articleSummary: summaryMarkdownFromArticle(body) };
    }
  },
});

// ─── WRITE: update article in place + save see-also ──────────────────────────

export const updateArticleInPlaceNode = defineNode({
  name: "write.update_article_in_place",
  kind: "write",
  description: "Persist repaired body + regenerated summary + see-also sidecar; stale-write guard.",
  reads: [
    "input",
    "finalArticleBody",
    "references",
    "seeAlso",
    "articleSummary",
    "postProcessExpectedGeneratedAt",
  ] as const,
  writes: ["persistedAt"] as const,
  run(
    { input, finalArticleBody, references, seeAlso, articleSummary, postProcessExpectedGeneratedAt },
    deps: PipelineDeps,
  ) {
    const slug = slugify(input.slug ?? "");
    if (!slug) return { persistedAt: undefined };

    const current = getArticleByLookup(deps.db, slug);
    if (!current) {
      deps.logger.warn("pipeline.update_in_place.article_missing", { slug });
      return { persistedAt: undefined };
    }

    if (
      postProcessExpectedGeneratedAt &&
      current.generated_at !== postProcessExpectedGeneratedAt
    ) {
      deps.logger.info("pipeline.update_in_place.stale_skipped", {
        slug,
        expected: postProcessExpectedGeneratedAt,
        actual: current.generated_at,
      });
      deps.logger.info("page.post_process_skipped", {
        slug,
        reason: "stale",
        expected: postProcessExpectedGeneratedAt,
        actual: current.generated_at,
      });
      return { persistedAt: undefined };
    }

    const body = finalArticleBody ?? current.markdown;
    const summary = articleSummary?.trim() || summaryMarkdownFromArticle(body);

    const haluLinks = extractInternalLinks(body);
    const haluSlugs = new Set(haluLinks.map((l) => l.targetSlug));
    const refLinks = extractRefLinksAsInternalLinks(deps.db, body, slug).filter(
      (l) => !haluSlugs.has(l.targetSlug),
    );
    const links = [...haluLinks, ...refLinks];
    const html = renderMarkdown(body);
    const plainText = markdownToPlainText(body);

    updateArticleInPlace(
      deps.db,
      slug,
      { markdown: body, html, summaryMarkdown: summary, plain_text: plainText },
      links,
      postProcessExpectedGeneratedAt
        ? { updateRevisionGeneratedAt: postProcessExpectedGeneratedAt }
        : {},
    );

    const now = Date.now();

    if (seeAlso && seeAlso.length > 0) {
      saveArticleSeeAlso(
        deps.db,
        slug,
        now,
        seeAlso.map((s) => ({ slug: s.slug, title: s.title, hint: s.hint })),
      );
    }

    deps.logger.info("pipeline.post_process.saved", {
      slug,
      links: links.length,
      refs: (references ?? []).length,
      see_also: seeAlso?.length ?? 0,
      summary_chars: summary.length,
    });

    // Push the updated article body/summary/see-also to subscribed clients.
    if (deps.onSidecarUpdate) {
      const updated = getArticleByLookup(deps.db, slug);
      if (updated) deps.onSidecarUpdate(slug, { type: "article", article: updated });
    }

    return { persistedAt: now };
  },
});

// ─── LLM: infobox generation ────────────────────────────────────────────────

export const generateInfoboxNode = defineNode({
  name: "llm.generate_infobox",
  kind: "llm",
  description:
    "Generate structured infobox rows (heavy, JSON). Runs for all articles regardless of image.",
  reads: ["finalArticleBody", "canonicalTitle", "input", "references"] as const,
  writes: ["infobox"] as const,
  async run({ finalArticleBody, canonicalTitle, input, references }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    const body = finalArticleBody ?? "";
    if (!slug || !body) return { infobox: undefined };

    const title = canonicalTitle ?? input.requestedTitle ?? slug;
    // Full body stripped of generated metadata sections — infobox should mine
    // every fact from the article, not a truncated excerpt.
    const articleBody = stripTopLevelSections(body, ["References", "See also"]);

    // Refs as formatted links only — no summaries, so the model derives facts
    // from the article itself and uses refs purely for correct slug targets.
    const refLinks = (references ?? [])
      .map((r) => `[${r.title}](ref:${r.slug})`)
      .join("\n");

    const rendered = deps.prompts.render("infobox", {
      requested_title: title,
      article_body: articleBody,
      ref_links: refLinks || "(none)",
    });

    try {
      deps.onSidecarUpdate?.(slug, { type: "generating", node: "llm.generate_infobox" });
      const raw = await deps.llm.chat(
        rendered.role ?? "heavy",
        rendered.system,
        rendered.user,
        { jsonMode: true, thinking: rendered.thinking },
      );
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("no JSON in infobox response");
      const parsed = JSON.parse(match[0]) as InfoboxData;
      if (!parsed.title || !Array.isArray(parsed.groups)) throw new Error("invalid infobox shape");
      return { infobox: parsed };
    } catch (err) {
      deps.logger.warn("pipeline.infobox.failed", {
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
      return { infobox: undefined };
    }
  },
});

// ─── WRITE: persist infobox ───────────────────────────────────────────────────

export const persistInfoboxNode = defineNode({
  name: "write.persist_infobox",
  kind: "write",
  description: "Save generated infobox data to article_infobox sidecar.",
  reads: ["input", "infobox"] as const,
  writes: [] as const,
  run({ input, infobox }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    if (!slug || !infobox) return {};
    try {
      setArticleInfobox(deps.db, slug, infobox as InfoboxData);
      deps.logger.info("pipeline.infobox.saved", { slug });
      const normalized = normalizeInfoboxData(infobox);
      if (normalized) deps.onSidecarUpdate?.(slug, { type: "infobox", infobox: normalized });
    } catch (err) {
      deps.logger.warn("pipeline.infobox.save_failed", {
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return {};
  },
});

// ─── WRITE: re-index RAG chunks ───────────────────────────────────────────────

export const indexRagChunksNode = defineNode({
  name: "write.index_rag_chunks",
  kind: "write",
  description: "Re-index article body as RAG chunks for future retrievals.",
  reads: ["input", "finalArticleBody"] as const,
  writes: ["ragIndexed"] as const,
  async run({ input, finalArticleBody }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    const body = finalArticleBody ?? "";
    if (!slug || !body) return { ragIndexed: false };
    const rag = deps.runtime.app.rag;
    const useEmbeddings = rag.enabled && deps.runtime.llm.embeddings.enabled;

    // Include image description as a searchable chunk so other articles
    // can discover and reference this article's image via RAG.
    const headlineMedia = getArticleHeadlineMedia(deps.db, slug);
    const imageDescriptions: Array<{ id: string; description: string }> = [];
    if (headlineMedia && deps.mediaDb) {
      const rec = getMediaById(deps.mediaDb, headlineMedia.mediaId);
      if (rec?.description) {
        imageDescriptions.push({ id: rec.id, description: rec.description });
      }
    }

    // Include flattened infobox as a single relevance-ranked chunk.
    const infobox = getArticleInfobox(deps.db, slug);
    const infoboxText = infobox ? flattenInfoboxForRag(slug, infobox) : undefined;

    await indexArticleChunks(
      deps.db,
      deps.llm,
      slug,
      body,
      useEmbeddings,
      rag.chunk_size,
      deps.logger,
      imageDescriptions,
      infoboxText,
    );
    return { ragIndexed: true };
  },
});

// ─── LLM: sidebar caption refresh ────────────────────────────────────────────

export const generateSidebarCaptionNode = defineNode({
  name: "llm.generate_sidebar_caption",
  kind: "llm",
  description:
    "Re-generate the per-article sidepane caption from the freshly-saved article body. " +
    "Runs after every article write so the caption stays in sync with the content. " +
    "Skipped silently when the article has no headline image or media DB is unavailable.",
  reads: ["input", "finalArticleBody", "canonicalTitle"] as const,
  writes: [] as const,
  async run({ input, finalArticleBody, canonicalTitle }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    const body = finalArticleBody ?? "";
    if (!slug || !body || !deps.mediaDb) return {};

    const headlineMedia = getArticleHeadlineMedia(deps.db, slug);
    if (!headlineMedia) return {};

    // Only generate if caption is not yet set — avoids an LLM call on every
    // refresh/rewrite. Caption is cleared when a new image is attached.
    if (headlineMedia.caption) return {};

    const mediaRecord = getMediaById(deps.mediaDb, headlineMedia.mediaId);
    if (!mediaRecord?.description) return {};

    const title = canonicalTitle ?? input.requestedTitle ?? slug;
    const articleExcerpt = stripTopLevelSections(body, ["References", "See also"]).slice(0, 1500);

    const rendered = deps.prompts.render("image_caption", {
      requested_title: title,
      image_description: mediaRecord.description,
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
      const caption = String(parsed.caption ?? "").replace(/\s+/g, " ").trim();
      if (caption) {
        updateArticleMediaCaption(deps.db, slug, 1, caption);
        deps.logger.info("pipeline.sidebar_caption.saved", { slug, mediaId: headlineMedia.mediaId });
        deps.onSidecarUpdate?.(slug, { type: "caption", caption, mediaId: headlineMedia.mediaId });
      }
    } catch (err) {
      deps.logger.warn("pipeline.sidebar_caption.failed", {
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {};
  },
});
