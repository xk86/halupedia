import { cleanup, render, screen } from "@testing-library/react";
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
    cleanup();
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

  it("re-renders the graph as the entity filter is typed and backspaced", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const user = userEvent.setup();
    render(
      <SemanticAtlas
        onNavigate={() => undefined}
        view="tree"
        onViewChange={() => undefined}
      />,
    );

    const svg = await screen.findByRole("img", { name: "Ontology tree graph" });
    const svgLabels = () =>
      Array.from(svg.querySelectorAll("text")).map((n) => n.textContent);
    // Both entities visible by default.
    expect(svgLabels()).toEqual(
      expect.arrayContaining(["Root entity", "Child entity"]),
    );

    const filter = screen
      .getAllByPlaceholderText("Filter entities…")
      .find((el) => (el as HTMLInputElement).type !== "hidden") as HTMLInputElement;
    await user.type(filter, "root");
    // Only the matching entity survives on the canvas.
    expect(svgLabels()).toEqual(expect.arrayContaining(["Root entity"]));
    expect(svgLabels()).not.toEqual(
      expect.arrayContaining(["Child entity"]),
    );

    // Backspace should restore the full graph — regression: previously the
    // Input's onChange was not being called, so state stayed at "root".
    await user.clear(filter);
    expect(svgLabels()).toEqual(
      expect.arrayContaining(["Root entity", "Child entity"]),
    );
  });

  it("draws tree edges as cubic Bézier splines, not straight lines", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { container } = render(
      <SemanticAtlas
        onNavigate={() => undefined}
        view="tree"
        onViewChange={() => undefined}
      />,
    );

    await screen.findByRole("img", { name: "Ontology tree graph" });
    const svg = container.querySelector(
      'svg[aria-label="Ontology tree graph"]',
    ) as SVGSVGElement;
    // At least one edge <path> should carry a cubic-Bézier command.
    const paths = Array.from(svg.querySelectorAll("path"));
    const cubic = paths.find((p) => /^M .* C /.test(p.getAttribute("d") ?? ""));
    expect(cubic).toBeTruthy();
    // Straight <line> stroke elements between nodes should be gone.
    expect(svg.querySelectorAll("line").length).toBe(0);
  });

  it("clamps tree label font size so an extreme labelSize doesn't overlap text", async () => {
    // Simulate a user having cranked the shared Label size slider toward its
    // max (used by the 3D world-space label, which has no natural pixel
    // ceiling) — the 2D SVG render must clamp rather than blow up.
    localStorage.setItem(
      "halupedia:graph-render:v1",
      JSON.stringify({ labelSize: 15, linkLabelSize: 4 }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { container } = render(
      <SemanticAtlas
        onNavigate={() => undefined}
        view="tree"
        onViewChange={() => undefined}
      />,
    );
    await screen.findByRole("img", { name: "Ontology tree graph" });
    const svg = container.querySelector(
      'svg[aria-label="Ontology tree graph"]',
    ) as SVGSVGElement;
    const nodeLabel = Array.from(svg.querySelectorAll("text")).find((t) =>
      t.textContent?.includes("Root entity"),
    )!;
    expect(Number(nodeLabel.getAttribute("font-size"))).toBeLessThanOrEqual(22);
    localStorage.removeItem("halupedia:graph-render:v1");
  });
});
