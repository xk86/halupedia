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
  article_generation: { textTopK: 12, imageTopK: 3, maxPromptTokens: 7000, ontologyQuota: 3, defaultKinds: ALL_TEXT_KINDS },
  article_rewrite: { textTopK: 8, imageTopK: 2, maxPromptTokens: 4000, ontologyQuota: 2, defaultKinds: ALL_TEXT_KINDS },
  article_refresh: { textTopK: 4, imageTopK: 1, maxPromptTokens: 1800, ontologyQuota: 1, defaultKinds: ["article_summary", "infobox_digest", "ontology_fact", "article_body"] },
  reference_search: { textTopK: 10, imageTopK: 0, maxPromptTokens: 0, ontologyQuota: 0, defaultKinds: ["article_summary", "infobox_digest", "ontology_fact"] },
};

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

export async function retrieveContext(
  deps: RetrieverDeps,
  args: RetrieveContextArgs,
): Promise<RetrievalResult> {
  const profiles = deps.profiles ?? DEFAULT_PROFILES;
  const profile = profiles[args.profile];
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
  const semanticHits = queryVector.length
    ? await deps.store.queryText(queryVector, { k: overFetch, includeKinds, excludeSlugs })
    : [];

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

  const ranked = [...docByID.values()].sort(
    (a, b) => (fusionScore.get(b.documentId) ?? 0) - (fusionScore.get(a.documentId) ?? 0),
  );
  ranked.forEach((doc, i) => (doc.fusedRank = i));

  // Select with an ontology quota: guarantee up to `ontologyQuota` ontology
  // facts even if they'd otherwise fall outside textTopK.
  const ontologyRanked = ranked.filter((d) => d.sourceKind === "ontology_fact");
  const reserved = ontologyRanked.slice(0, profile.ontologyQuota);
  const reservedIds = new Set(reserved.map((d) => d.documentId));
  const remainder = ranked.filter((d) => !reservedIds.has(d.documentId));
  const selectedText = [...reserved, ...remainder].slice(0, profile.textTopK);

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
      if (selectedText.some((d) => d.documentId === hit.documentId)) return;
      directDocs.push(hitToDoc(hit, "direct", "direct", i));
    });
  }

  const textDocuments = [...selectedText, ...directDocs];

  // ---- article candidates (feed the reference list) ----
  const candidateMap = new Map<string, RetrievedArticleCandidate>();
  for (const doc of textDocuments) {
    const existing = candidateMap.get(doc.articleSlug);
    if (existing) {
      existing.score = Math.max(existing.score, doc.rawScore);
      if (!existing.contributingKinds.includes(doc.sourceKind)) existing.contributingKinds.push(doc.sourceKind);
    } else {
      candidateMap.set(doc.articleSlug, {
        slug: doc.articleSlug,
        title: titleFor(deps.db, doc.articleSlug),
        score: doc.rawScore,
        contributingKinds: [doc.sourceKind],
        provenance: doc.provenance,
      });
    }
  }
  const sourceArticles = [...candidateMap.values()].sort((a, b) => b.score - a.score);

  for (const hit of semanticHits) {
    if (!textDocuments.some((d) => d.documentId === hit.documentId)) {
      exclusions.push({ documentId: hit.documentId, reason: "below_top_k" });
    }
  }

  return {
    textDocuments,
    imageDocuments: [], // Phase 2
    sourceArticles,
    relatedTitles: sourceArticles.map((c) => c.title),
    diagnostics: {
      profile: args.profile,
      queryText,
      textEmbeddingModel: embedModel,
      servingHost: host,
      vectorDimensions: queryVector.length || undefined,
      candidateTextCount: semanticHits.length + symbolicHits.length,
      candidateImageCount: 0,
      selectedTextCount: textDocuments.length,
      selectedImageCount: 0,
      selectedKinds: [...new Set(textDocuments.map((d) => d.sourceKind))],
      exclusions,
      degraded,
    },
  };
}
