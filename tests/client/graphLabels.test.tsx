import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { Text } from "troika-three-text";
import {
  makeNodeLabel,
  setLabelColor,
  setLabelOpacity,
  labelWorldHeight,
  faceCamera,
  disposeLabels,
  type NodeLabel,
} from "../../src/client/graphLabels";

// jsdom has no 2D canvas — stub the surface the width estimator and the shared
// backdrop texture touch.
function stubCanvasContext() {
  const ctx = {
    font: "",
    fillStyle: "",
    measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return ctx;
}

function parts(label: NodeLabel) {
  return label.userData.label;
}

describe("graphLabels (SDF node labels)", () => {
  beforeEach(() => {
    stubCanvasContext();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the full title as SDF text — never truncated", () => {
    const longTitle = "x".repeat(500);
    const label = makeNodeLabel(longTitle, "#ffffff", 6);
    expect(parts(label).title).toBeInstanceOf(Text);
    expect(parts(label).title.text).toBe(longTitle);
  });

  it("carries the world height and adds a degree sub-line when given", () => {
    const plain = makeNodeLabel("Plain", "#ffffff", 8);
    expect(labelWorldHeight(plain)).toBe(8);
    expect(parts(plain).sub).toBeNull();

    const withDegrees = makeNodeLabel("Hub", "#ffffff", 8, { in: 3, out: 7 });
    expect(parts(withDegrees).sub?.text).toContain("3 in");
    expect(parts(withDegrees).sub?.text).toContain("7 out");
    // Title shrinks to make room for the sub-line, mirroring the old layout.
    expect(parts(withDegrees).title.fontSize).toBeLessThan(parts(plain).title.fontSize);
  });

  it("prefixes the sub-line with a kind tag when given (article/orphan/literal)", () => {
    const withKind = makeNodeLabel("Thing", "#ffffff", 8, {
      in: 1,
      out: 2,
      kind: "Literal fact",
    });
    expect(parts(withKind).sub?.text).toContain("Literal fact");
    expect(parts(withKind).sub?.text).toContain("1 in");
    expect(parts(withKind).sub?.text).toContain("2 out");

    // No kind given — sub-line is just the degree counts, same as before.
    const withoutKind = makeNodeLabel("Thing", "#ffffff", 8, { in: 1, out: 2 });
    expect(withoutKind.userData.label.sub?.text).not.toContain("kind");
  });

  it("tints the title directly and the sub-line dimmed; backdrop stays black", () => {
    const label = makeNodeLabel("Tinted", "#ff0000", 6, { in: 1, out: 1 });
    setLabelColor(label, "#00ff00");
    expect(parts(label).title.color).toBe("#00ff00");
    const sub = new THREE.Color(parts(label).sub!.color as string);
    expect(sub.g).toBeGreaterThan(0);
    expect(sub.g).toBeLessThan(1);
    expect(sub.r).toBe(0);
    expect(parts(label).backdrop.material.color.getHex()).toBe(0x000000);
  });

  it("fades the backdrop while keeping the text fill fully opaque", () => {
    const label = makeNodeLabel("Fade", "#ffffff", 6);
    setLabelOpacity(label, 0.5);
    expect(parts(label).title.fillOpacity).toBe(1.0);
    expect(parts(label).backdrop.material.opacity).toBeCloseTo(0.275);
  });

  it("faceCamera orients visible labels to the camera and skips hidden ones", () => {
    const visible = makeNodeLabel("A", "#ffffff", 6);
    const hidden = makeNodeLabel("B", "#ffffff", 6);
    hidden.visible = false;
    const camera = new THREE.PerspectiveCamera();
    camera.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3);
    faceCamera([visible, hidden], camera);
    expect(visible.quaternion.equals(camera.quaternion)).toBe(true);
    expect(hidden.quaternion.equals(camera.quaternion)).toBe(false);
  });

  it("routes raycasts through the group (not the rotated inner meshes) so node drag stays world-aligned", () => {
    const label = makeNodeLabel("Grabbable", "#ffffff", 6, { in: 1, out: 1 });
    // Inner meshes opt out of raycasting — only the group is a hit target, and
    // its parent is the unrotated node group, so 3d-force-graph reads a
    // world-aligned drag delta from the group's local position.
    const p = parts(label);
    const hits = (obj: THREE.Object3D, ray: THREE.Raycaster) => {
      const out: THREE.Intersection[] = [];
      obj.raycast(ray, out);
      return out;
    };
    // Inner meshes never report a hit.
    label.updateMatrixWorld(true);
    const straightOn = new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));
    expect(hits(p.title, straightOn)).toHaveLength(0);
    expect(hits(p.backdrop, straightOn)).toHaveLength(0);

    // The group reports a hit for a ray through its center, and the hit's
    // `object` is the group itself (the unrotated-parent drag target).
    const groupHits = hits(label, straightOn);
    expect(groupHits).toHaveLength(1);
    expect(groupHits[0].object).toBe(label);

    // A ray well outside the billboard quad misses.
    const wide = new THREE.Raycaster(new THREE.Vector3(9999, 0, 10), new THREE.Vector3(0, 0, -1));
    expect(hits(label, wide)).toHaveLength(0);

    // Hidden labels are not grabbable.
    label.visible = false;
    expect(hits(label, straightOn)).toHaveLength(0);
  });

  it("disposeLabels frees text meshes and per-label backdrop materials", () => {
    const labels = new Map<string, NodeLabel>();
    labels.set("a", makeNodeLabel("A", "#ffffff", 6));
    labels.set("b", makeNodeLabel("B", "#ffffff", 6, { in: 1, out: 2 }));
    const spies = [...labels.values()].flatMap((label) => {
      const p = parts(label);
      return [
        vi.spyOn(p.title, "dispose"),
        ...(p.sub ? [vi.spyOn(p.sub, "dispose")] : []),
        vi.spyOn(p.backdrop.material, "dispose"),
      ];
    });
    disposeLabels(labels);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(labels.size).toBe(0);
  });
});
