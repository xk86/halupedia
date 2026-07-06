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
