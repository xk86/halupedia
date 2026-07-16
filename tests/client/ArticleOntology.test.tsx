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
    status: "pending",
  }],
};

describe("ArticleOntology suggestions", () => {
  it("reloads persisted suggestions and exposes per-row add, merge, needs-review, and discard actions", async () => {
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
    expect(
      screen.getByRole("button", { name: "Mark causes for human review" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard causes" })).toBeInTheDocument();

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

  it("marks a suggestion for human review instead of deleting it", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify(payload), { status: 200 });
      return new Response(
        JSON.stringify({
          ...payload,
          suggestions: [{ ...payload.suggestions[0], status: "human_review" }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ArticleOntology slug="subject" onNavigate={() => undefined} />);

    await screen.findByText("structural change");
    await userEvent.click(
      screen.getByRole("button", { name: "Mark causes for human review" }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/article/subject/ontology/suggestions/human-review",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ ids: [7] }),
        }),
      );
    });
    expect(await screen.findByText("needs review")).toBeInTheDocument();
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

  it("sends custom predicates as normalized keys", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/ontology/vocabulary") {
        return new Response(JSON.stringify({ predicates: [], entityTypes: ["thing", "person"] }), { status: 200 });
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ ...payload, facts: [{ id: 1, predicate: "caused_by", label: "caused by", object: "chlorophyll", objectSlug: null, source: "curated", confidence: 1 }], suggestions: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ArticleOntology slug="subject" onNavigate={() => undefined} />);

    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.type(screen.getByPlaceholderText("Relationship…"), "Caused by");
    await userEvent.type(screen.getByPlaceholderText("e.g. 1998"), "chlorophyll");
    await userEvent.click(screen.getByRole("button", { name: "Add fact" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/article/subject/ontology/facts",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ predicate: "caused_by", objectLiteral: "chlorophyll" }),
        }),
      );
    });
  });

  it("can change the article entity type", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/ontology/vocabulary") {
        return new Response(JSON.stringify({ predicates: [], entityTypes: ["thing", "person"] }), { status: 200 });
      }
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ ...payload, entityType: "person" }), { status: 200 });
      }
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ArticleOntology slug="subject" onNavigate={() => undefined} />);

    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const typeInput = screen.getByPlaceholderText("person");
    await userEvent.clear(typeInput);
    await userEvent.type(typeInput, "person");
    await userEvent.click(screen.getByRole("button", { name: "Set type" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/article/subject/ontology/entity",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ entityType: "person" }),
        }),
      );
    });
    expect(await screen.findByText("person")).toBeInTheDocument();
  });
});
