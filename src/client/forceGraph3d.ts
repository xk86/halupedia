import { DragControls } from "three/examples/jsm/controls/DragControls.js";
import { labelWorldHeight, makeNodeLabel, type NodeLabel } from "./graphLabels";

export interface ForceGraphDrawSettings {
  nodeResolution: number;
  nodeRelSize: number;
  nodeOpacity: number;
  linkOpacity: number;
  linkWidth: number;
  arrowLength: number;
  linkCurvature: number;
  chargeStrength: number;
  centerStrength: number;
  linkDistance: number;
  alphaDecay: number;
  velocityDecay: number;
  bgColor: string;
  labelSize: number;
  dynamicLabelSize: boolean;
  labelSizeInfluence: number;
  labelDegreeMode: "in" | "out" | "both";
}

export const DEFAULT_FORCE_GRAPH_DRAW_SETTINGS: ForceGraphDrawSettings = {
  nodeResolution: 16,
  nodeRelSize: 4,
  nodeOpacity: 0.9,
  linkOpacity: 0.4,
  linkWidth: 1,
  arrowLength: 3.5,
  linkCurvature: 0,
  chargeStrength: -180,
  centerStrength: 1,
  linkDistance: 60,
  alphaDecay: 0.0228,
  velocityDecay: 0.4,
  bgColor: "#080810",
  labelSize: 1.5,
  dynamicLabelSize: false,
  labelSizeInfluence: 0.5,
  labelDegreeMode: "both",
};

export interface ForceGraphLabelNode {
  title: string;
  visibleInDegree: number;
  visibleOutDegree: number;
  /** Optional short kind tag (e.g. "Article", "Literal fact") shown
   *  alongside the in/out degree sub-line. Link-graph nodes don't set this. */
  kind?: string;
}

export interface ForceGraphInstance {
  // The package exposes a callable fluent runtime without a complete public
  // TypeScript surface. Keep the escape hatch constrained to this boundary.
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface ForceGraphPhysicsNode {
  componentId?: number;
  x: number;
  y: number;
  z?: number;
  vx: number;
  vy: number;
  vz?: number;
}

let dragControlsPatched = false;

function patchDragControls(): void {
  if (dragControlsPatched) return;
  dragControlsPatched = true;
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
      if (Object.getOwnPropertyDescriptor(this, "_onPointerDown")) return;
      let gated: ((event: PointerEvent) => void) | undefined;
      Object.defineProperty(this, "_onPointerDown", {
        configurable: true,
        get: () => gated,
        set: (handler: (event: PointerEvent) => void) => {
          gated = (event: PointerEvent) => {
            if (
              event.pointerType !== "touch" &&
              (event.button !== 0 || event.shiftKey)
            ) {
              return;
            }
            handler(event);
          };
        },
      });
    },
  });
}

patchDragControls();

function createComponentChargeForce(initialStrength: number) {
  let currentStrength = initialStrength;
  let currentNodes: ForceGraphPhysicsNode[] = [];
  let currentRandom: (() => number) | undefined;
  let currentDimensions = 2;
  let components: ForceGraphPhysicsNode[][] = [];

  const jiggle = () => ((currentRandom ?? Math.random)() - 0.5) * 1e-6;

  const rebuild = () => {
    const groups = new Map<number, ForceGraphPhysicsNode[]>();
    for (const node of currentNodes) {
      const key = node.componentId ?? -1;
      const bucket = groups.get(key);
      if (bucket) bucket.push(node);
      else groups.set(key, [node]);
    }
    components = Array.from(groups.values()).filter((nodes) => nodes.length > 1);
  };

  const force = (alpha: number) => {
    if (currentStrength === 0) return;
    for (const nodes of components) {
      for (let i = 0; i < nodes.length - 1; i += 1) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j += 1) {
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dz = currentDimensions > 2 ? (b.z ?? 0) - (a.z ?? 0) : 0;
          let distanceSquared = dx * dx + dy * dy + dz * dz;
          if (distanceSquared < 1e-9) {
            dx = jiggle();
            dy = currentDimensions > 1 ? jiggle() : 0;
            dz = currentDimensions > 2 ? jiggle() : 0;
            distanceSquared = dx * dx + dy * dy + dz * dz;
          }
          const boundedDistanceSquared = Math.max(1, distanceSquared);
          const impulse = currentStrength * alpha / boundedDistanceSquared;
          a.vx += dx * impulse;
          b.vx -= dx * impulse;
          if (currentDimensions > 1) {
            a.vy += dy * impulse;
            b.vy -= dy * impulse;
          }
          if (currentDimensions > 2) {
            a.vz = (a.vz ?? 0) + dz * impulse;
            b.vz = (b.vz ?? 0) - dz * impulse;
          }
        }
      }
    }
  };

  force.initialize = (
    nodes: ForceGraphPhysicsNode[],
    random?: () => number,
    dimensions?: number,
  ) => {
    currentNodes = nodes;
    currentRandom = random;
    currentDimensions = dimensions ?? 2;
    rebuild();
  };

  force.strength = (next?: number) => {
    if (next === undefined) return currentStrength;
    currentStrength = next;
    rebuild();
    return force;
  };

  return force;
}

export async function createForceGraph3D(
  element: HTMLElement,
): Promise<ForceGraphInstance> {
  const { default: ForceGraph3D } = await import("3d-force-graph");
  // Configure graph data before mounting. Mounting starts the animation loop
  // synchronously, so setting graphData after `(element)` leaves one frame
  // where three-forcegraph can mark its engine running without a layout.
  const graph = (ForceGraph3D as any)({
    // eslint-disable-line @typescript-eslint/no-explicit-any
    controlType: "orbit",
  }) as ForceGraphInstance & ((element: HTMLElement) => void);
  graph.d3Force("charge", createComponentChargeForce(
    DEFAULT_FORCE_GRAPH_DRAW_SETTINGS.chargeStrength,
  ));
  graph.graphData({ nodes: [], links: [] });
  // three-forcegraph digests its initial props on a deferred timer. Let that
  // inner digest create the force layout before the outer renderer starts its
  // synchronous first animation frame.
  await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
  graph(element);
  return graph;
}

export function destroyForceGraph3D(graph: ForceGraphInstance | null): void {
  if (!graph) return;
  try {
    graph._destructor?.();
  } catch {
    // The renderer may already have released its WebGL context.
  }
}

export function observeForceGraphSize(
  element: HTMLElement,
  getGraph: () => ForceGraphInstance | null,
): () => void {
  const resize = () => {
    const graph = getGraph();
    if (!graph) return;
    graph.width(element.clientWidth).height(element.clientHeight);
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(element);
  return () => observer.disconnect();
}

export function applyForceGraphPhysicsSettings(
  graph: ForceGraphInstance,
  settings: Pick<
    ForceGraphDrawSettings,
    "chargeStrength" | "centerStrength" | "linkDistance"
  >,
): void {
  const centerStrength = Math.max(0, Math.min(1, settings.centerStrength));
  graph.d3Force("charge")?.strength(settings.chargeStrength);
  graph.d3Force("center")?.strength?.(centerStrength);
  graph.d3Force("link")?.distance(settings.linkDistance);
}

export function makeForceGraphNodeLabel(
  node: ForceGraphLabelNode,
  color: string,
  nodeValue: number,
  settings: Pick<
    ForceGraphDrawSettings,
    | "nodeRelSize"
    | "labelSize"
    | "dynamicLabelSize"
    | "labelSizeInfluence"
    | "labelDegreeMode"
  >,
): NodeLabel {
  const nodeRadius = Math.cbrt(Math.max(1, nodeValue)) * settings.nodeRelSize;
  const degreeCount =
    settings.labelDegreeMode === "in"
      ? node.visibleInDegree
      : settings.labelDegreeMode === "out"
        ? node.visibleOutDegree
        : node.visibleInDegree + node.visibleOutDegree;
  const prominence = settings.dynamicLabelSize
    ? 1 + settings.labelSizeInfluence * Math.log2(1 + degreeCount)
    : 1;
  const worldHeight =
    Math.max(2, nodeRadius) * 0.7 * settings.labelSize * prominence;
  const label = makeNodeLabel(node.title, color, worldHeight, {
    in: node.visibleInDegree,
    out: node.visibleOutDegree,
    kind: node.kind,
  });
  label.position.set(0, nodeRadius + labelWorldHeight(label) / 2 + 1, 0);
  return label;
}
