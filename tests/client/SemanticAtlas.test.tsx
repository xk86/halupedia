import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SemanticAtlas } from "../../src/client/ontologyGraph/SemanticAtlas";
import type { OntologyGraphPayload } from "../../src/client/ontologyGraph/types";

const metrics = {
  pagerank: 0.5,
  betweenness: 0,
  closeness: 0,
  eigenvector: 0,
  degree: 1,
  inDegree: 0,
  outDegree: 1,
  hitsAuthority: 0,
  hitsHub: 0,
  eccentricity: 1,
  factCount: 1,
  literalFactCount: 0,
};

const payload: OntologyGraphPayload = {
  version: 1,
  ontologySignature: "test",
  graphRevision: 1,
  nodes: [
    {
      id: "root",
      entityId: 1,
      label: "Root entity",
      entityType: "organization",
      articleSlug: "root-entity",
      description: "",
      community: 0,
      componentId: 0,
      metrics,
    },
    {
      id: "child",
      entityId: 2,
      label: "Child entity",
      entityType: "person",
      articleSlug: "child-entity",
      description: "",
      community: 0,
      componentId: 0,
      metrics: { ...metrics, inDegree: 1, outDegree: 0 },
    },
  ],
  relations: [
    {
      id: "relation",
      relationId: 1,
      source: "root",
      target: "child",
      targetLiteral: null,
      predicate: "contains",
      predicateLabel: "contains",
      provenanceSlug: "root-entity",
      sourceKind: "curated",
      confidence: 1,
      pinned: true,
      inferredFrom: null,
    },
  ],
  predicates: [
    {
      name: "contains",
      label: "contains",
      subject: "organization",
      object: "person",
      relationCount: 1,
      entityEdgeCount: 1,
      literalCount: 0,
      sources: { curated: 1 },
    },
  ],
  entityTypes: [
    {
      type: "organization",
      entityCount: 1,
      incomingCount: 0,
      outgoingCount: 1,
      literalFactCount: 0,
    },
    {
      type: "person",
      entityCount: 1,
      incomingCount: 1,
      outgoingCount: 0,
      literalFactCount: 0,
    },
  ],
  coverage: {
    articleCount: 2,
    entityCount: 2,
    articleEntityCount: 2,
    articlesWithoutEntityCount: 0,
    relationCount: 1,
    entityEdgeCount: 1,
    literalFactCount: 0,
    isolatedEntityCount: 0,
    lowConfidenceRelationCount: 0,
    inferredRelationCount: 0,
    staleArticleCount: 0,
  },
  analysis: {
    stages: [],
    metrics: [],
    density: 0.5,
    componentCount: 1,
    communityCount: 1,
  },
};

describe("SemanticAtlas", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("switches graph views and keeps the fact inspector connected to tree nodes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(
      <SemanticAtlas
        onNavigate={() => undefined}
        view="tree"
        onViewChange={onViewChange}
      />,
    );

    expect(
      await screen.findByRole("img", { name: "Ontology tree graph" }),
    ).toBeInTheDocument();
    await user.click(screen.getByText("Root entity"));
    expect(screen.getByText("Nearby facts")).toBeInTheDocument();
    expect(screen.getAllByText("contains").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Render" }));
    expect(screen.getByText("Branch spread")).toBeInTheDocument();
    expect(screen.queryByText("Repulsion")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /3D force/i }));
    expect(onViewChange).toHaveBeenCalledWith("3d");
  });
});
