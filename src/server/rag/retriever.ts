/**
 * Structured retrieval service — the single retrieval entry point.
 *
 * Replaces the old `retrieveContext` / `retrieveDirectArticleContext` helpers and
 * the `summary`/`full` mode switch with explicit profiles. Combines three paths:
 *   - semantic   : vector search over text documents
 *   - direct     : bounded fetch for explicitly-referenced articles
 *   - symbolic   : ontology facts for entities sharing a category with the target
 * and fuses them with reciprocal-rank fusion, reserving a quota for ontology
 * facts so high-precision symbolic evidence is never crowded out.
 */
import type { DatabaseSync } from "node:sqlite";
import { prepared } from "../db";
import { slugify } from "../slug";
import { markdownToPlainText } from "../markdown";
import { truncateForLog } from "../logger";
import type { Logger } from "../logger";
import type { RagStore, TextQueryHit } from "./store";
import type { TextEmbedder } from "./embeddings";
import type {
  RetrievalProfile,
  RetrievalResult,
  RetrievedArticleCandidate,
  RetrievedTextDocument,
  RetrieveContextArgs,
  TextDocumentKind,
} from "./types";

export interface ProfileConfig {
  textTopK: number;
  imageTopK: number;
  maxPromptTokens: number;
  /** Minimum slots reserved for ontology_fact evidence. */
  ontologyQuota: number;
  /**
   * Hard per-article cap on ontology_fact documents surviving fusion: at most
   * this many ranked facts from any single article's contribution reach
   * `selectedText`, so one fact-dense article can't crowd another's facts out
   * of a shared result set. Distinct from `ontologyQuota`, which reserves
   * slots for ontology evidence overall regardless of which article it's
   * attributed to.
   */
  ontologyFactsPerRetrievedArticle: number;
  /** Token budget reserved for prose body chunks so compact summary/infobox/
   *  ontology docs can't crowd article_body out of the assembled context. */
  bodyReserveTokens: number;
  /** Default document kinds when the caller doesn't restrict. */
  defaultKinds: TextDocumentKind[];
}

const ALL_TEXT_KINDS: TextDocumentKind[] = [
  "article_body",
  "article_summary",
  "infobox_digest",
  "infobox_fact",
  "link_hint",
  "image_caption",
  "image_description",
  "ontology_fact",
];

export const DEFAULT_PROFILES: Record<RetrievalProfile, ProfileConfig> = {
  article_generation: { textTopK: 12, imageTopK: 3, maxPromptTokens: 7000, ontologyQuota: 3, ontologyFactsPerRetrievedArticle: 8, bodyReserveTokens: 2000, defaultKinds: ALL_TEXT_KINDS },
  article_rewrite: { textTopK: 8, imageTopK: 2, maxPromptTokens: 4000, ontologyQuota: 2, ontologyFactsPerRetrievedArticle: 8, bodyReserveTokens: 1200, defaultKinds: ALL_TEXT_KINDS },
  article_refresh: { textTopK: 4, imageTopK: 1, maxPromptTokens: 1800, ontologyQuota: 1, ontologyFactsPerRetrievedArticle: 8, bodyReserveTokens: 600, defaultKinds: ["article_summary", "infobox_digest", "ontology_fact", "article_body"] },
  // ontologyQuota reserves slots for symbolic (same-category) ontology facts so
  // the chat research tool's default search always surfaces some structured
  // world data, not just prose summaries that happened to rank highest.
  reference_search: { textTopK: 10, imageTopK: 0, maxPromptTokens: 0, ontologyQuota: 3, ontologyFactsPerRetrievedArticle: 8, bodyReserveTokens: 0, defaultKinds: ["article_summary", "infobox_digest", "ontology_fact"] },
};

/**
 * Cap the number of `kind` documents contributed by any single article,
 * preserving relative order otherwise. Applied before quota reservation and
 * top-K selection so a fact-dense article can't starve another admitted
 * article's ontology-fact allowance. `maxPerArticle <= 0` disables the cap
 * (matches the "0 = uncapped" convention used elsewhere in this config).
 */
function capPerArticle(
  docs: RetrievedTextDocument[],
  kind: TextDocumentKind,
  maxPerArticle: number,
): RetrievedTextDocument[] {
  if (maxPerArticle <= 0) return docs;
  const counts = new Map<string, number>();
  return docs.filter((d) => {
    if (d.sourceKind !== kind) return true;
    const count = counts.get(d.articleSlug) ?? 0;
    if (count >= maxPerArticle) return false;
    counts.set(d.articleSlug, count + 1);
    return true;
  });
}

export interface RetrieverDeps {
  db: DatabaseSync;
  store: RagStore;
  embedder: TextEmbedder;
  profiles?: Record<RetrievalProfile, ProfileConfig>;
  logger?: Logger;
}

const RRF_K = 60;

function titleFor(db: DatabaseSync, slug: string): string {
  const row = prepared(
    db,
    `SELECT COALESCE(NULLIF(display_title, ''), title) AS title FROM articles WHERE slug = ?`,
  ).get(slug) as { title: string } | undefined;
  return row?.title ?? slug;
}

/**
 * One-line summary excerpt for a candidate article, independent of whatever
 * text documents were actually selected as evidence. A candidate surfaced
 * only via a terse ontology fact or infobox row (e.g. "X is a thing") would
 * otherwise show the model nothing about what the article actually is.
 */
function summaryFor(db: DatabaseSync, slug: string): string | undefined {
  const row = prepared(db, `SELECT summary_markdown AS summary FROM articles WHERE slug = ?`).get(
    slug,
  ) as { summary?: string } | undefined;
  const raw = row?.summary?.trim();
  if (!raw) return undefined;
  return truncateForLog(markdownToPlainText(raw), 160);
}

/** Article slugs that share at least one category with the target. */
function sameCategorySlugs(db: DatabaseSync, slug: string, limit: number): string[] {
  const rows = prepared(
    db,
    `SELECT DISTINCT ac2.article_slug AS slug
     FROM article_categories ac1
     JOIN article_categories ac2 ON ac2.category_id = ac1.category_id
     WHERE ac1.article_slug = ? AND ac2.article_slug <> ?
     LIMIT ?`,
  ).all(slug, slug, limit) as Array<{ slug: string }>;
  return rows.map((r) => r.slug);
}

function hitToDoc(
  hit: TextQueryHit,
  reason: RetrievedTextDocument["retrievalReason"],
  provenance: RetrievedTextDocument["provenance"],
  fusedRank: number,
): RetrievedTextDocument {
  return {
    documentId: hit.documentId,
    articleSlug: hit.articleSlug,
    sourceKind: hit.sourceKind,
    sourceId: hit.sourceId,
    content: hit.content,
    sectionPath: hit.sectionPath,
    metadata: hit.metadata,
    rawScore: hit.score,
    fusedRank,
    retrievalReason: reason,
    provenance,
  };
}

/** Reciprocal-rank-fusion score for a 0-based rank. */
function rrf(rank: number): number {
  return 1 / (RRF_K + rank + 1);
}

/**
 * Link hints are owned by the article containing the link, but their text is
 * evidence about the link target. Keep storage ownership intact while
 * attributing prompt evidence and link candidates to the described subject.
 *
 * Exported for `./evidenceContext`, which groups documents by the same
 * subject when building the typed per-article evidence context.
 */
export function evidenceSubject(doc: RetrievedTextDocument): { slug: string; title?: string } {
  if (doc.sourceKind !== "link_hint") return { slug: doc.articleSlug };
  const targetSlug = typeof doc.metadata?.targetSlug === "string"
    ? slugify(doc.metadata.targetSlug)
    : "";
  const targetTitle = typeof doc.metadata?.targetTitle === "string"
    ? doc.metadata.targetTitle.trim()
    : "";
  return targetSlug
    ? { slug: targetSlug, title: targetTitle || undefined }
    : { slug: doc.articleSlug };
}


export async function retrieveContext(
  deps: RetrieverDeps,
  args: RetrieveContextArgs,
): Promise<RetrievalResult> {
  const profiles = deps.profiles ?? DEFAULT_PROFILES;
  const baseProfile = profiles[args.profile];
  const profile: ProfileConfig =
    args.topK && args.topK > 0 ? { ...baseProfile, textTopK: args.topK } : baseProfile;
  const targetSlug = slugify(args.targetSlug);
  const includeKinds = args.includeKinds?.length ? args.includeKinds : profile.defaultKinds;
  const excludeSlugs = [
    targetSlug,
    ...(args.excludeSlugs ?? []).map((s) => slugify(s)).filter(Boolean),
  ];
  const exclusions: RetrievalResult["diagnostics"]["exclusions"] = [];

  const queryText = (args.queryText ?? titleFor(deps.db, targetSlug)).replace(/\s+/g, " ").trim();

  // ---- semantic path ----
  let queryVector: number[] = [];
  let embedModel = deps.embedder.model;
  let host: string | undefined;
  let degraded: string | undefined;
  try {
    const embedded = await deps.embedder.embed([queryText]);
    queryVector = embedded.vectors[0] ?? [];
    embedModel = embedded.model;
    host = embedded.host;
  } catch (err) {
    degraded = `embed_failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const overFetch = Math.max(profile.textTopK * 3, profile.textTopK + 10);
  const rawSemanticHits = queryVector.length
    ? await deps.store.queryText(queryVector, { k: overFetch, includeKinds, excludeSlugs })
    : [];
  const minScore = args.minScore ?? Number.NEGATIVE_INFINITY;
  const semanticHits = rawSemanticHits.filter((hit) => hit.score >= minScore);
  for (const hit of rawSemanticHits) {
    if (hit.score < minScore) {
      exclusions.push({
        documentId: hit.documentId,
        reason: "below_min_score",
        score: hit.score,
      });
    }
  }

  // Split semantic hits into ontology vs the rest so we can fuse with a quota.
  const semanticOntology = semanticHits.filter((h) => h.sourceKind === "ontology_fact");
  const semanticOther = semanticHits.filter((h) => h.sourceKind !== "ontology_fact");

  // ---- symbolic path: ontology facts of same-category articles ----
  const symbolicHits: TextQueryHit[] = [];
  if (profile.ontologyQuota > 0) {
    const neighbours = sameCategorySlugs(deps.db, targetSlug, 8);
    for (const slug of neighbours) {
      if (excludeSlugs.includes(slug)) continue;
      const facts = await deps.store.fetchByArticle(slug, ["ontology_fact"], 4);
      symbolicHits.push(...facts);
    }
  }

  // ---- fuse with RRF + ontology quota ----
  const fusionScore = new Map<string, number>();
  const docByID = new Map<string, RetrievedTextDocument>();
  const accumulate = (
    hits: TextQueryHit[],
    reason: RetrievedTextDocument["retrievalReason"],
    provenance: RetrievedTextDocument["provenance"],
  ) => {
    hits.forEach((hit, rank) => {
      const prior = fusionScore.get(hit.documentId) ?? 0;
      fusionScore.set(hit.documentId, prior + rrf(rank));
      if (!docByID.has(hit.documentId)) {
        docByID.set(hit.documentId, hitToDoc(hit, reason, provenance, rank));
      }
    });
  };
  accumulate(semanticOther, "semantic", "semantic");
  accumulate(semanticOntology, "semantic", "semantic");
  accumulate(symbolicHits, "symbolic", "symbolic");

  const fused = [...docByID.values()].sort(
    (a, b) => (fusionScore.get(b.documentId) ?? 0) - (fusionScore.get(a.documentId) ?? 0),
  );
  // Trim each article to at most `ontologyFactsPerRetrievedArticle` ontology
  // facts. Every fact that survives this cap is then guaranteed a slot below, so
  // the cap doubles as the per-article fact allowance.
  const ranked = capPerArticle(fused, "ontology_fact", profile.ontologyFactsPerRetrievedArticle);
  ranked.forEach((doc, i) => (doc.fusedRank = i));

  // Guarantee up to `ontologyFactsPerRetrievedArticle` facts for *every* article
  // that surfaced, reserved on top of the textTopK budget so they never crowd
  // out — or get crowded out by — article bodies/summaries. Only non-fact
  // evidence competes for textTopK; the per-article cap above already bounds how
  // many facts each article can contribute, and the downstream token budget
  // (maxPromptTokens) still caps the total prompt size.
  const reservedFacts = ranked.filter((d) => d.sourceKind === "ontology_fact");
  const reservedIds = new Set(reservedFacts.map((d) => d.documentId));
  const nonFacts = ranked.filter((d) => !reservedIds.has(d.documentId));
  const selectedText = [...reservedFacts, ...nonFacts.slice(0, profile.textTopK)].sort(
    (a, b) => a.fusedRank - b.fusedRank,
  );

  // ---- direct references ----
  const directDocs: RetrievedTextDocument[] = [];
  for (const raw of args.directSlugs ?? []) {
    const slug = slugify(raw);
    if (!slug || slug === targetSlug) continue;
    const hits = await deps.store.fetchByArticle(
      slug,
      ["article_summary", "infobox_digest", "infobox_fact", "article_body", "ontology_fact"],
      3,
    );
    hits.forEach((hit, i) => {
      // A doc already selected semantically/symbolically is still an explicit
      // reference — promote it to direct provenance in place rather than adding
      // a duplicate (or, as before, silently dropping the direct signal).
      const existing = selectedText.find((d) => d.documentId === hit.documentId);
      if (existing) {
        existing.provenance = "direct";
        existing.retrievalReason = "direct";
        return;
      }
      directDocs.push(hitToDoc(hit, "direct", "direct", i));
    });
  }

  const textDocuments = [...selectedText, ...directDocs];

  // ---- article candidates (feed the reference list) ----
  const candidateMap = new Map<string, RetrievedArticleCandidate>();
  for (const doc of textDocuments) {
    const subject = evidenceSubject(doc);
    const existing = candidateMap.get(subject.slug);
    if (existing) {
      existing.score = Math.max(existing.score, doc.rawScore);
      if (!existing.contributingKinds.includes(doc.sourceKind)) existing.contributingKinds.push(doc.sourceKind);
      // Promote to the strongest provenance: an article reached both directly
      // and semantically is still an explicit reference.
      if (doc.provenance === "direct") existing.provenance = "direct";
    } else {
      candidateMap.set(subject.slug, {
        slug: subject.slug,
        title: subject.title ?? titleFor(deps.db, subject.slug),
        score: doc.rawScore,
        contributingKinds: [doc.sourceKind],
        provenance: doc.provenance,
        summary: summaryFor(deps.db, subject.slug),
      });
    }
  }
  // Direct (explicitly-referenced) articles are prioritised over semantically /
  // symbolically discovered ones regardless of raw score — the latter come from
  // `fetchByArticle` and carry no vector distance (score 0), so a pure score
  // sort would otherwise bury explicit references at the bottom.
  const provenanceRank: Record<RetrievedTextDocument["provenance"], number> = {
    direct: 0,
    semantic: 1,
    symbolic: 2,
  };
  const sourceArticles = [...candidateMap.values()].sort(
    (a, b) => provenanceRank[a.provenance] - provenanceRank[b.provenance] || b.score - a.score,
  );

  for (const hit of semanticHits) {
    if (!textDocuments.some((d) => d.documentId === hit.documentId)) {
      exclusions.push({
        documentId: hit.documentId,
        reason: "below_top_k",
        score: hit.score,
      });
    }
  }

  const diagnostics: RetrievalResult["diagnostics"] = {
    profile: args.profile,
    queryText,
    textEmbeddingModel: embedModel,
    servingHost: host,
    vectorDimensions: queryVector.length || undefined,
    candidateTextCount: rawSemanticHits.length + symbolicHits.length,
    candidateImageCount: 0,
    selectedTextCount: textDocuments.length,
    selectedImageCount: 0,
    selectedKinds: [...new Set(textDocuments.map((d) => d.sourceKind))],
    exclusions,
    degraded,
  };

  deps.logger?.info("rag.retrieve", {
    profile: args.profile,
    target: targetSlug,
    candidates: diagnostics.candidateTextCount,
    selected: diagnostics.selectedTextCount,
    kinds: diagnostics.selectedKinds.join(","),
    articles: sourceArticles.length,
    model: embedModel,
    host,
    degraded,
  });

  return {
    textDocuments,
    imageDocuments: [], // Phase 2
    sourceArticles,
    relatedTitles: sourceArticles.map((c) => c.title),
    diagnostics,
  };
}
