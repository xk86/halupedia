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
  /** Allowed subject entity type, or "*" for any. */
  subject: string;
  /** Allowed object entity type, or "*" for any. */
  object: string;
}

export interface OntologyVocabulary {
  version: number;
  entityTypes: Set<string>;
  predicates: Map<string, PredicateDef>;
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
  predicates?: Array<{ name: string; subject?: string; object?: string }>;
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
      subject: p.subject ?? "*",
      object: p.object ?? "*",
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
    labelPredicates,
    identifierLabels,
    hash: createHash("sha256").update(raw).digest("hex").slice(0, 16),
  };
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
