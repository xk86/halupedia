/**
 * Hybrid ontology extraction.
 *
 *  - Deterministic: infobox key=value rows + `ref:` links become entities,
 *    typed relations, identifiers, and a category tag from the subtitle. This is
 *    high precision and needs no model.
 *  - LLM-assisted (optional): a light model proposes additional entities,
 *    relations, and category tags from prose; everything is validated against
 *    the controlled vocabulary before it is trusted.
 */
import type { InfoboxData } from "../db";
import { parseMarkdownLinks } from "../text/markdownLinkParser";
import { classifyType, normalizeLabel, relationMatchesVocabulary, type OntologyVocabulary } from "./vocabulary";
import { emptyExtraction, type ExtractedEntity, type ExtractionResult } from "./types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INTERNAL_LINK_KINDS = new Set(["ref", "halu", "wiki", "plain-slug"]);

/**
 * Reduce an infobox/model value to clean plain text for a fact. Unwraps proper
 * markdown links AND the bare `[brackets]` the model sometimes emits without a
 * target, and collapses whitespace. Emphasis (`*italic*`, `**bold**`) and
 * inline code are left as-is — they're legitimate formatting, not stray
 * markup — and underscores are untouched so slugs/identifiers aren't mangled.
 * Keeping fact text clean at the source stops malformed link syntax from
 * reaching the model, where it compounds into worse output downstream.
 */
export function sanitizeFactText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/\[([^\]]+)\]/g, "$1") // bare [text] -> text
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Recognize an internal link in an infobox value and return its display name +
 * target slug. Handles every internal form the link parser knows:
 *   - proper links `[Name](ref:slug)` / `[Name](halu:slug)` / wiki / plain-slug
 *   - the loose shorthand `Name (halu:slug)` the model often emits
 * Returns null when the value carries no internal link (a literal).
 */
function resolveLinkedObject(rawValue: string): { name: string; slug: string } | null {
  const parsed = parseMarkdownLinks(rawValue);
  const link = parsed.links.find((l) => INTERNAL_LINK_KINDS.has(l.kind) && l.slug);
  if (link?.slug) {
    return { name: link.label.trim() || link.slug, slug: link.slug };
  }
  const marker = parsed.looseInternalMarkers.find((m) => m.slug);
  if (marker?.slug) {
    // The visible name is the value with the marker removed.
    const name = (rawValue.slice(0, marker.start) + rawValue.slice(marker.end)).trim() || marker.slug;
    return { name: sanitizeFactText(name), slug: marker.slug };
  }
  return null;
}

export interface DeterministicArgs {
  slug: string;
  title: string;
  infobox: InfoboxData | null;
  vocab: OntologyVocabulary;
}

/** Emit the unary `is_a` classification fact ("<title> is a <type>"). */
function emitIsA(result: ExtractionResult, title: string, type: string): void {
  result.relations.push({
    subject: title,
    predicate: "is_a",
    object: type,
    objectIsLiteral: true,
    source: "infobox",
  });
}

export function extractDeterministic(args: DeterministicArgs): ExtractionResult {
  const { slug, title, infobox, vocab } = args;
  const result = emptyExtraction();
  if (!infobox) {
    // Still register the article as an entity so it can be a relation object,
    // and tag its (fallback) type so even infobox-less articles are classified.
    // A personal honorific in the title is still a usable signal with no
    // infobox to go on.
    const { type } = classifyType(vocab, undefined, title);
    result.entities.push({ name: title, type, articleSlug: slug });
    emitIsA(result, title, type);
    return result;
  }

  const { type: articleType, category } = classifyType(vocab, infobox.subtitle, title);
  const articleEntity: ExtractedEntity = {
    name: title,
    type: articleType,
    articleSlug: slug,
    identifiers: [],
    description: infobox.subtitle ? sanitizeFactText(infobox.subtitle) : undefined,
  };
  result.entities.push(articleEntity);
  emitIsA(result, title, articleType);
  // Prefer the canonical category from the classification rule; otherwise keep
  // the raw subtitle as an emergent tag.
  if (category) result.categories.push(category);
  if (infobox.subtitle) result.categories.push(sanitizeFactText(infobox.subtitle));

  for (const group of infobox.groups ?? []) {
    for (const row of group.rows) {
      // Drop a trailing colon some infobox labels carry ("Nature:"), so the
      // label reads cleanly whether it's matched to a predicate or kept verbatim
      // as one (otherwise the attribute renders as "Nature:: value").
      const label = (row.label ?? "").trim().replace(/\s*:+\s*$/, "");
      const rawValue = (row.value ?? "").trim();
      if (!label || !rawValue) continue;
      const lowerLabel = label.toLowerCase();
      const normLabel = normalizeLabel(label);

      // Typed identifier (ticker/isin/…)?
      const scheme = vocab.identifierLabels.get(lowerLabel) ?? vocab.identifierLabels.get(normLabel);
      if (scheme) {
        articleEntity.identifiers!.push({
          scheme,
          value: sanitizeFactText(rawValue),
        });
        continue;
      }

      // Map the row label onto a core predicate when we can. Otherwise keep the
      // label verbatim as the predicate: the row is a descriptive attribute
      // ("Hypothesis: …"), not a relation to another entity. Collapsing it to
      // `related_to` would both discard the meaningful label and falsely imply a
      // relationship — `related_to` is reserved for the vocabulary's use.
      const predicate = vocab.labelPredicates.get(lowerLabel) ?? vocab.labelPredicates.get(normLabel) ?? (vocab.predicates.has(normLabel) ? normLabel : label);

      const linked = resolveLinkedObject(rawValue);
      if (linked) {
        result.entities.push({
          name: linked.name,
          type: "thing",
          articleSlug: linked.slug,
        });
        result.relations.push({
          subject: title,
          predicate,
          object: linked.name,
          objectSlug: linked.slug,
          objectIsLiteral: false,
          source: "infobox",
        });
      } else {
        const value = sanitizeFactText(rawValue);
        if (ISO_DATE.test(value)) {
          articleEntity.identifiers!.push({ scheme: "iso_date", value });
        }
        result.relations.push({
          subject: title,
          predicate,
          object: value,
          objectIsLiteral: true,
          source: "infobox",
        });
      }
    }
  }
  return result;
}

/**
 * Coerce an untrusted model field to a trimmed string. The model sometimes
 * emits a number, boolean, or a nested object/array where a string is expected;
 * anything non-scalar becomes "" (and is dropped downstream) rather than
 * crashing on a `.trim()` that isn't a function.
 */
function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Validate a raw model extraction against the vocabulary. Tolerates arbitrary
 * malformed input (`unknown`): missing/mistyped fields are coerced or skipped,
 * never thrown on. Drops off-vocabulary entities/relations; keeps emergent
 * category tags. Entity types must be in the core set and relation predicates
 * must satisfy their signature.
 */
export function validateLlmExtraction(raw: unknown, vocab: OntologyVocabulary): ExtractionResult {
  const result = emptyExtraction();
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const typeByName = new Map<string, string>();
  const canonByAlias = new Map<string, string>();
  for (const entry of asArray(root.entities)) {
    const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const name = sanitizeFactText(asText(e.name));
    const type = asText(e.type).toLowerCase();
    if (!name || !vocab.entityTypes.has(type)) continue;
    typeByName.set(name, type);
    const aliases = asArray(e.aliases)
      .map((a) => sanitizeFactText(asText(a)))
      .filter(Boolean);
    for (const alias of aliases) canonByAlias.set(alias, name);
    result.entities.push({
      name,
      type,
      aliases,
      description: sanitizeFactText(asText(e.description)) || undefined,
    });
  }
  const resolveEntity = (raw: string): { name: string; type: string } | null => {
    const direct = typeByName.get(raw);
    if (direct) return { name: raw, type: direct };
    const canon = canonByAlias.get(raw);
    if (canon) return { name: canon, type: typeByName.get(canon)! };
    return null;
  };
  for (const entry of asArray(root.relations)) {
    const r = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const subject = sanitizeFactText(asText(r.subject));
    const predicate = asText(r.predicate);
    const object = sanitizeFactText(asText(r.object));
    if (!subject || !predicate || !object) continue;
    if (!vocab.predicates.has(predicate)) continue;
    const subjectRes = resolveEntity(subject);
    if (!subjectRes) continue;
    const objectRes = resolveEntity(object);
    if (objectRes) {
      if (!relationMatchesVocabulary(vocab, predicate, subjectRes.type, objectRes.type)) continue;
      result.relations.push({
        subject: subjectRes.name,
        predicate,
        object: objectRes.name,
        source: "extracted",
      });
    } else {
      const def = vocab.predicates.get(predicate)!;
      if (def.object !== "*") continue;
      result.relations.push({
        subject: subjectRes.name,
        predicate,
        object,
        source: "extracted",
      });
    }
  }
  for (const c of asArray(root.categories)) {
    const clean = asText(c);
    if (clean) result.categories.push(clean);
  }
  return result;
}

function comparableFactText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function conveysSameObject(left: string, right: string): boolean {
  const a = comparableFactText(left);
  const b = comparableFactText(right);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)));
}

/** Append model-derived facts without removing deterministic facts. */
export function mergeExtractions(deterministic: ExtractionResult, llm: ExtractionResult): ExtractionResult {
  const entities = [...deterministic.entities];
  const seenEntity = new Set(entities.map((e) => `${e.name}|${e.type}`));
  for (const e of llm.entities) {
    const key = `${e.name}|${e.type}`;
    if (!seenEntity.has(key)) {
      seenEntity.add(key);
      entities.push(e);
    }
  }
  const relations = [...deterministic.relations];
  const seenRel = new Set(relations.map((r) => `${r.subject}|${r.predicate}|${r.object}`));
  for (const r of llm.relations) {
    const key = `${r.subject}|${r.predicate}|${r.object}`;
    if (!seenRel.has(key)) {
      seenRel.add(key);
      relations.push(r);
    }
  }
  const categories = [...new Set([...deterministic.categories, ...llm.categories])];
  return { entities, relations, categories };
}

/**
 * Merge model-derived facts while removing broad infobox facts that convey the
 * same object value. The sidebar remains unchanged; only ontology rows are
 * pruned.
 */
export function mergeOntologyExtractions(deterministic: ExtractionResult, llm: ExtractionResult): ExtractionResult {
  const prunedDeterministic = {
    ...deterministic,
    relations: deterministic.relations.filter((candidate) => {
      if (candidate.source !== "infobox" || candidate.predicate === "is_a") return true;
      return !llm.relations.some((inferred) => comparableFactText(inferred.subject) === comparableFactText(candidate.subject) && conveysSameObject(inferred.object, candidate.object));
    }),
  };
  return mergeExtractions(prunedDeterministic, llm);
}
