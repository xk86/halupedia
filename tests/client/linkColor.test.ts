import { describe, expect, it } from "vitest";
import { resolveGradientLinkColor } from "../../src/client/graphRender/linkColor";

describe("resolveGradientLinkColor", () => {
  it("blends the two endpoint colors when both are known", () => {
    const colorById = new Map([
      ["a", "#e63946"],
      ["b", "#457b9d"],
    ]);
    const result = resolveGradientLinkColor("a", "b", "#d6d6e0", colorById, 1);
    expect(result).not.toBe("#d6d6e0");
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("falls back to neutral when an endpoint color is unknown", () => {
    // Regression: this is exactly the state a link is in on a fresh mount,
    // before 3d-force-graph's link-force has resolved the source/target
    // strings to node objects — resolveGradientLinkColor must not throw and
    // must produce the neutral tone rather than caching a bad blend forever.
    const colorById = new Map([["a", "#e63946"]]);
    expect(resolveGradientLinkColor("a", "b", "#d6d6e0", colorById, 1)).toBe(
      "#d6d6e0",
    );
    expect(resolveGradientLinkColor("a", null, "#d6d6e0", colorById, 1)).toBe(
      "#d6d6e0",
    );
  });

  it("fades toward neutral as intensity drops", () => {
    const colorById = new Map([
      ["a", "#e63946"],
      ["b", "#457b9d"],
    ]);
    const full = resolveGradientLinkColor("a", "b", "#808080", colorById, 1);
    const none = resolveGradientLinkColor("a", "b", "#808080", colorById, 0);
    expect(none).toBe("#808080");
    expect(full).not.toBe("#808080");
  });
});
