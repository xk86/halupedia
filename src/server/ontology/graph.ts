import type { DatabaseSync } from "node:sqlite";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import { connectedComponents } from "graphology-components";
import { density } from "graphology-metrics/graph";
import {
  degreeCentrality,
  inDegreeCentrality,
  outDegreeCentrality,
} from "graphology-metrics/centrality/degree";
import pagerank from "graphology-metrics/centrality/pagerank";
import betweenness from "graphology-metrics/centrality/betweenness";
import closeness from "graphology-metrics/centrality/closeness";
import eigenvector from "graphology-metrics/centrality/eigenvector";
import hits from "graphology-metrics/centrality/hits";
import { eccentricity } from "graphology-metrics/node";
import type { OntologyVocabulary } from "./vocabulary";

export type OntologyGraphSource = "curated" | "extracted" | "infobox" | "inferred";

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

interface EntityRow {
  id: number;
  canonical_name: string;
  entity_type: string;
  article_slug: string | null;
  description: string;
}

interface RelationRow {
  id: number;
  subject_entity_id: number;
  subject_name: string;
  subject_type: string;
  object_entity_id: number | null;
  object_name: string | null;
  object_type: string | null;
  object_literal: string | null;
  predicate: string;
  provenance_slug: string | null;
  source: OntologyGraphSource;
  confidence: number;
  pinned: number;
  inferred_from: string | null;
}

function relationEntityKey(row: RelationRow): string | null {
  if (row.object_entity_id === null) return null;
  return `${row.subject_entity_id}\u0001${row.predicate}\u0001${row.object_entity_id}`;
}

function increment(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function objectFromCounts(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function safeMetric(fn: () => Record<string, number>, nodes: string[]): Record<string, number> {
  try {
    return fn();
  } catch {
    return Object.fromEntries(nodes.map((id) => [id, 0]));
  }
}

function buildMetricGraph(entityIds: string[], relations: RelationRow[]): Graph {
  const g = new Graph({ type: "directed", multi: false, allowSelfLoops: true });
  for (const id of entityIds) g.mergeNode(id);
  const seenEdges = new Set<string>();
  for (const row of relations) {
    if (row.object_entity_id === null) continue;
    const source = String(row.subject_entity_id);
    const target = String(row.object_entity_id);
    const edgeKey = `${source}>${target}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    g.mergeDirectedEdge(source, target);
  }
  return g;
}

function reduceRelations(relations: RelationRow[]): RelationRow[] {
  const byKey = new Map<string, RelationRow>();
  for (const row of relations) {
    const key =
      relationEntityKey(row) ??
      `${row.subject_entity_id}\u0001${row.predicate}\u0001literal\u0001${row.object_literal ?? ""}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    const sourceRank = (source: string): number =>
      source === "curated" ? 4 : source === "infobox" ? 3 : source === "extracted" ? 2 : 1;
    if (
      sourceRank(row.source) > sourceRank(existing.source) ||
      (sourceRank(row.source) === sourceRank(existing.source) && row.confidence > existing.confidence)
    ) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort((a, b) => a.id - b.id);
}

export function buildOntologyGraphPayload(
  db: DatabaseSync,
  vocab: OntologyVocabulary,
): OntologyGraphPayload {
  const entities = db
    .prepare(
      `SELECT id, canonical_name, entity_type, article_slug, description
       FROM entities
       ORDER BY canonical_name COLLATE NOCASE, entity_type`,
    )
    .all() as unknown as EntityRow[];

  const relationRows = db
    .prepare(
      `SELECT r.id,
              r.subject_entity_id,
              s.canonical_name AS subject_name,
              s.entity_type AS subject_type,
              r.object_entity_id,
              o.canonical_name AS object_name,
              o.entity_type AS object_type,
              r.object_literal,
              r.predicate,
              r.provenance_slug,
              r.source,
              r.confidence,
              r.pinned,
              r.inferred_from
       FROM entity_relations r
       JOIN entities s ON s.id = r.subject_entity_id
       LEFT JOIN entities o ON o.id = r.object_entity_id
       ORDER BY r.id`,
    )
    .all() as unknown as RelationRow[];

  const relations = reduceRelations(relationRows);
  const entityIds = entities.map((entity) => String(entity.id));
  const graph = buildMetricGraph(entityIds, relations);
  const components = connectedComponents(graph);
  const componentByNode = new Map<string, number>();
  components.forEach((component, index) => {
    for (const id of component) componentByNode.set(id, index);
  });
  const communities = safeMetric(() => louvain(graph), entityIds);
  const communityCount = new Set(Object.values(communities)).size;

  const metricNodes = graph.nodes();
  const metrics = {
    pagerank: safeMetric(() => pagerank(graph, { getEdgeWeight: null }), metricNodes),
    betweenness: safeMetric(() => betweenness(graph), metricNodes),
    closeness: safeMetric(() => closeness(graph), metricNodes),
    eigenvector: safeMetric(() => eigenvector(graph), metricNodes),
    degree: safeMetric(() => degreeCentrality(graph), metricNodes),
    inDegree: safeMetric(() => inDegreeCentrality(graph), metricNodes),
    outDegree: safeMetric(() => outDegreeCentrality(graph), metricNodes),
    hitsAuthority: safeMetric(() => hits(graph).authorities, metricNodes),
    hitsHub: safeMetric(() => hits(graph).hubs, metricNodes),
  };
  const eccentricityByNode: Record<string, number> = {};
  for (const id of metricNodes) {
    try {
      eccentricityByNode[id] = eccentricity(graph, id);
    } catch {
      eccentricityByNode[id] = 0;
    }
  }

  const factCounts = new Map<string, number>();
  const literalFactCounts = new Map<string, number>();
  const incomingCounts = new Map<string, number>();
  const outgoingCounts = new Map<string, number>();
  const predicateCounts = new Map<string, PredicateSummary>();
  const typeCounts = new Map<string, EntityTypeSummary>();

  for (const entity of entities) {
    typeCounts.set(entity.entity_type, {
      type: entity.entity_type,
      entityCount: (typeCounts.get(entity.entity_type)?.entityCount ?? 0) + 1,
      incomingCount: typeCounts.get(entity.entity_type)?.incomingCount ?? 0,
      outgoingCount: typeCounts.get(entity.entity_type)?.outgoingCount ?? 0,
      literalFactCount: typeCounts.get(entity.entity_type)?.literalFactCount ?? 0,
    });
  }

  for (const row of relations) {
    const subjectId = String(row.subject_entity_id);
    increment(factCounts, subjectId);
    increment(outgoingCounts, subjectId);
    if (row.object_entity_id !== null) {
      increment(incomingCounts, String(row.object_entity_id));
    } else {
      increment(literalFactCounts, subjectId);
    }

    const predicate = vocab.predicates.get(row.predicate);
    const summary =
      predicateCounts.get(row.predicate) ?? {
        name: row.predicate,
        label: predicate?.label ?? row.predicate,
        subject: predicate?.subject ?? "*",
        object: predicate?.object ?? "*",
        relationCount: 0,
        entityEdgeCount: 0,
        literalCount: 0,
        sources: {},
      };
    summary.relationCount += 1;
    if (row.object_entity_id === null) summary.literalCount += 1;
    else summary.entityEdgeCount += 1;
    summary.sources[row.source] = (summary.sources[row.source] ?? 0) + 1;
    predicateCounts.set(row.predicate, summary);

    const subjectType = typeCounts.get(row.subject_type);
    if (subjectType) {
      subjectType.outgoingCount += 1;
      if (row.object_entity_id === null) subjectType.literalFactCount += 1;
    }
    if (row.object_type) {
      const objectType = typeCounts.get(row.object_type);
      if (objectType) objectType.incomingCount += 1;
    }
  }

  const nodes: OntologyGraphNode[] = entities.map((entity) => {
    const id = String(entity.id);
    return {
      id,
      entityId: entity.id,
      label: entity.canonical_name,
      entityType: entity.entity_type,
      articleSlug: entity.article_slug,
      description: entity.description,
      metrics: {
        pagerank: metrics.pagerank[id] ?? 0,
        betweenness: metrics.betweenness[id] ?? 0,
        closeness: metrics.closeness[id] ?? 0,
        eigenvector: metrics.eigenvector[id] ?? 0,
        degree: metrics.degree[id] ?? 0,
        inDegree: metrics.inDegree[id] ?? 0,
        outDegree: metrics.outDegree[id] ?? 0,
        hitsAuthority: metrics.hitsAuthority[id] ?? 0,
        hitsHub: metrics.hitsHub[id] ?? 0,
        eccentricity: eccentricityByNode[id] ?? 0,
        factCount: factCounts.get(id) ?? 0,
        literalFactCount: literalFactCounts.get(id) ?? 0,
      },
      community: communities[id] ?? 0,
      componentId: componentByNode.get(id) ?? -1,
    };
  });

  const graphRelations: OntologyGraphRelation[] = relations.map((row) => {
    const predicate = vocab.predicates.get(row.predicate);
    return {
      id: String(row.id),
      relationId: row.id,
      source: String(row.subject_entity_id),
      target: row.object_entity_id === null ? null : String(row.object_entity_id),
      targetLiteral: row.object_entity_id === null ? row.object_literal : null,
      predicate: row.predicate,
      predicateLabel: predicate?.label ?? row.predicate,
      provenanceSlug: row.provenance_slug,
      sourceKind: row.source,
      confidence: row.confidence,
      pinned: row.pinned === 1,
      inferredFrom: row.inferred_from,
    };
  });

  const articleCount = (db.prepare(`SELECT COUNT(*) AS n FROM articles WHERE is_disambiguation = 0`).get() as { n: number }).n;
  const articleEntityCount = nodes.filter((node) => node.articleSlug).length;
  const staleArticleCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM articles a
         LEFT JOIN article_ontology_state s ON s.article_slug = a.slug
         WHERE a.is_disambiguation = 0
           AND COALESCE(s.signature, '') <> ?`,
      )
      .get(vocab.signature) as { n: number }
  ).n;

  const isolatedEntityCount = nodes.filter(
    (node) =>
      (incomingCounts.get(node.id) ?? 0) === 0 &&
      (outgoingCounts.get(node.id) ?? 0) === 0 &&
      node.metrics.literalFactCount === 0,
  ).length;

  return {
    version: 1,
    ontologySignature: vocab.signature,
    graphRevision: Date.now(),
    nodes,
    relations: graphRelations,
    predicates: [...predicateCounts.values()].sort((a, b) => b.relationCount - a.relationCount || a.name.localeCompare(b.name)),
    entityTypes: [...typeCounts.values()].sort((a, b) => b.entityCount - a.entityCount || a.type.localeCompare(b.type)),
    coverage: {
      articleCount,
      entityCount: nodes.length,
      articleEntityCount,
      articlesWithoutEntityCount: Math.max(0, articleCount - articleEntityCount),
      relationCount: graphRelations.length,
      entityEdgeCount: graphRelations.filter((relation) => relation.target !== null).length,
      literalFactCount: graphRelations.filter((relation) => relation.target === null).length,
      isolatedEntityCount,
      lowConfidenceRelationCount: graphRelations.filter((relation) => relation.confidence < 0.75).length,
      inferredRelationCount: graphRelations.filter((relation) => relation.sourceKind === "inferred").length,
      staleArticleCount,
    },
    analysis: {
      stages: [
        "map:entities",
        "map:relations",
        "filter:ontology-lens",
        "reduce:dedupe-facts",
        "reduce:aggregate-predicates",
        "reduce:aggregate-types",
        "compute:centrality",
        "compute:components",
        "compute:communities",
        "project:semantic-atlas",
      ],
      metrics: [
        "pagerank",
        "betweenness",
        "closeness",
        "eigenvector",
        "degree",
        "inDegree",
        "outDegree",
        "hitsAuthority",
        "hitsHub",
        "eccentricity",
        "components",
        "louvain",
        "density",
      ],
      density: metricNodes.length > 1 ? density(graph) : 0,
      componentCount: components.length,
      communityCount,
    },
  };
}
