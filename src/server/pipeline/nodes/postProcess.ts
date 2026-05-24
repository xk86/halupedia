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
import type { PipelineDeps } from "../deps";
import {
  getArticleByLookup,
  listIncomingHints,
  saveArticleSeeAlso,
  updateArticleInPlace,
} from "../../db";
import {
  buildReferenceList,
  convertExistingArticleLinksToRefs,
  extractRefLinksAsInternalLinks,
  findBodyReferencedArticles,
  linkMentionedReferencesInBody,
  loadPriorReferenceList,
  resolveRefLinks,
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

// ─── TRANSFORM: repair malformed halu: links ─────────────────────────────────

export const repairLinksNode = defineNode({
  name: "llm.repair_links",
  kind: "llm",
  description: "LLM-backed repair of malformed halu: occurrences in body markdown (light model, body-only).",
  reads: ["loadedArticle", "input"] as const,
  writes: ["finalArticleBody"] as const,
  async run({ loadedArticle, input }, deps: PipelineDeps) {
    if (!loadedArticle) return { finalArticleBody: "" };
    const slug = loadedArticle.slug;

    // Strip any metadata sections before passing to the LLM repair — these
    // are algorithmically generated and must never be rewritten by a model.
    const body = stripTopLevelSections(loadedArticle.body, ["References", "See also"]);

    if (!body.includes("halu:")) return { finalArticleBody: body };

    // Guard: never repair a body that somehow still has metadata sections.
    if (/^#{2,6}\s+(references|see also):?\s*#*\s*$/im.test(body)) {
      deps.logger.error("pipeline.repair_links.refused_metadata", { slug });
      return { finalArticleBody: body };
    }

    // Find positions of `halu:` outside valid LINK_RE matches.
    const { LINK_RE } = await import("../../markdown");
    const validRanges: Array<{ start: number; end: number }> = [];
    const linkPat = new RegExp(LINK_RE.source, LINK_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = linkPat.exec(body)) !== null) {
      validRanges.push({ start: m.index, end: m.index + m[0].length });
    }

    const malformed: number[] = [];
    let pos = 0;
    while (true) {
      const idx = body.indexOf("halu:", pos);
      if (idx < 0) break;
      if (!validRanges.some((r) => idx >= r.start && idx < r.end)) {
        malformed.push(idx);
      }
      pos = idx + 1;
    }

    if (malformed.length === 0) return { finalArticleBody: body };

    deps.logger.warn("pipeline.repair_links.malformed_detected", {
      slug,
      count: malformed.length,
    });

    let rendered;
    try {
      rendered = deps.prompts.render("link_repair", {});
    } catch {
      return { finalArticleBody: body };
    }

    let result = body;
    let offset = 0;
    for (const rawPos of malformed) {
      const p = rawPos + offset;
      const ctxStart = Math.max(0, p - 120);
      const ctxEnd = Math.min(result.length, p + 300);
      const context = result.slice(ctxStart, ctxEnd);
      try {
        const repaired = await deps.llm.chat(
          "light",
          rendered.system,
          deps.prompts.render("link_repair", { context }).user,
          { thinking: false },
        );
        if (repaired && repaired.trim() !== context.trim()) {
          result = result.slice(0, ctxStart) + repaired.trim() + result.slice(ctxEnd);
          offset += repaired.trim().length - (ctxEnd - ctxStart);
        }
      } catch (err) {
        deps.logger.warn("pipeline.repair_links.repair_failed", {
          slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { finalArticleBody: result };
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
      additionsBySlug.set(ref.slug, ref);
    }

    const refs = buildReferenceList(
      deps.db,
      {
        articleSlug: slug,
        ragSources: merged.sourceArticles,
        priorReferences: loadPriorReferenceList(deps.db, slug) ?? [],
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
    body = resolveRefLinks(body, refs);
    body = linkMentionedReferencesInBody(body, refs);
    body = convertExistingArticleLinksToRefs(deps.db, body, slug);
    body = stripSelfLinks(body, slug);
    return { finalArticleBody: body };
  },
});

// ─── LLM: see-also generation ────────────────────────────────────────────────

export const generateSeeAlsoNode = defineNode({
  name: "llm.generate_see_also",
  kind: "llm",
  description: "Generate see-also candidates (LLM, heavy); filtered to non-existing articles only.",
  reads: ["finalArticleBody", "references", "canonicalTitle", "input"] as const,
  writes: ["seeAlso"] as const,
  async run({ finalArticleBody, references, canonicalTitle, input }, deps: PipelineDeps) {
    const slug = slugify(input.slug ?? "");
    const title = canonicalTitle ?? input.requestedTitle ?? slug;
    const body = finalArticleBody ?? "";
    const refSlugs = (references ?? []).map((r) => r.slug);

    const bodyLinkSlugs = new Set(
      extractInternalLinks(body).map((l) => l.targetSlug),
    );
    const isHaluOnly = (s: string) =>
      s !== slug && !bodyLinkSlugs.has(s) && !getArticleByLookup(deps.db, s);

    const attempt = async (forbiddenSlugs: string[]) => {
      const rendered = deps.prompts.render("see_also", {
        requested_title: title,
        article_excerpt: body.slice(0, 6000),
        reference_slugs: refSlugs.length
          ? refSlugs.map((s) => `- ${s}`).join("\n")
          : "(none)",
        already_used_section: forbiddenSlugs.length
          ? `Already used or rejected (do not re-suggest):\n${forbiddenSlugs.map((s) => `- ${s}`).join("\n")}\n\n`
          : "",
      });
      const seeAlsoRole = rendered.role ?? "heavy";
      try {
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
        return items
          .filter((i) => i.slug)
          .map((i) => ({ slug: slugify(i.slug ?? ""), hint: (i.hint ?? "").replace(/\s+/g, " ").trim() }))
          .filter((i) => i.slug);
      } catch {
        return [];
      }
    };

    const raw = await attempt([]);
    let valid = raw.filter((c) => isHaluOnly(c.slug)).slice(0, 7);

    if (valid.length < 3) {
      const rejected = raw.map((c) => c.slug).filter((s) => !isHaluOnly(s));
      const retryRaw = await attempt([...refSlugs, ...rejected]);
      const retryValid = retryRaw.filter((c) => isHaluOnly(c.slug)).slice(0, 7);
      if (retryValid.length > valid.length) valid = retryValid;
    }

    return {
      seeAlso: valid.map((c) => ({
        slug: c.slug,
        title: c.slug.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
        hint: c.hint,
      })),
    };
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
    const summaryRole = rendered.role ?? "heavy";
    try {
      const raw = await deps.llm.chat(summaryRole, rendered.system, rendered.user, {
        thinking: rendered.thinking,
        jsonMode: rendered.json,
      });
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

    return { persistedAt: now };
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
    await indexArticleChunks(
      deps.db,
      deps.llm,
      slug,
      body,
      useEmbeddings,
      rag.chunk_size,
      deps.logger,
    );
    return { ragIndexed: true };
  },
});
