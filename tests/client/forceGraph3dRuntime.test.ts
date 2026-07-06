import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => {
  const calls: string[] = [];
  const graph = Object.assign(
    vi.fn(() => {
      calls.push("mount");
    }),
    {
      graphData: vi.fn(() => {
        calls.push("data");
        return graph;
      }),
    },
  );
  return { calls, graph, factory: vi.fn(() => graph) };
});

vi.mock("3d-force-graph", () => ({ default: runtime.factory }));

import { createForceGraph3D } from "../../src/client/forceGraph3d";

describe("shared 3D force graph runtime", () => {
  it("digests empty graph data before mounting the animation loop", async () => {
    runtime.calls.length = 0;
    const element = document.createElement("div");

    const graph = await createForceGraph3D(element);

    expect(graph).toBe(runtime.graph);
    expect(runtime.calls).toEqual(["data", "mount"]);
    expect(runtime.graph).toHaveBeenCalledWith(element);
  });
});
