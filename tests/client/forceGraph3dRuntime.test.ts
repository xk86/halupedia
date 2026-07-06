import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => {
  const calls: string[] = [];
  const installedForces = new Map<string, unknown>();
  const forces = {
    center: { strength: vi.fn() },
    charge: { strength: vi.fn() },
    link: { distance: vi.fn() },
  };
  const graph = Object.assign(
    vi.fn(() => {
      calls.push("mount");
    }),
    {
      graphData: vi.fn(() => {
        calls.push("data");
        return graph;
      }),
      d3Force: vi.fn(function (name: keyof typeof forces, value?: unknown) {
        if (arguments.length > 1) {
          installedForces.set(name, value);
          return graph;
        }
        return installedForces.get(name) ?? forces[name];
      }),
    },
  );
  return { calls, forces, graph, factory: vi.fn(() => graph), installedForces };
});

vi.mock("3d-force-graph", () => ({ default: runtime.factory }));

import {
  applyForceGraphPhysicsSettings,
  createForceGraph3D,
} from "../../src/client/forceGraph3d";

describe("shared 3D force graph runtime", () => {
  it("digests empty graph data before mounting the animation loop", async () => {
    runtime.calls.length = 0;
    runtime.installedForces.clear();
    const element = document.createElement("div");

    const graph = await createForceGraph3D(element);

    expect(graph).toBe(runtime.graph);
    expect(runtime.calls).toEqual(["data", "mount"]);
    expect(runtime.graph).toHaveBeenCalledWith(element);
    expect(runtime.graph.d3Force).toHaveBeenCalledWith(
      "charge",
      expect.any(Function),
    );
  });

  it("applies shared physics settings to force graph forces", () => {
    runtime.graph.d3Force.mockClear();
    runtime.installedForces.clear();
    runtime.forces.center.strength.mockClear();
    runtime.forces.charge.strength.mockClear();
    runtime.forces.link.distance.mockClear();

    applyForceGraphPhysicsSettings(runtime.graph, {
      chargeStrength: -320,
      centerStrength: 1.75,
      linkDistance: 45,
    });

    expect(runtime.graph.d3Force).toHaveBeenCalledWith("charge");
    expect(runtime.graph.d3Force).toHaveBeenCalledWith("center");
    expect(runtime.graph.d3Force).toHaveBeenCalledWith("link");
    expect(runtime.forces.charge.strength).toHaveBeenCalledWith(-320);
    expect(runtime.forces.center.strength).toHaveBeenCalledWith(1);
    expect(runtime.forces.link.distance).toHaveBeenCalledWith(45);
  });
});
