import type { DatabaseSync } from "node:sqlite";
import { prepared } from "../db";
import { conveysSameObject, sanitizeFactText } from "./extract";
import {
  addCuratedFact,
  getArticleEntityId,
  listArticleEntityFacts,
  suppressFact,
} from "./store";
import type { ExtractionResult } from "./types";

export interface OntologyTypeSuggestion {
  suggestedType: string;
  status: OntologySuggestionStatus;
  createdAt: number;
}

/**
 * Replace (or clear) the pending entity-type suggestion for an article, based
 * on the extraction's entity matching the article's own title. Only written
 * when it differs from the currently stored type — a re-affirming extraction
 * clears any stale suggestion rather than leaving a stale one behind.
 */
export function replaceOntologyTypeSuggestion(
  db: DatabaseSync,
  slug: string,
  articleTitle: string,
  currentType: string | null,
  extraction: ExtractionResult,
): void {
  const normalizedTitle = sanitizeFactText(articleTitle).toLowerCase();
  const subjectEntity = extraction.entities.find(
    (entity) => sanitizeFactText(entity.name).toLowerCase() === normalizedTitle,
  );
  const suggestedType = subjectEntity?.type ?? "";
  if (!suggestedType || suggestedType === currentType) {
    prepared(db, `DELETE FROM ontology_type_suggestions WHERE article_slug = ?`).run(slug);
    return;
  }
  // A suggestion a human or auto-review already settled (discarded/human_review)
  // must survive re-extraction the same way a settled fact does (see
  // replaceOntologySuggestions above) — otherwise it silently resets to
  // 'pending' and gets re-reviewed forever. Only reset to 'pending' when the
  // freshly extracted type actually differs from whatever was last stored.
  const existing = prepared(
    db,
    `SELECT suggested_type AS suggestedType, status FROM ontology_type_suggestions WHERE article_slug = ?`,
  ).get(slug) as { suggestedType: string; status: OntologySuggestionStatus } | undefined;
  const nextStatus: OntologySuggestionStatus =
    existing && existing.status !== "pending" && existing.suggestedType === suggestedType
      ? existing.status
      : "pending";
  prepared(
    db,
    `INSERT INTO ontology_type_suggestions (article_slug, suggested_type, status, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(article_slug) DO UPDATE SET
       suggested_type = excluded.suggested_type,
       status = excluded.status,
       created_at = excluded.created_at`,
  ).run(slug, suggestedType, nextStatus, Date.now());
}

export function getOntologyTypeSuggestion(
  db: DatabaseSync,
  slug: string,
): OntologyTypeSuggestion | null {
  const row = prepared(
    db,
    `SELECT suggested_type AS suggestedType, status, created_at AS createdAt
     FROM ontology_type_suggestions WHERE article_slug = ?`,
  ).get(slug) as OntologyTypeSuggestion | undefined;
  return row ?? null;
}

/** Sets the (single, per-article) type suggestion's status without deleting
 *  the row — the type-change analog of `setOntologySuggestionsStatus`, used
 *  by the reviewer to settle a failed review instead of leaving the row
 *  'pending' forever (which re-queued the article for review on every pass). */
export function setOntologyTypeSuggestionStatus(
  db: DatabaseSync,
  slug: string,
  status: OntologySuggestionStatus,
): void {
  prepared(
    db,
    `UPDATE ontology_type_suggestions SET status = ? WHERE article_slug = ?`,
  ).run(status, slug);
}

export function deleteOntologyTypeSuggestion(db: DatabaseSync, slug: string): void {
  prepared(db, `DELETE FROM ontology_type_suggestions WHERE article_slug = ?`).run(slug);
}

/** `pending`: awaiting review. `discarded`: rejected — a settled, permanent
 *  no, hidden from the default list. `human_review`: auto-review couldn't
 *  decide — stays visible, but exempted from the auto-review queue. */
export type OntologySuggestionStatus = "pending" | "discarded" | "human_review";

export interface OntologySuggestion {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  validated: boolean;
  status: OntologySuggestionStatus;
}

export interface ArticleOntologySuggestionGroup {
  slug: string;
  title: string;
  suggestions: Array<OntologySuggestion & { createdAt: number }>;
  typeSuggestion: OntologyTypeSuggestion | null;
}

function text(value: unknown): string {
  if (typeof value === "string") return sanitizeFactText(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "";
}

export function replaceOntologySuggestions(
  db: DatabaseSync,
  slug: string,
  raw: unknown,
  validated: ExtractionResult,
): void {
  const root =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawRelations = Array.isArray(root.relations) ? root.relations : [];
  const relations =
    rawRelations.length > 0
      ? rawRelations.map((entry) => {
          const relation =
            entry && typeof entry === "object"
              ? (entry as Record<string, unknown>)
              : {};
          return {
            subject: text(relation.subject),
            predicate: text(relation.predicate),
            object: text(relation.object),
          };
        })
      : validated.relations.map(({ subject, predicate, object }) => ({
          subject,
          predicate,
          object,
        }));
  const validatedKeys = new Set(
    validated.relations.map(
      ({ subject, predicate, object }) => `${subject}\0${predicate}\0${object}`,
    ),
  );

  // A fact a human already discarded or flagged for review has a settled
  // status that must survive re-extraction — otherwise it silently comes
  // back as 'pending' the next time this article's ontology is refreshed.
  // Match on the (subject, predicate, object) triple, not row id (ids don't
  // survive the delete-and-reinsert below).
  const preservedStatuses = new Map<string, OntologySuggestionStatus>();
  const settled = prepared(
    db,
    `SELECT subject, predicate, object, status FROM ontology_suggestions
      WHERE article_slug = ? AND status != 'pending'`,
  ).all(slug) as Array<{
    subject: string;
    predicate: string;
    object: string;
    status: OntologySuggestionStatus;
  }>;
  for (const row of settled) {
    preservedStatuses.set(
      `${row.subject}\0${row.predicate}\0${row.object}`,
      row.status,
    );
  }

  prepared(db, `DELETE FROM ontology_suggestions WHERE article_slug = ?`).run(
    slug,
  );
  const now = Date.now();
  for (const relation of relations) {
    if (
      !relation.subject ||
      !relation.predicate ||
      !relation.object ||
      relation.predicate === "is_a"
    )
      continue;
    const key = `${relation.subject}\0${relation.predicate}\0${relation.object}`;
    prepared(
      db,
      `INSERT OR IGNORE INTO ontology_suggestions
         (article_slug, subject, predicate, object, validated, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      slug,
      relation.subject,
      relation.predicate,
      relation.object,
      validatedKeys.has(key) ? 1 : 0,
      preservedStatuses.get(key) ?? "pending",
      now,
    );
  }
}

export function listOntologySuggestions(
  db: DatabaseSync,
  slug: string,
): OntologySuggestion[] {
  const rows = prepared(
    db,
    `SELECT id, subject, predicate, object, validated, status
     FROM ontology_suggestions WHERE article_slug = ? ORDER BY id`,
  ).all(slug) as Array<
    Omit<OntologySuggestion, "validated"> & { validated: number }
  >;
  return rows.map((row) => ({ ...row, validated: row.validated === 1 }));
}

/** Overwrite a suggestion's object text in place — used by the reviewer to
 *  humanize a machine-identifier-shaped value before it's evaluated/merged. */
export function updateOntologySuggestionObject(
  db: DatabaseSync,
  id: number,
  object: string,
): void {
  prepared(db, `UPDATE ontology_suggestions SET object = ? WHERE id = ?`).run(
    object,
    id,
  );
}

export function listPendingOntologySuggestionsByArticle(
  db: DatabaseSync,
): ArticleOntologySuggestionGroup[] {
  const rows = prepared(
    db,
    `SELECT s.id,
            s.article_slug AS articleSlug,
            COALESCE(a.title, s.article_slug) AS articleTitle,
            s.subject,
            s.predicate,
            s.object,
            s.validated,
            s.status,
            s.created_at AS createdAt
       FROM ontology_suggestions s
       LEFT JOIN articles a ON a.slug = s.article_slug
      WHERE s.status != 'discarded'
      ORDER BY s.article_slug COLLATE NOCASE, s.id`,
  ).all() as Array<{
    id: number;
    articleSlug: string;
    articleTitle: string;
    subject: string;
    predicate: string;
    object: string;
    validated: number;
    status: OntologySuggestionStatus;
    createdAt: number;
  }>;

  const groups = new Map<string, ArticleOntologySuggestionGroup>();
  const groupFor = (slug: string, title: string): ArticleOntologySuggestionGroup => {
    let group = groups.get(slug);
    if (!group) {
      group = { slug, title, suggestions: [], typeSuggestion: null };
      groups.set(slug, group);
    }
    return group;
  };
  for (const row of rows) {
    const group = groupFor(row.articleSlug, row.articleTitle);
    group.suggestions.push({
      id: row.id,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      validated: row.validated === 1,
      status: row.status,
      createdAt: row.createdAt,
    });
  }

  const typeRows = prepared(
    db,
    `SELECT t.article_slug AS articleSlug,
            COALESCE(a.title, t.article_slug) AS articleTitle,
            t.suggested_type AS suggestedType,
            t.status,
            t.created_at AS createdAt
       FROM ontology_type_suggestions t
       LEFT JOIN articles a ON a.slug = t.article_slug
      WHERE t.status != 'discarded'`,
  ).all() as Array<{
    articleSlug: string;
    articleTitle: string;
    suggestedType: string;
    status: OntologySuggestionStatus;
    createdAt: number;
  }>;
  for (const row of typeRows) {
    const group = groupFor(row.articleSlug, row.articleTitle);
    group.typeSuggestion = {
      suggestedType: row.suggestedType,
      status: row.status,
      createdAt: row.createdAt,
    };
  }

  return [...groups.values()];
}

export function deleteOntologySuggestions(
  db: DatabaseSync,
  slug: string,
  ids?: number[],
): number {
  if (!ids?.length) {
    return Number(
      prepared(
        db,
        `DELETE FROM ontology_suggestions WHERE article_slug = ?`,
      ).run(slug).changes,
    );
  }
  let removed = 0;
  for (const id of ids) {
    removed += Number(
      prepared(
        db,
        `DELETE FROM ontology_suggestions WHERE article_slug = ? AND id = ?`,
      ).run(slug, id).changes,
    );
  }
  return removed;
}

/** Sets a suggestion's status without deleting the row — used for the
 *  Discard and Needs-review actions, both of which must survive
 *  re-extraction (see `replaceOntologySuggestions`), unlike a hard delete. */
export function setOntologySuggestionsStatus(
  db: DatabaseSync,
  slug: string,
  status: OntologySuggestionStatus,
  ids?: number[],
): number {
  if (!ids?.length) {
    return Number(
      prepared(
        db,
        `UPDATE ontology_suggestions SET status = ? WHERE article_slug = ?`,
      ).run(status, slug).changes,
    );
  }
  let updated = 0;
  for (const id of ids) {
    updated += Number(
      prepared(
        db,
        `UPDATE ontology_suggestions SET status = ? WHERE article_slug = ? AND id = ?`,
      ).run(status, slug, id).changes,
    );
  }
  return updated;
}

export function applyOntologySuggestions(
  db: DatabaseSync,
  slug: string,
  mode: "append" | "merge",
  ids?: number[],
): { applied: number; removedInfoboxRelations: number } {
  const selectedIds = ids === undefined ? null : new Set(ids);
  const suggestions = listOntologySuggestions(db, slug).filter(
    (suggestion) => !selectedIds || selectedIds.has(suggestion.id),
  );
  const subjectId = getArticleEntityId(db, slug);
  if (subjectId === null) return { applied: 0, removedInfoboxRelations: 0 };

  let removedInfoboxRelations = 0;
  if (mode === "merge") {
    const { facts } = listArticleEntityFacts(db, slug);
    for (const fact of facts) {
      if (
        fact.source === "infobox" &&
        suggestions.some((suggestion) =>
          conveysSameObject(fact.object, suggestion.object),
        ) &&
        suppressFact(db, slug, fact.relationId)
      ) {
        removedInfoboxRelations += 1;
      }
    }
  }

  for (const suggestion of suggestions) {
    addCuratedFact(db, {
      subjectId,
      predicate: suggestion.predicate,
      objectLiteral: suggestion.object,
      provenanceSlug: slug,
    });
  }
  if (suggestions.length > 0) {
    deleteOntologySuggestions(
      db,
      slug,
      suggestions.map((suggestion) => suggestion.id),
    );
  }
  return { applied: suggestions.length, removedInfoboxRelations };
}
