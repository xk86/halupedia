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
