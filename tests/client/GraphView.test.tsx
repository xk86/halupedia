import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

import { makeNodeLabelSprite, summarizeCommunities } from "../../src/client/GraphView";

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

  it("draws the given title text onto the backing canvas", () => {
    const ctx = stubCanvasContext();
    makeNodeLabelSprite("Some Title", "#abcdef");
    expect(ctx.fillText).toHaveBeenCalledWith("Some Title", expect.any(Number), expect.any(Number));
    expect(ctx.fillStyle).toBe("#abcdef");
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
