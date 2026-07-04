/**
 * Ontological inference over asserted relations.
 *
 * Derives new, provable relations from the ones extraction gave us, using the
 * inference metadata on each predicate in the controlled vocabulary:
 *   - symmetric:  S p O  ⇒  O p S
 *   - inverse q:  S p O  ⇒  O q S
 *   - transitive: S p O, O p T  ⇒  S p T   (one hop, within the given set)
 *
 * Derived relations are tagged `source: "inferred"`, carry a decayed confidence
 * (product of the basis confidences × a decay factor), and record the basis
 * fact(s) in `inferredFrom` so the inference stays provable. Only entity-object
 * relations participate — literal objects (dates, is_a class tags) do not.
 */
import type { ExtractedRelation } from "./types";
import type { OntologyVocabulary } from "./vocabulary";

const DEFAULT_DECAY = 0.9;

function relationKey(r: ExtractedRelation): string {
  return `${r.subject}|${r.predicate}|${r.object}`;
}

export function inferRelations(
  vocab: OntologyVocabulary,
  relations: ExtractedRelation[],
  decay = DEFAULT_DECAY,
): ExtractedRelation[] {
  const inferred: ExtractedRelation[] = [];
  const seen = new Set(relations.map(relationKey));
  const add = (r: ExtractedRelation): void => {
    if (r.subject === r.object) return; // never derive a self-loop
    const key = relationKey(r);
    if (seen.has(key)) return;
    seen.add(key);
    inferred.push(r);
  };

  // Only relations whose object is a real entity can be reversed/chained.
  const entityRels = relations.filter(
    (r) => !r.objectIsLiteral && r.predicate !== "is_a",
  );

  for (const r of entityRels) {
    const def = vocab.predicates.get(r.predicate);
    if (!def || def.arity !== "binary") continue;
    const conf = (r.confidence ?? 1) * decay;
    const basis = `${r.subject} ${r.predicate} ${r.object}`;
    if (def.symmetric) {
      add({ subject: r.object, predicate: r.predicate, object: r.subject, source: "inferred", confidence: conf, inferredFrom: basis });
    }
    if (def.inverse && vocab.predicates.has(def.inverse)) {
      add({ subject: r.object, predicate: def.inverse, object: r.subject, source: "inferred", confidence: conf, inferredFrom: basis });
    }
  }

  // Transitive closure within the given set (one hop). Full cross-article
  // closure would need a global pass; this catches chains present per-article.
  for (const a of entityRels) {
    const def = vocab.predicates.get(a.predicate);
    if (!def?.transitive) continue;
    for (const b of entityRels) {
      if (b.predicate !== a.predicate || b.subject !== a.object) continue;
      const conf = (a.confidence ?? 1) * (b.confidence ?? 1) * decay;
      add({
        subject: a.subject,
        predicate: a.predicate,
        object: b.object,
        source: "inferred",
        confidence: conf,
        inferredFrom: `${a.subject} ${a.predicate} ${a.object} + ${b.subject} ${b.predicate} ${b.object}`,
      });
    }
  }

  return inferred;
}
