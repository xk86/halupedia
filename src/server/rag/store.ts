/**
 * LanceDB store adapter — the sole vector store for RAG.
 *
 * Three tables:
 *  - `rag_text_documents`  — all text evidence (body/summary/infobox/…/ontology).
 *  - `rag_image_documents` — cross-modal image vectors (created lazily in Phase 2).
 *  - `rag_corpus_meta`     — single-row corpus fingerprint (schema/model/dims/…).
 *
 * All vector search runs server-side via cosine distance; we never load the
 * corpus into JS. `document_id` is the merge key so re-indexing a source
 * replaces exactly its prior rows.
 */
import * as lancedb from "@lancedb/lancedb";
import { makeArrowTable } from "@lancedb/lancedb";
import { Float32 } from "apache-arrow";
import type {
  EmbeddedTextDocument,
  RagCorpusMeta,
  TextDocumentKind,
} from "./types";

const TEXT_TABLE = "rag_text_documents";
const IMAGE_TABLE = "rag_image_documents";
const META_TABLE = "rag_corpus_meta";
const SECTION_SEP = " › "; // " › "

export interface TextQueryHit {
  documentId: string;
  articleSlug: string;
  sourceKind: TextDocumentKind;
  sourceId: string;
  content: string;
  sectionPath: string[];
  metadata: Record<string, unknown>;
  /** Cosine similarity in [-1, 1] (1 - cosine distance). Higher is better. */
  score: number;
}

interface TextRow {
  document_id: string;
  article_slug: string;
  source_kind: string;
  source_id: string;
  content: string;
  content_hash: string;
  source_updated_at: number;
  section_path: string;
  metadata_json: string;
  embedding_model: string;
  vector: number[];
  _distance?: number;
}

function toRow(doc: EmbeddedTextDocument): TextRow {
  return {
    document_id: doc.documentId,
    article_slug: doc.articleSlug,
    source_kind: doc.sourceKind,
    source_id: doc.sourceId,
    content: doc.content,
    content_hash: doc.contentHash,
    source_updated_at: doc.sourceUpdatedAt,
    section_path: (doc.sectionPath ?? []).join(SECTION_SEP),
    metadata_json: JSON.stringify(doc.metadata ?? {}),
    embedding_model: doc.embeddingModel,
    vector: doc.vector,
  };
}

function fromHit(row: TextRow): TextQueryHit {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
  } catch {
    metadata = {};
  }
  return {
    documentId: row.document_id,
    articleSlug: row.article_slug,
    sourceKind: row.source_kind as TextDocumentKind,
    sourceId: row.source_id,
    content: row.content,
    sectionPath: row.section_path ? row.section_path.split(SECTION_SEP) : [],
    metadata,
    score: 1 - (row._distance ?? 1),
  };
}

/** Escape a string literal for a LanceDB SQL filter predicate. */
function sqlLit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface TextQueryOptions {
  k: number;
  includeKinds?: TextDocumentKind[];
  excludeSlugs?: string[];
  /** Restrict to these article slugs (used by direct/category retrieval). */
  onlySlugs?: string[];
}

export class RagStore {
  private constructor(private readonly conn: lancedb.Connection) {}

  static async open(path: string): Promise<RagStore> {
    const conn = await lancedb.connect(path);
    return new RagStore(conn);
  }

  async close(): Promise<void> {
    this.conn.close();
  }

  private async textTable(): Promise<lancedb.Table | null> {
    const names = await this.conn.tableNames();
    if (!names.includes(TEXT_TABLE)) return null;
    return this.conn.openTable(TEXT_TABLE);
  }

  /** Vector dimension of the existing text table, or null if absent/unknown. */
  private async textVectorDim(): Promise<number | null> {
    const table = await this.textTable();
    if (!table) return null;
    const schema = await table.schema();
    const field = schema.fields.find((f) => f.name === "vector");
    const size = (field?.type as { listSize?: number } | undefined)?.listSize;
    return typeof size === "number" ? size : null;
  }

  /**
   * Idempotent upsert keyed on `document_id`. Creates the table on first write.
   *
   * Validates that every vector shares one non-degenerate dimension, and refuses
   * to merge into a table whose vector dimension differs — otherwise a stale or
   * mis-inferred schema silently mangles vectors (e.g. a corpus pinned to
   * `FixedSizeList[1]`), breaking all queries with no error.
   */
  async upsertTextDocuments(docs: EmbeddedTextDocument[]): Promise<void> {
    if (docs.length === 0) return;
    const dim = docs[0].vector.length;
    if (dim < 2) {
      throw new Error(`rag store: degenerate embedding dimension ${dim} (document ${docs[0].documentId})`);
    }
    for (const d of docs) {
      if (d.vector.length !== dim) {
        throw new Error(
          `rag store: inconsistent embedding dimension ${d.vector.length} != ${dim} (document ${d.documentId})`,
        );
      }
    }
    const rows = docs.map(toRow) as unknown as Record<string, unknown>[];
    const names = await this.conn.tableNames();
    if (!names.includes(TEXT_TABLE)) {
      const tbl = makeArrowTable(rows, { vectorColumns: { vector: { type: new Float32() } } });
      await this.conn.createTable(TEXT_TABLE, tbl);
      return;
    }
    const existingDim = await this.textVectorDim();
    if (existingDim != null && existingDim !== dim) {
      throw new Error(
        `rag store: corpus vector dimension ${existingDim} != incoming ${dim}; the corpus is stale — run: npm run rag:rebuild`,
      );
    }
    const table = await this.conn.openTable(TEXT_TABLE);
    await table
      .mergeInsert("document_id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows);
  }

  /** Drop the text table (used by a clean full rebuild). */
  async dropTextTable(): Promise<void> {
    const names = await this.conn.tableNames();
    if (names.includes(TEXT_TABLE)) await this.conn.dropTable(TEXT_TABLE);
  }

  async deleteByArticle(slug: string): Promise<void> {
    const table = await this.textTable();
    if (table) await table.delete(`article_slug = ${sqlLit(slug)}`);
  }

  async deleteByDocumentIds(documentIds: string[]): Promise<void> {
    if (documentIds.length === 0) return;
    const table = await this.textTable();
    if (!table) return;
    const list = documentIds.map(sqlLit).join(", ");
    await table.delete(`document_id IN (${list})`);
  }

  /** Delete every text doc for an article whose source_kind matches a set. */
  async deleteByArticleKinds(slug: string, kinds: TextDocumentKind[]): Promise<void> {
    if (kinds.length === 0) return;
    const table = await this.textTable();
    if (!table) return;
    const list = kinds.map((k) => sqlLit(k)).join(", ");
    await table.delete(`article_slug = ${sqlLit(slug)} AND source_kind IN (${list})`);
  }

  async queryText(vector: number[], opts: TextQueryOptions): Promise<TextQueryHit[]> {
    const table = await this.textTable();
    if (!table) return [];
    const filters: string[] = [];
    if (opts.includeKinds?.length) {
      filters.push(`source_kind IN (${opts.includeKinds.map(sqlLit).join(", ")})`);
    }
    if (opts.excludeSlugs?.length) {
      filters.push(`article_slug NOT IN (${opts.excludeSlugs.map(sqlLit).join(", ")})`);
    }
    if (opts.onlySlugs?.length) {
      filters.push(`article_slug IN (${opts.onlySlugs.map(sqlLit).join(", ")})`);
    }
    let q = table.query().nearestTo(vector).distanceType("cosine").limit(opts.k);
    if (filters.length) q = q.where(filters.join(" AND "));
    const rows = (await q.toArray()) as TextRow[];
    return rows.map(fromHit);
  }

  /** Fetch bounded documents for explicit articles without semantic ranking. */
  async fetchByArticle(
    slug: string,
    kinds: TextDocumentKind[],
    limit: number,
  ): Promise<TextQueryHit[]> {
    const table = await this.textTable();
    if (!table) return [];
    const kindFilter = kinds.length ? ` AND source_kind IN (${kinds.map(sqlLit).join(", ")})` : "";
    const rows = (await table
      .query()
      .where(`article_slug = ${sqlLit(slug)}${kindFilter}`)
      .limit(limit)
      .toArray()) as TextRow[];
    return rows.map(fromHit);
  }

  async countRows(): Promise<number> {
    const table = await this.textTable();
    if (!table) return 0;
    return table.countRows();
  }

  async countByKind(): Promise<Record<string, number>> {
    const table = await this.textTable();
    if (!table) return {};
    // Small corpora: pull kinds column only. (Counts feed meta/diagnostics.)
    const rows = (await table.query().select(["source_kind"]).toArray()) as Array<{
      source_kind: string;
    }>;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.source_kind] = (counts[r.source_kind] ?? 0) + 1;
    return counts;
  }

  async writeMeta(meta: RagCorpusMeta): Promise<void> {
    const row = {
      id: "corpus",
      schema_version: meta.schemaVersion,
      chunker_version: meta.chunkerVersion,
      text_embedding_model: meta.textEmbeddingModel,
      image_embedding_model: meta.imageEmbeddingModel,
      vector_dimensions: meta.vectorDimensions,
      config_hash: meta.configHash,
      source_database_id: meta.sourceDatabaseId,
      build_timestamp: meta.buildTimestamp,
      build_complete: meta.buildComplete,
      document_counts_json: JSON.stringify(meta.documentCountsByKind),
    };
    const names = await this.conn.tableNames();
    if (names.includes(META_TABLE)) await this.conn.dropTable(META_TABLE);
    await this.conn.createTable(META_TABLE, [row]);
  }

  async readMeta(): Promise<RagCorpusMeta | null> {
    const names = await this.conn.tableNames();
    if (!names.includes(META_TABLE)) return null;
    const table = await this.conn.openTable(META_TABLE);
    const rows = (await table.query().limit(1).toArray()) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      schemaVersion: Number(r.schema_version),
      chunkerVersion: Number(r.chunker_version),
      textEmbeddingModel: String(r.text_embedding_model),
      imageEmbeddingModel: String(r.image_embedding_model),
      vectorDimensions: Number(r.vector_dimensions),
      configHash: String(r.config_hash),
      sourceDatabaseId: String(r.source_database_id),
      buildTimestamp: Number(r.build_timestamp),
      buildComplete: Boolean(r.build_complete),
      documentCountsByKind: r.document_counts_json
        ? (JSON.parse(String(r.document_counts_json)) as Record<string, number>)
        : {},
    };
  }

  async hasTextTable(): Promise<boolean> {
    return (await this.conn.tableNames()).includes(TEXT_TABLE);
  }
}

export { TEXT_TABLE, IMAGE_TABLE, META_TABLE };
