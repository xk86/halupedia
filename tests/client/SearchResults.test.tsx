import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchResults } from "../../src/client/SearchResults";

describe("SearchResults", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders existing and unwritten search results and navigates on click", async () => {
    const onNavigate = vi.fn();
    const onSearch = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            query: "clock",
            results: [
              { slug: "clock-tower", title: "Clock Tower", exists: true },
              { slug: "moon-clock", title: "Moon Clock", exists: false },
            ],
            existing_count: 1,
            hallucinated_count: 1,
            rate_limited: false,
            retry_after: null,
          }),
          { headers: { "content-type": "application/json" } }
        )
      )
    );

    render(<SearchResults q="clock" onNavigate={onNavigate} onSearch={onSearch} />);

    expect(await screen.findByText("In the encyclopedia")).toBeInTheDocument();
    expect(screen.getByText("Not yet written")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: /Moon Clock/i }));
    expect(onNavigate).toHaveBeenCalledWith("Moon_Clock");
  });

  it("shows a 'Go to' direct link when a query is active", async () => {
    const onNavigate = vi.fn();
    const onSearch = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            query: "Foobar",
            results: [],
            existing_count: 0,
            hallucinated_count: 0,
            rate_limited: false,
            retry_after: null,
          }),
          { headers: { "content-type": "application/json" } }
        )
      )
    );

    render(<SearchResults q="Foobar" onNavigate={onNavigate} onSearch={onSearch} />);

    const gotoLink = await screen.findByRole("link", { name: "Foobar" });
    expect(gotoLink).toBeInTheDocument();
    expect(gotoLink.closest(".search-goto")).toBeInTheDocument();

    await userEvent.click(gotoLink);
    expect(onNavigate).toHaveBeenCalledWith("Foobar");
  });

  it("submits trimmed search input through onSearch", async () => {
    const onNavigate = vi.fn();
    const onSearch = vi.fn();
    vi.stubGlobal("fetch", vi.fn());

    render(<SearchResults q="" onNavigate={onNavigate} onSearch={onSearch} />);

    const input = screen.getByPlaceholderText("Search Halupedia…");
    await userEvent.type(input, "  lantern guild  ");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(onSearch).toHaveBeenCalledWith("lantern guild");
  });
});
