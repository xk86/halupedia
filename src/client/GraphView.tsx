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
}

type FilterMode = "top" | "search";
type NeighborhoodMode = "refs" | "backlinks" | "both";

interface Suggestion { slug: string; title: string; }
interface Seed { slug: string; title: string; }

const COMMUNITY_COLORS = [
  "#e63946", "#457b9d", "#2a9d8f", "#e9c46a", "#f4a261",
  "#8338ec", "#06d6a0", "#ef476f", "#118ab2", "#ffd166",
  "#6a4c93", "#1982c4", "#8ac926", "#ff595e", "#ffca3a",
];

function communityColor(id: number): string {
  return COMMUNITY_COLORS[id % COMMUNITY_COLORS.length];
}

export function GraphView({ onNavigate }: { onNavigate: (slug: string) => void }) {
  const [rawData, setRawData] = useState<GraphData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [filterMode, setFilterMode] = useState<FilterMode>("top");
  const [topN, setTopN] = useState(60);
  const [neighborMode, setNeighborMode] = useState<NeighborhoodMode>("both");
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [seeds, setSeeds] = useState<Seed[]>([]);
  const [initialized, setInitialized] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);

  // Build graphology graph + compute stats once raw data arrives
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
    try { communities = louvain(g); } catch { /* undirected required, skip */ }

    const stats = new Map<string, { pr: number; community: number }>();
    for (const slug of g.nodes()) {
      stats.set(slug, { pr: pr[slug] ?? 0, community: communities[slug] ?? 0 });
    }

    return { gInstance: g, nodeStats: stats };
  }, [rawData]);

  // Build filtered node/link list for the renderer
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

    const nodes: FgNode[] = [...slugSet].map((slug) => ({
      id: slug,
      title: gInstance.getNodeAttribute(slug, "title") as string || slug,
      exists: gInstance.getNodeAttribute(slug, "exists") as boolean ?? false,
      pagerank: nodeStats.get(slug)?.pr ?? 0,
      community: nodeStats.get(slug)?.community ?? 0,
      inDegree: gInstance.inDegree(slug),
      outDegree: gInstance.outDegree(slug),
    }));

    const links: { source: string; target: string }[] = [];
    for (const edge of gInstance.edges()) {
      const [src, tgt] = gInstance.extremities(edge);
      if (slugSet.has(src) && slugSet.has(tgt)) {
        links.push({ source: src, target: tgt });
      }
    }

    return { nodes, links };
  }, [gInstance, nodeStats, filterMode, topN, seeds, neighborMode]);

  // Fetch raw graph data on mount
  useEffect(() => {
    fetch("/api/graph")
      .then((r) => r.json())
      .then((d) => setRawData(d as GraphData))
      .catch(() => setLoadError(true));
  }, []);

  // Debounced article search for seed suggestions
  useEffect(() => {
    if (!searchQuery.trim()) { setSuggestions([]); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d: any) => {
          const hits = (d.results ?? []).filter((r: any) => r.exists).slice(0, 7);
          setSuggestions(hits.map((r: any) => ({ slug: r.slug, title: r.title })));
        })
        .catch(() => {});
    }, 180);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [searchQuery]);

  // Initialize 3d-force-graph instance once (async import)
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
        .nodeLabel((n: FgNode) => `${n.title}\n↑ ${n.inDegree} in  ↓ ${n.outDegree} out`)
        .nodeColor((n: FgNode) => n.exists ? communityColor(n.community) : "#555566")
        .nodeVal((n: FgNode) => Math.max(1, n.inDegree * 0.5 + n.pagerank * 4000))
        .linkColor(() => "rgba(255,255,255,0.1)")
        .linkWidth(0.4)
        .linkDirectionalArrowLength(2.5)
        .linkDirectionalArrowRelPos(1)
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

  // Push updated data into the live graph whenever fgData or init state changes
  useEffect(() => {
    if (!fgRef.current || !initialized || fgData.nodes.length === 0) return;
    fgRef.current.graphData({
      nodes: fgData.nodes.map((n) => ({ ...n })),
      links: fgData.links.map((l) => ({ ...l })),
    });
  }, [fgData, initialized]);

  // Keep canvas sized to container
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

  return (
    <div className="graph-view">
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

        {filterMode === "top" && (
          <div className="graph-top-control">
            <label>
              Top <strong>{topN}</strong> by PageRank
            </label>
            <input
              type="range"
              min={10}
              max={200}
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
            <div className="graph-search-wrap">
              <input
                type="text"
                className="graph-search-input"
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
                      <button type="button" onMouseDown={() => addSeed(s)}>
                        {s.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="graph-neighbor-tabs">
              {(["refs", "backlinks", "both"] as NeighborhoodMode[]).map((m) => (
                <button
                  key={m}
                  className={neighborMode === m ? "active" : ""}
                  onClick={() => setNeighborMode(m)}
                >
                  {m === "refs" ? "Refs" : m === "backlinks" ? "Backlinks" : "Both"}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="graph-stats">
          {loadError && <span className="graph-error-inline">Failed to load graph data.</span>}
          {!loadError && gInstance && (
            <span>{nodeCount} nodes · {edgeCount} edges · {gInstance.order} total articles</span>
          )}
          {!loadError && !gInstance && <span>Loading graph…</span>}
        </div>
      </div>

      <div className="graph-canvas" ref={containerRef} />
    </div>
  );
}
