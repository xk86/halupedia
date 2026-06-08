import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank";
import betweenness from "graphology-metrics/centrality/betweenness";
import closeness from "graphology-metrics/centrality/closeness";
import eigenvector from "graphology-metrics/centrality/eigenvector";
import { degreeCentrality, inDegreeCentrality, outDegreeCentrality } from "graphology-metrics/centrality/degree";
import hits from "graphology-metrics/centrality/hits";
import { eccentricity } from "graphology-metrics/node";
import { density } from "graphology-metrics/graph";
import { singleSourceLength, bidirectional as unweightedPath } from "graphology-shortest-path/unweighted";
import { connectedComponents, largestConnectedComponent } from "graphology-components";
import louvain from "graphology-communities-louvain";
import * as THREE from "three";
import { toWikiSegment } from "./wikiPath";

interface RawNode { slug: string; title: string; exists: boolean; }
interface RawLink { source: string; target: string; }
interface GraphData { nodes: RawNode[]; links: RawLink[]; }

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
type Metric =
  | "pagerank" | "betweenness" | "closeness" | "eigenvector"
  | "degree" | "inDegree" | "outDegree"
  | "hitsAuthority" | "hitsHub"
  | "eccentricity" | "distanceFromSeed";

const METRICS: { value: Metric; label: string; needsSeeds?: true }[] = [
  { value: "pagerank",         label: "PageRank" },
  { value: "betweenness",      label: "Betweenness" },
  { value: "closeness",        label: "Closeness" },
  { value: "eigenvector",      label: "Eigenvector" },
  { value: "degree",           label: "Degree" },
  { value: "inDegree",         label: "In-degree" },
  { value: "outDegree",        label: "Out-degree" },
  { value: "hitsAuthority",    label: "HITS authority" },
  { value: "hitsHub",          label: "HITS hub" },
  { value: "eccentricity",     label: "Eccentricity" },
  { value: "distanceFromSeed", label: "Seed distance", needsSeeds: true },
];

interface Seed { slug: string; title: string; }

function computeMetric(g: Graph, metric: Metric, seeds?: Seed[]): Record<string, number> {
  const zero = () => { const z: Record<string, number> = {}; for (const n of g.nodes()) z[n] = 0; return z; };
  try {
    switch (metric) {
      case "pagerank":    return pagerank(g, { getEdgeWeight: null });
      case "betweenness": return betweenness(g);
      case "closeness":   return closeness(g);
      case "eigenvector": return eigenvector(g);
      case "degree":      return degreeCentrality(g);
      case "inDegree":    return inDegreeCentrality(g);
      case "outDegree":   return outDegreeCentrality(g);
      case "hitsAuthority": return hits(g).authorities;
      case "hitsHub":       return hits(g).hubs;
      case "eccentricity": {
        const result: Record<string, number> = {};
        for (const n of g.nodes()) { try { result[n] = eccentricity(g, n); } catch { result[n] = 0; } }
        return result;
      }
      case "distanceFromSeed": {
        const validSeeds = (seeds ?? []).filter(s => g.hasNode(s.slug));
        if (!validSeeds.length) return computeMetric(g, "pagerank");
        const distMaps = validSeeds.map(s => singleSourceLength(g, s.slug));
        const result: Record<string, number> = {};
        for (const n of g.nodes()) {
          const minDist = Math.min(...distMaps.map(dm => dm[n] ?? Infinity));
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

interface Suggestion { slug: string; title: string; }

// ── Render settings ──────────────────────────────────────────────────────────

interface RenderSettings {
  // Nodes
  nodeResolution: number;   // sphere segments: 4–32
  nodeRelSize: number;      // base sphere volume per val unit: 1–12
  nodeOpacity: number;      // 0.1–1.0
  // Links
  linkOpacity: number;      // 0.01–0.6
  linkWidth: number;        // 0.1–4.0
  arrowLength: number;      // 0–10
  linkCurvature: number;    // 0–0.8
  particles: number;        // 0–8
  particleSpeed: number;    // 0.001–0.02
  particleWidth: number;    // 0.5–6
  // Physics
  chargeStrength: number;   // -20 to -1200 (repulsion)
  linkDistance: number;     // 5–400
  alphaDecay: number;       // 0.001–0.06
  velocityDecay: number;    // 0.1–0.99
  // Appearance
  bgColor: string;
  alwaysShowLabels: boolean; // show node-name labels above all nodes, not just on hover
  directionalParticles: boolean;
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
  directionalParticles: false,
};

const BG_PRESETS = [
  { label: "Void", value: "#080810" },
  { label: "Space", value: "#020408" },
  { label: "Slate", value: "#0d1117" },
  { label: "Paper", value: "#1a1a2e" },
];

// ── Community colours ────────────────────────────────────────────────────────

const COMMUNITY_COLORS = [
  "#e63946", "#457b9d", "#2a9d8f", "#e9c46a", "#f4a261",
  "#8338ec", "#06d6a0", "#ef476f", "#118ab2", "#ffd166",
  "#6a4c93", "#1982c4", "#8ac926", "#ff595e", "#ffca3a",
];

function communityColor(id: number): string {
  return COMMUNITY_COLORS[id % COMMUNITY_COLORS.length];
}

// ── Persistent node-name labels ──────────────────────────────────────────────
//
// The hover tooltip (`.nodeLabel`) already shows each node's title when you
// mouse over it. "Always show names" renders that same title as a floating
// text sprite hovering above the node, so it stays visible without hovering.
// Built on a canvas texture rather than pulling in a label-sprite dependency,
// since `three` is already available.

export function makeNodeLabelSprite(text: string, color: string): THREE.Sprite {
  const fontSize = 28;
  const font = `${fontSize}px sans-serif`;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  const textWidth = ctx.measureText(text).width;
  const padding = 8;
  canvas.width = Math.ceil(textWidth + padding * 2);
  canvas.height = Math.ceil(fontSize * 1.4);

  // Re-apply font after resizing (canvas resize clears context state)
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  // Scale so the sprite reads at a consistent on-screen size relative to nodes
  const scale = canvas.height / 90;
  sprite.scale.set((canvas.width / canvas.height) * scale * 4, scale * 4, 1);
  return sprite;
}

// ── Knob helpers ─────────────────────────────────────────────────────────────

function Knob({
  label, value, min, max, step, format, onChange,
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
  } catch { /* storage unavailable — ignore */ }
}

// ── Main component ───────────────────────────────────────────────────────────

export function GraphView({ onNavigate }: { onNavigate: (slug: string) => void }) {
  const [rawData, setRawData] = useState<GraphData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [filterMode, setFilterMode] = useState<FilterMode>(() => loadPrefs().filterMode ?? "top");
  const [topN, setTopN] = useState(() => loadPrefs().topN ?? 60);
  const [neighborMode, setNeighborMode] = useState<NeighborhoodMode>(() => loadPrefs().neighborMode ?? "both");
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestHasMore, setSuggestHasMore] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const suggestOffsetRef = useRef(0);
  const suggestQueryRef = useRef("");
  const [seeds, setSeeds] = useState<Seed[]>([]);
  const [showHalu, setShowHalu] = useState(() => loadPrefs().showHalu ?? false);
  const [metric, setMetric] = useState<Metric>(() => loadPrefs().metric ?? "pagerank");
  const [colorMode, setColorMode] = useState<ColorMode>(() => loadPrefs().colorMode ?? "community");
  const [largestComponentOnly, setLargestComponentOnly] = useState(() => loadPrefs().largestComponentOnly ?? false);
  const [initialized, setInitialized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<RenderSettings>(() => ({ ...DEFAULT_SETTINGS, ...loadPrefs().settings }));
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const seedsRef = useRef(seeds);
  const colorModeRef = useRef(colorMode);
  const pathEdgeSetRef = useRef(new Set<string>());

  const set = useCallback(<K extends keyof RenderSettings>(key: K, value: RenderSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
  }, []);

  // Keep refs current so accessors always read fresh values without triggering re-renders
  useEffect(() => { seedsRef.current = seeds; }, [seeds]);
  useEffect(() => { colorModeRef.current = colorMode; }, [colorMode]);

  // Persist preferences whenever any user-controlled value changes (seeds are transient, not saved)
  useEffect(() => {
    savePrefs({ settings, showHalu, topN, filterMode, neighborMode, metric, colorMode, largestComponentOnly });
  }, [settings, showHalu, topN, filterMode, neighborMode, metric, colorMode, largestComponentOnly]);

  // ── Graphology: build directed graph + stats ────────────────────────────────

  type NodeStat = { score: number; scoreNorm: number; community: number; componentId: number };
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
      if (!g.hasNode(n.slug)) g.addNode(n.slug, { title: n.title, exists: n.exists });
    }
    for (const l of rawData.links) {
      if (g.hasNode(l.source) && g.hasNode(l.target) && !g.hasEdge(l.source, l.target)) {
        g.addEdge(l.source, l.target);
      }
    }

    const rawScores = computeMetric(g, metric, seeds);
    const scoreValues = Object.values(rawScores);
    const maxScore = scoreValues.length > 0 ? Math.max(...scoreValues) : 1;
    const safeMax = maxScore > 0 ? maxScore : 1;

    let communities: Record<string, number> = {};
    try { communities = louvain(g); } catch { /* needs edges */ }

    const nodeComponentId = new Map<string, number>();
    let componentCount = 0;
    try {
      const comps = connectedComponents(g);
      componentCount = comps.length;
      comps.forEach((comp, idx) => comp.forEach(n => nodeComponentId.set(n, idx)));
    } catch { /* ignore */ }

    let graphDensity = 0;
    try { graphDensity = density(g); } catch { /* ignore */ }

    const stats = new Map<string, NodeStat>();
    for (const slug of g.nodes()) {
      const score = rawScores[slug] ?? 0;
      stats.set(slug, {
        score,
        scoreNorm: score / safeMax,
        community: communities[slug] ?? 0,
        componentId: nodeComponentId.get(slug) ?? 0,
      });
    }

    return { gInstance: g, nodeStats: stats, graphStats: { density: graphDensity, componentCount } };
  }, [rawData, metric, seeds]);

  // ── Shortest paths between all seed pairs ────────────────────────────────────

  const pathEdgeSet = useMemo(() => {
    if (!gInstance || seeds.length < 2) return new Set<string>();
    const edgeSet = new Set<string>();
    for (let i = 0; i < seeds.length; i++) {
      for (let j = i + 1; j < seeds.length; j++) {
        if (!gInstance.hasNode(seeds[i].slug) || !gInstance.hasNode(seeds[j].slug)) continue;
        try {
          const path = unweightedPath(gInstance, seeds[i].slug, seeds[j].slug);
          if (!path) continue;
          for (let k = 0; k < path.length - 1; k++) edgeSet.add(`${path[k]}>${path[k + 1]}`);
        } catch { /* unreachable pair */ }
      }
    }
    return edgeSet;
  }, [gInstance, seeds]);

  // ── Filtered subgraph for the renderer ─────────────────────────────────────

  const fgData = useMemo(() => {
    if (!gInstance) return { nodes: [] as FgNode[], links: [] as { source: string; target: string }[] };

    let slugSet: Set<string>;

    if (filterMode === "top") {
      const sorted = [...gInstance.nodes()]
        .sort((a, b) => (nodeStats.get(b)?.score ?? 0) - (nodeStats.get(a)?.score ?? 0))
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
          .sort((a, b) => (nodeStats.get(b)?.score ?? 0) - (nodeStats.get(a)?.score ?? 0))
          .slice(0, 20)
          .forEach((s) => slugSet.add(s));
      }
    }

    if (largestComponentOnly) {
      try {
        const largest = new Set(largestConnectedComponent(gInstance));
        slugSet = new Set([...slugSet].filter(s => largest.has(s)));
      } catch { /* ignore */ }
    }

    const allNodes: FgNode[] = [...slugSet].map((slug) => ({
      id: slug,
      title: (gInstance.getNodeAttribute(slug, "title") as string) || slug,
      exists: (gInstance.getNodeAttribute(slug, "exists") as boolean) ?? false,
      score: nodeStats.get(slug)?.score ?? 0,
      scoreNorm: nodeStats.get(slug)?.scoreNorm ?? 0,
      community: nodeStats.get(slug)?.community ?? 0,
      componentId: nodeStats.get(slug)?.componentId ?? 0,
      inDegree: gInstance.inDegree(slug),
      outDegree: gInstance.outDegree(slug),
      visibleInDegree: 0,
      visibleOutDegree: 0,
    }));

    const haluCount = allNodes.filter((n) => !n.exists).length;
    const nodes = showHalu ? allNodes : allNodes.filter((n) => n.exists);
    const visibleIds = new Set(nodes.map((n) => n.id));

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
  }, [gInstance, nodeStats, filterMode, topN, seeds, neighborMode, showHalu, largestComponentOnly]);

  // ── Data fetching ───────────────────────────────────────────────────────────

  useEffect(() => {
    fetch("/api/graph")
      .then((r) => r.json())
      .then((d) => setRawData(d as GraphData))
      .catch(() => setLoadError(true));
  }, []);

  // Debounced article search — resets on query change
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSuggestions([]);
      setSuggestHasMore(false);
      suggestOffsetRef.current = 0;
      suggestQueryRef.current = "";
      return;
    }
    suggestQueryRef.current = searchQuery;
    suggestOffsetRef.current = 0;
    setSuggestions([]);
    setSuggestHasMore(false);

    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d: any = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&offset=0`, { signal: ctrl.signal }).then((r) => r.json());
        if (ctrl.signal.aborted) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hits = (d.results ?? []).filter((r: any) => r.exists);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setSuggestions(hits.map((r: any) => ({ slug: r.slug, title: r.title })));
        setSuggestHasMore(d.has_more ?? false);
        suggestOffsetRef.current = hits.length;
      } catch { /* aborted or network error */ }
    }, 180);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [searchQuery]);

  const loadMoreSuggestions = useCallback(async () => {
    if (suggestLoading || !suggestHasMore || !suggestQueryRef.current.trim()) return;
    setSuggestLoading(true);
    const q = suggestQueryRef.current;
    const offset = suggestOffsetRef.current;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d: any = await fetch(`/api/search?q=${encodeURIComponent(q)}&offset=${offset}`).then((r) => r.json());
      if (suggestQueryRef.current !== q) return; // query changed while loading
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hits = (d.results ?? []).filter((r: any) => r.exists);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setSuggestions((prev) => [...prev, ...hits.map((r: any) => ({ slug: r.slug, title: r.title }))]);
      setSuggestHasMore(d.has_more ?? false);
      suggestOffsetRef.current = offset + hits.length;
    } catch { /* network error */ }
    setSuggestLoading(false);
  }, [suggestLoading, suggestHasMore]);

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

      fg
        .nodeId("id")
        .nodeLabel((n: FgNode) => `${n.title}\n↑ ${n.visibleInDegree} in  ↓ ${n.visibleOutDegree} out`)
        .nodeVal((n: FgNode) => Math.max(1, n.inDegree * 0.5 + n.scoreNorm * 6))
        .onNodeClick((n: FgNode) => {
          if (n.exists) onNavigate(toWikiSegment(n.title));
        });

      setInitialized(true);
    });

    return () => {
      destroyed = true;
      if (fgRef.current) {
        try { fgRef.current._destructor?.(); } catch { /* ignore */ }
        fgRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Push graph data whenever it changes ────────────────────────────────────

  useEffect(() => {
    if (!fgRef.current || !initialized || fgData.nodes.length === 0) return;
    fgRef.current.graphData({
      nodes: fgData.nodes.map((n) => ({ ...n })),
      links: fgData.links.map((l) => ({ ...l })),
    });
  }, [fgData, initialized]);

  // ── Apply render settings imperatively ─────────────────────────────────────

  useEffect(() => {
    if (!fgRef.current || !initialized) return;
    const fg = fgRef.current;

    fg
      .nodeResolution(settings.nodeResolution)
      .nodeRelSize(settings.nodeRelSize)
      .nodeOpacity(settings.nodeOpacity)
      .linkOpacity(settings.linkOpacity)
      .linkWidth(settings.linkWidth)
      .linkDirectionalArrowLength(settings.arrowLength)
      .linkCurvature(settings.linkCurvature)
      .linkDirectionalParticles(settings.particles)
      .linkDirectionalParticleSpeed(settings.particleSpeed)
      .linkDirectionalParticleWidth(settings.particleWidth)
      .linkDirectionalParticleColor((l: { source: FgNode | string; target: FgNode | string }) => {
        if (!settings.directionalParticles) return "#ffffff";
        const src = typeof l.source === "object" ? l.source.id : l.source;
        const tgt = typeof l.target === "object" ? l.target.id : l.target;
        const currentSeeds = seedsRef.current;
        // Seed-relative: into a seed = green, out of a seed = red
        if (currentSeeds.some((s) => s.slug === tgt)) return "#3ddc84";
        if (currentSeeds.some((s) => s.slug === src)) return "#ff4d4d";
        // No seed match: particle is traveling in the forward direction = green ("in")
        return "#3ddc84";
      })
      .backgroundColor(settings.bgColor)
      .d3AlphaDecay(settings.alphaDecay)
      .d3VelocityDecay(settings.velocityDecay);

    // "Always show names": render the same title shown on hover as a
    // permanent floating sprite above each node, instead of only in the
    // hover tooltip. nodeThreeObjectExtend keeps the default sphere and adds
    // the label sprite alongside it.
    if (settings.alwaysShowLabels) {
      fg
        .nodeThreeObjectExtend(true)
        .nodeThreeObject((n: FgNode) => {
          const color = n.exists
            ? (colorModeRef.current === "component" ? communityColor(n.componentId) : communityColor(n.community))
            : "#999999";
          const sprite = makeNodeLabelSprite(n.title, color);
          const nodeRadius = Math.cbrt(Math.max(1, n.inDegree * 0.5 + n.scoreNorm * 6)) * settings.nodeRelSize;
          sprite.position.set(0, nodeRadius + sprite.scale.y / 2 + 1, 0);
          return sprite;
        });
    } else {
      fg.nodeThreeObjectExtend(false).nodeThreeObject(null);
    }

    const charge = fg.d3Force("charge");
    if (charge) charge.strength(settings.chargeStrength);

    const link = fg.d3Force("link");
    if (link) link.distance(settings.linkDistance);

    fg.d3ReheatSimulation();
  }, [settings, initialized]);

  // ── Node colour + path highlighting (no physics re-heat) ─────────────────────

  useEffect(() => {
    pathEdgeSetRef.current = pathEdgeSet;
    if (!fgRef.current || !initialized) return;
    fgRef.current
      .nodeColor((n: FgNode) => {
        if (!n.exists) return "#555566";
        return colorModeRef.current === "component"
          ? communityColor(n.componentId)
          : communityColor(n.community);
      })
      .linkColor((l: { source: FgNode | string; target: FgNode | string }) => {
        const src = typeof l.source === "object" ? l.source.id : l.source;
        const tgt = typeof l.target === "object" ? l.target.id : l.target;
        return pathEdgeSetRef.current.has(`${src}>${tgt}`) ? "#ffd700" : "#ffffff";
      })
      .refresh();
  }, [colorMode, pathEdgeSet, initialized]);

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
    setSeeds((prev) => prev.some((x) => x.slug === s.slug) ? prev : [...prev, { slug: s.slug, title: s.title }]);
    setSearchQuery("");
    setSuggestions([]);
    setSuggestOpen(false);
    setFilterMode("search");
  }, []);

  const removeSeed = useCallback((slug: string) => {
    setSeeds((prev) => prev.filter((s) => s.slug !== slug));
  }, []);

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
          <button className={filterMode === "top" ? "active" : ""} onClick={() => setFilterMode("top")}>
            Top articles
          </button>
          <button className={filterMode === "search" ? "active" : ""} onClick={() => setFilterMode("search")}>
            Find article
          </button>
        </div>

        <select
          className="graph-metric-select"
          value={metric}
          onChange={(e) => setMetric(e.target.value as Metric)}
          title="Node size and Top-N ranking metric"
        >
          {METRICS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}{m.needsSeeds ? " *" : ""}</option>
          ))}
        </select>

        <select
          className="graph-metric-select"
          value={colorMode}
          onChange={(e) => setColorMode(e.target.value as ColorMode)}
          title="Node color mode"
        >
          <option value="community">Community</option>
          <option value="component">Component</option>
        </select>

        {filterMode === "top" && (
          <div className="graph-top-control">
            <label>Top <strong>{topN}</strong> by {METRICS.find((m) => m.value === metric)?.label}</label>
            <input type="range" min={10}
              max={Math.max(10, rawData?.nodes.filter((n) => n.exists).length ?? 10)}
              step={10} value={topN}
              onChange={(e) => setTopN(Number(e.target.value))} />
          </div>
        )}

        {filterMode === "search" && (
          <div className="graph-search-control">
            {seeds.length > 0 && (
              <div className="graph-seeds">
                {seeds.map((s) => (
                  <span key={s.slug} className="graph-seed-chip">
                    {s.title}
                    <button type="button" aria-label={`Remove ${s.title}`} onClick={() => removeSeed(s.slug)}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="graph-search-wrap">
              <input type="text" className="graph-search-input"
                placeholder="Search articles to seed graph..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setSuggestOpen(true)}
                onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
              />
              {suggestOpen && suggestions.length > 0 && (
                <ul
                  className="graph-suggest"
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) {
                      loadMoreSuggestions();
                    }
                  }}
                >
                  {suggestions.map((s) => (
                    <li key={s.slug}>
                      <button type="button" onMouseDown={() => addSeed(s)}>{s.title}</button>
                    </li>
                  ))}
                  {suggestHasMore && (
                    <li className="graph-suggest-more">
                      {suggestLoading ? "Loading…" : "Scroll for more"}
                    </li>
                  )}
                </ul>
              )}
            </div>
            <div className="graph-neighbor-tabs">
              {(["refs", "backlinks", "both"] as NeighborhoodMode[]).map((m) => (
                <button key={m} className={neighborMode === m ? "active" : ""} onClick={() => setNeighborMode(m)}>
                  {m === "refs" ? "Refs" : m === "backlinks" ? "Backlinks" : "Both"}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="graph-stats">
          {loadError && <span className="graph-error-inline">Failed to load graph data.</span>}
          {!loadError && gInstance && (
            <span>
              {nodeCount} nodes
              {!showHalu && haluCount > 0 && <span className="graph-halu-hidden"> ({haluCount} halu hidden)</span>}
              {" · "}{edgeCount} edges · {totalArticles} total
              {" · "}{graphStats.componentCount} components
              {" · "}density {graphStats.density < 0.001 ? graphStats.density.toExponential(1) : graphStats.density.toFixed(4)}
              {pathEdgeSet.size > 0 && <span className="graph-path-info"> · {pathEdgeSet.size} path edges</span>}
            </span>
          )}
          {!loadError && !gInstance && <span>Loading graph…</span>}
        </div>

        <button
          type="button"
          className={`graph-settings-btn${largestComponentOnly ? " active" : ""}`}
          onClick={() => setLargestComponentOnly((v) => !v)}
        >
          {largestComponentOnly ? "All components" : "Largest only"}
        </button>

        <button
          type="button"
          className={`graph-settings-btn${showHalu ? " active" : ""}`}
          onClick={() => setShowHalu((v) => !v)}
        >
          {showHalu ? "Hide halu" : "Show halu"}
        </button>

        <button
          type="button"
          className={`graph-settings-btn${settingsOpen ? " active" : ""}`}
          onClick={() => setSettingsOpen((o) => !o)}
        >
          ⚙ Render
        </button>
      </div>

      {/* ── Body: canvas + settings side panel ── */}
      <div className="graph-body">
        <div className="graph-canvas" ref={containerRef} />

        {settingsOpen && (
          <div className="grs-panel">

            <div className="grs-section">
              <div className="grs-section-label">Nodes</div>
              <Knob label="Resolution" value={settings.nodeResolution} min={4} max={32} step={2}
                onChange={(v) => set("nodeResolution", v)} />
              <Knob label="Base size" value={settings.nodeRelSize} min={1} max={12} step={0.5}
                format={(v) => v.toFixed(1)} onChange={(v) => set("nodeRelSize", v)} />
              <Knob label="Opacity" value={settings.nodeOpacity} min={0.1} max={1} step={0.05}
                format={(v) => v.toFixed(2)} onChange={(v) => set("nodeOpacity", v)} />
              <label className="grs-toggle">
                <input
                  type="checkbox"
                  checked={settings.alwaysShowLabels}
                  onChange={(e) => set("alwaysShowLabels", e.target.checked)}
                />
                <span>Always show names</span>
                <span className="grs-toggle-hint">show node labels above all nodes, not just on hover</span>
              </label>
            </div>

            <div className="grs-section">
              <div className="grs-section-label">Links</div>
              <Knob label="Opacity" value={settings.linkOpacity} min={0.01} max={0.6} step={0.01}
                format={(v) => v.toFixed(2)} onChange={(v) => set("linkOpacity", v)} />
              <Knob label="Width" value={settings.linkWidth} min={0.1} max={4} step={0.1}
                format={(v) => v.toFixed(1)} onChange={(v) => set("linkWidth", v)} />
              <Knob label="Arrow size" value={settings.arrowLength} min={0} max={10} step={0.5}
                format={(v) => v.toFixed(1)} onChange={(v) => set("arrowLength", v)} />
              <Knob label="Curvature" value={settings.linkCurvature} min={0} max={0.8} step={0.05}
                format={(v) => v.toFixed(2)} onChange={(v) => set("linkCurvature", v)} />
              <Knob label="Particles" value={settings.particles} min={0} max={8} step={1}
                onChange={(v) => set("particles", v)} />
              <Knob label="Particle speed" value={settings.particleSpeed} min={0.001} max={0.02} step={0.001}
                format={(v) => v.toFixed(3)} onChange={(v) => set("particleSpeed", v)} />
              <Knob label="Particle size" value={settings.particleWidth} min={0.5} max={6} step={0.5}
                format={(v) => v.toFixed(1)} onChange={(v) => set("particleWidth", v)} />
              <label className="grs-toggle">
                <input
                  type="checkbox"
                  checked={settings.directionalParticles}
                  onChange={(e) => set("directionalParticles", e.target.checked)}
                />
                <span>Color by direction</span>
                <span className="grs-toggle-hint">green=in red=out (needs seeds + particles)</span>
              </label>
            </div>

            <div className="grs-section">
              <div className="grs-section-label">Physics</div>
              <Knob label="Repulsion" value={settings.chargeStrength} min={-1200} max={-20} step={20}
                onChange={(v) => set("chargeStrength", v)} />
              <Knob label="Link distance" value={settings.linkDistance} min={5} max={400} step={5}
                onChange={(v) => set("linkDistance", v)} />
              <Knob label="Alpha decay" value={settings.alphaDecay} min={0.001} max={0.06} step={0.001}
                format={(v) => v.toFixed(3)} onChange={(v) => set("alphaDecay", v)} />
              <Knob label="Velocity decay" value={settings.velocityDecay} min={0.1} max={0.99} step={0.01}
                format={(v) => v.toFixed(2)} onChange={(v) => set("velocityDecay", v)} />
            </div>

            <div className="grs-section">
              <div className="grs-section-label">Background</div>
              <div className="grs-bg-presets">
                {BG_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    className={`grs-bg-swatch${settings.bgColor === p.value ? " active" : ""}`}
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
