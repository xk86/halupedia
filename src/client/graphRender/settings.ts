// Unified render settings shared by the ontology (SemanticAtlas) and the
// link-graph view. Both surfaces render the same 3D force graph and the same
// 2D tree, so they share one settings blob and one settings panel.
//
// This is a superset of the legacy `RenderSettings` (link graph) and
// `OntologyRenderSettings` (ontology) — historical field names are preserved
// (`nodeRelSize` rather than `nodeScale`, `labelSize` rather than `labelScale`)
// to match `ForceGraphDrawSettings`.
import { DEFAULT_FORCE_GRAPH_DRAW_SETTINGS } from "../forceGraph3d";

export type LabelDegreeMode = "in" | "out" | "both";
export type LinkColorMode = "neutral" | "gradient";

export interface GraphRenderSettings {
  // ── Nodes ────────────────────────────────────────────────────────────────
  nodeResolution: number;
  nodeRelSize: number;
  nodeOpacity: number;
  showLabels: boolean;
  labelSize: number;
  dynamicLabelSize: boolean;
  labelSizeInfluence: number;
  labelDegreeMode: LabelDegreeMode;
  // ── Links ────────────────────────────────────────────────────────────────
  linkOpacity: number;
  linkWidth: number;
  arrowLength: number;
  linkCurvature: number;
  showLinkLabels: boolean;
  linkLabelSize: number;
  linkColorMode: LinkColorMode;
  linkColorIntensity: number;
  particles: number;
  particleSpeed: number;
  particleWidth: number;
  directionalParticles: boolean;
  // ── Physics ──────────────────────────────────────────────────────────────
  chargeStrength: number;
  linkDistance: number;
  alphaDecay: number;
  velocityDecay: number;
  // ── Path trace (link graph) ──────────────────────────────────────────────
  maxPaths: number;
  particleGlow: boolean;
  traceSpeed: number;
  traceAccel: number;
  traceLoopDelay: number;
  traceLightness: number;
  traceChroma: number;
  traceStartHue: number;
  traceEndHue: number;
  traceHueSpread: number;
  pathLinkBrightness: number;
  // ── Appearance ───────────────────────────────────────────────────────────
  bgColor: string;
  shadedOpacity: number;
  // ── 2D tree ──────────────────────────────────────────────────────────────
  treeSpread: number;
}

export const BG_PRESETS: { label: string; value: string }[] = [
  { label: "Void", value: "#080810" },
  { label: "Space", value: "#020408" },
  { label: "Slate", value: "#0d1117" },
  { label: "Paper", value: "#1a1a2e" },
];

export const DEFAULT_GRAPH_RENDER_SETTINGS: GraphRenderSettings = {
  ...DEFAULT_FORCE_GRAPH_DRAW_SETTINGS,
  showLabels: DEFAULT_FORCE_GRAPH_DRAW_SETTINGS.dynamicLabelSize
    ? true
    : true,
  showLinkLabels: false,
  linkLabelSize: 0.9,
  linkColorMode: "neutral",
  linkColorIntensity: 0.6,
  particles: 0,
  particleSpeed: 0.005,
  particleWidth: 2,
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
  shadedOpacity: 0.1,
  treeSpread: 1,
};

const GRAPH_RENDER_STORAGE_KEY = "halupedia:graph-render:v1";
// Legacy keys we migrate from once so previously-tuned values carry over.
const LEGACY_ONTOLOGY_KEY = "halupedia:ontology-render:v1";
const LEGACY_GRAPH_PREFS_KEY = "halupedia-graph-prefs";

function readJson(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Load persisted settings, falling back to the two legacy keys (ontology pane
 * and link-graph prefs) so users don't lose their tuning after this migration.
 * Legacy field names (`nodeScale`, `labelScale`, `alwaysShowLabels`) get
 * rehomed onto the unified fields.
 */
export function loadGraphRenderSettings(): GraphRenderSettings {
  const current = readJson(GRAPH_RENDER_STORAGE_KEY);
  if (current) {
    return { ...DEFAULT_GRAPH_RENDER_SETTINGS, ...current } as GraphRenderSettings;
  }
  const migrated: Partial<GraphRenderSettings> = {};
  const ontology = readJson(LEGACY_ONTOLOGY_KEY);
  if (ontology) {
    // `nodeScale` was a multiplier on top of the base rel-size; approximate.
    if (typeof ontology.nodeScale === "number") {
      migrated.nodeRelSize =
        DEFAULT_FORCE_GRAPH_DRAW_SETTINGS.nodeRelSize *
        (ontology.nodeScale as number);
    }
    if (typeof ontology.labelScale === "number") {
      migrated.labelSize = ontology.labelScale as number;
    }
    for (const key of [
      "nodeOpacity",
      "showLabels",
      "linkOpacity",
      "linkWidth",
      "arrowLength",
      "chargeStrength",
      "linkDistance",
      "treeSpread",
    ] as const) {
      if (key in ontology) {
        (migrated as Record<string, unknown>)[key] = ontology[key];
      }
    }
  }
  const legacy = readJson(LEGACY_GRAPH_PREFS_KEY);
  const legacyRender =
    legacy && typeof legacy.settings === "object" && legacy.settings !== null
      ? (legacy.settings as Record<string, unknown>)
      : null;
  if (legacyRender) {
    // `alwaysShowLabels` was the old boolean; unify onto `showLabels`.
    if ("alwaysShowLabels" in legacyRender) {
      migrated.showLabels = Boolean(legacyRender.alwaysShowLabels);
    }
    for (const key of [
      "nodeResolution",
      "nodeRelSize",
      "nodeOpacity",
      "labelSize",
      "dynamicLabelSize",
      "labelSizeInfluence",
      "labelDegreeMode",
      "linkOpacity",
      "linkWidth",
      "arrowLength",
      "linkCurvature",
      "particles",
      "particleSpeed",
      "particleWidth",
      "directionalParticles",
      "chargeStrength",
      "linkDistance",
      "alphaDecay",
      "velocityDecay",
      "maxPaths",
      "particleGlow",
      "traceSpeed",
      "traceAccel",
      "traceLoopDelay",
      "traceLightness",
      "traceChroma",
      "traceStartHue",
      "traceEndHue",
      "traceHueSpread",
      "pathLinkBrightness",
      "bgColor",
      "shadedOpacity",
    ] as const) {
      if (key in legacyRender) {
        (migrated as Record<string, unknown>)[key] = legacyRender[key];
      }
    }
  }
  return { ...DEFAULT_GRAPH_RENDER_SETTINGS, ...migrated };
}

export function saveGraphRenderSettings(settings: GraphRenderSettings): void {
  try {
    localStorage.setItem(GRAPH_RENDER_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage optional */
  }
}
