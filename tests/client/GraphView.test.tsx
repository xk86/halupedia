import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Graph from "graphology";

import * as THREE from "three";
import { DragControls } from "three/examples/jsm/controls/DragControls.js";
import { blendHex, computeNodeDisplayColor, computePathNodes, computePaths, desaturate, dim, kShortestPaths, labelDrawState, oklch, summarizeCommunities, traceHue, trailNodeLightness } from "../../src/client/GraphView";

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
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return ctx;
}

describe("labelDrawState", () => {
  it("keeps unshaded labels fully opaque and visible", () => {
    expect(labelDrawState(false, 0)).toEqual({ opacity: 1, visible: true });
    expect(labelDrawState(false, 0.5)).toEqual({ opacity: 1, visible: true });
  });

  it("applies the shaded opacity to faded labels", () => {
    expect(labelDrawState(true, 0.3)).toEqual({ opacity: 0.3, visible: true });
  });

  it("hides shaded labels when faded to (near) zero so the renderer skips them", () => {
    expect(labelDrawState(true, 0)).toEqual({ opacity: 0, visible: false });
    expect(labelDrawState(true, 0.005)).toEqual({ opacity: 0.005, visible: false });
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

describe("blendHex", () => {
  it("returns the source color unchanged when keeping all of it", () => {
    expect(blendHex("#e63946", "#080810", 1)).toBe("#e63946");
  });

  it("returns the target color when keeping none of the source", () => {
    expect(blendHex("#e63946", "#080810", 0)).toBe("#080810");
  });

  it("mixes halfway toward the background (a faded shaded node)", () => {
    // #ffffff toward #000000 at 0.5 → mid grey on every channel.
    expect(blendHex("#ffffff", "#000000", 0.5)).toBe("#808080");
  });

  it("clamps keep outside 0..1 and passes through bad hex", () => {
    expect(blendHex("#ffffff", "#000000", 2)).toBe("#ffffff");
    expect(blendHex("not-a-color", "#000000", 0.5)).toBe("not-a-color");
  });
});

describe("desaturate", () => {
  it("drops chroma toward grey so a shaded node loses its color", () => {
    const grey = desaturate("#e63946", 1);
    const r = parseInt(grey.slice(1, 3), 16);
    const g = parseInt(grey.slice(3, 5), 16);
    const b = parseInt(grey.slice(5, 7), 16);
    // Fully desaturated: channels collapse to near-equal (grey).
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(12);
  });

  it("leaves a color unchanged at amount 0", () => {
    expect(desaturate("#e63946", 0)).toBe("#e63946");
  });

  it("passes non-hex strings through", () => {
    expect(desaturate("rebeccapurple", 1)).toBe("rebeccapurple");
  });
});

describe("traceHue", () => {
  const start = 200, end = 40, len = 5;

  it("pins both endpoints to the start/end hue regardless of rank or spread", () => {
    for (const rank of [0, 1, 2, 3]) {
      for (const spread of [0, 30, 90]) {
        expect(traceHue(rank, len, 0, start, end, spread)).toBeCloseTo(start);
        expect(traceHue(rank, len, len - 1, start, end, spread)).toBeCloseTo(end);
      }
    }
  });

  it("leaves the primary (rank 0) route on the plain start→end gradient", () => {
    // Midpoint of a 5-node route is the average of the endpoints.
    expect(traceHue(0, len, 2, start, end, 90)).toBeCloseTo((start + end) / 2);
  });

  it("ignores spread of 0 (single unified gradient)", () => {
    expect(traceHue(3, len, 2, start, end, 0)).toBeCloseTo((start + end) / 2);
  });

  it("offsets interior nodes by the spread, tapered by sin(pi*u)", () => {
    // u = 0.5 at the midpoint of a 5-node route → sin(pi/2) = 1, full offset.
    const base = (start + end) / 2;
    expect(traceHue(1, len, 2, start, end, 30)).toBeCloseTo(base + 30); // rank 1 → +1 step
    expect(traceHue(2, len, 2, start, end, 30)).toBeCloseTo(base - 30); // rank 2 → -1 step
    expect(traceHue(3, len, 2, start, end, 30)).toBeCloseTo(base + 60); // rank 3 → +2 steps
  });

  it("tapers the offset toward the endpoints (smaller near the ends)", () => {
    const mid = Math.abs(traceHue(1, len, 2, start, end, 30) - (start + (end - start) * 0.5));
    const near = Math.abs(traceHue(1, len, 1, start, end, 30) - (start + (end - start) * 0.25));
    expect(near).toBeLessThan(mid);
    expect(near).toBeGreaterThan(0);
  });

  it("returns the start hue for a degenerate single-node route", () => {
    expect(traceHue(2, 1, 0, start, end, 50)).toBe(start);
  });
});

describe("trailNodeLightness", () => {
  const dimL = 0.4, fullL = 0.72, pulseL = 0.12, finaleL = 0.18;

  it("keeps an untouched node at the dim base", () => {
    expect(trailNodeLightness(0, 3, dimL, fullL, 0, pulseL, false, finaleL)).toBeCloseTo(dimL);
  });

  it("reaches full brightness where every route passes through (e.g. start/end)", () => {
    expect(trailNodeLightness(3, 3, dimL, fullL, 0, pulseL, false, finaleL)).toBeCloseTo(fullL);
  });

  it("lights a node in proportion to how many routes pass through it", () => {
    const oneOfThree = trailNodeLightness(1, 3, dimL, fullL, 0, pulseL, false, finaleL);
    const twoOfThree = trailNodeLightness(2, 3, dimL, fullL, 0, pulseL, false, finaleL);
    expect(oneOfThree).toBeCloseTo(dimL + (fullL - dimL) / 3);
    // Even spacing: each additional pass adds the same brightness step.
    expect(twoOfThree - oneOfThree).toBeCloseTo(oneOfThree - dimL);
  });

  it("adds the subtle per-pass flash on top of the accumulated brightness", () => {
    const calm = trailNodeLightness(1, 3, dimL, fullL, 0, pulseL, false, finaleL);
    const flashing = trailNodeLightness(1, 3, dimL, fullL, 1, pulseL, false, finaleL);
    expect(flashing).toBeCloseTo(calm + pulseL);
  });

  it("adds the big finale flare when active", () => {
    const calm = trailNodeLightness(3, 3, dimL, fullL, 0, pulseL, false, finaleL);
    const flared = trailNodeLightness(3, 3, dimL, fullL, 0, pulseL, true, finaleL);
    expect(flared).toBeGreaterThan(calm);
  });

  it("clamps the combined lightness to stay in gamut (<= 0.99)", () => {
    expect(trailNodeLightness(3, 3, dimL, 0.95, 1, 0.4, true, 0.4)).toBeLessThanOrEqual(0.99);
  });

  it("treats a zero-route node as the dim base (no divide-by-zero)", () => {
    expect(trailNodeLightness(0, 0, dimL, fullL, 0, pulseL, false, finaleL)).toBeCloseTo(dimL);
  });
});

describe("computeNodeDisplayColor", () => {
  const baseNode = makeNode({ id: "n1", title: "Test Node", community: 0, exists: true });

  it("returns trace color when in pathMode and node is being traced", () => {
    const traceColor = new Map<string, string>([["n1", "#ff0000"]]);
    const result = computeNodeDisplayColor(
      "n1",
      baseNode,
      true, // pathMode
      traceColor,
      new Set(), // highlightSet
      false, // shadingEnabled
      "community", // colorMode
      "#000000", // bgColor
      0.5, // shadedOpacity
    );
    expect(result).toBe("#ff0000");
  });

  it("returns grey for unvisited path nodes (in highlightSet but no trace color)", () => {
    const result = computeNodeDisplayColor(
      "n1",
      baseNode,
      true, // pathMode
      new Map(), // no trace color
      new Set(["n1"]), // in highlightSet but not traced
      false,
      "community",
      "#000000",
      0.5,
    );
    expect(result).toBe("#888888");
  });

  it("returns base community color when not shaded", () => {
    const result = computeNodeDisplayColor(
      "n1",
      baseNode,
      false, // pathMode
      new Map(),
      new Set(), // empty highlightSet
      false, // shadingEnabled
      "community",
      "#000000",
      0.5,
    );
    // Should be the community color for community 0
    expect(result).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("desaturates and blends shaded nodes toward background", () => {
    const highlightSet = new Set(["other-node"]); // n1 not in the highlight set
    const result = computeNodeDisplayColor(
      "n1",
      baseNode,
      false,
      new Map(),
      highlightSet,
      true, // shadingEnabled
      "community",
      "#000000", // dark background
      0.5, // fade to 50% opacity
    );
    // Should be darker and more greyish than the original community color
    expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    expect(result).not.toBe("#e63946"); // not the base red color
  });

  it("returns white fallback for null node", () => {
    const result = computeNodeDisplayColor(
      "nonexistent",
      null,
      false,
      new Map(),
      new Set(),
      false,
      "community",
      "#000000",
      0.5,
    );
    expect(result).toBe("#ffffff");
  });

  it("returns grey color for non-existent nodes (exists: false)", () => {
    const deadNode = makeNode({ id: "dead", title: "Dead Link", exists: false });
    const result = computeNodeDisplayColor(
      "dead",
      deadNode,
      false,
      new Map(),
      new Set(),
      false,
      "community",
      "#000000",
      0.5,
    );
    expect(result).toBe("#555566");
  });

  it("respects colorMode to use componentId instead of community", () => {
    const node = makeNode({ id: "n1", title: "Node", community: 1, componentId: 5, exists: true });
    const result = computeNodeDisplayColor(
      "n1",
      node,
      false,
      new Map(),
      new Set(),
      false,
      "component", // use componentId instead
      "#000000",
      0.5,
    );
    // Result should be based on componentId 5, not community 1
    expect(result).toMatch(/^#[0-9a-f]{6}$/i);
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

  it("counts visible cross-group links in/out, ignoring intra-group edges", () => {
    const nodes = [
      makeNode({ id: "a", title: "A", community: 1 }),
      makeNode({ id: "b", title: "B", community: 1 }),
      makeNode({ id: "c", title: "C", community: 2 }),
    ];
    const links = [
      { source: "a", target: "c" }, // 1 → 2
      { source: "c", target: "b" }, // 2 → 1
      { source: "a", target: "b" }, // intra-1, ignored
      // Renderer-mutated endpoints (node objects) must also resolve.
      { source: { id: "c" }, target: { id: "a" } }, // 2 → 1
    ];

    const groups = summarizeCommunities(nodes as any, "community", links);

    const g1 = groups.find((g) => g.id === 1)!;
    const g2 = groups.find((g) => g.id === 2)!;
    expect(g1.linksOut).toBe(1);
    expect(g1.linksIn).toBe(2);
    expect(g2.linksOut).toBe(2);
    expect(g2.linksIn).toBe(1);
  });
});

describe("DragControls button dispatch (node grab is left-button only)", () => {
  // Importing GraphView patches the shared DragControls prototype so its
  // pointerdown handler only engages on plain left-button (or touch) presses;
  // right/middle buttons and shift-held interactions never enter DragControls
  // and fall through to the camera controls (orbit pan). Crucially, a gated
  // press must not record a selection: an "inert" right-press over a node
  // used to emit a dragstart-less dragend on release, which crashed the
  // dragend handler and wedged every later grab.
  function makeDragRig() {
    const dom = document.createElement("div");
    dom.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    const scene = new THREE.Scene();
    scene.add(mesh);
    scene.updateMatrixWorld(true);
    const dc = new DragControls([mesh], camera, dom);
    const events: string[] = [];
    dc.addEventListener("dragstart", () => events.push("dragstart"));
    dc.addEventListener("drag", () => events.push("drag"));
    dc.addEventListener("dragend", () => events.push("dragend"));
    // jsdom has no PointerEvent; DragControls only reads type/coords/button/
    // shiftKey/pointerType, so a MouseEvent with pointerType defined works.
    const fire = (
      type: "pointerdown" | "pointermove" | "pointerup",
      init: { button?: number; shiftKey?: boolean; pointerType?: string; x?: number; y?: number } = {},
    ) => {
      const e = new MouseEvent(type, {
        clientX: init.x ?? 100,
        clientY: init.y ?? 100,
        button: init.button ?? 0,
        shiftKey: init.shiftKey ?? false,
        bubbles: true,
      });
      Object.defineProperty(e, "pointerType", { value: init.pointerType ?? "mouse" });
      dom.dispatchEvent(e);
    };
    return { dc, fire, events };
  }

  it("left-button grab over a node starts, drags, and releases cleanly", () => {
    const { dc, fire, events } = makeDragRig();
    fire("pointerdown", { button: 0 });
    expect(events).toEqual(["dragstart"]);
    fire("pointermove", { x: 120, y: 110 });
    expect(events).toEqual(["dragstart", "drag"]);
    fire("pointerup");
    expect(events).toEqual(["dragstart", "drag", "dragend"]);
    dc.dispose();
  });

  it("right-button press+release over a node emits no drag events and later grabs still release", () => {
    const { dc, fire, events } = makeDragRig();
    fire("pointerdown", { button: 2 });
    fire("pointermove", { x: 130, y: 90 });
    fire("pointerup", { button: 2 });
    expect(events).toEqual([]); // no spurious dragend from the gated press

    // A normal grab afterwards must still work end-to-end.
    fire("pointerdown", { button: 0 });
    fire("pointerup");
    expect(events).toEqual(["dragstart", "dragend"]);
    dc.dispose();
  });

  it("middle-button and shift-left presses never grab", () => {
    const { dc, fire, events } = makeDragRig();
    fire("pointerdown", { button: 1 });
    fire("pointerup", { button: 1 });
    fire("pointerdown", { button: 0, shiftKey: true });
    fire("pointerup");
    expect(events).toEqual([]);
    dc.dispose();
  });

  it("keeps single-finger touch drags working", () => {
    const { dc, fire, events } = makeDragRig();
    fire("pointerdown", { pointerType: "touch" });
    fire("pointerup", { pointerType: "touch" });
    expect(events).toEqual(["dragstart", "dragend"]);
    dc.dispose();
  });
});
