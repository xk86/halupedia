/**
 * Core RAG type contracts for the LanceDB-backed retrieval system.
 *
 * These interfaces are the stable boundary between the indexing side (chunker +
 * document builders + store) and the retrieval side (retriever + prompt
 * assembly). They are intentionally storage-agnostic: a `RagTextDocument` is the
 * logical record; the LanceDB row adds the `vector` column on top.
 */

/** Text document kinds indexed into `rag_text_documents`. */
export type TextDocumentKind =
  | "article_body"
  | "article_summary"
  | "infobox_digest"
  | "infobox_fact"
  | "link_hint"
  | "image_caption"
  | "image_description"
  | "ontology_fact";

/** Visual document kind indexed into `rag_image_documents` (Phase 2). */
export type ImageDocumentKind = "image_vector";

/**
 * A single text document destined for the vector store, before embedding.
 *
 * `documentId` is deterministic (`${sourceKind}:${sourceId}`) so re-indexing a
 * source replaces exactly its prior rows. `contentHash` lets the job processor
 * skip re-embedding unchanged content.
 */
export interface RagTextDocument {
  documentId: string;
  articleSlug: string;
  sourceKind: TextDocumentKind;
  /** Stable identifier of the underlying source row (e.g. body segment index,
   *  infobox row key, media id, entity-relation id). */
  sourceId: string;
  content: string;
  contentHash: string;
  sourceUpdatedAt: number;
  sectionPath?: string[];
  /** Arbitrary per-kind structured metadata, serialized to `metadata_json`. */
  metadata?: Record<string, unknown>;
}

/** A `RagTextDocument` plus its embedding vector and model id, ready to upsert. */
export interface EmbeddedTextDocument extends RagTextDocument {
  embeddingModel: string;
  vector: number[];
}

/** A text document returned from retrieval with scoring/provenance attached. */
export interface RetrievedTextDocument {
  documentId: string;
  articleSlug: string;
  sourceKind: TextDocumentKind;
  sourceId: string;
  content: string;
  sectionPath?: string[];
  metadata?: Record<string, unknown>;
  /** Raw store score (cosine distance converted to similarity), pre-fusion. */
  rawScore: number;
  /** Rank after reciprocal-rank fusion across modalities/paths. */
  fusedRank: number;
  /** Why this document was returned: semantic hit, direct ref, symbolic edge. */
  retrievalReason: "semantic" | "direct" | "symbolic" | "summary";
  provenance: "semantic" | "direct" | "symbolic";
}

/** An image document returned from retrieval (Phase 2 — empty in Phase 1). */
export interface RetrievedImageDocument {
  documentId: string;
  articleSlug: string;
  mediaId: string;
  role: string;
  ordinal: number;
  caption: string;
  description: string;
  rawScore: number;
  fusedRank: number;
}

/** An article-level candidate surfaced by retrieval (feeds the reference list). */
export interface RetrievedArticleCandidate {
  slug: string;
  title: string;
  /** Best score among the article's contributing documents. */
  score: number;
  /** Kinds of documents that contributed to this candidate. */
  contributingKinds: TextDocumentKind[];
  provenance: "semantic" | "direct" | "symbolic";
}

export interface RetrievalDiagnostics {
  profile: string;
  queryText?: string;
  queryHash?: string;
  textEmbeddingModel?: string;
  imageEmbeddingModel?: string;
  servingHost?: string;
  vectorDimensions?: number;
  candidateTextCount: number;
  candidateImageCount: number;
  selectedTextCount: number;
  selectedImageCount: number;
  selectedKinds: TextDocumentKind[];
  /** Documents considered but excluded, with a reason (blacklist, dedupe, …). */
  exclusions: Array<{ documentId: string; reason: string }>;
  degraded?: string;
}

export interface RetrievalResult {
  textDocuments: RetrievedTextDocument[];
  imageDocuments: RetrievedImageDocument[];
  sourceArticles: RetrievedArticleCandidate[];
  relatedTitles: string[];
  diagnostics: RetrievalDiagnostics;
}

/** Retrieval profiles replace the old `rag.mode` summary/full switch. */
export type RetrievalProfile =
  | "article_generation"
  | "article_rewrite"
  | "article_refresh"
  | "reference_search";

export interface RetrieveContextArgs {
  targetSlug: string;
  queryText?: string;
  /** Minimum cosine similarity for semantic evidence. Direct evidence bypasses it. */
  minScore?: number;
  directSlugs?: string[];
  excludeSlugs?: string[];
  includeKinds?: TextDocumentKind[];
  includeImages?: boolean;
  includeCategories?: string[];
  profile: RetrievalProfile;
}

/** Persistent corpus metadata (one row in `rag_corpus_meta`). */
export interface RagCorpusMeta {
  schemaVersion: number;
  chunkerVersion: number;
  textEmbeddingModel: string;
  imageEmbeddingModel: string;
  vectorDimensions: number;
  configHash: string;
  sourceDatabaseId: string;
  buildTimestamp: number;
  buildComplete: boolean;
  documentCountsByKind: Record<string, number>;
}
