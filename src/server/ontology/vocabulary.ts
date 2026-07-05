/**
 * Controlled ontology vocabulary loaded from `config/ontology.toml`.
 *
 * The vocabulary is the "fixed core": a closed set of entity types and relation
 * predicates with type signatures. Extraction validates against it. A change to
 * `version` invalidates prior extractions (analogous to the chunker version).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";

export interface PredicateDef {
  name: string;
  /** "unary" classifies the subject; "binary" links two entities. */
  arity: "unary" | "binary";
  /** Allowed subject entity type, or "*" for any. */
  subject: string;
  /** Allowed object entity type, or "*" for any. */
  object: string;
  /** Human phrase used when rendering the fact ("<subject> <label> <object>"). */
  label: string;
  /** Binary only: S p O implies O p S. */
  symmetric: boolean;
  /** Binary only: S p O, O p T implies S p T. */
  transitive: boolean;
  /** Binary only: the predicate whose fact is implied in the reverse direction. */
  inverse?: string;
}

/** A deterministic subtitle-keyword -> entity-type classification rule. */
export interface ClassificationRule {
  match: string[];
  type: string;
  category?: string;
}

export interface OntologyVocabulary {
  version: number;
  entityTypes: Set<string>;
  predicates: Map<string, PredicateDef>;
  /** Ordered subtitle-keyword classification rules (first match wins). */
  classification: ClassificationRule[];
  /** Lowercased infobox label -> core predicate name. */
  labelPredicates: Map<string, string>;
  /** Lowercased infobox label -> identifier scheme. */
  identifierLabels: Map<string, string>;
  /** Stable hash of the vocabulary content (feeds corpus config hash). */
  hash: string;
}

interface RawVocabulary {
  version?: number;
  entity_types?: string[];
  classification?: Array<{ match?: string[]; type?: string; category?: string }>;
  predicates?: Array<{
    name: string;
    arity?: string;
    subject?: string;
    object?: string;
    label?: string;
    symmetric?: boolean;
    transitive?: boolean;
    inverse?: string;
  }>;
  label_predicates?: Record<string, string>;
  identifier_labels?: Record<string, string>;
}

const DEFAULT_PATH = "config/ontology.toml";

export function loadOntologyVocabulary(path = DEFAULT_PATH): OntologyVocabulary {
  const root = process.cwd();
  const configPath = resolve(root, path);
  const examplePath = resolve(root, `${path}.example`);
  const file = existsSync(configPath) ? configPath : examplePath;
  const raw = readFileSync(file, "utf8");
  const parsed = parse(raw) as RawVocabulary;

  const entityTypes = new Set(parsed.entity_types ?? []);
  const predicates = new Map<string, PredicateDef>();
  for (const p of parsed.predicates ?? []) {
    if (!p.name) continue;
    predicates.set(p.name, {
      name: p.name,
      arity: p.arity === "unary" ? "unary" : "binary",
      subject: p.subject ?? "*",
      object: p.object ?? "*",
      label: p.label ?? p.name.replace(/_/g, " "),
      symmetric: p.symmetric === true,
      transitive: p.transitive === true,
      inverse: p.inverse,
    });
  }
  const classification: ClassificationRule[] = [];
  for (const c of parsed.classification ?? []) {
    if (!c.type || !Array.isArray(c.match) || c.match.length === 0) continue;
    classification.push({
      match: c.match.map((m) => m.toLowerCase()),
      type: c.type,
      category: c.category,
    });
  }
  const labelPredicates = new Map<string, string>();
  for (const [label, pred] of Object.entries(parsed.label_predicates ?? {})) {
    labelPredicates.set(label.toLowerCase(), pred);
  }
  const identifierLabels = new Map<string, string>();
  for (const [label, scheme] of Object.entries(parsed.identifier_labels ?? {})) {
    identifierLabels.set(label.toLowerCase(), scheme);
  }

  return {
    version: parsed.version ?? 1,
    entityTypes,
    predicates,
    classification,
    labelPredicates,
    identifierLabels,
    hash: createHash("sha256").update(raw).digest("hex").slice(0, 16),
  };
}

// A personal honorific in the title itself ("Mr. Test", "Dr. Okafor") is a
// far more reliable person signal than a subtitle/role string, which can be
// any free-text job description the domain vocabulary was never going to
// enumerate ("Diagnostic Expert", "Structural Evaluation Expert", ...).
// Checked before the keyword rules below so it can't be shadowed by a
// subtitle that happens to match some other class.
const PERSON_HONORIFIC = /^(mr|mrs|ms|miss|mx|dr|prof|professor|sir|dame|madam|lord|lady|rev|capt|captain|sgt|sergeant)\.?\s+\S/i;

/**
 * Deterministically classify an entity type from the title's personal
 * honorific (if any) or an infobox subtitle / category label, using the
 * config-driven classification rules (first keyword match wins). Falls back
 * to `thing`. Returns the matched rule so callers can also pick up a
 * canonical category tag.
 */
export function classifyType(
  vocab: OntologyVocabulary,
  subtitle: string | undefined,
  title?: string,
): { type: string; category?: string } {
  if (title && vocab.entityTypes.has("person") && PERSON_HONORIFIC.test(title.trim())) {
    return { type: "person" };
  }
  const s = (subtitle ?? "").toLowerCase();
  if (s) {
    for (const rule of vocab.classification) {
      if (!vocab.entityTypes.has(rule.type)) continue;
      if (rule.match.some((kw) => s.includes(kw))) {
        return { type: rule.type, category: rule.category };
      }
    }
  }
  const fallback = vocab.entityTypes.has("thing") ? "thing" : [...vocab.entityTypes][0];
  return { type: fallback };
}

/** True when a typed relation satisfies the vocabulary's predicate signature. */
export function relationMatchesVocabulary(
  vocab: OntologyVocabulary,
  predicate: string,
  subjectType: string,
  objectType: string,
): boolean {
  const def = vocab.predicates.get(predicate);
  if (!def) return false;
  const subjectOk = def.subject === "*" || def.subject === subjectType;
  // Unary predicates (e.g. is_a) only classify the subject; the object is a
  // class/literal, not a typed entity, so its type is not constrained.
  if (def.arity === "unary") return subjectOk;
  const objectOk = def.object === "*" || def.object === objectType;
  return subjectOk && objectOk;
}

/** Normalize a free label to a snake_case key for predicate/identifier lookup. */
export function normalizeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
