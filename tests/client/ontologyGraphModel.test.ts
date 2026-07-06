import { describe, expect, test } from "vitest";
import {
  layoutSemanticNodes,
  layoutSemanticTreeNodes,
  projectSemanticGraph,
} from "../../src/client/ontologyGraph/model";
import type { OntologyGraphPayload } from "../../src/client/ontologyGraph/types";

const payload: OntologyGraphPayload = {
  version: 1,
  ontologySignature: "sig",
  graphRevision: 1,
  nodes: [
    {
      id: "1",
      entityId: 1,
      label: "Acme Labs",
      entityType: "organization",
      articleSlug: "acme-labs",
      description: "Lab",
      community: 0,
      componentId: 0,
      metrics: {
        pagerank: 0.8,
        betweenness: 0,
        closeness: 0,
        eigenvector: 0,
        degree: 2,
        inDegree: 0,
        outDegree: 2,
        hitsAuthority: 0,
        hitsHub: 0,
        eccentricity: 1,
        factCount: 2,
        literalFactCount: 1,
      },
    },
    {
      id: "2",
      entityId: 2,
      label: "Ada Person",
      entityType: "person",
      articleSlug: "ada-person",
      description: "Founder",
      community: 0,
      componentId: 0,
      metrics: {
        pagerank: 0.2,
        betweenness: 0,
        closeness: 0,
        eigenvector: 0,
        degree: 1,
        inDegree: 1,
        outDegree: 0,
        hitsAuthority: 0,
        hitsHub: 0,
        eccentricity: 1,
        factCount: 0,
        literalFactCount: 0,
      },
    },
  ],
  relations: [
    {
      id: "10",
      relationId: 10,
      source: "1",
      target: "2",
      targetLiteral: null,
      predicate: "founded_by",
      predicateLabel: "founded by",
      provenanceSlug: "acme-labs",
      sourceKind: "curated",
      confidence: 1,
      pinned: true,
      inferredFrom: null,
    },
    {
      id: "11",
      relationId: 11,
      source: "1",
      target: null,
      targetLiteral: "Nowhere",
      predicate: "headquartered_in",
      predicateLabel: "headquartered in",
      provenanceSlug: "acme-labs",
      sourceKind: "infobox",
      confidence: 0.8,
      pinned: false,
      inferredFrom: null,
    },
  ],
  predicates: [],
  entityTypes: [],
  coverage: {
    articleCount: 2,
    entityCount: 2,
    articleEntityCount: 2,
    articlesWithoutEntityCount: 0,
    relationCount: 2,
    entityEdgeCount: 1,
    literalFactCount: 1,
    isolatedEntityCount: 0,
    lowConfidenceRelationCount: 0,
    inferredRelationCount: 0,
    staleArticleCount: 0,
  },
  analysis: {
    stages: [],
    metrics: [],
    density: 1,
    componentCount: 1,
    communityCount: 1,
  },
};

describe("ontology graph projection", () => {
  test("filters entity edges separately from literal facts", () => {
    const projection = projectSemanticGraph(payload, {
      lens: "relations",
      query: "",
      predicate: "all",
      entityType: "all",
      sourceKind: "all",
      metric: "pagerank",
      limit: 10,
      showLiteralFacts: true,
    });

    expect(projection.nodes.map((node) => node.id)).toEqual(["1", "2"]);
    expect(projection.relations.map((relation) => relation.id)).toEqual(["10"]);
    expect(projection.literalRelations.map((relation) => relation.id)).toEqual(["11"]);
  });

  test("honors predicate and query filters", () => {
    const projection = projectSemanticGraph(payload, {
      lens: "relations",
      query: "ada",
      predicate: "founded_by",
      entityType: "person",
      sourceKind: "curated",
      metric: "pagerank",
      limit: 10,
      showLiteralFacts: false,
    });

    expect(projection.nodes.map((node) => node.label)).toEqual(["Ada Person"]);
    expect(projection.relations).toEqual([]);
    expect(projection.literalRelations).toEqual([]);
  });

  test("keeps filtered relation endpoints ahead of unrelated literal-fact nodes", () => {
    const literalHeavyNode = {
      ...payload.nodes[0],
      id: "3",
      entityId: 3,
      label: "Literal Heavy",
      articleSlug: "literal-heavy",
      metrics: {
        ...payload.nodes[0].metrics,
        pagerank: 1,
        literalFactCount: 20,
      },
    };
    const projection = projectSemanticGraph(
      {
        ...payload,
        nodes: payload.nodes.concat(literalHeavyNode),
        relations: payload.relations.concat({
          ...payload.relations[1],
          id: "12",
          relationId: 12,
          source: "3",
        }),
      },
      {
        lens: "relations",
        query: "",
        predicate: "founded_by",
        entityType: "all",
        sourceKind: "curated",
        metric: "pagerank",
        limit: 2,
        showLiteralFacts: true,
      },
    );

    expect(projection.nodes.map((node) => node.id).sort()).toEqual(["1", "2"]);
    expect(projection.relations.map((relation) => relation.id)).toEqual(["10"]);
    expect(projection.literalRelations).toEqual([]);
  });

  test("layout is deterministic and radius follows the chosen metric", () => {
    const positioned = layoutSemanticNodes(payload.nodes, "pagerank", 0.8);

    expect(positioned).toHaveLength(2);
    expect(positioned[0].x).toBe(positioned[0].x);
    expect(positioned.find((node) => node.id === "1")!.radius).toBeGreaterThan(
      positioned.find((node) => node.id === "2")!.radius,
    );
  });

  test("tree layout produces deterministic levels for a directed forest", () => {
    const positioned = layoutSemanticTreeNodes(
      payload.nodes,
      payload.relations.filter((relation) => relation.target !== null),
      "pagerank",
      0.8,
    );
    const root = positioned.find((node) => node.id === "1")!;
    const child = positioned.find((node) => node.id === "2")!;

    expect(root.depth).toBe(0);
    expect(child.depth).toBe(1);
    expect(child.y).toBeGreaterThan(root.y);
    expect(layoutSemanticTreeNodes(
      payload.nodes,
      payload.relations.filter((relation) => relation.target !== null),
      "pagerank",
      0.8,
    )).toEqual(positioned);
  });
});
