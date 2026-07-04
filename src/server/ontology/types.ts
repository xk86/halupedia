/** Shared types for ontology extraction and storage. */

export interface ExtractedIdentifier {
  scheme: string;
  value: string;
}

export interface ExtractedEntity {
  /** Canonical display name. */
  name: string;
  /** Core entity type (validated against the vocabulary). */
  type: string;
  /** Article this entity owns, if any. */
  articleSlug?: string;
  aliases?: string[];
  identifiers?: ExtractedIdentifier[];
  description?: string;
}

export interface ExtractedRelation {
  /** Subject entity canonical name. */
  subject: string;
  predicate: string;
  /** Object entity name, or a literal value when `objectIsLiteral`. */
  object: string;
  /** Article slug the object links to, when the object is an internal link. */
  objectSlug?: string;
  objectIsLiteral?: boolean;
  /** 'infobox' | 'extracted' | 'curated'. Determines pin/clobber policy. */
  source: "infobox" | "extracted" | "curated";
  confidence?: number;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  /** Emergent category tags (normalized, not necessarily in core vocab). */
  categories: string[];
}

export function emptyExtraction(): ExtractionResult {
  return { entities: [], relations: [], categories: [] };
}
