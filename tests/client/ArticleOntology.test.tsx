import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArticleOntology } from "../../src/client/article/ArticleOntology";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const payload = {
  entityType: "thing",
  facts: [],
  identifiers: [],
  categories: [],
  suggestions: [{
    id: 7,
    predicate: "causes",
    label: "causes",
    object: "structural change",
    validated: true,
  }],
};

describe("ArticleOntology suggestions", () => {
  it("reloads persisted suggestions and exposes per-row add, merge, and dismiss actions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!init?.method) return new Response(JSON.stringify(payload), { status: 200 });
      return new Response(
        JSON.stringify({ ...payload, suggestions: [] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ArticleOntology slug="subject" onNavigate={() => undefined} />);

    expect(await screen.findByText("structural change")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add causes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge causes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss causes" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Merge causes" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/article/subject/ontology/suggestions/merge",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ ids: [7] }),
        }),
      );
    });
  });

  it("does not blank when inference returns the legacy preview shape", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(
            JSON.stringify({ proposed: [], raw: [], called: true }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(payload), { status: 200 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ArticleOntology slug="subject" onNavigate={() => undefined} />);

    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Suggest facts" }),
    );

    expect(await screen.findByText("structural change")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/article/subject/ontology");
  });
});
