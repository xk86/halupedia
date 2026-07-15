import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OntologySuggestionsPane } from "../../src/client/admin/panes/OntologySuggestionsPane";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const payload = {
  articleCount: 2,
  suggestionCount: 3,
  articles: [
    {
      slug: "apple-broker",
      title: "Apple Broker",
      suggestionCount: 2,
      suggestions: [
        {
          id: 7,
          predicate: "manages",
          label: "manages",
          object: "orchard inventory",
          objectHtml: "orchard inventory",
          validated: true,
        },
        {
          id: 8,
          predicate: "requires_knowledge_of",
          label: "requires knowledge of",
          object: "grade standards",
          objectHtml: "grade standards",
          validated: false,
        },
      ],
    },
    {
      slug: "citrus-processor",
      title: "Citrus Processor",
      suggestionCount: 1,
      suggestions: [
        {
          id: 9,
          predicate: "interfaces_with",
          label: "interfaces with",
          object: "regulatory boards",
          objectHtml: "regulatory boards",
          validated: true,
        },
      ],
    },
  ],
};

describe("OntologySuggestionsPane", () => {
  it("groups pending suggestions by article and delegates mutations to article endpoints", async () => {
    const onNavigate = vi.fn();
    let listCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/ontology/suggestions" && !init?.method) {
        listCalls += 1;
        const body =
          listCalls === 1
            ? payload
            : {
                ...payload,
                articles: [payload.articles[1]],
                suggestionCount: 1,
                articleCount: 1,
              };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OntologySuggestionsPane onNavigate={onNavigate} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Load pending suggestions" }),
    );

    const apple = await screen.findByTestId("ontology-suggestion-article-apple-broker");
    expect(within(apple).getByText("orchard inventory")).toBeInTheDocument();
    expect(within(apple).getByText("grade standards")).toBeInTheDocument();
    expect(screen.getByText("Citrus Processor")).toBeInTheDocument();

    await userEvent.click(
      within(apple).getByRole("button", { name: "Open Apple Broker" }),
    );
    expect(onNavigate).toHaveBeenCalledWith("apple-broker");

    await userEvent.click(
      within(apple).getByRole("button", { name: "Toggle Apple Broker" }),
    );
    expect(within(apple).queryByText("orchard inventory")).not.toBeInTheDocument();

    await userEvent.click(
      within(apple).getByRole("button", { name: "Toggle Apple Broker" }),
    );
    await userEvent.click(
      within(apple).getByRole("button", { name: "Merge all for Apple Broker" }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/article/apple-broker/ontology/suggestions/merge",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ ids: [7, 8] }),
        }),
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/ontology/suggestions",
      undefined,
    );
  });

  it("auto-merges relations and applies pending type changes across articles", async () => {
    const autoMergePayload = {
      articleCount: 2,
      suggestionCount: 2,
      articles: [
        {
          slug: "apple-broker",
          title: "Apple Broker",
          suggestionCount: 2,
          suggestions: [
            {
              id: 7,
              predicate: "manages",
              label: "manages",
              object: "orchard inventory",
              objectHtml: "orchard inventory",
              validated: true,
            },
            {
              id: 8,
              predicate: "requires_knowledge_of",
              label: "requires knowledge of",
              object: "grade standards",
              objectHtml: "grade standards",
              validated: false,
            },
          ],
          typeSuggestion: { suggestedType: "occupation", createdAt: 1 },
        },
        {
          // Type-only article: no relation suggestions, just a type change.
          slug: "citrus-processor",
          title: "Citrus Processor",
          suggestionCount: 0,
          suggestions: [],
          typeSuggestion: { suggestedType: "organization", createdAt: 2 },
        },
      ],
    };

    let listCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/ontology/suggestions" && !init?.method) {
        listCalls += 1;
        const body =
          listCalls === 1
            ? autoMergePayload
            : { articleCount: 0, suggestionCount: 0, articles: [] };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OntologySuggestionsPane onNavigate={vi.fn()} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Load pending suggestions" }),
    );
    await screen.findByTestId("ontology-suggestion-article-apple-broker");

    await userEvent.click(
      screen.getByRole("button", { name: /Auto merge all/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Merge all" }));

    // Relations merged only for the article that has them.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/article/apple-broker/ontology/suggestions/merge",
        expect.objectContaining({ method: "POST", body: JSON.stringify({}) }),
      );
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/article/citrus-processor/ontology/suggestions/merge",
      expect.anything(),
    );

    // Type change applied for every article that has one.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/article/apple-broker/ontology/type-suggestion/apply",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/article/citrus-processor/ontology/type-suggestion/apply",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
