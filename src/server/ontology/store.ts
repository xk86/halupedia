/**
 * Ontology storage — upsert/dedupe entities, identifiers, categories, and typed
 * relations, with a curation pin policy: curated/pinned rows survive
 * re-extraction; only `extracted`/`infobox` rows for an article's provenance are
 * replaced on reindex.
 */
import type { DatabaseSync } from "node:sqlite";
import { prepared } from "../db";
import { slugify } from "../slug";
import type { ExtractedEntity, ExtractionResult } from "./types";

/**
 * Slug of an existing article this object name refers to, or null. Used to turn
 * a literal relation object (e.g. an LLM-extracted `related_to` target that was
 * never linked to an entity) into a real `ref:` link — but only when a backing
 * article actually exists, so we never emit dangling links.
 *
 * Matching is case-insensitive throughout: the LLM's casing of a name rarely
 * matches the canonical title exactly ("global reporting desk" vs "Global
 * Reporting Desk"), and a real match shouldn't be missed over that. Tries, in
 * order: an ontology entity that owns an article (by name or alias), then a
 * direct article match (by slug, title, or alias slug).
 */
export function resolveArticleSlugByName(db: DatabaseSync, name: string): string | null {
  const clean = name.trim();
  if (!clean) return null;
  const slug = slugify(clean);

  const viaEntity = prepared(
    db,
    `SELECT article_slug AS slug FROM entities
     WHERE LOWER(canonical_name) = LOWER(?) AND article_slug IS NOT NULL LIMIT 1`,
  ).get(clean) as { slug: string } | undefined;
  if (viaEntity?.slug) return viaEntity.slug;

  const viaAlias = prepared(
    db,
    `SELECT e.article_slug AS slug FROM entity_aliases a
     JOIN entities e ON e.id = a.entity_id
     WHERE LOWER(a.alias) = LOWER(?) AND e.article_slug IS NOT NULL LIMIT 1`,
  ).get(clean) as { slug: string } | undefined;
  if (viaAlias?.slug) return viaAlias.slug;

  const direct = prepared(
    db,
    `SELECT slug FROM articles WHERE slug = ? OR LOWER(title) = LOWER(?) LIMIT 1`,
  ).get(slug, clean) as { slug: string } | undefined;
  if (direct?.slug) return direct.slug;

  const viaArticleAlias = prepared(
    db,
    `SELECT article_slug AS slug FROM article_aliases WHERE alias_slug = ? LIMIT 1`,
  ).get(slug) as { slug: string } | undefined;
  return viaArticleAlias?.slug ?? null;
}

export interface EntityRow {
  id: number;
  canonicalName: string;
  entityType: string;
  articleSlug: string | null;
  description: string;
}

/** Resolve an entity id by exact (name, type), else by alias of the same type. */
export function findEntityId(db: DatabaseSync, name: string, type: string): number | null {
  const direct = prepared(
    db,
    `SELECT id FROM entities WHERE canonical_name = ? AND entity_type = ?`,
  ).get(name, type) as { id: number } | undefined;
  if (direct) return direct.id;
  const viaAlias = prepared(
    db,
    `SELECT e.id AS id FROM entity_aliases a
     JOIN entities e ON e.id = a.entity_id
     WHERE a.alias = ? AND e.entity_type = ?
     LIMIT 1`,
  ).get(name, type) as { id: number } | undefined;
  return viaAlias?.id ?? null;
}

export function upsertEntity(db: DatabaseSync, entity: ExtractedEntity): number {
  const now = Date.now();
  let id = findEntityId(db, entity.name, entity.type);
  if (id === null) {
    const res = prepared(
      db,
      `INSERT INTO entities (canonical_name, entity_type, article_slug, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(canonical_name, entity_type) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(entity.name, entity.type, entity.articleSlug ?? null, entity.description ?? "", now, now);
    id = Number(res.lastInsertRowid);
  } else {
    // Fill in article ownership / description if newly known; never blank them.
    prepared(
      db,
      `UPDATE entities
       SET article_slug = COALESCE(?, article_slug),
           description = CASE WHEN ? <> '' THEN ? ELSE description END,
           updated_at = ?
       WHERE id = ?`,
    ).run(entity.articleSlug ?? null, entity.description ?? "", entity.description ?? "", now, id);
  }
  for (const alias of entity.aliases ?? []) {
    if (!alias || alias === entity.name) continue;
    prepared(db, `INSERT OR IGNORE INTO entity_aliases (entity_id, alias) VALUES (?, ?)`).run(id, alias);
  }
  for (const ident of entity.identifiers ?? []) {
    if (!ident.scheme || !ident.value) continue;
    prepared(
      db,
      `INSERT OR IGNORE INTO entity_identifiers (entity_id, scheme, value) VALUES (?, ?, ?)`,
    ).run(id, ident.scheme, ident.value);
  }
  return id;
}

export function upsertCategory(db: DatabaseSync, name: string, isCore = false): number {
  const existing = prepared(db, `SELECT id FROM categories WHERE name = ?`).get(name) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const res = prepared(
    db,
    `INSERT INTO categories (name, parent_id, is_core) VALUES (?, NULL, ?)`,
  ).run(name, isCore ? 1 : 0);
  return Number(res.lastInsertRowid);
}

/** Replace an article's category tags for a given source (keeps curated). */
export function setArticleCategories(
  db: DatabaseSync,
  slug: string,
  categoryNames: string[],
  source: "extracted" | "curated",
): void {
  prepared(
    db,
    `DELETE FROM article_categories WHERE article_slug = ? AND source = ?`,
  ).run(slug, source);
  const seen = new Set<string>();
  for (const name of categoryNames) {
    const clean = name.trim();
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    const categoryId = upsertCategory(db, clean);
    prepared(
      db,
      `INSERT OR IGNORE INTO article_categories (article_slug, category_id, source, confidence)
       VALUES (?, ?, ?, 1)`,
    ).run(slug, categoryId, source);
  }
}

/** Identity of a relation independent of its id/source/confidence. */
export function relationKey(
  subjectId: number,
  predicate: string,
  objectEntityId: number | null,
  objectLiteral: string | null,
): string {
  return `${subjectId}${predicate}${objectEntityId ?? ""}${objectLiteral ?? ""}`;
}

interface ExistingRelationRow {
  id: number;
  subject_entity_id: number;
  predicate: string;
  object_entity_id: number | null;
  object_literal: string | null;
  source: string;
  confidence: number;
  pinned: number;
  inferred_from: string | null;
}

/**
 * Persist an extraction result for an article by **reconciling** — not
 * rebuilding — its non-curated relations. Facts that are still derived keep
 * their existing row (and id, so the RAG `ontology_fact` docs keyed on it stay
 * stable); newly derived facts are inserted; previously-derived facts that are
 * no longer supported are removed. Curated/pinned rows are never added, updated,
 * or deleted here. Categories are still replaced wholesale (no ids depend on
 * them).
 */
export function reconcileArticleOntology(
  db: DatabaseSync,
  slug: string,
  revisionId: number | null,
  extraction: ExtractionResult,
): void {
  const idByName = new Map<string, number>();
  for (const entity of extraction.entities) {
    idByName.set(`${entity.name}\0${entity.type}`, upsertEntity(db, entity));
  }
  const resolveByName = (name: string): number | null => {
    for (const entity of extraction.entities) {
      if (entity.name === name) return idByName.get(`${name}\0${entity.type}`) ?? null;
    }
    return null;
  };

  // Desired non-curated rows, deduped by identity.
  const desired = new Map<
    string,
    { subjectId: number; predicate: string; objectEntityId: number | null; objectLiteral: string | null; source: string; confidence: number; inferredFrom: string | null }
  >();
  for (const rel of extraction.relations) {
    const subjectId = resolveByName(rel.subject);
    if (subjectId === null) continue;
    let objectEntityId: number | null = null;
    let objectLiteral: string | null = null;
    if (rel.objectIsLiteral) {
      objectLiteral = rel.object;
    } else {
      objectEntityId = resolveByName(rel.object);
      // Object entity not in this extraction: store as literal so the fact
      // isn't lost, rather than fabricating an entity.
      if (objectEntityId === null) objectLiteral = rel.object;
    }
    const key = relationKey(subjectId, rel.predicate, objectEntityId, objectLiteral);
    if (!desired.has(key)) {
      desired.set(key, {
        subjectId,
        predicate: rel.predicate,
        objectEntityId,
        objectLiteral,
        source: rel.source,
        confidence: rel.confidence ?? 1,
        inferredFrom: rel.inferredFrom ?? null,
      });
    }
  }

  // Existing rows for this article. Curated/pinned rows are matched (so a
  // desired fact that coincides with one is not duplicated) but never mutated.
  const existing = prepared(
    db,
    `SELECT id, subject_entity_id, predicate, object_entity_id, object_literal,
            source, confidence, pinned, inferred_from
     FROM entity_relations WHERE provenance_slug = ?`,
  ).all(slug) as unknown as ExistingRelationRow[];
  const existingByKey = new Map<string, ExistingRelationRow>();
  for (const row of existing) {
    existingByKey.set(
      relationKey(row.subject_entity_id, row.predicate, row.object_entity_id, row.object_literal),
      row,
    );
  }
  const isReplaceable = (row: ExistingRelationRow): boolean =>
    row.pinned === 0 && (row.source === "extracted" || row.source === "infobox" || row.source === "inferred");

  // Remove replaceable rows that are no longer desired.
  for (const row of existing) {
    if (isReplaceable(row) && !desired.has(relationKey(row.subject_entity_id, row.predicate, row.object_entity_id, row.object_literal))) {
      prepared(db, `DELETE FROM entity_relations WHERE id = ?`).run(row.id);
    }
  }

  // Load suppressions so we skip re-inserting facts the user explicitly dismissed.
  const suppressed = new Set(
    (prepared(db, `SELECT relation_key FROM suppressed_relations WHERE article_slug = ?`)
      .all(slug) as Array<{ relation_key: string }>).map((r) => r.relation_key),
  );

  // Insert new desired rows; refresh source/confidence on kept replaceable rows.
  const now = Date.now();
  for (const [key, d] of desired) {
    if (suppressed.has(key)) continue;
    const row = existingByKey.get(key);
    if (!row) {
      prepared(
        db,
        `INSERT INTO entity_relations
           (subject_entity_id, predicate, object_entity_id, object_literal,
            provenance_slug, provenance_revision_id, source, confidence, pinned,
            inferred_from, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(d.subjectId, d.predicate, d.objectEntityId, d.objectLiteral, slug, revisionId, d.source, d.confidence, d.inferredFrom, now);
    } else if (isReplaceable(row) && (row.source !== d.source || row.confidence !== d.confidence || row.inferred_from !== d.inferredFrom)) {
      // Same fact, but its derivation changed (e.g. promoted infobox->extracted
      // or a new confidence). Update in place; the id — and its RAG doc — stays.
      prepared(
        db,
        `UPDATE entity_relations SET source = ?, confidence = ?, inferred_from = ?, provenance_revision_id = ? WHERE id = ?`,
      ).run(d.source, d.confidence, d.inferredFrom, revisionId, row.id);
    }
    // A curated/pinned row with the same key is left untouched.
  }

  setArticleCategories(db, slug, extraction.categories, "extracted");
}

/** Vocabulary signature an article's ontology was last extracted under, if any. */
export function getArticleOntologySignature(db: DatabaseSync, slug: string): string | null {
  const row = prepared(
    db,
    `SELECT signature FROM article_ontology_state WHERE article_slug = ?`,
  ).get(slug) as { signature: string } | undefined;
  return row?.signature ?? null;
}

/** Record the vocabulary signature an article was just extracted under. */
export function setArticleOntologySignature(db: DatabaseSync, slug: string, signature: string): void {
  prepared(
    db,
    `INSERT INTO article_ontology_state (article_slug, signature, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(article_slug) DO UPDATE SET
       signature = excluded.signature,
       updated_at = excluded.updated_at`,
  ).run(slug, signature, Date.now());
}

export interface ArticleOntologyFact {
  predicate: string;
  object: string;
  /** Article slug the object links to, when the object is a known entity. */
  objectSlug: string | null;
  source: string;
  confidence: number;
  /** 1 for hand-curated/pinned facts (editable/removable in the UI). */
  pinned: number;
  /** For inferred facts: the basis fact(s) they were derived from. */
  inferredFrom: string | null;
  relationId: number;
}

/** Outgoing relations for the entity that owns an article. */
export function listArticleEntityFacts(
  db: DatabaseSync,
  slug: string,
): { entity: EntityRow | null; facts: ArticleOntologyFact[]; identifiers: Array<{ scheme: string; value: string }>; categories: string[] } {
  const entity = prepared(
    db,
    `SELECT id, canonical_name AS canonicalName, entity_type AS entityType,
            article_slug AS articleSlug, description
     FROM entities WHERE article_slug = ? LIMIT 1`,
  ).get(slug) as EntityRow | undefined;
  if (!entity) {
    return { entity: null, facts: [], identifiers: [], categories: [] };
  }
  const facts = prepared(
    db,
    `SELECT r.id AS relationId, r.predicate AS predicate,
            COALESCE(oe.canonical_name, r.object_literal) AS object,
            oe.article_slug AS objectSlug,
            r.source AS source, r.confidence AS confidence, r.pinned AS pinned,
            r.inferred_from AS inferredFrom
     FROM entity_relations r
     LEFT JOIN entities oe ON oe.id = r.object_entity_id
     WHERE r.subject_entity_id = ?
     ORDER BY r.pinned DESC, r.confidence DESC, r.id ASC`,
  ).all(entity.id) as unknown as ArticleOntologyFact[];
  const identifiers = prepared(
    db,
    `SELECT scheme, value FROM entity_identifiers WHERE entity_id = ?`,
  ).all(entity.id) as Array<{ scheme: string; value: string }>;
  const categories = (
    prepared(
      db,
      `SELECT c.name AS name FROM article_categories ac
       JOIN categories c ON c.id = ac.category_id
       WHERE ac.article_slug = ?`,
    ).all(slug) as Array<{ name: string }>
  ).map((r) => r.name);
  return { entity, facts, identifiers, categories };
}

/** Entity id owning an article, or null when the article was never extracted. */
export function getArticleEntityId(db: DatabaseSync, slug: string): number | null {
  const row = prepared(
    db,
    `SELECT id FROM entities WHERE article_slug = ? LIMIT 1`,
  ).get(slug) as { id: number } | undefined;
  return row?.id ?? null;
}

export function updateArticleEntityType(
  db: DatabaseSync,
  slug: string,
  entityType: string,
): boolean {
  const entity = prepared(
    db,
    `SELECT id, canonical_name AS canonicalName FROM entities WHERE article_slug = ? LIMIT 1`,
  ).get(slug) as { id: number; canonicalName: string } | undefined;
  if (!entity) return false;
  const conflict = prepared(
    db,
    `SELECT id FROM entities WHERE canonical_name = ? AND entity_type = ? AND id <> ? LIMIT 1`,
  ).get(entity.canonicalName, entityType, entity.id) as { id: number } | undefined;
  if (conflict) return false;
  prepared(db, `UPDATE entities SET entity_type = ?, updated_at = ? WHERE id = ?`).run(
    entityType,
    Date.now(),
    entity.id,
  );
  prepared(
    db,
    `UPDATE entity_relations
     SET object_literal = ?
     WHERE subject_entity_id = ? AND predicate = 'is_a' AND object_entity_id IS NULL`,
  ).run(entityType, entity.id);
  return true;
}

export interface CuratedFactInput {
  subjectId: number;
  predicate: string;
  /** Object entity (links to its article) XOR a plain literal value. */
  objectEntityId?: number | null;
  objectLiteral?: string | null;
  provenanceSlug: string;
}

/**
 * Insert a hand-curated fact (`source='curated'`, pinned). Pinned/curated rows
 * survive re-extraction, so a user-authored fact is never clobbered by the
 * deterministic or LLM extractors. Returns the new relation id, or the existing
 * one when an identical fact is already present (idempotent on the unique key).
 */
export function addCuratedFact(db: DatabaseSync, input: CuratedFactInput): number {
  const objectEntityId = input.objectEntityId ?? null;
  const objectLiteral = objectEntityId === null ? (input.objectLiteral ?? "") : null;
  // Check-then-insert rather than INSERT OR IGNORE: the unique index can't
  // dedupe here because SQLite treats NULLs as distinct, so a literal-object
  // fact (object_entity_id IS NULL) would otherwise insert a duplicate row.
  const existing = prepared(
    db,
    `SELECT id FROM entity_relations
     WHERE subject_entity_id = ? AND predicate = ? AND source = 'curated'
       AND object_entity_id IS ? AND object_literal IS ?`,
  ).get(input.subjectId, input.predicate, objectEntityId, objectLiteral) as { id: number } | undefined;
  if (existing) return existing.id;
  const res = prepared(
    db,
    `INSERT INTO entity_relations
       (subject_entity_id, predicate, object_entity_id, object_literal,
        provenance_slug, provenance_revision_id, source, confidence, pinned,
        inferred_from, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'curated', 1, 1, NULL, ?)`,
  ).run(input.subjectId, input.predicate, objectEntityId, objectLiteral, input.provenanceSlug, Date.now());
  return Number(res.lastInsertRowid);
}

/**
 * Delete a curated fact by id, but only when it is a curated row owned by the
 * given article's entity — extracted/infobox/inferred rows are regenerated and
 * must not be hand-deleted. Returns whether a row was removed.
 */
export function deleteCuratedFact(db: DatabaseSync, slug: string, relationId: number): boolean {
  const res = prepared(
    db,
    `DELETE FROM entity_relations
     WHERE id = ? AND source = 'curated'
       AND subject_entity_id IN (SELECT id FROM entities WHERE article_slug = ?)`,
  ).run(relationId, slug);
  return Number(res.changes) > 0;
}

/**
 * Suppress a non-curated fact so it is hidden and not re-created on reindex.
 * For curated facts, use `deleteCuratedFact` (actual delete) instead.
 * Returns whether the suppression was applied.
 */
export function suppressFact(db: DatabaseSync, slug: string, relationId: number): boolean {
  const row = prepared(
    db,
    `SELECT r.subject_entity_id, r.predicate, r.object_entity_id, r.object_literal
     FROM entity_relations r
     JOIN entities e ON e.id = r.subject_entity_id
     WHERE r.id = ? AND e.article_slug = ?`,
  ).get(relationId, slug) as { subject_entity_id: number; predicate: string; object_entity_id: number | null; object_literal: string | null } | undefined;
  if (!row) return false;
  const key = relationKey(row.subject_entity_id, row.predicate, row.object_entity_id, row.object_literal);
  prepared(
    db,
    `INSERT OR IGNORE INTO suppressed_relations (article_slug, relation_key, created_at) VALUES (?, ?, ?)`,
  ).run(slug, key, Date.now());
  prepared(db, `DELETE FROM entity_relations WHERE id = ?`).run(relationId);
  return true;
}

export interface FactUpdateInput {
  predicate?: string;
  objectEntityId?: number | null;
  objectLiteral?: string | null;
}

/**
 * Edit a fact. Curated facts are updated in place. Non-curated facts are
 * promoted to curated: the original row is deleted (and suppressed so it
 * isn't regenerated) and a new curated row is inserted with the edited values.
 */
export function updateFact(
  db: DatabaseSync,
  slug: string,
  relationId: number,
  updates: FactUpdateInput,
): number | null {
  const row = prepared(
    db,
    `SELECT r.id, r.subject_entity_id, r.predicate, r.object_entity_id,
            r.object_literal, r.source, r.provenance_slug
     FROM entity_relations r
     JOIN entities e ON e.id = r.subject_entity_id
     WHERE r.id = ? AND e.article_slug = ?`,
  ).get(relationId, slug) as {
    id: number; subject_entity_id: number; predicate: string;
    object_entity_id: number | null; object_literal: string | null;
    source: string; provenance_slug: string;
  } | undefined;
  if (!row) return null;

  const newPredicate = updates.predicate ?? row.predicate;
  const newObjectEntityId = updates.objectEntityId !== undefined ? updates.objectEntityId : row.object_entity_id;
  const newObjectLiteral = updates.objectLiteral !== undefined ? updates.objectLiteral : row.object_literal;

  if (row.source === "curated") {
    prepared(
      db,
      `UPDATE entity_relations SET predicate = ?, object_entity_id = ?, object_literal = ? WHERE id = ?`,
    ).run(newPredicate, newObjectEntityId, newObjectLiteral, row.id);
    return row.id;
  }

  // Non-curated: suppress the original identity and replace with a curated row.
  const oldKey = relationKey(row.subject_entity_id, row.predicate, row.object_entity_id, row.object_literal);
  prepared(
    db,
    `INSERT OR IGNORE INTO suppressed_relations (article_slug, relation_key, created_at) VALUES (?, ?, ?)`,
  ).run(slug, oldKey, Date.now());
  prepared(db, `DELETE FROM entity_relations WHERE id = ?`).run(row.id);

  return addCuratedFact(db, {
    subjectId: row.subject_entity_id,
    predicate: newPredicate,
    objectEntityId: newObjectEntityId,
    objectLiteral: newObjectEntityId === null ? (newObjectLiteral ?? "") : null,
    provenanceSlug: slug,
  });
}

/** Remove all ontology rows owned by / provenanced to an article (on delete). */
export function deleteArticleOntology(db: DatabaseSync, slug: string): void {
  prepared(db, `DELETE FROM entity_relations WHERE provenance_slug = ?`).run(slug);
  prepared(db, `DELETE FROM article_categories WHERE article_slug = ?`).run(slug);
  prepared(db, `DELETE FROM suppressed_relations WHERE article_slug = ?`).run(slug);
  prepared(db, `UPDATE entities SET article_slug = NULL WHERE article_slug = ?`).run(slug);
}
