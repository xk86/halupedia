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

export interface SemanticRenderGraph {
  nodes: OntologyGraphNode[];
  relations: OntologyGraphRelation[];
}

const searchableText = (node: OntologyGraphNode): string =>
  `${node.label} ${node.entityType} ${node.description} ${node.articleSlug ?? ""}`.toLowerCase();

export function projectSemanticGraph(
  payload: OntologyGraphPayload,
  filters: SemanticGraphFilters,
): SemanticGraphProjection {
  const query = filters.query.trim().toLowerCase();
  const relationCandidates = payload.relations.filter((relation) => {
    if (filters.predicate !== "all" && relation.predicate !== filters.predicate)
      return false;
    if (
      filters.sourceKind !== "all" &&
      relation.sourceKind !== filters.sourceKind
    )
      return false;
    if (!filters.showLiteralFacts && relation.target === null) return false;
    return true;
  });
  const relationNodeIds = new Set<string>();
  for (const relation of relationCandidates) {
    relationNodeIds.add(relation.source);
    if (relation.target) relationNodeIds.add(relation.target);
  }

  const eligibleNodes = payload.nodes
    .filter((node) => {
      if (
        filters.entityType !== "all" &&
        node.entityType !== filters.entityType
      )
        return false;
      if (query && !searchableText(node).includes(query)) return false;
      if (filters.lens === "coverage") return true;
      return relationNodeIds.has(node.id);
    })
    .sort(
      (a, b) =>
        (b.metrics[filters.metric] ?? 0) - (a.metrics[filters.metric] ?? 0) ||
        a.label.localeCompare(b.label),
    );
  const eligibleIds = new Set(eligibleNodes.map((node) => node.id));
  const selectedIds = new Set<string>();

  if (filters.lens !== "coverage") {
    const nodeById = new Map(eligibleNodes.map((node) => [node.id, node]));
    const entityRelations = relationCandidates
      .filter(
        (relation) =>
          relation.target !== null &&
          eligibleIds.has(relation.source) &&
          eligibleIds.has(relation.target),
      )
      .sort((a, b) => {
        const aMetric = Math.max(
          nodeById.get(a.source)?.metrics[filters.metric] ?? 0,
          nodeById.get(a.target!)?.metrics[filters.metric] ?? 0,
        );
        const bMetric = Math.max(
          nodeById.get(b.source)?.metrics[filters.metric] ?? 0,
          nodeById.get(b.target!)?.metrics[filters.metric] ?? 0,
        );
        return bMetric - aMetric || a.id.localeCompare(b.id);
      });
    for (const relation of entityRelations) {
      const additions = [relation.source, relation.target!].filter(
        (id) => !selectedIds.has(id),
      );
      if (selectedIds.size + additions.length > filters.limit) continue;
      additions.forEach((id) => selectedIds.add(id));
    }
  }
  for (const node of eligibleNodes) {
    if (selectedIds.size >= filters.limit) break;
    selectedIds.add(node.id);
  }
  const visibleNodes = eligibleNodes.filter((node) => selectedIds.has(node.id));

  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const relations = relationCandidates.filter(
    (relation) =>
      visibleIds.has(relation.source) &&
      relation.target !== null &&
      visibleIds.has(relation.target),
  );
  const literalRelations = relationCandidates.filter(
    (relation) => relation.target === null && visibleIds.has(relation.source),
  );
  const maxMetric = Math.max(
    1e-9,
    ...visibleNodes.map((node) => node.metrics[filters.metric] ?? 0),
  );

  return {
    nodes: visibleNodes,
    relations,
    literalRelations,
    maxMetric,
    selectedPredicateCount: new Set(
      relations.concat(literalRelations).map((relation) => relation.predicate),
    ).size,
    selectedTypeCount: new Set(visibleNodes.map((node) => node.entityType))
      .size,
  };
}

export function materializeSemanticGraph(
  projection: Pick<
    SemanticGraphProjection,
    "nodes" | "relations" | "literalRelations"
  >,
  nodeLimit = 160,
): SemanticRenderGraph {
  const nodes = [...projection.nodes];
  const relations = [...projection.relations];
  const availableLiteralSlots = Math.max(0, nodeLimit - nodes.length);
  const sourceById = new Map(nodes.map((node) => [node.id, node]));
  for (const relation of projection.literalRelations.slice(
    0,
    availableLiteralSlots,
  )) {
    const source = sourceById.get(relation.source);
    if (!source || !relation.targetLiteral) continue;
    const literalId = `literal:${relation.id}`;
    nodes.push({
      id: literalId,
      entityId: -relation.relationId,
      label: relation.targetLiteral,
      entityType: "literal value",
      articleSlug: null,
      description: relation.predicateLabel,
      community: source.community,
      componentId: source.componentId,
      metrics: {
        pagerank: 0,
        betweenness: 0,
        closeness: 0,
        eigenvector: 0,
        degree: 1,
        inDegree: 1,
        outDegree: 0,
        hitsAuthority: 0,
        hitsHub: 0,
        eccentricity: 0,
        factCount: 1,
        literalFactCount: 1,
      },
    });
    relations.push({ ...relation, target: literalId });
  }
  return { nodes, relations };
}

export interface PositionedNode extends OntologyGraphNode {
  x: number;
  y: number;
  radius: number;
}

export interface TreePositionedNode extends PositionedNode {
  depth: number;
}

export function layoutSemanticTreeNodes(
  nodes: OntologyGraphNode[],
  relations: OntologyGraphRelation[],
  metric: SemanticMetric,
  maxMetric: number,
): TreePositionedNode[] {
  if (nodes.length === 0) return [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  for (const relation of relations) {
    if (
      !relation.target ||
      !nodeById.has(relation.source) ||
      !nodeById.has(relation.target)
    )
      continue;
    outgoing.set(relation.source, [
      ...(outgoing.get(relation.source) ?? []),
      relation.target,
    ]);
    incoming.set(relation.target, (incoming.get(relation.target) ?? 0) + 1);
  }
  const byRank = (a: OntologyGraphNode, b: OntologyGraphNode) =>
    (b.metrics[metric] ?? 0) - (a.metrics[metric] ?? 0) ||
    a.label.localeCompare(b.label);
  const roots = nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .sort(byRank);
  const remaining = nodes.filter((node) => !roots.includes(node)).sort(byRank);
  const depthById = new Map<string, number>();
  const visit = (rootId: string) => {
    if (depthById.has(rootId)) return;
    depthById.set(rootId, 0);
    const queue = [rootId];
    while (queue.length > 0) {
      const source = queue.shift()!;
      const nextDepth = (depthById.get(source) ?? 0) + 1;
      const targets = [...new Set(outgoing.get(source) ?? [])].sort((a, b) =>
        byRank(nodeById.get(a)!, nodeById.get(b)!),
      );
      for (const target of targets) {
        if (depthById.has(target)) continue;
        depthById.set(target, nextDepth);
        queue.push(target);
      }
    }
  };
  roots.forEach((node) => visit(node.id));
  remaining.forEach((node) => visit(node.id));

  const levels = new Map<number, OntologyGraphNode[]>();
  for (const node of nodes) {
    const depth = depthById.get(node.id) ?? 0;
    levels.set(depth, [...(levels.get(depth) ?? []), node]);
  }
  const width = 960;
  const height = 560;
  const maxDepth = Math.max(0, ...levels.keys());
  return [...levels.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([depth, level]) =>
      level.sort(byRank).map((node, index) => {
        const metricNorm = (node.metrics[metric] ?? 0) / maxMetric;
        return {
          ...node,
          depth,
          x: ((index + 1) * width) / (level.length + 1),
          y: 54 + (depth * (height - 108)) / Math.max(1, maxDepth),
          radius: 5 + Math.sqrt(metricNorm) * 18,
        };
      }),
    );
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
    const key = Number.isFinite(node.community)
      ? node.community
      : node.componentId;
    byCommunity.set(key, [...(byCommunity.get(key) ?? []), node]);
  }
  const groups = [...byCommunity.entries()].sort(([a], [b]) => a - b);
  const groupRadius = Math.min(width, height) * 0.32;

  return groups.flatMap(([community, group], groupIndex) => {
    const groupAngle =
      groups.length === 1
        ? -Math.PI / 2
        : (Math.PI * 2 * groupIndex) / groups.length - Math.PI / 2;
    const localCenterX =
      groups.length === 1
        ? centerX
        : centerX + Math.cos(groupAngle) * groupRadius;
    const localCenterY =
      groups.length === 1
        ? centerY
        : centerY + Math.sin(groupAngle) * groupRadius * 0.72;
    const localRadius = Math.max(42, Math.min(128, 20 + group.length * 7));
    return group
      .sort(
        (a, b) =>
          (b.metrics[metric] ?? 0) - (a.metrics[metric] ?? 0) ||
          a.label.localeCompare(b.label),
      )
      .map((node, index) => {
        const angle =
          group.length === 1
            ? 0
            : (Math.PI * 2 * index) / group.length - Math.PI / 2;
        const ring =
          group.length < 4
            ? localRadius * 0.45
            : localRadius * (0.55 + (index % 3) * 0.18);
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
