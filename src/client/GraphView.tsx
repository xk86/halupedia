import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Graph from "graphology";
import pagerank from "graphology-pagerank";
import louvain from "graphology-communities-louvain";
import { toWikiSegment } from "./wikiPath";

interface RawNode { slug: string; title: string; exists: boolean; }
interface RawLink { source: string; target: string; }
interface GraphData { nodes: RawNode[]; links: RawLink[]; }

interface FgNode {
  id: string;
  title: string;
  exists: boolean;
  pagerank: number;
  community: number;
  inDegree: number;
  outDegree: number;
  visibleInDegree: number;
  visibleOutDegree: number;
}

type FilterMode = "top" | "search";
type NeighborhoodMode = "refs" | "backlinks" | "both";

interface Suggestion { slug: string; title: string; }
interface Seed { slug: string; title: string; }

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
  labelThreshold: number;   // inDegree >= this shows a persistent label: 0–20
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
  labelThreshold: 999, // off by default
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
  const [seeds, setSeeds] = useState<Seed[]>([]);
  const [showHalu, setShowHalu] = useState(() => loadPrefs().showHalu ?? false);
  const [initialized, setInitialized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<RenderSettings>(() => ({ ...DEFAULT_SETTINGS, ...loadPrefs().settings }));
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);

  const set = useCallback(<K extends keyof RenderSettings>(key: K, value: RenderSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
  }, []);

  // Persist preferences whenever any user-controlled value changes (seeds are transient, not saved)
  useEffect(() => {
    savePrefs({ settings, showHalu, topN, filterMode, neighborMode });
  }, [settings, showHalu, topN, filterMode, neighborMode]);

  // ── Graphology: build directed graph + stats ────────────────────────────────

  const { gInstance, nodeStats } = useMemo(() => {
    if (!rawData) return { gInstance: null, nodeStats: new Map<string, { pr: number; community: number }>() };

    const g = new Graph({ type: "directed", multi: false });
    for (const n of rawData.nodes) {
      if (!g.hasNode(n.slug)) g.addNode(n.slug, { title: n.title, exists: n.exists });
    }
    for (const l of rawData.links) {
      if (g.hasNode(l.source) && g.hasNode(l.target) && !g.hasEdge(l.source, l.target)) {
        g.addEdge(l.source, l.target);
      }
    }

    const pr = pagerank(g);
    let communities: Record<string, number> = {};
    try { communities = louvain(g); } catch { /* needs edges */ }

    const stats = new Map<string, { pr: number; community: number }>();
    for (const slug of g.nodes()) {
      stats.set(slug, { pr: pr[slug] ?? 0, community: communities[slug] ?? 0 });
    }

    return { gInstance: g, nodeStats: stats };
  }, [rawData]);

  // ── Filtered subgraph for the renderer ─────────────────────────────────────

  const fgData = useMemo(() => {
    if (!gInstance) return { nodes: [] as FgNode[], links: [] as { source: string; target: string }[] };

    let slugSet: Set<string>;

    if (filterMode === "top") {
      const sorted = [...gInstance.nodes()]
        .sort((a, b) => (nodeStats.get(b)?.pr ?? 0) - (nodeStats.get(a)?.pr ?? 0))
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
          .sort((a, b) => (nodeStats.get(b)?.pr ?? 0) - (nodeStats.get(a)?.pr ?? 0))
          .slice(0, 20)
          .forEach((s) => slugSet.add(s));
      }
    }

    const allNodes: FgNode[] = [...slugSet].map((slug) => ({
      id: slug,
      title: (gInstance.getNodeAttribute(slug, "title") as string) || slug,
      exists: (gInstance.getNodeAttribute(slug, "exists") as boolean) ?? false,
      pagerank: nodeStats.get(slug)?.pr ?? 0,
      community: nodeStats.get(slug)?.community ?? 0,
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
  }, [gInstance, nodeStats, filterMode, topN, seeds, neighborMode, showHalu]);

  // ── Data fetching ───────────────────────────────────────────────────────────

  useEffect(() => {
    fetch("/api/graph")
      .then((r) => r.json())
      .then((d) => setRawData(d as GraphData))
      .catch(() => setLoadError(true));
  }, []);

  // Debounced article search
  useEffect(() => {
    if (!searchQuery.trim()) { setSuggestions([]); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`, { signal: ctrl.signal })
        .then((r) => r.json())
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((d: any) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hits = (d.results ?? []).filter((r: any) => r.exists).slice(0, 7);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setSuggestions(hits.map((r: any) => ({ slug: r.slug, title: r.title })));
        })
        .catch(() => { });
    }, 180);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [searchQuery]);

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
        .nodeColor((n: FgNode) => n.exists ? communityColor(n.community) : "#555566")
        .nodeVal((n: FgNode) => Math.max(1, n.inDegree * 0.5 + n.pagerank * 4000))
        .linkColor(() => "#ffffff")
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
      .backgroundColor(settings.bgColor)
      .d3AlphaDecay(settings.alphaDecay)
      .d3VelocityDecay(settings.velocityDecay);

    const charge = fg.d3Force("charge");
    if (charge) charge.strength(settings.chargeStrength);

    const link = fg.d3Force("link");
    if (link) link.distance(settings.linkDistance);

    fg.d3ReheatSimulation();
  }, [settings, initialized]);

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

        {filterMode === "top" && (
          <div className="graph-top-control">
            <label>Top <strong>{topN}</strong> by PageRank</label>
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
                <ul className="graph-suggest">
                  {suggestions.map((s) => (
                    <li key={s.slug}>
                      <button type="button" onMouseDown={() => addSeed(s)}>{s.title}</button>
                    </li>
                  ))}
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
            </span>
          )}
          {!loadError && !gInstance && <span>Loading graph…</span>}
        </div>

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

      {/* ── Render settings panel ── */}
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

      <div className="graph-canvas" ref={containerRef} />
    </div>
  );
}
