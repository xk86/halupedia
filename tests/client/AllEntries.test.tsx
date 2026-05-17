import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AllEntries } from "../../src/client/AllEntries";

describe("AllEntries", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders entry titles without summary excerpts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              slug: "coal-futures-markets",
              title: "Coal futures markets",
              summaryMarkdown: "Coal futures markets are complex, highly volatile financial instruments.",
              generatedAt: null,
            },
          ],
          cursor: null,
          complete: true,
          total: 1,
        }),
        { headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    render(<AllEntries onNavigate={vi.fn()} />);

    expect(await screen.findByRole("link", { name: "Coal futures markets" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/index?all=1");
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
    expect(
      screen.queryByText("Coal futures markets are complex, highly volatile financial instruments.")
    ).not.toBeInTheDocument();
  });
});
