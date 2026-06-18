import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank";
import betweenness from "graphology-metrics/centrality/betweenness";
import closeness from "graphology-metrics/centrality/closeness";
import eigenvector from "graphology-metrics/centrality/eigenvector";
import {
  degreeCentrality,
  inDegreeCentrality,
  outDegreeCentrality,
} from "graphology-metrics/centrality/degree";
import hits from "graphology-metrics/centrality/hits";
import { eccentricity } from "graphology-metrics/node";
import { density } from "graphology-metrics/graph";
import {
  singleSourceLength,
  bidirectional as unweightedPath,
} from "graphology-shortest-path/unweighted";
import {
  connectedComponents,
  largestConnectedComponent,
} from "graphology-components";
import louvain from "graphology-communities-louvain";
import * as THREE from "three";
import { DragControls } from "three/examples/jsm/controls/DragControls.js";
import {
  makeNodeLabel,
  setLabelColor,
  setLabelOpacity,
  labelWorldHeight,
  faceCamera,
  disposeLabels,
  type NodeLabel,
} from "./graphLabels";
import { toWikiSegment } from "./wikiPath";
import { type Suggestion } from "./articleSuggest";
import { ArticleSearchDropdown } from "./ArticleSearchDropdown";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ── Node-drag button dispatch ────────────────────────────────────────────────
// 3d-force-graph builds a THREE DragControls over the node meshes but never
// exposes the instance, and DragControls engages on every pointer button —
// hijacking the orbit-controls right-button pan whenever the drag starts on a
// node. Node grabs are a left-button-only gesture here, so gate the
// pointerdown handler itself: any other button (or shift-held left, the
// "camera, not node" modifier) never enters DragControls and falls through to
// the camera controls untouched. The gate must sit at pointerdown — merely
// mapping the button to "no action" still records the hovered node as the
// active selection, and the next pointerup then emits a dragstart-less
// dragend that crashes the library's handler and wedges all later grabs.
//
// The constructor binds the handler per instance, so hook the construction
// path: the `mouseButtons` assignment (which precedes the handler binding)
// installs an accessor that wraps whatever handler gets assigned next. pnpm
// shares one `three` module between us and 3d-force-graph, so this prototype
// is the one its DragControls instances use.
{
  const proto = DragControls.prototype as unknown as Record<string, unknown>;
  type WithHandlers = {
    __mouseButtons?: unknown;
    _onPointerDown?: (event: PointerEvent) => void;
  };
  Object.defineProperty(proto, "mouseButtons", {
    configurable: true,
    get(this: WithHandlers) {
      return this.__mouseButtons;
    },
    set(this: WithHandlers, value: unknown) {
      this.__mouseButtons = value;
      if (!Object.getOwnPropertyDescriptor(this, "_onPointerDown")) {
        let gated: ((event: PointerEvent) => void) | undefined;
        Object.defineProperty(this, "_onPointerDown", {
          configurable: true,
          get: () => gated,
          set: (handler: (event: PointerEvent) => void) => {
            gated = (event: PointerEvent) => {
              if (
                event.pointerType !== "touch" &&
                (event.button !== 0 || event.shiftKey)
              )
                return;
              handler(event);
            };
          },
        });
      }
    },
  });
}

interface RawNode {
  slug: string;
  title: string;
  exists: boolean;
}
interface RawLink {
  source: string;
  target: string;
}
interface GraphData {
  nodes: RawNode[];
  links: RawLink[];
}

interface FgNode {
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

type ColorMode = "community" | "component";

type FilterMode = "top" | "search";
type NeighborhoodMode = "refs" | "backlinks" | "both";
type PathDir = "directed" | "undirected" | "either";
type DegreeMode = "in" | "out" | "both";
type Metric =
  | "pagerank"
  | "betweenness"
  | "closeness"
  | "eigenvector"
  | "degree"
  | "inDegree"
  | "outDegree"
  | "hitsAuthority"
  | "hitsHub"
  | "eccentricity"
  | "distanceFromSeed";

const METRICS: { value: Metric; label: string; needsSeeds?: true }[] = [
  { value: "pagerank", label: "PageRank" },
  { value: "betweenness", label: "Betweenness" },
  { value: "closeness", label: "Closeness" },
  { value: "eigenvector", label: "Eigenvector" },
  { value: "degree", label: "Degree" },
  { value: "inDegree", label: "In-degree" },
  { value: "outDegree", label: "Out-degree" },
  { value: "hitsAuthority", label: "HITS authority" },
  { value: "hitsHub", label: "HITS hub" },
  { value: "eccentricity", label: "Eccentricity" },
  { value: "distanceFromSeed", label: "Seed distance", needsSeeds: true },
];

interface Seed {
  slug: string;
  title: string;
}

function computeMetric(
  g: Graph,
  metric: Metric,
  seeds?: Seed[],
): Record<string, number> {
  const zero = () => {
    const z: Record<string, number> = {};
    for (const n of g.nodes()) z[n] = 0;
    return z;
  };
  try {
    switch (metric) {
      case "pagerank":
        return pagerank(g, { getEdgeWeight: null });
      case "betweenness":
        return betweenness(g);
      case "closeness":
        return closeness(g);
      case "eigenvector":
        return eigenvector(g);
      case "degree":
        return degreeCentrality(g);
      case "inDegree":
        return inDegreeCentrality(g);
      case "outDegree":
        return outDegreeCentrality(g);
      case "hitsAuthority":
        return hits(g).authorities;
      case "hitsHub":
        return hits(g).hubs;
      case "eccentricity": {
        const result: Record<string, number> = {};
        for (const n of g.nodes()) {
          try {
            result[n] = eccentricity(g, n);
          } catch {
            result[n] = 0;
          }
        }
        return result;
      }
      case "distanceFromSeed": {
        const validSeeds = (seeds ?? []).filter((s) => g.hasNode(s.slug));
        if (!validSeeds.length) return computeMetric(g, "pagerank");
        const distMaps = validSeeds.map((s) => singleSourceLength(g, s.slug));
        const result: Record<string, number> = {};
        for (const n of g.nodes()) {
          const minDist = Math.min(...distMaps.map((dm) => dm[n] ?? Infinity));
          // invert so closer = higher score; unreachable = 0
          result[n] = isFinite(minDist) ? 1 / (minDist + 1) : 0;
        }
        return result;
      }
    }
  } catch {
    return zero();
  }
}

// ── Waypoint pathfinding ───────────────────────────────────────────────────

/** BFS treating the directed graph as undirected (neighbors in either direction). */
function bfsUndirected(g: Graph, a: string, b: string): string[] | null {
  if (a === b) return [a];
  const prev = new Map<string, string>();
  const visited = new Set<string>([a]);
  const queue: string[] = [a];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of g.neighbors(cur)) {
      if (visited.has(nb)) continue;
      visited.add(nb);
      prev.set(nb, cur);
      if (nb === b) {
        const path = [b];
        let c = b;
        while (c !== a) {
          c = prev.get(c)!;
          path.push(c);
        }
        return path.reverse();
      }
      queue.push(nb);
    }
  }
  return null;
}

/**
 * Stitch the shortest paths between each *consecutive* pair of waypoints into
 * one ordered node walk, plus the set of edges it uses (both orientations, so
 * link coloring matches regardless of the underlying edge direction).
 *  - "directed": follow link direction only
 *  - "undirected": ignore direction
 *  - "either": try directed first, fall back to undirected
 */
export function computePathNodes(
  g: Graph,
  waypoints: { slug: string }[],
  dir: PathDir,
): { nodes: string[]; edgeSet: Set<string> } {
  const nodes: string[] = [];
  const edgeSet = new Set<string>();
  const push = (slug: string) => {
    if (nodes[nodes.length - 1] !== slug) nodes.push(slug);
  };

  // A directed route along the arrows. Try the natural waypoint order first,
  // then the reverse — so the route still follows real edge directions even if
  // the user listed the endpoints in the opposite order to the link flow.
  const directedSeg = (a: string, b: string): string[] | null => {
    const fwd = unweightedPath(g, a, b);
    if (fwd) return fwd;
    const rev = unweightedPath(g, b, a);
    return rev ? [...rev].reverse() : null;
  };

  for (let i = 0; i + 1 < waypoints.length; i++) {
    const a = waypoints[i].slug,
      b = waypoints[i + 1].slug;
    if (!g.hasNode(a) || !g.hasNode(b)) continue;
    let seg: string[] | null = null;
    try {
      if (dir === "directed") seg = directedSeg(a, b);
      else if (dir === "undirected") seg = bfsUndirected(g, a, b);
      else seg = directedSeg(a, b) ?? bfsUndirected(g, a, b);
    } catch {
      seg = null;
    }
    if (!seg) continue;
    for (const s of seg) push(s);
    for (let k = 0; k + 1 < seg.length; k++) {
      edgeSet.add(`${seg[k]}>${seg[k + 1]}`);
      edgeSet.add(`${seg[k + 1]}>${seg[k]}`);
    }
  }
  return { nodes, edgeSet };
}

/** Prettify a kebab-case slug into a readable title (halu nodes store the slug). */
export function slugToTitle(slug: string): string {
  const s = slug.replace(/-/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : slug;
}

export interface PathRoute {
  nodes: string[];
  edgeSet: Set<string>;
}

/** Edge keys (both orientations) for an ordered node walk. */
function edgeSetOf(nodes: string[]): Set<string> {
  const s = new Set<string>();
  for (let k = 0; k + 1 < nodes.length; k++) {
    s.add(`${nodes[k]}>${nodes[k + 1]}`);
    s.add(`${nodes[k + 1]}>${nodes[k]}`);
  }
  return s;
}

/**
 * Up to `k` shortest loopless paths from a→b in increasing length order. BFS
 * over partial paths: because edges are unweighted, popping FIFO yields paths
 * by non-decreasing length. Bounded by an expansion cap so a far/missing
 * target can't hang the UI.
 */
export function kShortestPaths(
  g: Graph,
  a: string,
  b: string,
  k: number,
  dir: PathDir,
): string[][] {
  if (!g.hasNode(a) || !g.hasNode(b) || k < 1) return [];
  const neighborsOf = (n: string) =>
    dir === "directed" ? g.outNeighbors(n) : g.neighbors(n);
  const results: string[][] = [];
  const queue: string[][] = [[a]];
  let expansions = 0;
  const CAP = 50000;
  while (queue.length && results.length < k && expansions < CAP) {
    const path = queue.shift()!;
    const last = path[path.length - 1];
    if (last === b) {
      results.push(path);
      continue;
    }
    expansions++;
    for (const nb of neighborsOf(last)) {
      if (path.includes(nb)) continue; // loopless
      queue.push([...path, nb]);
    }
  }
  return results;
}

/**
 * The routes to animate. For exactly two waypoints, race up to `maxPaths`
 * shortest routes (ranked by length, shortest first); directed falls back to
 * the reverse waypoint order. For more waypoints, a single stitched route
 * through the consecutive shortest paths.
 */
export function computePaths(
  g: Graph,
  waypoints: { slug: string }[],
  dir: PathDir,
  maxPaths: number,
): PathRoute[] {
  if (waypoints.length < 2) return [];
  if (waypoints.length === 2) {
    const a = waypoints[0].slug,
      b = waypoints[1].slug;
    let raw = kShortestPaths(g, a, b, maxPaths, dir);
    if (dir === "directed") {
      // Also include routes that follow the arrows the other way (waypoints
      // listed against the link flow), then keep the shortest overall.
      const rev = kShortestPaths(g, b, a, maxPaths, dir).map((p) =>
        [...p].reverse(),
      );
      const seen = new Set(raw.map((p) => p.join(">")));
      for (const p of rev) {
        const key = p.join(">");
        if (!seen.has(key)) {
          seen.add(key);
          raw.push(p);
        }
      }
      raw.sort((x, y) => x.length - y.length);
      raw = raw.slice(0, maxPaths);
    }
    return raw.map((nodes) => ({ nodes, edgeSet: edgeSetOf(nodes) }));
  }
  const stitched = computePathNodes(g, waypoints, dir);
  return stitched.nodes.length
    ? [{ nodes: stitched.nodes, edgeSet: stitched.edgeSet }]
    : [];
}

// ── Reusable article picker ────────────────────────────────────────────────
//
// Thin stateful wrapper around the shared <ArticleSearchDropdown> for each
// path-mode waypoint slot: holds the query and clears it after a pick.

function ArticlePicker({
  onPick,
  placeholder,
  autoFocus,
}: {
  onPick: (s: Suggestion) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  return (
    <ArticleSearchDropdown
      wrapClassName="w-[200px]"
      inputType="text"
      query={query}
      onQueryChange={setQuery}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onPick={(s) => {
        onPick(s);
        setQuery("");
      }}
    />
  );
}

// ── Render settings ──────────────────────────────────────────────────────────

interface RenderSettings {
  // Nodes
  nodeResolution: number; // sphere segments: 4–32
  nodeRelSize: number; // base sphere volume per val unit: 1–12
  nodeOpacity: number; // 0.1–1.0
  // Links
  linkOpacity: number; // 0.01–0.6
  linkWidth: number; // 0.1–4.0
  arrowLength: number; // 0–10
  linkCurvature: number; // 0–0.8
  particles: number; // 0–8
  particleSpeed: number; // 0.001–0.02
  particleWidth: number; // 0.5–6
  // Physics
  chargeStrength: number; // -20 to -1200 (repulsion)
  linkDistance: number; // 5–400
  alphaDecay: number; // 0.001–0.06
  velocityDecay: number; // 0.1–0.99
  // Appearance
  bgColor: string;
  alwaysShowLabels: boolean; // show node-name labels above all nodes, not just on hover
  shadedOpacity: number; // how visible shaded (non-highlighted) nodes, links, and labels are: 0–1; 0 fades them out (labels hidden entirely)
  labelSize: number; // size multiplier for always-on node-name labels: 0.5–5
  dynamicLabelSize: boolean; // scale each label by the node's link count
  labelSizeInfluence: number; // how strongly the count affects label size: 0–1
  labelDegreeMode: DegreeMode; // which links to count for sizing: in / out / both
  directionalParticles: boolean;
  // Path trace
  maxPaths: number; // how many shortest routes to race between 2 waypoints: 1–10
  particleGlow: boolean; // wrap the travelling particle in a soft glow halo
  traceSpeed: number; // base traversal speed, nodes/sec: 0.4–5
  traceAccel: number; // ease-in-out intensity (0 = constant speed): 0–1
  traceLoopDelay: number; // seconds to wait after all routes finish before looping: 0–5
  traceLightness: number; // OKLCH L for the trace colors: 0.4–0.95
  traceChroma: number; // OKLCH C (vividness) for the trace colors: 0.02–0.37
  traceStartHue: number; // hue (deg) at each route's start node: 0–360
  traceEndHue: number; // hue (deg) at each route's end node: 0–360
  traceHueSpread: number; // how far apart overlapping routes' hues fan out (deg), tapered to 0 at endpoints: 0–120
  pathLinkBrightness: number; // how bright the (untraced) path edges are: 0–1
}

const DEFAULT_SETTINGS: RenderSettings = {
  nodeResolution: 16,
  nodeRelSize: 4,
  nodeOpacity: 0.9,
  linkOpacity: 0.4,
  linkWidth: 1.0,
  arrowLength: 3.5,
  linkCurvature: 0,
  particles: 0,
  particleSpeed: 0.005,
  particleWidth: 2,
  chargeStrength: -180,
  linkDistance: 60,
  alphaDecay: 0.0228,
  velocityDecay: 0.4,
  bgColor: "#080810",
  alwaysShowLabels: false,
  shadedOpacity: 0.1,
  labelSize: 1.5,
  dynamicLabelSize: false,
  labelSizeInfluence: 0.5,
  labelDegreeMode: "both",
  directionalParticles: false,
  maxPaths: 3,
  particleGlow: true,
  traceSpeed: 1.4,
  traceAccel: 0.5,
  traceLoopDelay: 0.9,
  traceLightness: 0.72,
  traceChroma: 0.17,
  traceStartHue: 200,
  traceEndHue: 40,
  traceHueSpread: 28,
  pathLinkBrightness: 0.35,
};

const BG_PRESETS = [
  { label: "Void", value: "#080810" },
  { label: "Space", value: "#020408" },
  { label: "Slate", value: "#0d1117" },
  { label: "Paper", value: "#1a1a2e" },
];

// ── Community colours ────────────────────────────────────────────────────────

const COMMUNITY_COLORS = [
  "#e63946",
  "#457b9d",
  "#2a9d8f",
  "#e9c46a",
  "#f4a261",
  "#8338ec",
  "#06d6a0",
  "#ef476f",
  "#118ab2",
  "#ffd166",
  "#6a4c93",
  "#1982c4",
  "#8ac926",
  "#ff595e",
  "#ffca3a",
];

// Neutral color reserved for singleton communities (id -1). Louvain gives
// every isolated node its own community, which would cycle the palette and
// make ambiguous near-matches with real communities — instead all N=1
// communities share this grey. Distinct from the unwritten-article "#555566".
const SINGLETON_COMMUNITY_COLOR = "#9aa0a6";

function communityColor(id: number): string {
  if (id < 0) return SINGLETON_COMMUNITY_COLOR;
  return COMMUNITY_COLORS[id % COMMUNITY_COLORS.length];
}

// ── Color (OKLCH) ──────────────────────────────────────────────────────────
//
// OKLCH is a perceptually-uniform space: stepping hue by a fixed amount gives
// evenly-spaced, equally-vivid colors (unlike HSL, where some hues read much
// brighter/muddier than others). We use it for the path-trace rainbow so the
// per-node color bands are perceptually even, and for the shading dim so faded
// nodes desaturate cleanly instead of turning muddy brown.

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** OKLCH (L 0–1, C chroma, H degrees) → "#rrggbb" (clamped to sRGB gamut). */
export function oklch(L: number, C: number, H: number): string {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h),
    b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3,
    m = m_ ** 3,
    s = s_ ** 3;
  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const to2 = (v: number) => {
    const n = Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255);
    return n.toString(16).padStart(2, "0");
  };
  return `#${to2(lr)}${to2(lg)}${to2(lb)}`;
}

/** "#rrggbb" → OKLCH { L, C, H }. */
function hexToOklch(hex: string): { L: number; C: number; H: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = srgbToLinear(((n >> 16) & 0xff) / 255);
  const g = srgbToLinear(((n >> 8) & 0xff) / 255);
  const b = srgbToLinear((n & 0xff) / 255);
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  return { L, C: Math.hypot(a, bb), H: (Math.atan2(bb, a) * 180) / Math.PI };
}

function parseHexRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Mix `hex` toward `toward` in sRGB. `keep` is how much of `hex` survives
 * (1 = unchanged, 0 = fully `toward`). Used to fade shaded nodes/links right
 * down into the background so a low "Shaded opacity" makes them nearly vanish
 * — matching how the labels fade to the same opacity.
 */
export function blendHex(hex: string, toward: string, keep: number): string {
  const a = parseHexRgb(hex),
    b = parseHexRgb(toward);
  if (!a || !b) return hex;
  const t = Math.max(0, Math.min(1, keep));
  const mix = (x: number, y: number) => Math.round(x * t + y * (1 - t));
  const to2 = (v: number) => v.toString(16).padStart(2, "0");
  return `#${to2(mix(a.r, b.r))}${to2(mix(a.g, b.g))}${to2(mix(a.b, b.b))}`;
}

/**
 * Drop a #rrggbb color's OKLCH chroma toward grey. amount=0 → unchanged,
 * 1 → fully desaturated. Used so shaded nodes lose their community color (not
 * just their brightness) before they fade into the background.
 */
export function desaturate(hex: string, amount: number): string {
  if (amount <= 0) return hex;
  const o = hexToOklch(hex);
  if (!o) return hex;
  const t = Math.min(1, amount);
  return oklch(o.L, o.C * (1 - t), o.H);
}

export function dim(hex: string, amount = 0.78): string {
  if (amount <= 0) return hex;
  const o = hexToOklch(hex);
  if (!o) return hex;
  return oklch(o.L * (1 - 0.6 * amount), o.C * (1 - amount), o.H);
}

/**
 * Hue (deg) for node/fraction `x` along a path-trace route of length `len`.
 *
 * The base hue interpolates linearly from `startHue` at the first node to
 * `endHue` at the last, so the route's endpoints are fixed and controllable.
 * On top of that, each route gets a rank-based offset so that routes which
 * share nodes (k-shortest paths overlap heavily) fan their hues apart and stay
 * tellable-apart — `spread` is the per-rank distance in degrees. The offset is
 * multiplied by `sin(π · u)`, which is zero at both endpoints, so *every* route
 * still starts exactly on `startHue` and ends exactly on `endHue` no matter the
 * spread — the fan only bulges out across the middle of the route. Rank 0 (the
 * shortest/primary route) gets no offset; higher ranks alternate ±1, ±2 … so
 * they spread symmetrically around the primary gradient.
 */
export function traceHue(
  rank: number,
  len: number,
  x: number,
  startHue: number,
  endHue: number,
  spread: number,
): number {
  if (len <= 1) return startHue;
  const u = x / (len - 1);
  const base = startHue + (endHue - startHue) * u;
  if (rank <= 0 || spread === 0) return base;
  const taper = Math.sin(Math.PI * u); // 0 at u=0 and u=1
  const sign = rank % 2 === 1 ? 1 : -1;
  const step = Math.ceil(rank / 2); // 1,1,2,2,3,3 … → ±1,∓1,±2 …
  return base + sign * step * spread * taper;
}

/**
 * OKLCH lightness for a node on the trace trail. The node lights up by *how much
 * traffic flows through it*: `passes` route-fronts have crossed it out of `total`
 * routes, ramping from `dimL` (untouched) toward `fullL` (every route passes —
 * e.g. the shared start/end nodes). `pulse` (0–1) is the subtle decaying flash
 * fired the moment a front first crosses; `finale` adds the big sustained flare
 * (`finaleL`) held through the loop delay once the whole trace has finished.
 * The result is clamped into a sane lightness range.
 */
export function trailNodeLightness(
  passes: number,
  total: number,
  dimL: number,
  fullL: number,
  pulse: number,
  pulseL: number,
  finale: boolean,
  finaleL: number,
): number {
  const accum = total > 0 ? Math.min(1, Math.max(0, passes / total)) : 0;
  const L =
    dimL +
    (fullL - dimL) * accum +
    Math.max(0, pulse) * pulseL +
    (finale ? finaleL : 0);
  return Math.min(0.99, Math.max(0, L));
}

// ── Community legend ─────────────────────────────────────────────────────────

interface CommunityGroup {
  id: number;
  color: string;
  members: { id: string; title: string }[];
  /** Visible edges arriving from nodes outside this group. */
  linksIn: number;
  /** Visible edges leaving this group for nodes outside it. */
  linksOut: number;
}

/**
 * Group the currently-visible nodes by community (or component, matching
 * whichever coloring mode is active) so the legend always reflects what's
 * actually drawn on screen — same grouping key the renderer uses for color.
 * Largest groups first; members alphabetical by title. Cross-group edge
 * counts (links in/out of each community) come from the visible link list.
 */
export function summarizeCommunities(
  nodes: FgNode[],
  colorMode: ColorMode,
  links: Array<{ source: unknown; target: unknown }> = [],
): CommunityGroup[] {
  const groups = new Map<number, CommunityGroup>();
  const groupOfNode = new Map<string, number>();
  for (const n of nodes) {
    const key = colorMode === "component" ? n.componentId : n.community;
    groupOfNode.set(n.id, key);
    let group = groups.get(key);
    if (!group) {
      group = {
        id: key,
        color: communityColor(key),
        members: [],
        linksIn: 0,
        linksOut: 0,
      };
      groups.set(key, group);
    }
    group.members.push({ id: n.id, title: n.title });
  }
  // The renderer mutates link endpoints from id strings into node objects —
  // accept either form.
  const endpointId = (e: unknown): string =>
    typeof e === "object" && e !== null
      ? String((e as { id?: string }).id ?? "")
      : String(e ?? "");
  for (const link of links) {
    const sourceGroup = groupOfNode.get(endpointId(link.source));
    const targetGroup = groupOfNode.get(endpointId(link.target));
    if (
      sourceGroup === undefined ||
      targetGroup === undefined ||
      sourceGroup === targetGroup
    )
      continue;
    groups.get(sourceGroup)!.linksOut += 1;
    groups.get(targetGroup)!.linksIn += 1;
  }
  for (const group of groups.values()) {
    group.members.sort((a, b) => a.title.localeCompare(b.title));
  }
  return [...groups.values()].sort(
    (a, b) => b.members.length - a.members.length,
  );
}

/**
 * Resolve a label sprite's draw state from whether it's shaded (outside the
 * highlight set) and the configured shaded opacity. Fully-faded labels report
 * `visible: false` so the renderer can skip them entirely — the key cost saver
 * while the layout is actively rearranging hundreds of sprites.
 */
export function labelDrawState(
  faded: boolean,
  shadedOpacity: number,
): { opacity: number; visible: boolean } {
  const opacity = faded ? shadedOpacity : 1;
  return { opacity, visible: opacity > 0.01 };
}

/**
 * Compute the display color for a node, applying all transformations in priority order:
 * 1. Animated trace color (if in pathMode and node is being traced)
 * 2. Grey for unvisited path nodes (if in pathMode and not in highlight set)
 * 3. Base color desaturated and blended toward background (if node is shaded)
 * 4. Base color (default)
 */
export function computeNodeDisplayColor(
  nodeId: string,
  nodeObj: FgNode | null,
  pathMode: boolean,
  traceNodeColor: Map<string, string>,
  highlightSet: Set<string>,
  shadingEnabled: boolean,
  colorMode: ColorMode,
  bgColor: string,
  shadedOpacity: number,
): string {
  // Animated trace color wins so passed nodes stay lit.
  if (pathMode) {
    const tc = traceNodeColor.get(nodeId);
    if (tc) return tc;
    // A path node the trace hasn't reached yet stays neutral grey.
    if (highlightSet.has(nodeId)) return "#888888";
  }

  if (!nodeObj) return "#ffffff";

  const base = !nodeObj.exists
    ? "#555566"
    : colorMode === "component"
      ? communityColor(nodeObj.componentId)
      : communityColor(nodeObj.community);

  // Shaded nodes desaturate and fade toward the background.
  if (shadingEnabled && highlightSet.size > 0 && !highlightSet.has(nodeId)) {
    return blendHex(desaturate(base, 0.7), bgColor, shadedOpacity);
  }

  return base;
}

// ── Persistent node-name labels ──────────────────────────────────────────────
//
// The hover tooltip (`.nodeLabel`) already shows each node's title when you
// mouse over it. "Always show names" renders that same title as a floating
// text sprite hovering above the node, so it stays visible without hovering.
// Built on a canvas texture rather than pulling in a label-sprite dependency,
// since `three` is already available.

/** Detect phone-class devices, where GPU memory is the scarce resource. */
export function isMobileDevice(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uaMobile = (navigator as any).userAgentData?.mobile;
  if (typeof uaMobile === "boolean") return uaMobile;
  return /iPhone|iPad|iPod|Android.*Mobile/i.test(navigator.userAgent);
}

// SDF labels (troika-three-text) live in graphLabels.ts — text is rendered
// from a shared glyph atlas, so it's crisp at any zoom, never truncated, and
// costs a small geometry per label instead of a per-node canvas texture.

// ── Knob helpers ─────────────────────────────────────────────────────────────

function Knob({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const display = format ? format(value) : String(value);
  return (
    <label className="grs-knob">
      <span className="grs-knob-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="grs-knob-val">{display}</span>
    </label>
  );
}

// ── Preferences persistence ──────────────────────────────────────────────────

const PREFS_KEY = "halupedia-graph-prefs";

interface SavedPrefs {
  settings: RenderSettings;
  showHalu: boolean;
  topN: number;
  filterMode: FilterMode;
  neighborMode: NeighborhoodMode;
  metric: Metric;
  colorMode: ColorMode;
  largestComponentOnly: boolean;
  shadingEnabled: boolean;
  pathDir: PathDir;
}

function loadPrefs(): Partial<SavedPrefs> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<SavedPrefs>) : {};
  } catch {
    return {};
  }
}

function savePrefs(prefs: SavedPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable — ignore */
  }
}

// ── Main component ───────────────────────────────────────────────────────────

export function GraphView({
  onNavigate,
}: {
  onNavigate: (slug: string) => void;
}) {
  const [rawData, setRawData] = useState<GraphData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [filterMode, setFilterMode] = useState<FilterMode>(
    () => loadPrefs().filterMode ?? "top",
  );
  const [topN, setTopN] = useState(() => loadPrefs().topN ?? 60);
  const [neighborMode, setNeighborMode] = useState<NeighborhoodMode>(
    () => loadPrefs().neighborMode ?? "both",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [seeds, setSeeds] = useState<Seed[]>([]);
  const [showHalu, setShowHalu] = useState(() => loadPrefs().showHalu ?? false);
  const [metric, setMetric] = useState<Metric>(
    () => loadPrefs().metric ?? "pagerank",
  );
  const [colorMode, setColorMode] = useState<ColorMode>(
    () => loadPrefs().colorMode ?? "community",
  );
  const [largestComponentOnly, setLargestComponentOnly] = useState(
    () => loadPrefs().largestComponentOnly ?? false,
  );
  const [shadingEnabled, setShadingEnabled] = useState(
    () => loadPrefs().shadingEnabled ?? false,
  );
  const [highlightSet, setHighlightSet] = useState<Set<string>>(
    () => new Set(),
  );
  const [pathDir, setPathDir] = useState<PathDir>(
    () => loadPrefs().pathDir ?? "either",
  );
  const [pathMode, setPathMode] = useState(false);
  const [waypoints, setWaypoints] = useState<Seed[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [settings, setSettings] = useState<RenderSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...loadPrefs().settings,
  }));
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const seedsRef = useRef(seeds);
  const colorModeRef = useRef(colorMode);
  const pathEdgeSetRef = useRef(new Set<string>());
  const highlightSetRef = useRef(highlightSet);
  const shadingEnabledRef = useRef(shadingEnabled);
  const pathModeRef = useRef(pathMode);
  const pathEdgesRef = useRef(new Set<string>());
  const pathLinkBrightnessRef = useRef(settings.pathLinkBrightness);
  const traceNodeColorRef = useRef(new Map<string, string>());
  const traceEdgeColorRef = useRef(new Map<string, string>());
  const labelSpritesRef = useRef(new Map<string, NodeLabel>());
  const shadedOpacityRef = useRef(settings.shadedOpacity);
  const bgColorRef = useRef(settings.bgColor);
  // Live trace params so the animation loop reads speed/accel/colors without
  // restarting (smooth while dragging sliders); `dirty` forces a trail recolor.
  const traceParamsRef = useRef({
    speed: settings.traceSpeed,
    accel: settings.traceAccel,
    loopDelay: settings.traceLoopDelay,
    L: settings.traceLightness,
    C: settings.traceChroma,
    startHue: settings.traceStartHue,
    endHue: settings.traceEndHue,
    hueSpread: settings.traceHueSpread,
    dirty: false,
  });
  // All node label sprites' base (community) colors, so trace coloring can be
  // reverted to the underlying node color once the trace passes / loops.
  const labelBaseColorRef = useRef(new Map<string, string>());

  // Wrapper that reads from refs for use in accessors.
  const computeNodeColorFromRefs = useCallback(
    (nodeId: string, nodeObj: FgNode | null): string => {
      return computeNodeDisplayColor(
        nodeId,
        nodeObj,
        pathModeRef.current,
        traceNodeColorRef.current,
        highlightSetRef.current,
        shadingEnabledRef.current,
        colorModeRef.current,
        bgColorRef.current,
        shadedOpacityRef.current,
      );
    },
    [],
  );

  const set = useCallback(
    <K extends keyof RenderSettings>(key: K, value: RenderSettings[K]) => {
      setSettings((s) => ({ ...s, [key]: value }));
    },
    [],
  );

  // Fade the floating name labels of shaded (non-whitelisted) nodes so the text
  // recedes with the node. Reads the live shading refs; called whenever the
  // whitelist changes and when labels are (re)created.
  const applyLabelFade = useCallback(() => {
    const hl = highlightSetRef.current;
    const shade = shadingEnabledRef.current;
    const shadedOpacity = shadedOpacityRef.current;
    for (const [id, label] of labelSpritesRef.current) {
      const faded = shade && hl.size > 0 && !hl.has(id);
      // Hidden labels are skipped entirely by the renderer — no transparent
      // draw call and no per-frame depth sort — which is the real cost when the
      // layout is actively rearranging hundreds of labels. Toggling `visible`
      // (rather than just lowering opacity) is what makes a fully-faded shaded
      // set cheap on huge graphs.
      const { opacity, visible } = labelDrawState(faded, shadedOpacity);
      setLabelOpacity(label, opacity);
      if (label.visible !== visible) label.visible = visible;
    }
  }, []);

  // Keep refs current so accessors always read fresh values without triggering re-renders
  useEffect(() => {
    seedsRef.current = seeds;
  }, [seeds]);
  useEffect(() => {
    colorModeRef.current = colorMode;
  }, [colorMode]);

  // Persist preferences whenever any user-controlled value changes (seeds are transient, not saved)
  useEffect(() => {
    savePrefs({
      settings,
      showHalu,
      topN,
      filterMode,
      neighborMode,
      metric,
      colorMode,
      largestComponentOnly,
      shadingEnabled,
      pathDir,
    });
  }, [
    settings,
    showHalu,
    topN,
    filterMode,
    neighborMode,
    metric,
    colorMode,
    largestComponentOnly,
    shadingEnabled,
    pathDir,
  ]);

  // ── Graphology: build directed graph + stats ────────────────────────────────

  type NodeStat = {
    score: number;
    scoreNorm: number;
    community: number;
    componentId: number;
  };
  type GraphStat = { density: number; componentCount: number };

  const { gInstance, nodeStats, graphStats } = useMemo(() => {
    const empty = {
      gInstance: null,
      nodeStats: new Map<string, NodeStat>(),
      graphStats: { density: 0, componentCount: 0 } as GraphStat,
    };
    if (!rawData) return empty;

    const g = new Graph({ type: "directed", multi: false });
    for (const n of rawData.nodes) {
      if (!g.hasNode(n.slug))
        g.addNode(n.slug, { title: n.title, exists: n.exists });
    }
    for (const l of rawData.links) {
      if (
        g.hasNode(l.source) &&
        g.hasNode(l.target) &&
        !g.hasEdge(l.source, l.target)
      ) {
        g.addEdge(l.source, l.target);
      }
    }

    const rawScores = computeMetric(g, metric, seeds);
    const scoreValues = Object.values(rawScores);
    const maxScore = scoreValues.length > 0 ? Math.max(...scoreValues) : 1;
    const safeMax = maxScore > 0 ? maxScore : 1;

    let communities: Record<string, number> = {};
    try {
      communities = louvain(g);
    } catch {
      /* needs edges */
    }
    // Collapse all single-member communities onto the reserved -1 id so they
    // render in one neutral color instead of cycling the palette.
    const communitySizes = new Map<number, number>();
    for (const slug of g.nodes()) {
      const c = communities[slug] ?? 0;
      communitySizes.set(c, (communitySizes.get(c) ?? 0) + 1);
    }
    const communityOf = (slug: string): number => {
      const c = communities[slug] ?? 0;
      return (communitySizes.get(c) ?? 0) <= 1 ? -1 : c;
    };

    const nodeComponentId = new Map<string, number>();
    let componentCount = 0;
    try {
      const comps = connectedComponents(g);
      componentCount = comps.length;
      comps.forEach((comp, idx) =>
        comp.forEach((n) => nodeComponentId.set(n, idx)),
      );
    } catch {
      /* ignore */
    }

    let graphDensity = 0;
    try {
      graphDensity = density(g);
    } catch {
      /* ignore */
    }

    const stats = new Map<string, NodeStat>();
    for (const slug of g.nodes()) {
      const score = rawScores[slug] ?? 0;
      stats.set(slug, {
        score,
        scoreNorm: score / safeMax,
        community: communityOf(slug),
        componentId: nodeComponentId.get(slug) ?? 0,
      });
    }

    return {
      gInstance: g,
      nodeStats: stats,
      graphStats: { density: graphDensity, componentCount },
    };
  }, [rawData, metric, seeds]);

  // ── Shortest paths between all seed pairs ────────────────────────────────────

  const pathEdgeSet = useMemo(() => {
    if (!gInstance || seeds.length < 2) return new Set<string>();
    const edgeSet = new Set<string>();
    for (let i = 0; i < seeds.length; i++) {
      for (let j = i + 1; j < seeds.length; j++) {
        if (
          !gInstance.hasNode(seeds[i].slug) ||
          !gInstance.hasNode(seeds[j].slug)
        )
          continue;
        try {
          const path = unweightedPath(gInstance, seeds[i].slug, seeds[j].slug);
          if (!path) continue;
          for (let k = 0; k < path.length - 1; k++)
            edgeSet.add(`${path[k]}>${path[k + 1]}`);
        } catch {
          /* unreachable pair */
        }
      }
    }
    return edgeSet;
  }, [gInstance, seeds]);

  // ── Ordered path through the chosen waypoints ────────────────────────────────

  const paths = useMemo(() => {
    if (!gInstance || waypoints.length < 2) return [] as PathRoute[];
    return computePaths(gInstance, waypoints, pathDir, settings.maxPaths);
  }, [gInstance, waypoints, pathDir, settings.maxPaths]);

  // Union of every route's nodes/edges — drives the shading whitelist and the
  // set of nodes force-included in the rendered subgraph.
  const pathUnion = useMemo(() => {
    const nodes = new Set<string>();
    const edges = new Set<string>();
    for (const p of paths) {
      for (const n of p.nodes) nodes.add(n);
      for (const e of p.edgeSet) edges.add(e);
    }
    return { nodes, edges };
  }, [paths]);

  // ── Filtered subgraph for the renderer ─────────────────────────────────────

  const fgData = useMemo(() => {
    if (!gInstance)
      return {
        nodes: [] as FgNode[],
        links: [] as { source: string; target: string }[],
      };

    let slugSet: Set<string>;

    if (filterMode === "top") {
      const sorted = [...gInstance.nodes()]
        .sort(
          (a, b) =>
            (nodeStats.get(b)?.score ?? 0) - (nodeStats.get(a)?.score ?? 0),
        )
        .slice(0, topN);
      slugSet = new Set(sorted);
    } else {
      slugSet = new Set<string>();
      for (const seed of seeds) {
        if (!gInstance.hasNode(seed.slug)) continue;
        slugSet.add(seed.slug);
        if (neighborMode === "refs" || neighborMode === "both") {
          for (const n of gInstance.outNeighbors(seed.slug)) slugSet.add(n);
        }
        if (neighborMode === "backlinks" || neighborMode === "both") {
          for (const n of gInstance.inNeighbors(seed.slug)) slugSet.add(n);
        }
      }
      if (slugSet.size === 0) {
        [...gInstance.nodes()]
          .sort(
            (a, b) =>
              (nodeStats.get(b)?.score ?? 0) - (nodeStats.get(a)?.score ?? 0),
          )
          .slice(0, 20)
          .forEach((s) => slugSet.add(s));
      }
    }

    if (largestComponentOnly) {
      try {
        const largest = new Set(largestConnectedComponent(gInstance));
        slugSet = new Set([...slugSet].filter((s) => largest.has(s)));
      } catch {
        /* ignore */
      }
    }

    // Always include the path waypoints + intermediate route nodes so the trace
    // has something to draw, even if they fall outside the top-N / neighbor
    // filter — and the waypoints themselves even when no route connects them.
    if (pathMode) {
      for (const w of waypoints)
        if (gInstance.hasNode(w.slug)) slugSet.add(w.slug);
      for (const slug of pathUnion.nodes)
        if (gInstance.hasNode(slug)) slugSet.add(slug);
    }

    const allNodes: FgNode[] = [...slugSet].map((slug) => {
      const exists =
        (gInstance.getNodeAttribute(slug, "exists") as boolean) ?? false;
      const rawTitle =
        (gInstance.getNodeAttribute(slug, "title") as string) || slug;
      return {
        id: slug,
        title: exists ? rawTitle : slugToTitle(rawTitle),
        exists,
        score: nodeStats.get(slug)?.score ?? 0,
        scoreNorm: nodeStats.get(slug)?.scoreNorm ?? 0,
        community: nodeStats.get(slug)?.community ?? 0,
        componentId: nodeStats.get(slug)?.componentId ?? 0,
        inDegree: gInstance.inDegree(slug),
        outDegree: gInstance.outDegree(slug),
        visibleInDegree: 0,
        visibleOutDegree: 0,
      };
    });

    const haluCount = allNodes.filter((n) => !n.exists).length;
    const nodes = showHalu ? allNodes : allNodes.filter((n) => n.exists);
    const visibleIds = new Set(nodes.map((n) => n.id));

    // Force every chosen waypoint to appear — even ones with no links at all
    // (not in the link graph) or hidden by the halu filter. Synthesize a node
    // when it isn't already present so the article you searched is always shown.
    if (pathMode) {
      for (const w of waypoints) {
        if (visibleIds.has(w.slug)) continue;
        const inG = gInstance.hasNode(w.slug);
        nodes.push({
          id: w.slug,
          title: inG
            ? (gInstance.getNodeAttribute(w.slug, "title") as string) || w.title
            : w.title,
          exists: true,
          score: nodeStats.get(w.slug)?.score ?? 0,
          scoreNorm: nodeStats.get(w.slug)?.scoreNorm ?? 0,
          community: nodeStats.get(w.slug)?.community ?? 0,
          componentId: nodeStats.get(w.slug)?.componentId ?? 0,
          inDegree: inG ? gInstance.inDegree(w.slug) : 0,
          outDegree: inG ? gInstance.outDegree(w.slug) : 0,
          visibleInDegree: 0,
          visibleOutDegree: 0,
        });
        visibleIds.add(w.slug);
      }
    }

    const links: { source: string; target: string }[] = [];
    for (const edge of gInstance.edges()) {
      const [src, tgt] = gInstance.extremities(edge);
      if (visibleIds.has(src) && visibleIds.has(tgt)) {
        links.push({ source: src, target: tgt });
      }
    }

    // Compute visible-only degrees from the filtered edge list
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    for (const l of links) {
      const src = nodeById.get(l.source);
      const tgt = nodeById.get(l.target);
      if (src) src.visibleOutDegree++;
      if (tgt) tgt.visibleInDegree++;
    }

    return { nodes, links, haluCount };
  }, [
    gInstance,
    nodeStats,
    filterMode,
    topN,
    seeds,
    neighborMode,
    showHalu,
    largestComponentOnly,
    pathMode,
    pathUnion,
    waypoints,
  ]);

  // ── Data fetching ───────────────────────────────────────────────────────────

  useEffect(() => {
    fetch("/api/graph")
      .then((r) => r.json())
      .then((d) => setRawData(d as GraphData))
      .catch(() => setLoadError(true));
  }, []);

  // ── 3d-force-graph: initialize once ────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    let destroyed = false;

    import("3d-force-graph").then(({ default: ForceGraph3D }) => {
      if (destroyed || fgRef.current) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fg = (ForceGraph3D as any)({ controlType: "orbit" })(el);
      fgRef.current = fg;

      fg.nodeId("id")
        .nodeLabel(
          (n: FgNode) =>
            `${n.title}\n↑ ${n.visibleInDegree} in  ↓ ${n.visibleOutDegree} out`,
        )
        .nodeVal((n: FgNode) => Math.max(1, n.inDegree * 0.5 + n.scoreNorm * 6))
        .onNodeClick((n: FgNode, event?: MouseEvent) => {
          // Shaded (non-highlighted) nodes are visually receded — don't let
          // them be grabbed/navigated, which would be confusing.
          const hl = highlightSetRef.current;
          if (shadingEnabledRef.current && hl.size > 0 && !hl.has(n.id)) return;
          // Shift-click is the "interact with the camera, not the node" gesture.
          if (event?.shiftKey) return;
          if (n.exists) onNavigate(toWikiSegment(n.title));
        });

      // Seed an empty dataset before any other prop is applied. The force
      // engine resumes (engineRunning = true) at the end of EVERY update
      // digest, but its layout is only created by digests that include a
      // graphData change — if the first digest came from a settings prop
      // while /api/graph was still in flight, the next tick crashed on an
      // undefined layout ("can't access property 'tick', e.layout is
      // undefined" on page refresh).
      fg.graphData({ nodes: [], links: [] });

      // Debug handle for devtools/automation (inspecting camera, controls,
      // and drag state without prop drilling).
      (window as unknown as Record<string, unknown>).__halu_fg = fg;

      setInitialized(true);
    });

    return () => {
      destroyed = true;
      disposeLabels(labelSpritesRef.current);
      if (fgRef.current) {
        try {
          fgRef.current._destructor?.();
        } catch {
          /* ignore */
        }
        fgRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Push graph data whenever it changes ────────────────────────────────────

  useEffect(() => {
    if (!fgRef.current || !initialized || fgData.nodes.length === 0) return;
    // Drop the cached label sprites so they rebuild against the new data (titles
    // / sizes / colors) — nodeThreeObject otherwise reuses the stale cached one.
    disposeLabels(labelSpritesRef.current);
    labelBaseColorRef.current.clear();
    // Cap the framebuffer's pixel ratio: 3x phone screens triple-account every
    // canvas pixel and are the main reason big graphs crash mobile Safari.
    const dprCap = isMobileDevice() && fgData.nodes.length > 1000 ? 1.5 : 2;
    fgRef.current
      .renderer?.()
      ?.setPixelRatio?.(Math.min(window.devicePixelRatio || 1, dprCap));
    fgRef.current.graphData({
      nodes: fgData.nodes.map((n) => ({ ...n })),
      links: fgData.links.map((l) => ({ ...l })),
    });
  }, [fgData, initialized]);

  // ── Apply render settings imperatively ─────────────────────────────────────

  useEffect(() => {
    if (!fgRef.current || !initialized) return;
    const fg = fgRef.current;

    fg.nodeResolution(settings.nodeResolution)
      .nodeRelSize(settings.nodeRelSize)
      .nodeOpacity(settings.nodeOpacity)
      .linkOpacity(settings.linkOpacity)
      .linkWidth(settings.linkWidth)
      .linkDirectionalArrowLength(settings.arrowLength)
      .linkCurvature(settings.linkCurvature)
      .linkDirectionalParticles(settings.particles)
      .linkDirectionalParticleSpeed(settings.particleSpeed)
      .linkDirectionalParticleWidth(settings.particleWidth)
      .linkDirectionalParticleColor(
        (l: { source: FgNode | string; target: FgNode | string }) => {
          if (!settings.directionalParticles) return "#ffffff";
          const src = typeof l.source === "object" ? l.source.id : l.source;
          const tgt = typeof l.target === "object" ? l.target.id : l.target;
          const currentSeeds = seedsRef.current;
          // Seed-relative: into a seed = green, out of a seed = red
          if (currentSeeds.some((s) => s.slug === tgt)) return "#3ddc84";
          if (currentSeeds.some((s) => s.slug === src)) return "#ff4d4d";
          // No seed match: particle is traveling in the forward direction = green ("in")
          return "#3ddc84";
        },
      )
      .backgroundColor(settings.bgColor)
      .d3AlphaDecay(settings.alphaDecay)
      .d3VelocityDecay(settings.velocityDecay);

    // "Always show names": render the same title shown on hover as a
    // permanent floating sprite above each node, instead of only in the
    // hover tooltip. nodeThreeObjectExtend keeps the default sphere and adds
    // the label sprite alongside it.
    if (settings.alwaysShowLabels) {
      disposeLabels(labelSpritesRef.current);
      labelBaseColorRef.current.clear();
      fg.nodeThreeObjectExtend(true).nodeThreeObject((n: FgNode) => {
        // Reuse the existing sprite if we already built one for this node.
        // `refresh()` re-invokes this accessor on its own frame; rebuilding
        // here would reset the sprite to its base community color and fight
        // the live trace tint (a visible community↔trace strobe). The cache
        // is cleared above whenever settings actually change, so size/opacity
        // still rebuild then.
        const cached = labelSpritesRef.current.get(n.id);
        if (cached) return cached;
        const color = n.exists
          ? colorModeRef.current === "component"
            ? communityColor(n.componentId)
            : communityColor(n.community)
          : "#999999";
        const nodeRadius =
          Math.cbrt(Math.max(1, n.inDegree * 0.5 + n.scoreNorm * 6)) *
          settings.nodeRelSize;
        // Scale the label off the node's own radius so it stays legible
        // relative to the node regardless of the "Base size" setting —
        // "Label size" is a multiplier on top of that baseline.
        // "Size by link count" scales each label by how many links the node
        // has (in / out / both, per the dropdown), with an influence knob.
        // log keeps very high-degree hubs from dwarfing everything.
        const degCount =
          settings.labelDegreeMode === "in"
            ? n.visibleInDegree
            : settings.labelDegreeMode === "out"
              ? n.visibleOutDegree
              : n.visibleInDegree + n.visibleOutDegree;
        const prominence = settings.dynamicLabelSize
          ? 1 + settings.labelSizeInfluence * Math.log2(1 + degCount)
          : 1;
        const worldHeight =
          Math.max(2, nodeRadius) * 0.7 * settings.labelSize * prominence;
        const sprite = makeNodeLabel(n.title, color, worldHeight, {
          in: n.visibleInDegree,
          out: n.visibleOutDegree,
        });
        sprite.position.set(
          0,
          nodeRadius + labelWorldHeight(sprite) / 2 + 1,
          0,
        );
        const hl = highlightSetRef.current;
        const faded = shadingEnabledRef.current && hl.size > 0 && !hl.has(n.id);
        const { opacity, visible } = labelDrawState(
          faded,
          shadedOpacityRef.current,
        );
        setLabelOpacity(sprite, opacity);
        sprite.visible = visible;
        labelSpritesRef.current.set(n.id, sprite);
        labelBaseColorRef.current.set(n.id, color);
        return sprite;
      });
    } else {
      disposeLabels(labelSpritesRef.current);
      fg.nodeThreeObjectExtend(false).nodeThreeObject(null);
    }

    const charge = fg.d3Force("charge");
    if (charge) charge.strength(settings.chargeStrength);

    const link = fg.d3Force("link");
    if (link) link.distance(settings.linkDistance);

    fg.d3ReheatSimulation();
  }, [settings, initialized]);

  // SDF label meshes don't billboard on their own the way sprites did — turn
  // every visible label toward the camera each frame (a quaternion copy per
  // label; trivial CPU even at thousands of labels).
  useEffect(() => {
    if (!fgRef.current || !initialized || !settings.alwaysShowLabels) return;
    let raf = 0;
    const tick = () => {
      const fg = fgRef.current;
      const camera = fg?.camera?.();
      if (camera) faceCamera(labelSpritesRef.current.values(), camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [settings.alwaysShowLabels, initialized]);

  // The label sprites are cached (so refresh() doesn't strobe their live trace
  // tint), which means a color-mode flip no longer rebuilds them — re-tint each
  // cached sprite to its node's new base color here instead. The trace tint, if
  // active, overrides per-frame; we still refresh the stored base so the trail
  // resets to the right color when path mode ends.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !initialized || !settings.alwaysShowLabels) return;
    for (const o of fg.graphData().nodes as FgNode[]) {
      const sprite = labelSpritesRef.current.get(o.id);
      if (!sprite) continue;
      const color = !o.exists
        ? "#999999"
        : colorMode === "component"
          ? communityColor(o.componentId)
          : communityColor(o.community);
      labelBaseColorRef.current.set(o.id, color);
      if (!pathModeRef.current) setLabelColor(sprite, color);
    }
  }, [colorMode, initialized, settings.alwaysShowLabels]);

  // ── Node colour + path highlighting (no physics re-heat) ─────────────────────

  useEffect(() => {
    pathEdgeSetRef.current = pathEdgeSet;
    if (!fgRef.current || !initialized) return;
    fgRef.current
      .nodeColor((n: FgNode) => computeNodeColorFromRefs(n.id, n))
      .linkColor((l: { source: FgNode | string; target: FgNode | string }) => {
        const src = typeof l.source === "object" ? l.source.id : l.source;
        const tgt = typeof l.target === "object" ? l.target.id : l.target;
        const key = `${src}>${tgt}`;
        if (pathModeRef.current) {
          // A route edge already swept by a particle keeps its hue band.
          const tc = traceEdgeColorRef.current.get(key);
          if (tc) return tc;
          // Route edges not yet reached are brightened by the "Path edges"
          // slider so the route stays visible without stealing focus.
          if (pathEdgesRef.current.has(key)) {
            const v = Math.round(
              (0.25 + 0.75 * pathLinkBrightnessRef.current) * 255,
            );
            return `rgb(${v},${v},${v})`;
          }
        }
        const base = pathEdgeSetRef.current.has(key) ? "#ffd700" : "#ffffff";
        const hl = highlightSetRef.current;
        if (
          shadingEnabledRef.current &&
          hl.size > 0 &&
          !(hl.has(src) && hl.has(tgt))
        )
          return blendHex(
            desaturate(base, 0.7),
            bgColorRef.current,
            shadedOpacityRef.current,
          );
        return base;
      })
      .refresh();
  }, [colorMode, pathEdgeSet, pathUnion, initialized]);

  // Re-apply colors (without re-heating physics) whenever the shading whitelist
  // or its enabled flag changes — the accessors above read these via refs.
  useEffect(() => {
    highlightSetRef.current = highlightSet;
    shadingEnabledRef.current = shadingEnabled;
    shadedOpacityRef.current = settings.shadedOpacity;
    bgColorRef.current = settings.bgColor;
    applyLabelFade();
    if (fgRef.current && initialized) fgRef.current.refresh();
  }, [
    highlightSet,
    shadingEnabled,
    settings.shadedOpacity,
    settings.bgColor,
    initialized,
    applyLabelFade,
  ]);

  // Keep the live trace params current; flag the trail for a recolor so color
  // tweaks show immediately (not only after the next node crossing).
  useEffect(() => {
    traceParamsRef.current = {
      speed: settings.traceSpeed,
      accel: settings.traceAccel,
      loopDelay: settings.traceLoopDelay,
      L: settings.traceLightness,
      C: settings.traceChroma,
      startHue: settings.traceStartHue,
      endHue: settings.traceEndHue,
      hueSpread: settings.traceHueSpread,
      dirty: true,
    };
    pathLinkBrightnessRef.current = settings.pathLinkBrightness;
    if (fgRef.current && initialized) fgRef.current.refresh();
  }, [
    settings.traceSpeed,
    settings.traceAccel,
    settings.traceLoopDelay,
    settings.traceLightness,
    settings.traceChroma,
    settings.traceStartHue,
    settings.traceEndHue,
    settings.traceHueSpread,
    settings.pathLinkBrightness,
    initialized,
  ]);

  // Entering path mode turns shading on (so the path stands out) and makes the
  // path nodes the highlight whitelist; leaving it clears the whitelist.
  useEffect(() => {
    pathModeRef.current = pathMode;
  }, [pathMode]);
  useEffect(() => {
    pathEdgesRef.current = pathUnion.edges;
    if (pathMode) {
      setHighlightSet(new Set(pathUnion.nodes));
    } else {
      setHighlightSet(new Set());
    }
  }, [pathMode, pathUnion]);

  // Auto-enable shading the first time path mode is turned on.
  useEffect(() => {
    if (pathMode) setShadingEnabled(true);
  }, [pathMode]);

  // ── Animated path trace ──────────────────────────────────────────────────
  //
  // One glowing energy particle per route races from the first waypoint to the
  // last, interpolating between live node positions every frame. All routes
  // start together; shorter ones finish first (their rank by distance). Each
  // route uses a hue band whose *step is 360°/route-length* so the full
  // spectrum spans the route regardless of how many nodes it has — adjacent
  // nodes stay distinguishable for counting — and each ranked route is offset
  // around the wheel so routes are told apart. Particles are sized/faded by
  // rank (shortest = biggest/brightest); an optional soft halo makes them glow.
  useEffect(() => {
    const nodeMap = traceNodeColorRef.current;
    const edgeMap = traceEdgeColorRef.current;
    nodeMap.clear();
    edgeMap.clear();
    const fg = fgRef.current;
    if (!fg || !initialized || !pathMode || paths.length === 0) {
      if (fg && initialized) fg.refresh();
      return;
    }

    const maxLen = Math.max(...paths.map((p) => p.nodes.length));
    const pathNodeIds = new Set<string>();
    for (const p of paths) for (const n of p.nodes) pathNodeIds.add(n);
    // Animation feel constants (all OKLCH, clamped to stay in gamut):
    const EDGE_L_BOOST = 0.16; // how much brighter an edge pulses as the trace crosses it
    const TAU = 0.18; // settle time-constant (s) for the brightness pulses
    const NODE_L_DIM = 0.4; // lightness of a path node before any front has crossed it
    const NODE_PULSE_L = 0.12; // subtle flash the instant a front first crosses a node
    const FINALE_L = 0.18; // big flare held over the loop delay once the trace finishes
    const REFRESH_CAP_MS = 8; // ≈120fps ceiling on recolor refreshes while pulses settle
    // Color for a node/edge on a route. Hue follows the start→end gradient with
    // the tapered per-rank fan (overlapping routes stay tellable-apart, endpoints
    // exact). `lBoost` brightens (a transient pulse); `fill` 0→1 scales chroma so
    // an edge *saturates* as the trace flows along it, then keeps its color when
    // calm. `x` is the node index or fractional progress; len the route length.
    const traceColor = (
      rank: number,
      len: number,
      x: number,
      lBoost = 0,
      fill = 1,
    ) => {
      const p = traceParamsRef.current;
      const L = Math.min(0.99, p.L + lBoost);
      const f = Math.max(0, Math.min(1, fill));
      const C = p.C * (0.25 + 0.75 * f); // keep a little color even at fill 0, full color at 1
      return oklch(
        L,
        C,
        traceHue(rank, len, x, p.startHue, p.endHue, p.hueSpread),
      );
    };
    // Ease-in-out applied to the whole traversal: accel 0 → constant speed,
    // higher → the particle accelerates out of the start and eases into the end.
    const easeAccel = (x: number, accel: number) => {
      const pe = 1 + accel * 3;
      return x < 0.5
        ? 0.5 * Math.pow(2 * x, pe)
        : 1 - 0.5 * Math.pow(2 * (1 - x), pe);
    };

    // Live position lookup — node objects are mutated in place by the layout.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const posMap = new Map<string, any>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const o of fg.graphData().nodes as any[]) posMap.set(o.id, o);

    const scene = fg.scene();
    const meshes: THREE.Object3D[] = [];
    const cores: {
      mesh: THREE.Mesh;
      glow?: THREE.Mesh;
      rank: number;
      len: number;
    }[] = [];
    const baseRadius = Math.max(2, settings.nodeRelSize * 0.9); // smaller than a node
    // All particles share one unit-sphere geometry, sized via mesh.scale —
    // per-route SphereGeometry allocations add up fast with many routes.
    const sphereGeometry = new THREE.SphereGeometry(1, 16, 16);

    paths.forEach((p, rank) => {
      const rankScale = Math.max(0.45, 1 - rank * 0.13);
      const r = baseRadius * rankScale;
      const coreMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(),
        transparent: true,
        opacity: 0.7 * rankScale,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const core = new THREE.Mesh(sphereGeometry, coreMat);
      core.scale.setScalar(r);
      scene.add(core);
      meshes.push(core);
      let glow: THREE.Mesh | undefined;
      if (settings.particleGlow) {
        const glowMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(),
          transparent: true,
          opacity: 0.16 * rankScale,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        glow = new THREE.Mesh(sphereGeometry, glowMat);
        glow.scale.setScalar(r * 2.6);
        scene.add(glow);
        meshes.push(glow);
      }
      cores.push({ mesh: core, glow, rank, len: p.nodes.length });
    });

    let raf = 0;
    let start = 0;
    let lastTs = 0;
    let lastRefreshTs = 0;
    let prevFinale = false;
    const lastSegs = paths.map(() => -1);
    // Brightness pulse maps that decay toward calm: edge brightness keyed by the
    // path-ordered edge, per-node flash keyed by the node id (fired when a front
    // first crosses it). Node accumulation itself is derived from `lastSegs`.
    const edgeHeat = new Map<string, number>();
    const nodePulse = new Map<string, number>();
    // Last color applied to each path node's label sprite, to skip no-op writes.
    const lastLabelColor = new Map<string, string>();
    // How many routes pass through each node at all — the denominator for its
    // brightness, so a node on a single route is full once that route crosses it,
    // while a node where several routes converge ramps up as each one arrives.
    const nodeTotals = new Map<string, number>();
    for (const p of paths)
      for (const id of p.nodes)
        nodeTotals.set(id, (nodeTotals.get(id) ?? 0) + 1);

    const tick = (ts: number) => {
      if (!start) start = ts;
      const prm = traceParamsRef.current;
      const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
      lastTs = ts;
      const activeDur = Math.max(0.1, (maxLen - 1) / prm.speed); // time to walk the longest route
      const total = activeDur + prm.loopDelay; // + delay, then loop
      const tc = ((ts - start) / 1000) % total;
      const phase = Math.min(1, tc / activeDur);
      let anyCrossed = false;
      // Once the longest route has finished we're in the loop-delay tail — hold a
      // big finale flare on the whole trail for that remaining time, then reset.
      const finaleActive = prm.loopDelay > 0 && tc >= activeDur;
      if (finaleActive !== prevFinale) {
        prevFinale = finaleActive;
        anyCrossed = true;
      }
      // distance travelled (in nodes) along the longest route; shorter routes
      // reach their end sooner — that staggered finish is the distance ranking.
      const d = easeAccel(phase, prm.accel) * (maxLen - 1);

      // Settle the pulses toward calm (exponential decay); drop the tiny tails.
      const decay = Math.exp(-dt / TAU);
      for (const [k, v] of edgeHeat) {
        const nv = v * decay;
        if (nv < 0.01) edgeHeat.delete(k);
        else edgeHeat.set(k, nv);
      }
      for (const [k, v] of nodePulse) {
        const nv = v * decay;
        if (nv < 0.01) nodePulse.delete(k);
        else nodePulse.set(k, nv);
      }

      cores.forEach((c, idx) => {
        const nodes = paths[idx].nodes;
        const N = nodes.length;
        const progress = Math.min(N - 1, d);
        const i = Math.floor(progress);
        const frac = progress - i;
        const a = posMap.get(nodes[i]);
        const b = posMap.get(nodes[Math.min(i + 1, N - 1)]);
        if (a && b) {
          const x = (a.x ?? 0) + ((b.x ?? 0) - (a.x ?? 0)) * frac;
          const y = (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * frac;
          const z = (a.z ?? 0) + ((b.z ?? 0) - (a.z ?? 0)) * frac;
          c.mesh.position.set(x, y, z);
          c.glow?.position.set(x, y, z);
        }
        const col = oklch(
          prm.L,
          prm.C,
          traceHue(
            c.rank,
            c.len,
            progress,
            prm.startHue,
            prm.endHue,
            prm.hueSpread,
          ),
        );
        (c.mesh.material as THREE.MeshBasicMaterial).color.set(col);
        if (c.glow) (c.glow.material as THREE.MeshBasicMaterial).color.set(col);
        // The edge the particle is on heats up as it travels along it (frac), so
        // it brightens while crossed; once the particle moves on, the heat decays
        // and the edge settles to calm.
        if (i + 1 < N) {
          const key = `${nodes[i]}>${nodes[i + 1]}`;
          edgeHeat.set(key, Math.max(edgeHeat.get(key) ?? 0, frac));
        }
        // Each time the front first reaches a new node, fire that node's subtle
        // flash; its steady brightness comes from how many routes pass through it.
        if (i !== lastSegs[idx]) {
          lastSegs[idx] = i;
          anyCrossed = true;
          nodePulse.set(nodes[i], 1);
        }
      });

      // Recolor on a node crossing / finale flip / slider change, otherwise
      // refresh up to ~120fps while anything is still settling — and stop
      // entirely once calm (idle loop-delay costs nothing on big graphs).
      const animating = edgeHeat.size > 0 || nodePulse.size > 0;
      if (
        anyCrossed ||
        prm.dirty ||
        (animating && ts - lastRefreshTs >= REFRESH_CAP_MS)
      ) {
        prm.dirty = false;
        lastRefreshTs = ts;
        nodeMap.clear();
        edgeMap.clear();
        // Tally how many route-fronts have crossed each node and remember the
        // first (lowest-rank) route's hue for it — so a node's color is its
        // trace hue and its brightness grows with the traffic flowing through it.
        const passes = new Map<string, number>();
        const hueOf = new Map<
          string,
          { rank: number; len: number; k: number }
        >();
        cores.forEach((c, idx) => {
          const nodes = paths[idx].nodes;
          const seg = lastSegs[idx];
          for (let k = 0; k <= seg && k < nodes.length; k++) {
            const id = nodes[k];
            passes.set(id, (passes.get(id) ?? 0) + 1);
            if (!hueOf.has(id)) hueOf.set(id, { rank: c.rank, len: c.len, k });
            // Crossed edges keep full saturation, plus any brightness pulse still settling.
            if (k > 0) {
              const heat = edgeHeat.get(`${nodes[k - 1]}>${nodes[k]}`) ?? 0;
              const col = traceColor(c.rank, c.len, k, heat * EDGE_L_BOOST, 1);
              edgeMap.set(`${nodes[k - 1]}>${nodes[k]}`, col);
              edgeMap.set(`${nodes[k]}>${nodes[k - 1]}`, col);
            }
          }
          // The edge the particle is *currently* crossing lights immediately and
          // both brightens and saturates with the trace's progress along it.
          if (seg >= 0 && seg + 1 < nodes.length) {
            const fill = Math.min(nodes.length - 1, d) - seg; // 0→1 across this segment
            const heat = edgeHeat.get(`${nodes[seg]}>${nodes[seg + 1]}`) ?? 0;
            const col = traceColor(
              c.rank,
              c.len,
              seg + 1,
              heat * EDGE_L_BOOST,
              fill,
            );
            edgeMap.set(`${nodes[seg]}>${nodes[seg + 1]}`, col);
            edgeMap.set(`${nodes[seg + 1]}>${nodes[seg]}`, col);
          }
        });
        // Each crossed node: brightness accumulates with the traffic through it
        // (full where every route converges — the shared start/end), a subtle
        // flash when first hit, and the big finale flare held over the loop delay.
        for (const [id, count] of passes) {
          const src = hueOf.get(id)!;
          const L = trailNodeLightness(
            count,
            nodeTotals.get(id) ?? 1,
            NODE_L_DIM,
            prm.L,
            nodePulse.get(id) ?? 0,
            NODE_PULSE_L,
            finaleActive,
            FINALE_L,
          );
          nodeMap.set(
            id,
            oklch(
              L,
              prm.C,
              traceHue(
                src.rank,
                src.len,
                src.k,
                prm.startHue,
                prm.endHue,
                prm.hueSpread,
              ),
            ),
          );
        }
        fg.refresh();
        // Tint each route's node labels to exactly the node's current color,
        // applying the same logic as nodeColor so labels undergo the same
        // transformations (desaturate, blend toward background, grey
        // unvisited). Label colors only change when the trace recolors nodes
        // (this block), so they're updated here rather than every frame — and
        // only when the computed color actually moved, skipping the material
        // write (and GPU uniform churn) for the rest.
        for (const id of pathNodeIds) {
          const sprite = labelSpritesRef.current.get(id);
          if (!sprite) continue;
          const nodeObj = posMap.get(id) as FgNode | undefined;
          const c = computeNodeDisplayColor(
            id,
            nodeObj ?? null,
            pathModeRef.current,
            traceNodeColorRef.current,
            highlightSetRef.current,
            shadingEnabledRef.current,
            colorModeRef.current,
            bgColorRef.current,
            shadedOpacityRef.current,
          );
          if (lastLabelColor.get(id) !== c) {
            lastLabelColor.set(id, c);
            setLabelColor(sprite, c);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      nodeMap.clear();
      edgeMap.clear();
      // Restore each route's label color to its proper display color (accounting for shading).
      for (const id of pathNodeIds) {
        const sprite = labelSpritesRef.current.get(id);
        if (!sprite) continue;
        const nodeObj = posMap.get(id) as FgNode | undefined;
        const c = computeNodeDisplayColor(
          id,
          nodeObj ?? null,
          pathModeRef.current,
          traceNodeColorRef.current,
          highlightSetRef.current,
          shadingEnabledRef.current,
          colorModeRef.current,
          bgColorRef.current,
          shadedOpacityRef.current,
        );
        setLabelColor(sprite, c);
      }
      for (const m of meshes) {
        scene.remove(m);
        ((m as THREE.Mesh).material as THREE.Material)?.dispose();
      }
      sphereGeometry.dispose();
      if (fgRef.current && initialized) fgRef.current.refresh();
    };
  }, [
    pathMode,
    paths,
    initialized,
    fgData,
    settings.nodeRelSize,
    settings.particleGlow,
  ]);

  // ── Resize observer ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => {
      if (fgRef.current && containerRef.current) {
        fgRef.current
          .width(containerRef.current.clientWidth)
          .height(containerRef.current.clientHeight);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [initialized]);

  // ── Seed management ─────────────────────────────────────────────────────────

  const addSeed = useCallback((s: Suggestion) => {
    setSeeds((prev) =>
      prev.some((x) => x.slug === s.slug)
        ? prev
        : [...prev, { slug: s.slug, title: s.title }],
    );
    setSearchQuery("");
    setFilterMode("search");
  }, []);

  const removeSeed = useCallback((slug: string) => {
    setSeeds((prev) => prev.filter((s) => s.slug !== slug));
  }, []);

  // Path waypoints: append in order. In find-article mode, also fold the pick
  // into the seed list so it shows up as a seed chip and joins that subgraph.
  const addWaypoint = useCallback(
    (s: Suggestion) => {
      setWaypoints((prev) =>
        prev.some((w) => w.slug === s.slug)
          ? prev
          : [...prev, { slug: s.slug, title: s.title }],
      );
      if (filterMode === "search") {
        setSeeds((prev) =>
          prev.some((x) => x.slug === s.slug)
            ? prev
            : [...prev, { slug: s.slug, title: s.title }],
        );
      }
    },
    [filterMode],
  );

  const removeWaypoint = useCallback((slug: string) => {
    setWaypoints((prev) => prev.filter((w) => w.slug !== slug));
  }, []);

  const communityGroups = useMemo(
    () => summarizeCommunities(fgData.nodes, colorMode, fgData.links),
    [fgData.nodes, fgData.links, colorMode],
  );

  const nodeCount = fgData.nodes.length;
  const edgeCount = fgData.links.length;
  const haluCount = fgData.haluCount ?? 0;
  const totalArticles = gInstance?.order ?? 0;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="graph-view">
      {/* ── Top control bar ── */}
      <div className="graph-controls">
        <div className="graph-filter-tabs">
          <button
            className={filterMode === "top" ? "active" : ""}
            onClick={() => setFilterMode("top")}
          >
            Top articles
          </button>
          <button
            className={filterMode === "search" ? "active" : ""}
            onClick={() => setFilterMode("search")}
          >
            Find article
          </button>
        </div>

        <label className="graph-path-toggle">
          <Checkbox
            checked={pathMode}
            onCheckedChange={(c) => setPathMode(c === true)}
          />
          <span>Path</span>
        </label>

        {pathMode && (
          <div className="graph-path-control">
            <div className="graph-path-pickers">
              {waypoints.map((w, i) => (
                <span key={w.slug} className="graph-seed-chip">
                  <span className="graph-path-index">{i + 1}</span>
                  {w.title}
                  <button
                    type="button"
                    aria-label={`Remove ${w.title}`}
                    onClick={() => removeWaypoint(w.slug)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {/* trailing empty box: picking here spawns the next slot */}
              <ArticlePicker
                key={waypoints.length}
                placeholder={
                  waypoints.length === 0
                    ? "Path: pick first article…"
                    : "next article…"
                }
                onPick={addWaypoint}
              />
            </div>
            <div className="graph-neighbor-tabs">
              {(["directed", "undirected", "either"] as PathDir[]).map((d) => (
                <button
                  key={d}
                  className={pathDir === d ? "active" : ""}
                  onClick={() => setPathDir(d)}
                >
                  {d === "directed"
                    ? "Directed"
                    : d === "undirected"
                      ? "Undirected"
                      : "Either"}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="graph-settings-btn"
              onClick={() => setWaypoints((w) => [...w].reverse())}
              disabled={waypoints.length < 2}
              title="Reverse the order of the path waypoints"
            >
              ⇄ Reverse
            </button>
          </div>
        )}

        <Select
          value={metric}
          onValueChange={(v) => v && setMetric(v as Metric)}
          items={Object.fromEntries(
            METRICS.map((m) => [m.value, m.label + (m.needsSeeds ? " *" : "")]),
          )}
        >
          <SelectTrigger
            className="graph-metric-select"
            aria-label="Metric"
            title="Node size and Top-N ranking metric"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METRICS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
                {m.needsSeeds ? " *" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={colorMode}
          onValueChange={(v) => v && setColorMode(v as ColorMode)}
        >
          <SelectTrigger
            className="graph-metric-select"
            aria-label="Color mode"
            title="Node color mode"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="community">Community</SelectItem>
            <SelectItem value="component">Component</SelectItem>
          </SelectContent>
        </Select>

        {filterMode === "top" && (
          <div className="graph-top-control">
            <label>
              Top <strong>{topN}</strong> by{" "}
              {METRICS.find((m) => m.value === metric)?.label}
            </label>
            <input
              type="range"
              min={10}
              max={Math.max(
                10,
                rawData?.nodes.filter((n) => n.exists).length ?? 10,
              )}
              step={10}
              value={topN}
              onChange={(e) => setTopN(Number(e.target.value))}
            />
          </div>
        )}

        {filterMode === "search" && (
          <div className="graph-search-control">
            {seeds.length > 0 && (
              <div className="graph-seeds">
                {seeds.map((s) => (
                  <span key={s.slug} className="graph-seed-chip">
                    {s.title}
                    <button
                      type="button"
                      aria-label={`Remove ${s.title}`}
                      onClick={() => removeSeed(s.slug)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <ArticleSearchDropdown
              wrapClassName="w-[200px]"
              inputType="text"
              query={searchQuery}
              onQueryChange={setSearchQuery}
              placeholder="Search articles to seed graph..."
              onPick={addSeed}
            />
            <div className="graph-neighbor-tabs">
              {(["refs", "backlinks", "both"] as NeighborhoodMode[]).map(
                (m) => (
                  <button
                    key={m}
                    className={neighborMode === m ? "active" : ""}
                    onClick={() => setNeighborMode(m)}
                  >
                    {m === "refs"
                      ? "Refs"
                      : m === "backlinks"
                        ? "Backlinks"
                        : "Both"}
                  </button>
                ),
              )}
            </div>
          </div>
        )}

        <div className="graph-stats">
          {loadError && (
            <span className="graph-error-inline">
              Failed to load graph data.
            </span>
          )}
          {!loadError && gInstance && (
            <span>
              {nodeCount} nodes
              {!showHalu && haluCount > 0 && (
                <span className="graph-halu-hidden">
                  {" "}
                  ({haluCount} halu hidden)
                </span>
              )}
              {" · "}
              {edgeCount} edges · {totalArticles} total
              {" · "}
              {graphStats.componentCount} components
              {" · "}density{" "}
              {graphStats.density < 0.001
                ? graphStats.density.toExponential(1)
                : graphStats.density.toFixed(4)}
              {pathEdgeSet.size > 0 && (
                <span className="graph-path-info">
                  {" "}
                  · {pathEdgeSet.size} path edges
                </span>
              )}
              {pathMode && paths.length > 0 && (
                <span className="graph-path-info">
                  {" · "}
                  {paths.length} route{paths.length > 1 ? "s" : ""} (
                  {paths.map((p) => p.nodes.length - 1).join(", ")} hops)
                </span>
              )}
              {pathMode && waypoints.length >= 2 && paths.length === 0 && (
                <span className="graph-path-info">
                  {" · "}no {pathDir === "directed" ? "directed " : ""}route
                  {pathDir === "directed" ? " (try Undirected)" : ""}
                </span>
              )}
              {pathMode &&
                gInstance &&
                waypoints.some((w) => !gInstance.hasNode(w.slug)) && (
                  <span className="graph-error-inline">
                    {" · "}
                    {waypoints
                      .filter((w) => !gInstance.hasNode(w.slug))
                      .map((w) => w.title)
                      .join(", ")}{" "}
                    not in link graph
                  </span>
                )}
            </span>
          )}
          {!loadError && !gInstance && <span>Loading graph…</span>}
        </div>

        <button
          type="button"
          className={`graph-settings-btn${largestComponentOnly ? "active" : ""}`}
          onClick={() => setLargestComponentOnly((v) => !v)}
        >
          {largestComponentOnly ? "All components" : "Largest only"}
        </button>

        <button
          type="button"
          className={`graph-settings-btn${showHalu ? "active" : ""}`}
          onClick={() => setShowHalu((v) => !v)}
        >
          {showHalu ? "Hide halu" : "Show halu"}
        </button>

        <button
          type="button"
          className={`graph-settings-btn${legendOpen ? "active" : ""}`}
          onClick={() => setLegendOpen((o) => !o)}
        >
          ▦ {colorMode === "component" ? "Components" : "Communities"}
        </button>

        <button
          type="button"
          className={`graph-settings-btn${settingsOpen ? "active" : ""}`}
          onClick={() => setSettingsOpen((o) => !o)}
        >
          ⚙ Render
        </button>
      </div>

      {/* ── Body: legend + canvas + settings side panel ── */}
      <div className="graph-body">
        {legendOpen && (
          <div className="graph-legend-panel">
            <div className="graph-legend-heading">
              {colorMode === "component" ? "Components" : "Communities"}
              <span className="graph-legend-count">
                {communityGroups.length}
              </span>
            </div>
            {communityGroups.length === 0 ? (
              <p className="graph-legend-empty">No nodes visible.</p>
            ) : (
              <ul className="graph-legend-list">
                {communityGroups.map((group) => (
                  <li key={group.id} className="graph-legend-group">
                    <div className="graph-legend-group-header">
                      <span
                        className="graph-legend-swatch"
                        style={{ background: group.color }}
                      />
                      <span className="graph-legend-group-label">
                        {group.id < 0
                          ? "Singletons"
                          : `${colorMode === "component" ? "Component" : "Community"} ${group.id}`}
                      </span>
                      <span
                        className="graph-legend-group-links"
                        title="Links into / out of this group (visible edges)"
                      >
                        ↓{group.linksIn} ↑{group.linksOut}
                      </span>
                      <span className="graph-legend-group-count">
                        {group.members.length}
                      </span>
                    </div>
                    <ul className="graph-legend-members">
                      {group.members.map((m) => (
                        <li key={m.id}>
                          <button
                            type="button"
                            onClick={() => onNavigate(toWikiSegment(m.title))}
                            onMouseEnter={() => {
                              if (!pathMode) setHighlightSet(new Set([m.id]));
                            }}
                            onMouseLeave={() => {
                              if (!pathMode) setHighlightSet(new Set());
                            }}
                          >
                            {m.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="graph-canvas" ref={containerRef} />

        {settingsOpen && (
          <div className="grs-panel">
            <div className="grs-section">
              <div className="grs-section-label">Nodes</div>
              <label className="grs-toggle">
                <Checkbox
                  checked={shadingEnabled}
                  onCheckedChange={(c) => setShadingEnabled(c === true)}
                />
                <span>Shading</span>
                <span className="grs-toggle-hint">
                  dim nodes outside the highlight set (hover / path waypoints)
                </span>
              </label>
              {shadingEnabled && (
                <Knob
                  label="Shaded opacity"
                  value={settings.shadedOpacity}
                  min={0}
                  max={1}
                  step={0.05}
                  format={(v) => v.toFixed(2)}
                  onChange={(v) => set("shadedOpacity", v)}
                />
              )}
              <Knob
                label="Resolution"
                value={settings.nodeResolution}
                min={4}
                max={32}
                step={2}
                onChange={(v) => set("nodeResolution", v)}
              />
              <Knob
                label="Base size"
                value={settings.nodeRelSize}
                min={1}
                max={12}
                step={0.5}
                format={(v) => v.toFixed(1)}
                onChange={(v) => set("nodeRelSize", v)}
              />
              <Knob
                label="Opacity"
                value={settings.nodeOpacity}
                min={0.1}
                max={1}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => set("nodeOpacity", v)}
              />
              <label className="grs-toggle">
                <Checkbox
                  checked={settings.alwaysShowLabels}
                  onCheckedChange={(c) =>
                    set("alwaysShowLabels", c === true)
                  }
                />
                <span>Always show names</span>
                <span className="grs-toggle-hint">
                  show node labels above all nodes, not just on hover
                </span>
              </label>
              {settings.alwaysShowLabels && (
                <Knob
                  label="Label size"
                  value={settings.labelSize}
                  min={0.5}
                  max={15}
                  step={0.25}
                  format={(v) => v.toFixed(1)}
                  onChange={(v) => set("labelSize", v)}
                />
              )}
              {settings.alwaysShowLabels && (
                <label className="grs-toggle">
                  <Checkbox
                    checked={settings.dynamicLabelSize}
                    onCheckedChange={(c) =>
                      set("dynamicLabelSize", c === true)
                    }
                  />
                  <span>Size by link count</span>
                  <span className="grs-toggle-hint">
                    scale each label by how many links the node has
                  </span>
                </label>
              )}
              {settings.alwaysShowLabels && settings.dynamicLabelSize && (
                <>
                  <Knob
                    label="Count influence"
                    value={settings.labelSizeInfluence}
                    min={0}
                    max={1}
                    step={0.05}
                    format={(v) => v.toFixed(2)}
                    onChange={(v) => set("labelSizeInfluence", v)}
                  />
                  <label className="grs-knob">
                    <span className="grs-knob-label">Count</span>
                    <Select
                      value={settings.labelDegreeMode}
                      onValueChange={(v) =>
                        v && set("labelDegreeMode", v as DegreeMode)
                      }
                    >
                      <SelectTrigger
                        className="graph-metric-select"
                        aria-label="Count"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="in">In links</SelectItem>
                        <SelectItem value="out">Out links</SelectItem>
                        <SelectItem value="both">Both</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                </>
              )}
            </div>

            <div className="grs-section">
              <div className="grs-section-label">Links</div>
              <Knob
                label="Opacity"
                value={settings.linkOpacity}
                min={0.01}
                max={0.6}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(v) => set("linkOpacity", v)}
              />
              <Knob
                label="Width"
                value={settings.linkWidth}
                min={0.1}
                max={4}
                step={0.1}
                format={(v) => v.toFixed(1)}
                onChange={(v) => set("linkWidth", v)}
              />
              <Knob
                label="Arrow size"
                value={settings.arrowLength}
                min={0}
                max={10}
                step={0.5}
                format={(v) => v.toFixed(1)}
                onChange={(v) => set("arrowLength", v)}
              />
              <Knob
                label="Curvature"
                value={settings.linkCurvature}
                min={0}
                max={0.8}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => set("linkCurvature", v)}
              />
              <Knob
                label="Particles"
                value={settings.particles}
                min={0}
                max={8}
                step={1}
                onChange={(v) => set("particles", v)}
              />
              <Knob
                label="Particle speed"
                value={settings.particleSpeed}
                min={0.001}
                max={0.02}
                step={0.001}
                format={(v) => v.toFixed(3)}
                onChange={(v) => set("particleSpeed", v)}
              />
              <Knob
                label="Particle size"
                value={settings.particleWidth}
                min={0.5}
                max={6}
                step={0.5}
                format={(v) => v.toFixed(1)}
                onChange={(v) => set("particleWidth", v)}
              />
              <label className="grs-toggle">
                <Checkbox
                  checked={settings.directionalParticles}
                  onCheckedChange={(c) =>
                    set("directionalParticles", c === true)
                  }
                />
                <span>Color by direction</span>
                <span className="grs-toggle-hint">
                  green=in red=out (needs seeds + particles)
                </span>
              </label>
            </div>

            <div className="grs-section">
              <div className="grs-section-label">Path trace</div>
              <Knob
                label="Max routes"
                value={settings.maxPaths}
                min={1}
                max={10}
                step={1}
                onChange={(v) => set("maxPaths", v)}
              />
              <Knob
                label="Speed"
                value={settings.traceSpeed}
                min={0.4}
                max={5}
                step={0.1}
                format={(v) => v.toFixed(1)}
                onChange={(v) => set("traceSpeed", v)}
              />
              <Knob
                label="Acceleration"
                value={settings.traceAccel}
                min={0}
                max={1}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => set("traceAccel", v)}
              />
              <Knob
                label="Loop delay"
                value={settings.traceLoopDelay}
                min={0}
                max={5}
                step={0.1}
                format={(v) => `${v.toFixed(1)}s`}
                onChange={(v) => set("traceLoopDelay", v)}
              />
              <Knob
                label="Color lightness"
                value={settings.traceLightness}
                min={0.4}
                max={0.95}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(v) => set("traceLightness", v)}
              />
              <Knob
                label="Color vividness"
                value={settings.traceChroma}
                min={0.02}
                max={0.37}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(v) => set("traceChroma", v)}
              />
              <div className="grs-knob-row">
                <Knob
                  label="Start hue"
                  value={settings.traceStartHue}
                  min={0}
                  max={360}
                  step={5}
                  format={(v) => `${v}°`}
                  onChange={(v) => set("traceStartHue", v)}
                />
                <Knob
                  label="End hue"
                  value={settings.traceEndHue}
                  min={0}
                  max={360}
                  step={5}
                  format={(v) => `${v}°`}
                  onChange={(v) => set("traceEndHue", v)}
                />
              </div>
              <Knob
                label="Hue spread"
                value={settings.traceHueSpread}
                min={0}
                max={120}
                step={2}
                format={(v) => `${v}°`}
                onChange={(v) => set("traceHueSpread", v)}
              />
              <Knob
                label="Path edges"
                value={settings.pathLinkBrightness}
                min={0}
                max={1}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => set("pathLinkBrightness", v)}
              />
              <label className="grs-toggle">
                <Checkbox
                  checked={settings.particleGlow}
                  onCheckedChange={(c) => set("particleGlow", c === true)}
                />
                <span>Particle glow</span>
                <span className="grs-toggle-hint">
                  soft halo around the travelling particle (between 2 waypoints)
                </span>
              </label>
            </div>

            <div className="grs-section">
              <div className="grs-section-label">Physics</div>
              <Knob
                label="Repulsion"
                value={settings.chargeStrength}
                min={-1200}
                max={-20}
                step={20}
                onChange={(v) => set("chargeStrength", v)}
              />
              <Knob
                label="Link distance"
                value={settings.linkDistance}
                min={5}
                max={400}
                step={5}
                onChange={(v) => set("linkDistance", v)}
              />
              <Knob
                label="Alpha decay"
                value={settings.alphaDecay}
                min={0.001}
                max={0.06}
                step={0.001}
                format={(v) => v.toFixed(3)}
                onChange={(v) => set("alphaDecay", v)}
              />
              <Knob
                label="Velocity decay"
                value={settings.velocityDecay}
                min={0.1}
                max={0.99}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(v) => set("velocityDecay", v)}
              />
            </div>

            <div className="grs-section">
              <div className="grs-section-label">Background</div>
              <div className="grs-bg-presets">
                {BG_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    className={`grs-bg-swatch${settings.bgColor === p.value ? "active" : ""}`}
                    style={{ background: p.value }}
                    title={p.label}
                    onClick={() => set("bgColor", p.value)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              className="grs-reset"
              onClick={() => setSettings(DEFAULT_SETTINGS)}
            >
              Reset to defaults
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
