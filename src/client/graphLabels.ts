// SDF-based node labels for the graph view, built on troika-three-text.
//
// The previous implementation rasterized every label into its own canvas
// texture (per-node VRAM, mipmaps, resolution/quality tradeoffs for long
// titles). troika renders glyphs from a shared signed-distance-field atlas:
// text is crisp at any zoom, never truncated, and the per-label GPU cost is a
// small glyph-quad geometry instead of a bitmap.
import * as THREE from "three";
import { Text } from "troika-three-text";
import interFontUrl from "@fontsource/inter/files/inter-latin-400-normal.woff?url";

interface LabelParts {
  title: Text;
  sub: Text | null;
  backdrop: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  worldHeight: number;
  baseOpacity: number;
}

/** A node label: a Group carrying SDF text meshes plus a backdrop plane. */
export type NodeLabel = THREE.Group & { userData: { label: LabelParts } };

// ── shared GPU resources (one of each for ALL labels) ────────────────────────

let sharedBackdropTexture: THREE.Texture | null = null;
let sharedBackdropGeometry: THREE.PlaneGeometry | null = null;
let sharedMeasureCtx: CanvasRenderingContext2D | null = null;

/** Rounded translucent-black pill, stretched per label. Drawn white here and
 *  colored/faded via the material so one texture serves every label. */
function backdropTexture(): THREE.Texture {
  if (sharedBackdropTexture) return sharedBackdropTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  const radius = canvas.height * 0.22;
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, radius);
    ctx.fill();
  } else {
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  sharedBackdropTexture = new THREE.CanvasTexture(canvas);
  sharedBackdropTexture.minFilter = THREE.LinearFilter;
  sharedBackdropTexture.magFilter = THREE.LinearFilter;
  sharedBackdropTexture.generateMipmaps = false;
  return sharedBackdropTexture;
}

function backdropGeometry(): THREE.PlaneGeometry {
  if (!sharedBackdropGeometry) sharedBackdropGeometry = new THREE.PlaneGeometry(1, 1);
  return sharedBackdropGeometry;
}

/** Cheap width estimate so the backdrop is sized immediately; corrected with
 *  troika's exact glyph metrics once the async SDF layout completes. */
function estimateTextWidth(text: string, fontSizeWorld: number): number {
  if (!sharedMeasureCtx) {
    sharedMeasureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!sharedMeasureCtx) return text.length * fontSizeWorld * 0.55;
  sharedMeasureCtx.font = "100px sans-serif";
  return (sharedMeasureCtx.measureText(text).width / 100) * fontSizeWorld;
}

const BACKDROP_OPACITY = 0.55;
const SUB_COLOR_SCALE = 0.62; // sub-text brightness relative to the tint

function makeText(content: string, fontSizeWorld: number, color: string): Text {
  const text = new Text();
  text.text = content;
  text.font = interFontUrl;
  text.fontSize = fontSizeWorld;
  text.anchorX = "center";
  text.anchorY = "middle";
  text.color = color;
  text.material.depthWrite = false;
  // Sync kicks off async SDF generation; guarded so non-browser test
  // environments (no workers/fetch) can still construct labels.
  try {
    text.sync();
  } catch {
    /* layout metrics stay on the estimate */
  }
  return text;
}

export function makeNodeLabel(
  textContent: string,
  color: string,
  worldHeight: number = 6,
  degrees?: { in: number; out: number },
): NodeLabel {
  const subText = degrees ? `↓ ${degrees.in} in   ↑ ${degrees.out} out` : null;
  // Match the old canvas layout proportions: the title occupied ~72% of the
  // label height alone, ~45% when a degree sub-line is present.
  const titleSize = worldHeight * (subText ? 0.45 : 0.72);
  const subSize = titleSize * 0.55;
  const padX = titleSize * 0.35;

  const group = new THREE.Group() as NodeLabel;

  const backdropMaterial = new THREE.MeshBasicMaterial({
    map: backdropTexture(),
    color: 0x000000,
    transparent: true,
    opacity: BACKDROP_OPACITY,
    depthWrite: false,
  });
  const backdrop = new THREE.Mesh(backdropGeometry(), backdropMaterial);
  backdrop.position.z = -titleSize * 0.02 - 0.01;
  backdrop.renderOrder = -1;
  group.add(backdrop);

  const title = makeText(textContent, titleSize, "#ffffff");
  let sub: Text | null = null;
  if (subText) {
    sub = makeText(subText, subSize, "#9a9a9a");
    const lineGap = subSize * 0.45;
    title.position.y = (subSize + lineGap) / 2;
    sub.position.y = -(titleSize + lineGap) / 2 + titleSize * 0.18;
    group.add(sub);
  }
  group.add(title);

  const sizeBackdrop = (width: number) => {
    backdrop.scale.set(Math.max(width, titleSize) + padX * 2, worldHeight, 1);
  };
  sizeBackdrop(Math.max(
    estimateTextWidth(textContent, titleSize),
    subText ? estimateTextWidth(subText, subSize) : 0,
  ));
  // Refine with exact metrics once troika finishes glyph layout.
  try {
    title.sync(() => {
      const bounds = title.textRenderInfo?.blockBounds;
      if (!bounds) return;
      const subBounds = sub?.textRenderInfo?.blockBounds;
      const width = Math.max(
        bounds[2] - bounds[0],
        subBounds ? subBounds[2] - subBounds[0] : 0,
      );
      sizeBackdrop(width);
    });
  } catch {
    /* estimate stands */
  }

  group.userData.label = { title, sub, backdrop, worldHeight, baseOpacity: 1 };
  setLabelColor(group, color);
  makeLabelDraggable(group, backdrop);
  return group;
}

/** Same SDF label as {@link makeNodeLabel} but non-interactive — edge labels
 *  ride along their link and shouldn't be draggable or clickable. */
export function makeEdgeLabel(
  textContent: string,
  color: string,
  worldHeight: number = 4,
): NodeLabel {
  const label = makeNodeLabel(textContent, color, worldHeight);
  const noRaycast = () => {};
  label.raycast = noRaycast;
  return label;
}

const _labelInverse = new THREE.Matrix4();
const _labelLocalRay = new THREE.Ray();
const _labelHitPoint = new THREE.Vector3();

/**
 * Route raycasts (drag + click) through the label *group* rather than its
 * inner text/backdrop meshes.
 *
 * Why this matters: the group is billboarded each frame
 * (quaternion = camera.quaternion), so its inner meshes sit in a
 * camera-rotated frame. 3d-force-graph drags a node by reading the *selected
 * child's* local-position delta and adding it to the node's world position —
 * if that child lives under the rotated label group, the delta is expressed
 * in camera axes and the node lurches along the wrong (screen-aligned) axes.
 * The label group itself, by contrast, is a direct child of the unrotated
 * node group, so its local frame *is* world-aligned and the drag delta is
 * correct. We therefore make the group the only hit target: it raycasts
 * against its own billboard quad, and the inner meshes opt out.
 */
function makeLabelDraggable(
  group: NodeLabel,
  backdrop: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>,
): void {
  const noRaycast = () => {};
  group.userData.label.title.raycast = noRaycast;
  group.userData.label.sub && (group.userData.label.sub.raycast = noRaycast);
  backdrop.raycast = noRaycast;

  group.raycast = function (raycaster, intersects) {
    if (!this.visible) return;
    // Quad extent comes from the backdrop's scale (its geometry is a unit
    // plane). Intersect the ray with the group-local z=0 plane and bounds-check.
    const halfW = backdrop.scale.x / 2;
    const halfH = backdrop.scale.y / 2;
    if (halfW <= 0 || halfH <= 0) return;
    _labelInverse.copy(this.matrixWorld).invert();
    _labelLocalRay.copy(raycaster.ray).applyMatrix4(_labelInverse);
    const dz = _labelLocalRay.direction.z;
    if (dz === 0) return;
    const t = -_labelLocalRay.origin.z / dz;
    if (t < 0) return;
    const x = _labelLocalRay.origin.x + _labelLocalRay.direction.x * t;
    const y = _labelLocalRay.origin.y + _labelLocalRay.direction.y * t;
    if (Math.abs(x) > halfW || Math.abs(y) > halfH) return;
    _labelHitPoint.set(x, y, 0).applyMatrix4(this.matrixWorld);
    const distance = raycaster.ray.origin.distanceTo(_labelHitPoint);
    if (distance < raycaster.near || distance > raycaster.far) return;
    intersects.push({ distance, point: _labelHitPoint.clone(), object: this });
  };
}

const tmpColor = new THREE.Color();

/** Tint the label — the title takes the color directly (like the old white
 *  canvas text under a material tint), the sub-line a dimmed version of it,
 *  and the backdrop stays black regardless. */
export function setLabelColor(label: NodeLabel, color: string): void {
  const parts = label.userData.label;
  parts.title.color = color;
  if (parts.sub) {
    tmpColor.set(color).multiplyScalar(SUB_COLOR_SCALE);
    parts.sub.color = `#${tmpColor.getHexString()}`;
  }
}

export function setLabelOpacity(label: NodeLabel, opacity: number): void {
  const parts = label.userData.label;
  if (parts.baseOpacity === opacity) return;
  parts.baseOpacity = opacity;
  parts.title.fillOpacity = 1.0;
  if (parts.sub) parts.sub.fillOpacity = 1.0;
  parts.backdrop.material.opacity = BACKDROP_OPACITY * opacity;
}

export function getLabelOpacity(label: NodeLabel): number {
  return label.userData.label.baseOpacity;
}

export function labelWorldHeight(label: NodeLabel): number {
  return label.userData.label.worldHeight;
}

/** SDF text meshes don't billboard on their own the way sprites did — turn
 *  each label toward the camera (a quaternion copy per label per frame). */
export function faceCamera(labels: Iterable<NodeLabel>, camera: THREE.Camera): void {
  for (const label of labels) {
    if (label.visible) label.quaternion.copy(camera.quaternion);
  }
}

export function disposeLabel(label: NodeLabel): void {
  const parts = label.userData.label;
  parts.title.dispose();
  parts.sub?.dispose();
  // Geometry and texture are shared across all labels; only the per-label
  // backdrop material is owned here.
  parts.backdrop.material.dispose();
}

export function disposeLabels(labels: Map<string, NodeLabel>): void {
  for (const label of labels.values()) disposeLabel(label);
  labels.clear();
}
