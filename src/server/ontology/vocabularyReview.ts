/**
 * Ontology vocabulary review — surfaces corpus evidence for growing or pruning
 * `config/ontology.toml`'s predicate set, and an optional LLM pass that turns
 * that evidence into concrete add/remove proposals. Nothing here mutates the
 * vocabulary or the database; `vocabularyToml.ts` applies whatever the caller
 * (the admin endpoint, after the operator picks proposals) decides to keep.
 */
import type { DatabaseSync } from "node:sqlite";
import type { LlmRouter } from "../llm";
import type { Logger } from "../logger";
import type { PromptConfig } from "../types";
import { prepared } from "../db";
import { getPrompt, parseJsonLoose, renderTemplate } from "../prompts";
import type { OntologyVocabulary, PredicateDef } from "./vocabulary";

export interface PredicateUsage {
  name: string;
  label: string;
  arity: "unary" | "binary";
  subject: string;
  object: string;
  symmetric: boolean;
  transitive: boolean;
  inverse?: string;
  /** Rows in entity_relations currently using this predicate. */
  usageCount: number;
}

export interface UnmappedLabelUsage {
  /** The raw infobox row label, kept verbatim as the predicate because no
   *  label_predicates/predicate mapping matched it. */
  label: string;
  count: number;
  /** One example object value, for context. */
  example: string;
}

export interface VocabularyReviewStats {
  predicates: PredicateUsage[];
  unmappedLabels: UnmappedLabelUsage[];
}

/** Every known predicate with how many stored relations currently use it. */
export function getPredicateUsageStats(db: DatabaseSync, vocab: OntologyVocabulary): PredicateUsage[] {
  const counts = new Map(
    (
      prepared(db, `SELECT predicate, COUNT(*) AS count FROM entity_relations GROUP BY predicate`).all() as Array<{
        predicate: string;
        count: number;
      }>
    ).map((r) => [r.predicate, r.count]),
  );
  return [...vocab.predicates.values()].map((p: PredicateDef) => ({
    name: p.name,
    label: p.label,
    arity: p.arity,
    subject: p.subject,
    object: p.object,
    symmetric: p.symmetric,
    transitive: p.transitive,
    inverse: p.inverse,
    usageCount: counts.get(p.name) ?? 0,
  }));
}

/**
 * Infobox rows whose label never mapped to a known predicate (extract.ts keeps
 * the raw label verbatim as the predicate in that case — see extract.ts's
 * `sanitizeFactText`/label-fallback comment). A label recurring across many
 * articles with a stable meaning is exactly the gap a new predicate should
 * close; a one-off is just a descriptive attribute and not worth a predicate.
 */
export function getUnmappedLabelStats(
  db: DatabaseSync,
  vocab: OntologyVocabulary,
  limit = 25,
): UnmappedLabelUsage[] {
  const rows = prepared(
    db,
    `SELECT predicate, COUNT(*) AS count,
            (SELECT COALESCE(oe.canonical_name, r.object_literal)
             FROM entity_relations r LEFT JOIN entities oe ON oe.id = r.object_entity_id
             WHERE r.predicate = entity_relations.predicate AND r.source = 'infobox' LIMIT 1) AS example
     FROM entity_relations
     WHERE source = 'infobox'
     GROUP BY predicate
     ORDER BY count DESC`,
  ).all() as Array<{ predicate: string; count: number; example: string | null }>;
  return rows
    .filter((r) => !vocab.predicates.has(r.predicate))
    .slice(0, limit)
    .map((r) => ({ label: r.predicate, count: r.count, example: r.example ?? "" }));
}

export function getVocabularyReviewStats(db: DatabaseSync, vocab: OntologyVocabulary): VocabularyReviewStats {
  return {
    predicates: getPredicateUsageStats(db, vocab),
    unmappedLabels: getUnmappedLabelStats(db, vocab),
  };
}

export interface PredicateAdditionProposal {
  name: string;
  arity: "unary" | "binary";
  subject: string;
  object: string;
  label: string;
  symmetric: boolean;
  transitive: boolean;
  inverse?: string;
  /** Raw infobox labels (lowercased) this predicate should absorb via
   *  label_predicates, e.g. the unmapped label that motivated it. */
  labelMappings: string[];
  reason: string;
}

export interface PredicateRemovalProposal {
  name: string;
  reason: string;
}

export interface VocabularyReviewProposals {
  additions: PredicateAdditionProposal[];
  removals: PredicateRemovalProposal[];
}

/** Predicates the review may never propose removing: structurally required. */
const PROTECTED_PREDICATES = new Set(["is_a", "related_to"]);

function describeExistingPredicates(stats: PredicateUsage[]): string {
  return stats
    .map(
      (p) =>
        `- ${p.name} (${p.arity}): ${p.subject} -> ${p.object}, label "${p.label}"` +
        `${p.symmetric ? ", symmetric" : ""}${p.inverse ? `, inverse ${p.inverse}` : ""}` +
        ` — used ${p.usageCount} time(s)`,
    )
    .join("\n");
}

function describeUnmappedLabels(labels: UnmappedLabelUsage[]): string {
  if (!labels.length) return "(none — every infobox label currently maps to a predicate)";
  return labels.map((l) => `- "${l.label}" — ${l.count} article(s), e.g. value "${l.example}"`).join("\n");
}

/** Coerce/validate a raw model addition proposal; null when unusable. */
export function sanitizePredicateAddition(
  raw: unknown,
  vocab: OntologyVocabulary,
  seenNames: Set<string>,
): PredicateAdditionProposal | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_") : "";
  if (!name || vocab.predicates.has(name) || seenNames.has(name)) return null;
  const arity = r.arity === "unary" ? "unary" : "binary";
  const subject = typeof r.subject === "string" && (r.subject === "*" || vocab.entityTypes.has(r.subject)) ? r.subject : "*";
  const object = typeof r.object === "string" && (r.object === "*" || vocab.entityTypes.has(r.object)) ? r.object : "*";
  const label = typeof r.label === "string" && r.label.trim() ? r.label.trim() : name.replace(/_/g, " ");
  const inverse = typeof r.inverse === "string" && r.inverse.trim() ? r.inverse.trim() : undefined;
  const labelMappings = Array.isArray(r.labelMappings)
    ? r.labelMappings.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim().toLowerCase())
    : [];
  const reason = typeof r.reason === "string" ? r.reason.trim() : "";
  seenNames.add(name);
  return {
    name,
    arity,
    subject,
    object,
    label,
    symmetric: r.symmetric === true,
    transitive: r.transitive === true,
    inverse,
    labelMappings,
    reason,
  };
}

export function sanitizePredicateRemoval(
  raw: unknown,
  vocab: OntologyVocabulary,
  seenNames: Set<string>,
): PredicateRemovalProposal | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim().toLowerCase() : "";
  if (!name || !vocab.predicates.has(name) || PROTECTED_PREDICATES.has(name) || seenNames.has(name)) return null;
  seenNames.add(name);
  return { name, reason: typeof r.reason === "string" ? r.reason.trim() : "" };
}

export interface OntologyVocabularyReviewOptions {
  llm: LlmRouter;
  prompts: PromptConfig;
  logger?: Logger;
}

/**
 * Run the LLM-assisted vocabulary review: gather corpus usage evidence and ask
 * the model to propose predicates to add (closing real gaps surfaced by
 * unmapped labels) and existing predicates to consider removing (near-zero
 * usage). Returns validated proposals only — never mutates the vocabulary,
 * the database, or the config file. Throws on model/parse failure so the
 * caller can surface a clear error (unlike per-article extraction, a review is
 * an explicit user action, not a background job — silently returning nothing
 * useful would be worse than reporting the failure).
 */
export async function runOntologyVocabularyReview(
  db: DatabaseSync,
  vocab: OntologyVocabulary,
  options: OntologyVocabularyReviewOptions,
): Promise<{ stats: VocabularyReviewStats; proposals: VocabularyReviewProposals }> {
  const stats = getVocabularyReviewStats(db, vocab);
  const prompt = getPrompt(options.prompts, "ontology_vocabulary_review");
  const templateVars = {
    entity_types: [...vocab.entityTypes].join(", "),
    existing_predicates: describeExistingPredicates(stats.predicates),
    unmapped_labels: describeUnmappedLabels(stats.unmappedLabels),
  };
  const raw = await options.llm.chat(
    prompt.model === "heavy" ? "heavy" : "light",
    renderTemplate(prompt.system, templateVars),
    renderTemplate(prompt.user, templateVars),
    { thinking: prompt.thinking, jsonMode: prompt.json },
  );
  const parsed = parseJsonLoose(raw);
  if (parsed === null) {
    options.logger?.warn?.("ontology.vocabulary_review_unparseable", {});
    throw new Error("Vocabulary review response was not valid JSON");
  }
  const root = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const seenAdd = new Set<string>();
  const seenRemove = new Set<string>();
  const additions = (Array.isArray(root.additions) ? root.additions : [])
    .map((a) => sanitizePredicateAddition(a, vocab, seenAdd))
    .filter((a): a is PredicateAdditionProposal => a !== null);
  const removals = (Array.isArray(root.removals) ? root.removals : [])
    .map((r) => sanitizePredicateRemoval(r, vocab, seenRemove))
    .filter((r): r is PredicateRemovalProposal => r !== null);
  return { stats, proposals: { additions, removals } };
}
