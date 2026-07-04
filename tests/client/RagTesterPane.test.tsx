import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RagTesterPane,
  sortDocumentsByScore,
} from "../../src/client/admin/panes/RagTesterPane";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("RagTesterPane", () => {
  it("orders selected documents by descending raw score", () => {
    const documents = [
      { documentId: "middle", rawScore: 0.7, fusedRank: 2 },
      { documentId: "highest-later-rank", rawScore: 0.9, fusedRank: 4 },
      { documentId: "highest-earlier-rank", rawScore: 0.9, fusedRank: 1 },
    ] as Parameters<typeof sortDocumentsByScore>[0];

    expect(
      sortDocumentsByScore(documents).map((document) => document.documentId),
    ).toEqual(["highest-earlier-rank", "highest-later-rank", "middle"]);
    expect(documents.map((document) => document.documentId)).toEqual([
      "middle",
      "highest-later-rank",
      "highest-earlier-rank",
    ]);
  });

  it("runs a read-only query and renders retrieval provenance", async () => {
    const payload = {
      request: {
        query: "Alpha systems",
        profile: "article_generation",
        targetSlug: "admin-rag-query",
        directSlugs: [],
        minScore: 0.4,
      },
      retrieval: {
        textDocuments: [
          {
            documentId: "article_summary:alpha",
            articleSlug: "alpha",
            sourceKind: "article_summary",
            sourceId: "alpha",
            content: "Alpha evidence.",
            rawScore: 0.91,
            fusedRank: 0,
            retrievalReason: "semantic",
            provenance: "semantic",
          },
        ],
        imageDocuments: [],
        sourceArticles: [
          {
            slug: "alpha",
            title: "Alpha",
            score: 0.91,
            contributingKinds: ["article_summary"],
            provenance: "semantic",
          },
        ],
        relatedTitles: ["Alpha"],
        diagnostics: {
          profile: "article_generation",
          queryText: "Alpha systems",
          textEmbeddingModel: "embedding-test",
          servingHost: "local",
          vectorDimensions: 24,
          candidateTextCount: 3,
          candidateImageCount: 0,
          selectedTextCount: 1,
          selectedImageCount: 0,
          selectedKinds: ["article_summary"],
          exclusions: [
            { documentId: "article_body:beta:0", reason: "below_top_k" },
          ],
        },
      },
      evidence: {
        articleContext: "[alpha]\nAlpha evidence.",
        infoboxContext: "",
        ontologyFacts: "",
        relatedTitles: "- Alpha",
        linkAllowlist: [{ slug: "alpha", title: "Alpha" }],
        decisions: [
          {
            documentId: "article_summary:alpha",
            kind: "article_summary",
            included: true,
            reason: "semantic",
          },
        ],
        tokensUsed: 12,
        tokenBudget: 7000,
      },
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RagTesterPane />);
    await userEvent.click(screen.getByRole("button", { name: "Raw markdown" }));
    await userEvent.type(
      screen.getByPlaceholderText("Describe the material to retrieve…"),
      "Alpha systems",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Run retrieval" }),
    );

    expect(await screen.findByText("Alpha evidence.")).toBeInTheDocument();
    expect(screen.getAllByText("semantic").length).toBeGreaterThan(0);
    expect(screen.getByText("below_top_k")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/rag/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "Alpha systems",
        profile: "article_generation",
        targetSlug: "",
      }),
    });
  });
});
