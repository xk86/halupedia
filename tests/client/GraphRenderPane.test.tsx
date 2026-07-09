import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GraphRenderPane } from "../../src/client/graphRender/GraphRenderPane";
import { DEFAULT_GRAPH_RENDER_SETTINGS } from "../../src/client/graphRender/settings";

afterEach(() => {
  cleanup();
});

describe("GraphRenderPane", () => {
  it("keeps render controls inside a scrollable card body", () => {
    const { container } = render(
      <GraphRenderPane
        mode="links"
        view="3d"
        settings={DEFAULT_GRAPH_RENDER_SETTINGS}
        onChange={vi.fn()}
        className="h-full"
      />,
    );

    const card = container.querySelector('[data-slot="card"]');
    const header = container.querySelector('[data-slot="card-header"]');
    const content = container.querySelector('[data-slot="card-content"]');

    expect(card).toHaveClass("max-h-full", "min-h-0", "h-full");
    expect(header).toHaveClass("shrink-0");
    expect(content).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
      "overflow-x-hidden",
    );
  });
});
