import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchArticleSuggestions, useArticleSuggestions } from "../../src/client/articleSuggest";

function mockSearch(body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
}

describe("fetchArticleSuggestions", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("keeps only existing articles and maps to {slug,title}", async () => {
    const fetchMock = mockSearch({
      results: [
        { slug: "clock-tower", title: "Clock Tower", exists: true },
        { slug: "moon-clock", title: "Moon Clock", exists: false },
      ],
      has_more: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    const { hits, hasMore } = await fetchArticleSuggestions("clock", 0);
    expect(hits).toEqual([{ slug: "clock-tower", title: "Clock Tower" }]);
    expect(hasMore).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/search?q=clock&offset=0",
      expect.objectContaining({ signal: undefined }),
    );
  });

  it("passes the offset through for pagination", async () => {
    const fetchMock = mockSearch({ results: [], has_more: false });
    vi.stubGlobal("fetch", fetchMock);
    await fetchArticleSuggestions("rat king", 20);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/search?q=rat%20king&offset=20",
      expect.anything(),
    );
  });
});

// A thin harness component to exercise the hook's lifecycle.
function Harness({ query }: { query: string }) {
  const { items, hasMore } = useArticleSuggestions(query);
  return (
    <div>
      <span data-testid="more">{hasMore ? "more" : "end"}</span>
      <ul>{items.map((s) => <li key={s.slug}>{s.title}</li>)}</ul>
    </div>
  );
}

describe("useArticleSuggestions", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => cleanup());

  it("debounces, fetches, and renders existing results", async () => {
    vi.stubGlobal("fetch", mockSearch({
      results: [{ slug: "clock-tower", title: "Clock Tower", exists: true }],
      has_more: false,
    }));
    render(<Harness query="clock" />);
    await waitFor(() => expect(screen.getByText("Clock Tower")).toBeTruthy());
    expect(screen.getByTestId("more").textContent).toBe("end");
  });

  it("clears results for an empty query", async () => {
    vi.stubGlobal("fetch", mockSearch({ results: [], has_more: false }));
    render(<Harness query="   " />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText("Clock Tower")).toBeNull();
  });
});
