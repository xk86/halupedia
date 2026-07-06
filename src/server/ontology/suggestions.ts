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

export interface OntologySuggestion {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  validated: boolean;
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
    prepared(
      db,
      `INSERT OR IGNORE INTO ontology_suggestions
         (article_slug, subject, predicate, object, validated, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      slug,
      relation.subject,
      relation.predicate,
      relation.object,
      validatedKeys.has(
        `${relation.subject}\0${relation.predicate}\0${relation.object}`,
      )
        ? 1
        : 0,
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
    `SELECT id, subject, predicate, object, validated
     FROM ontology_suggestions WHERE article_slug = ? ORDER BY id`,
  ).all(slug) as Array<
    Omit<OntologySuggestion, "validated"> & { validated: number }
  >;
  return rows.map((row) => ({ ...row, validated: row.validated === 1 }));
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
