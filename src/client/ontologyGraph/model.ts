import type {
  OntologyGraphNode,
  OntologyGraphPayload,
  OntologyGraphRelation,
  SemanticMetric,
} from "./types";

export interface SemanticGraphFilters {
  lens: "relations" | "types" | "coverage";
  query: string;
  predicate: string;
  entityType: string;
  sourceKind: string;
  metric: SemanticMetric;
  limit: number;
  showLiteralFacts: boolean;
}

export interface SemanticGraphProjection {
  nodes: OntologyGraphNode[];
  relations: OntologyGraphRelation[];
  literalRelations: OntologyGraphRelation[];
  maxMetric: number;
  selectedPredicateCount: number;
  selectedTypeCount: number;
}

const searchableText = (node: OntologyGraphNode): string =>
  `${node.label} ${node.entityType} ${node.description} ${node.articleSlug ?? ""}`.toLowerCase();

export function projectSemanticGraph(
  payload: OntologyGraphPayload,
  filters: SemanticGraphFilters,
): SemanticGraphProjection {
  const query = filters.query.trim().toLowerCase();
  const relationCandidates = payload.relations.filter((relation) => {
    if (filters.predicate !== "all" && relation.predicate !== filters.predicate) return false;
    if (filters.sourceKind !== "all" && relation.sourceKind !== filters.sourceKind) return false;
    if (!filters.showLiteralFacts && relation.target === null) return false;
    return true;
  });
  const relationNodeIds = new Set<string>();
  for (const relation of relationCandidates) {
    relationNodeIds.add(relation.source);
    if (relation.target) relationNodeIds.add(relation.target);
  }

  const visibleNodes = payload.nodes
    .filter((node) => {
      if (filters.entityType !== "all" && node.entityType !== filters.entityType) return false;
      if (query && !searchableText(node).includes(query)) return false;
      if (filters.lens === "coverage") return true;
      return relationNodeIds.has(node.id) || node.metrics.literalFactCount > 0;
    })
    .sort((a, b) => (b.metrics[filters.metric] ?? 0) - (a.metrics[filters.metric] ?? 0) || a.label.localeCompare(b.label))
    .slice(0, filters.limit);

  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const relations = relationCandidates.filter(
    (relation) => visibleIds.has(relation.source) && relation.target !== null && visibleIds.has(relation.target),
  );
  const literalRelations = relationCandidates.filter(
    (relation) => relation.target === null && visibleIds.has(relation.source),
  );
  const maxMetric = Math.max(1e-9, ...visibleNodes.map((node) => node.metrics[filters.metric] ?? 0));

  return {
    nodes: visibleNodes,
    relations,
    literalRelations,
    maxMetric,
    selectedPredicateCount: new Set(relations.concat(literalRelations).map((relation) => relation.predicate)).size,
    selectedTypeCount: new Set(visibleNodes.map((node) => node.entityType)).size,
  };
}

export interface PositionedNode extends OntologyGraphNode {
  x: number;
  y: number;
  radius: number;
}

export function layoutSemanticNodes(
  nodes: OntologyGraphNode[],
  metric: SemanticMetric,
  maxMetric: number,
): PositionedNode[] {
  if (nodes.length === 0) return [];
  const width = 960;
  const height = 560;
  const centerX = width / 2;
  const centerY = height / 2;
  const byCommunity = new Map<number, OntologyGraphNode[]>();
  for (const node of nodes) {
    const key = Number.isFinite(node.community) ? node.community : node.componentId;
    byCommunity.set(key, [...(byCommunity.get(key) ?? []), node]);
  }
  const groups = [...byCommunity.entries()].sort(([a], [b]) => a - b);
  const groupRadius = Math.min(width, height) * 0.32;

  return groups.flatMap(([community, group], groupIndex) => {
    const groupAngle = groups.length === 1 ? -Math.PI / 2 : (Math.PI * 2 * groupIndex) / groups.length - Math.PI / 2;
    const localCenterX = groups.length === 1 ? centerX : centerX + Math.cos(groupAngle) * groupRadius;
    const localCenterY = groups.length === 1 ? centerY : centerY + Math.sin(groupAngle) * groupRadius * 0.72;
    const localRadius = Math.max(42, Math.min(128, 20 + group.length * 7));
    return group
      .sort((a, b) => (b.metrics[metric] ?? 0) - (a.metrics[metric] ?? 0) || a.label.localeCompare(b.label))
      .map((node, index) => {
        const angle = group.length === 1 ? 0 : (Math.PI * 2 * index) / group.length - Math.PI / 2;
        const ring = group.length < 4 ? localRadius * 0.45 : localRadius * (0.55 + (index % 3) * 0.18);
        const metricNorm = (node.metrics[metric] ?? 0) / maxMetric;
        return {
          ...node,
          community,
          x: localCenterX + Math.cos(angle) * ring,
          y: localCenterY + Math.sin(angle) * ring,
          radius: 5 + Math.sqrt(metricNorm) * 18,
        };
      });
  });
}
