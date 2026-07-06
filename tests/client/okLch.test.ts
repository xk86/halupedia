import { describe, expect, it } from "vitest";
import {
  fadeTowardNeutral,
  mixOkLch,
  parseHex,
  toHex,
} from "../../src/client/graphRender/okLch";

describe("OKLCH color helpers", () => {
  it("round-trips hex through parseHex/toHex", () => {
    expect(toHex(parseHex("#e63946"))).toBe("#e63946");
    // Shorthand hex.
    expect(toHex(parseHex("#abc"))).toBe("#aabbcc");
    // Case-insensitive.
    expect(toHex(parseHex("#FF00AA"))).toBe("#ff00aa");
  });

  it("returns black for garbage input rather than throwing", () => {
    expect(toHex(parseHex("not a color"))).toBe("#000000");
    expect(toHex(parseHex(""))).toBe("#000000");
  });

  it("t=0 and t=1 pin to the endpoints", () => {
    expect(mixOkLch("#e63946", "#457b9d", 0)).toBe("#e63946");
    expect(mixOkLch("#e63946", "#457b9d", 1)).toBe("#457b9d");
  });

  it("t=0.5 gives a colorful midpoint (not a muddy grey)", () => {
    // sRGB midpoint of #e63946 and #457b9d is roughly #95 5a 71 (a muddy
    // pinkish-mauve). OKLCH keeps chroma up so the mid stays saturated.
    const mid = mixOkLch("#e63946", "#457b9d", 0.5);
    const { r, g, b } = parseHex(mid);
    // Not near-grey: the RGB channels shouldn't all be within ~15 of each
    // other (which would signal a desaturated midpoint).
    const min = Math.min(r, g, b);
    const max = Math.max(r, g, b);
    expect(max - min).toBeGreaterThan(30);
  });

  it("takes the shorter hue arc across the 0/360 boundary", () => {
    // Two nearly-red colors on opposite sides of the wrap; midpoint should be
    // near red, not tour through the whole wheel.
    const mid = mixOkLch("#ff0033", "#ff3300", 0.5);
    const { r, g, b } = parseHex(mid);
    expect(r).toBeGreaterThan(200); // still red-ish
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(80);
  });

  it("clamps t to [0, 1]", () => {
    expect(mixOkLch("#e63946", "#457b9d", -2)).toBe("#e63946");
    expect(mixOkLch("#e63946", "#457b9d", 42)).toBe("#457b9d");
  });

  it("fadeTowardNeutral at intensity=0 is the neutral, at 1 is the color", () => {
    expect(fadeTowardNeutral("#e63946", "#808080", 0)).toBe("#808080");
    expect(fadeTowardNeutral("#e63946", "#808080", 1)).toBe("#e63946");
  });
});
