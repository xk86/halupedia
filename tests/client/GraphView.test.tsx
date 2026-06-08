import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

import { makeNodeLabelSprite } from "../../src/client/GraphView";

// jsdom does not implement 2D canvas rendering, so stub just enough of the
// CanvasRenderingContext2D surface that makeNodeLabelSprite touches.
function stubCanvasContext() {
  const ctx = {
    font: "",
    textBaseline: "",
    textAlign: "",
    fillStyle: "",
    measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
    fillText: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return ctx;
}

describe("makeNodeLabelSprite", () => {
  beforeEach(() => {
    stubCanvasContext();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a sprite textured with the node title", () => {
    const sprite = makeNodeLabelSprite("Halupedia Article", "#ff0000");
    expect(sprite).toBeInstanceOf(THREE.Sprite);
    expect(sprite.material).toBeInstanceOf(THREE.SpriteMaterial);
    expect(sprite.material.map).toBeInstanceOf(THREE.CanvasTexture);
    // Sized so it reads at a consistent on-screen size, not zero/negative
    expect(sprite.scale.x).toBeGreaterThan(0);
    expect(sprite.scale.y).toBeGreaterThan(0);
  });

  it("draws the given title text onto the backing canvas", () => {
    const ctx = stubCanvasContext();
    makeNodeLabelSprite("Some Title", "#abcdef");
    expect(ctx.fillText).toHaveBeenCalledWith("Some Title", expect.any(Number), expect.any(Number));
    expect(ctx.fillStyle).toBe("#abcdef");
  });

  it("produces a wider sprite for longer text", () => {
    const short = makeNodeLabelSprite("A", "#ffffff");
    const long = makeNodeLabelSprite("A Much Longer Article Title Here", "#ffffff");
    expect(long.scale.x).toBeGreaterThan(short.scale.x);
  });
});
