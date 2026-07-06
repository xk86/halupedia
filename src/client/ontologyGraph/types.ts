export type OntologyGraphSource =
  "curated" | "extracted" | "infobox" | "inferred";
export type OntologyGraphView = "3d" | "tree";

export interface OntologyGraphNode {
  id: string;
  entityId: number;
  label: string;
  entityType: string;
  articleSlug: string | null;
  description: string;
  metrics: {
    pagerank: number;
    betweenness: number;
    closeness: number;
    eigenvector: number;
    degree: number;
    inDegree: number;
    outDegree: number;
    hitsAuthority: number;
    hitsHub: number;
    eccentricity: number;
    factCount: number;
    literalFactCount: number;
  };
  community: number;
  componentId: number;
}

export interface OntologyGraphRelation {
  id: string;
  relationId: number;
  source: string;
  target: string | null;
  targetLiteral: string | null;
  predicate: string;
  predicateLabel: string;
  provenanceSlug: string | null;
  sourceKind: OntologyGraphSource;
  confidence: number;
  pinned: boolean;
  inferredFrom: string | null;
}

export interface PredicateSummary {
  name: string;
  label: string;
  subject: string;
  object: string;
  relationCount: number;
  entityEdgeCount: number;
  literalCount: number;
  sources: Record<string, number>;
}

export interface EntityTypeSummary {
  type: string;
  entityCount: number;
  incomingCount: number;
  outgoingCount: number;
  literalFactCount: number;
}

export interface OntologyGraphCoverage {
  articleCount: number;
  entityCount: number;
  articleEntityCount: number;
  articlesWithoutEntityCount: number;
  relationCount: number;
  entityEdgeCount: number;
  literalFactCount: number;
  isolatedEntityCount: number;
  lowConfidenceRelationCount: number;
  inferredRelationCount: number;
  staleArticleCount: number;
}

export interface OntologyGraphPayload {
  version: number;
  ontologySignature: string;
  graphRevision: number;
  nodes: OntologyGraphNode[];
  relations: OntologyGraphRelation[];
  predicates: PredicateSummary[];
  entityTypes: EntityTypeSummary[];
  coverage: OntologyGraphCoverage;
  analysis: {
    stages: string[];
    metrics: string[];
    density: number;
    componentCount: number;
    communityCount: number;
  };
}

export type SemanticLens = "relations" | "types" | "coverage";
export type SemanticMetric = keyof OntologyGraphNode["metrics"];
