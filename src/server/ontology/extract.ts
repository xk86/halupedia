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
import {
  classifyType,
  normalizeLabel,
  relationMatchesVocabulary,
  type OntologyVocabulary,
} from "./vocabulary";
import { emptyExtraction, type ExtractedEntity, type ExtractionResult } from "./types";

const REF_LINK = /\[([^\]]+)\]\(ref:([^)\s]+)\)/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function stripLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
}

export interface DeterministicArgs {
  slug: string;
  title: string;
  infobox: InfoboxData | null;
  vocab: OntologyVocabulary;
}

export function extractDeterministic(args: DeterministicArgs): ExtractionResult {
  const { slug, title, infobox, vocab } = args;
  const result = emptyExtraction();
  if (!infobox) {
    // Still register the article as an entity so it can be a relation object.
    result.entities.push({ name: title, type: "thing", articleSlug: slug });
    return result;
  }

  const { type: articleType } = classifyType(vocab, infobox.subtitle);
  const articleEntity: ExtractedEntity = {
    name: title,
    type: articleType,
    articleSlug: slug,
    identifiers: [],
    description: infobox.subtitle ? stripLinks(infobox.subtitle) : undefined,
  };
  result.entities.push(articleEntity);
  if (infobox.subtitle) result.categories.push(stripLinks(infobox.subtitle));

  for (const group of infobox.groups ?? []) {
    for (const row of group.rows) {
      const label = (row.label ?? "").trim();
      const rawValue = (row.value ?? "").trim();
      if (!label || !rawValue) continue;
      const lowerLabel = label.toLowerCase();
      const normLabel = normalizeLabel(label);

      // Typed identifier (ticker/isin/…)?
      const scheme = vocab.identifierLabels.get(lowerLabel) ?? vocab.identifierLabels.get(normLabel);
      if (scheme) {
        articleEntity.identifiers!.push({ scheme, value: stripLinks(rawValue) });
        continue;
      }

      const predicate =
        vocab.labelPredicates.get(lowerLabel) ??
        vocab.labelPredicates.get(normLabel) ??
        (vocab.predicates.has(normLabel) ? normLabel : "related_to");

      const linkMatch = REF_LINK.exec(rawValue);
      if (linkMatch) {
        const objectName = linkMatch[1].trim();
        const objectSlug = linkMatch[2].trim();
        result.entities.push({ name: objectName, type: "thing", articleSlug: objectSlug });
        result.relations.push({
          subject: title,
          predicate,
          object: objectName,
          objectIsLiteral: false,
          source: "infobox",
        });
      } else {
        const value = stripLinks(rawValue);
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

/** Shape the model is asked to return (before validation). */
interface RawLlmExtraction {
  entities?: Array<{ name?: string; type?: string; aliases?: string[]; description?: string }>;
  relations?: Array<{ subject?: string; predicate?: string; object?: string }>;
  categories?: string[];
}

/**
 * Validate a raw model extraction against the vocabulary. Drops off-vocabulary
 * entities/relations; keeps emergent category tags. Entity types must be in the
 * core set and relation predicates must satisfy their signature.
 */
export function validateLlmExtraction(
  raw: RawLlmExtraction,
  vocab: OntologyVocabulary,
): ExtractionResult {
  const result = emptyExtraction();
  const typeByName = new Map<string, string>();
  for (const e of raw.entities ?? []) {
    const name = (e.name ?? "").trim();
    const type = (e.type ?? "").trim().toLowerCase();
    if (!name || !vocab.entityTypes.has(type)) continue;
    typeByName.set(name, type);
    result.entities.push({
      name,
      type,
      aliases: (e.aliases ?? []).map((a) => a.trim()).filter(Boolean),
      description: e.description?.trim(),
    });
  }
  for (const r of raw.relations ?? []) {
    const subject = (r.subject ?? "").trim();
    const predicate = (r.predicate ?? "").trim();
    const object = (r.object ?? "").trim();
    if (!subject || !predicate || !object) continue;
    const subjectType = typeByName.get(subject);
    const objectType = typeByName.get(object);
    if (!subjectType || !objectType) continue; // both must be validated entities
    if (!relationMatchesVocabulary(vocab, predicate, subjectType, objectType)) continue;
    result.relations.push({ subject, predicate, object, source: "extracted" });
  }
  for (const c of raw.categories ?? []) {
    const clean = (c ?? "").trim();
    if (clean) result.categories.push(clean);
  }
  return result;
}

/** Merge deterministic + LLM extractions (deterministic wins on conflicts). */
export function mergeExtractions(
  deterministic: ExtractionResult,
  llm: ExtractionResult,
): ExtractionResult {
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
