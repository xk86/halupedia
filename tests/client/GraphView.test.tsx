import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

import Graph from "graphology";

import { computePathNodes, computePaths, dim, kShortestPaths, makeNodeLabelSprite, oklch, summarizeCommunities } from "../../src/client/GraphView";

interface FgNodeLike {
  id: string;
  title: string;
  exists: boolean;
  score: number;
  scoreNorm: number;
  community: number;
  componentId: number;
  inDegree: number;
  outDegree: number;
  visibleInDegree: number;
  visibleOutDegree: number;
}

function makeNode(overrides: Partial<FgNodeLike> & { id: string; title: string }): FgNodeLike {
  return {
    exists: true,
    score: 0,
    scoreNorm: 0,
    community: 0,
    componentId: 0,
    inDegree: 0,
    outDegree: 0,
    visibleInDegree: 0,
    visibleOutDegree: 0,
    ...overrides,
  };
}

// jsdom does not implement 2D canvas rendering, so stub just enough of the
// CanvasRenderingContext2D surface that makeNodeLabelSprite touches.
function stubCanvasContext() {
  const ctx = {
    font: "",
    textBaseline: "",
    textAlign: "",
    fillStyle: "",
    measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
    fillText: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return ctx;
}

describe("makeNodeLabelSprite", () => {
  beforeEach(() => {
    stubCanvasContext();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a sprite textured with the node title", () => {
    const sprite = makeNodeLabelSprite("Halupedia Article", "#ff0000");
    expect(sprite).toBeInstanceOf(THREE.Sprite);
    expect(sprite.material).toBeInstanceOf(THREE.SpriteMaterial);
    expect(sprite.material.map).toBeInstanceOf(THREE.CanvasTexture);
    // Sized so it reads at a consistent on-screen size, not zero/negative
    expect(sprite.scale.x).toBeGreaterThan(0);
    expect(sprite.scale.y).toBeGreaterThan(0);
  });

  it("draws the title text and tints the sprite via material color", () => {
    const ctx = stubCanvasContext();
    const sprite = makeNodeLabelSprite("Some Title", "#abcdef");
    expect(ctx.fillText).toHaveBeenCalledWith("Some Title", expect.any(Number), expect.any(Number));
    // Text is drawn white and the color is applied as a material tint so it can
    // be recolored live (e.g. by the path trace).
    expect(sprite.material.color.getHexString()).toBe("abcdef");
  });

  it("produces a wider sprite for longer text", () => {
    const short = makeNodeLabelSprite("A", "#ffffff");
    const long = makeNodeLabelSprite("A Much Longer Article Title Here", "#ffffff");
    expect(long.scale.x).toBeGreaterThan(short.scale.x);
  });

  it("scales the sprite proportionally to the requested world height", () => {
    const normal = makeNodeLabelSprite("Halupedia Article", "#ffffff", 6);
    const big = makeNodeLabelSprite("Halupedia Article", "#ffffff", 12);
    expect(big.scale.y).toBeCloseTo(normal.scale.y * 2);
    expect(big.scale.x).toBeCloseTo(normal.scale.x * 2);
    expect(normal.scale.y).toBeCloseTo(6);
  });
});

describe("oklch", () => {
  it("produces valid sRGB hex for in-gamut colors", () => {
    expect(oklch(0.72, 0.17, 200)).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("gives distinct colors as hue rotates", () => {
    const a = oklch(0.72, 0.17, 30);
    const b = oklch(0.72, 0.17, 210);
    expect(a).not.toBe(b);
  });

  it("near-zero chroma is roughly grey (r≈g≈b)", () => {
    const m = /^#(..)(..)(..)$/.exec(oklch(0.6, 0, 0))!;
    const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
    expect(Math.abs(r - g)).toBeLessThan(6);
    expect(Math.abs(g - b)).toBeLessThan(6);
  });
});

describe("dim", () => {
  it("darkens a color (lower luminance) while staying valid hex", () => {
    const d = dim("#ffffff", 1);
    expect(d).toMatch(/^#[0-9a-f]{6}$/i);
    const lum = parseInt(d.slice(1, 3), 16);
    expect(lum).toBeLessThan(160); // clearly darker than white
  });

  it("leaves a color unchanged at amount 0", () => {
    expect(dim("#e63946", 0)).toBe("#e63946");
  });

  it("partially dims by default and stays a valid hex", () => {
    const d = dim("#ffffff");
    expect(d).toMatch(/^#[0-9a-f]{6}$/i);
    expect(d).not.toBe("#ffffff");
  });

  it("returns input unchanged for non-hex strings", () => {
    expect(dim("rebeccapurple")).toBe("rebeccapurple");
  });
});

describe("computePathNodes", () => {
  // a → b → c → d, plus a stray reverse-only link e → d
  function chain() {
    const g = new Graph({ type: "directed" });
    for (const n of ["a", "b", "c", "d", "e"]) g.addNode(n);
    g.addEdge("a", "b");
    g.addEdge("b", "c");
    g.addEdge("c", "d");
    g.addEdge("e", "d"); // only reachable from e going backwards
    return g;
  }

  it("stitches consecutive waypoints into one ordered walk", () => {
    const { nodes } = computePathNodes(chain(), [{ slug: "a" }, { slug: "d" }], "directed");
    expect(nodes).toEqual(["a", "b", "c", "d"]);
  });

  it("dedupes the shared node when chaining multiple waypoints", () => {
    const { nodes } = computePathNodes(chain(), [{ slug: "a" }, { slug: "c" }, { slug: "d" }], "directed");
    expect(nodes).toEqual(["a", "b", "c", "d"]);
  });

  it("directed finds a route even when waypoints are listed against the arrows", () => {
    // arrows go a→b→c→d; asking for c then a still follows the edges, reversed
    const { nodes } = computePathNodes(chain(), [{ slug: "c" }, { slug: "a" }], "directed");
    expect(nodes).toEqual(["c", "b", "a"]);
  });

  it("directed respects arrows where neither order connects; undirected bridges it", () => {
    // f → x ← h : convergent edges, no directed path either way
    const g = new Graph({ type: "directed" });
    for (const n of ["f", "x", "h"]) g.addNode(n);
    g.addEdge("f", "x");
    g.addEdge("h", "x");
    expect(computePathNodes(g, [{ slug: "f" }, { slug: "h" }], "directed").nodes).toEqual([]);
    expect(computePathNodes(g, [{ slug: "f" }, { slug: "h" }], "undirected").nodes).toEqual(["f", "x", "h"]);
  });

  it("records edge keys in both orientations for robust link coloring", () => {
    const { edgeSet } = computePathNodes(chain(), [{ slug: "a" }, { slug: "b" }], "directed");
    expect(edgeSet.has("a>b")).toBe(true);
    expect(edgeSet.has("b>a")).toBe(true);
  });

  it("returns empty for fewer than two reachable waypoints", () => {
    expect(computePathNodes(chain(), [{ slug: "a" }], "either").nodes).toEqual([]);
  });
});

describe("kShortestPaths / computePaths", () => {
  // a→b→d and a→c→d (two equal routes), plus a longer a→b→c→d-ish detour
  function diamond() {
    const g = new Graph({ type: "directed" });
    for (const n of ["a", "b", "c", "d"]) g.addNode(n);
    g.addEdge("a", "b");
    g.addEdge("a", "c");
    g.addEdge("b", "d");
    g.addEdge("c", "d");
    g.addEdge("b", "c"); // gives a longer a→b→c→d route too
    return g;
  }

  it("returns multiple routes in non-decreasing length order", () => {
    const routes = kShortestPaths(diamond(), "a", "d", 3, "directed");
    expect(routes.length).toBe(3);
    expect(routes[0]).toHaveLength(3); // a,b,d
    expect(routes[1]).toHaveLength(3); // a,c,d
    expect(routes[2]).toHaveLength(4); // a,b,c,d — longest last
  });

  it("respects the k cap", () => {
    expect(kShortestPaths(diamond(), "a", "d", 1, "directed")).toHaveLength(1);
  });

  it("computePaths races up to maxPaths routes between two waypoints", () => {
    const routes = computePaths(diamond(), [{ slug: "a" }, { slug: "d" }], "directed", 2);
    expect(routes).toHaveLength(2);
    expect(routes[0].edgeSet.has("a>b")).toBe(true);
    expect(routes[0].edgeSet.has("b>a")).toBe(true); // both orientations
  });

  it("computePaths falls back to a single stitched route for 3+ waypoints", () => {
    const routes = computePaths(diamond(), [{ slug: "a" }, { slug: "b" }, { slug: "d" }], "directed", 5);
    expect(routes).toHaveLength(1);
    expect(routes[0].nodes).toEqual(["a", "b", "d"]);
  });
});

describe("summarizeCommunities", () => {
  it("groups nodes by community, largest group first, members alphabetical", () => {
    const nodes = [
      makeNode({ id: "z-article", title: "Zeta Article", community: 1 }),
      makeNode({ id: "a-article", title: "Alpha Article", community: 1 }),
      makeNode({ id: "b-article", title: "Beta Article", community: 0 }),
      makeNode({ id: "m-article", title: "Mu Article", community: 1 }),
    ];

    const groups = summarizeCommunities(nodes as any, "community");

    expect(groups).toHaveLength(2);
    // community 1 has 3 members, community 0 has 1 — largest first
    expect(groups[0].id).toBe(1);
    expect(groups[0].members.map((m) => m.title)).toEqual(["Alpha Article", "Mu Article", "Zeta Article"]);
    expect(groups[1].id).toBe(0);
    expect(groups[1].members.map((m) => m.title)).toEqual(["Beta Article"]);
  });

  it("groups by componentId when colorMode is 'component'", () => {
    const nodes = [
      makeNode({ id: "n1", title: "N1", community: 0, componentId: 5 }),
      makeNode({ id: "n2", title: "N2", community: 1, componentId: 5 }),
      makeNode({ id: "n3", title: "N3", community: 2, componentId: 9 }),
    ];

    const groups = summarizeCommunities(nodes as any, "component");

    expect(groups).toHaveLength(2);
    expect(groups[0].id).toBe(5);
    expect(groups[0].members).toHaveLength(2);
    expect(groups[1].id).toBe(9);
    expect(groups[1].members).toHaveLength(1);
  });

  it("assigns each group a color matching the renderer's communityColor palette", () => {
    const nodes = [makeNode({ id: "n1", title: "N1", community: 3 })];
    const groups = summarizeCommunities(nodes as any, "community");
    expect(groups[0].color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("returns an empty list for no nodes", () => {
    expect(summarizeCommunities([], "community")).toEqual([]);
  });
});
