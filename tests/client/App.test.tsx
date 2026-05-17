import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";

function setPath(path: string) {
  window.history.replaceState({}, "", path);
}

function pagePayload(overrides: Partial<any> = {}) {
  return {
    cached: true,
    article: {
      slug: "test-article",
      canonicalSlug: "test-article",
      title: "Test Article",
      html: '<h1>Test Article</h1><p>Body copy with <a href="/wiki/Linked_Article">Linked Article</a>.</p>',
      markdown: '# Test Article\n\nBody copy with [Linked Article](halu:linked-article "Hidden hint").',
      plain_text: "Body copy with Linked Article.",
      generated_at: 1715000000000,
    },
    backlinks: {
      existing: [
        {
          slug: "linking-article",
          title: "Linking Article",
          visibleLabel: "Test Article",
          hiddenHint: "Seed backlink",
          createdAt: 1715000000001,
        },
      ],
      unwritten: [],
    },
    ...overrides,
  };
}

function ndjsonResponse(events: unknown[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders the home route and fetches homepage data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ featured: null, didYouKnow: [], didYouKnowPending: false, expiresAt: Date.now() + 3600000 }), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    expect(screen.getByRole("heading", { name: "Halupedia" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/homepage");
    expect(document.title).toBe("Halupedia");
  });

  it("random nav asks the server for a random page and redirects to it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ featured: null, didYouKnow: [], expiresAt: Date.now() + 3600000 }), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ path: "/wiki/Night_soil_tariff" }), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(pagePayload({
          article: {
            ...pagePayload().article,
            slug: "night-soil-tariff",
            canonicalSlug: "night-soil-tariff",
            title: "Night soil tariff",
            html: "<h1>Night soil tariff</h1><p>Random article body.</p>",
            markdown: "# Night soil tariff\n\nRandom article body.",
            plain_text: "Random article body.",
          },
        })), {
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    await userEvent.click(screen.getByRole("link", { name: "Random" }));

    expect(await screen.findByRole("heading", { name: "Night soil tariff" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/wiki/Night_soil_tariff");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/random-page");
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/page/Night_soil_tariff");
  });

  it("admin can regenerate an article summary from a pasted wiki link", async () => {
    const overview = {
      articleCount: 1,
      linkCount: 0,
      aliasCount: 0,
      latestArticles: [],
      model: "test-model",
      databasePath: "test.sqlite",
      promptConfigPath: "config/prompts.toml",
      ragMode: "full",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(overview), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          slug: "test-article",
          article: { title: "Test Article" },
        }), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(overview), {
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/admin");

    render(<App />);

    await screen.findByRole("heading", { name: "Admin" });
    await userEvent.type(screen.getByPlaceholderText("Slug or /wiki/ link for summary"), "https://host/wiki/Test_Article");
    await userEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));

    expect(await screen.findByText("Summary regenerated for Test Article.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/admin/regenerate-summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "https://host/wiki/Test_Article" }),
    });
  });

  it("shows the DYK section with an empty placeholder instead of hiding it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        featured: {
          slug: "goldfish",
          title: "Goldfish",
          summaryMarkdown: "Goldfish are ceremonial freshwater accountants.",
        },
        didYouKnow: [],
        didYouKnowPending: false,
        expiresAt: Date.now() + 3600000,
      }), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Featured article" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Did you know..." })).toBeInTheDocument();
    expect(screen.getByText("Add or generate an article to seed the first featured fact.")).toBeInTheDocument();
  });

  it("renders cached featured article, timer, and startup DYK without polling", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({
          featured: {
            slug: "test-article",
            title: "Test Article",
            summaryMarkdown: "A featured summary with $\\\\sigma$.",
          },
          didYouKnow: [
            {
              slug: "linked-article",
              title: "Linked Article",
              fact: "... [Linked Article](halu:linked-article \"Linked Article\") is filed under ceremonial ballast accounting.",
            },
          ],
          generatedAt: Date.now(),
          expiresAt: Date.now() + 3600000,
        }), {
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Featured article" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Test Article" })).toBeInTheDocument();
    expect(screen.getByText(/Homepage refreshes in/)).toBeInTheDocument();
    expect(document.querySelector(".homepage-summary .math-inline")).not.toBeNull();
    expect(await screen.findByRole("link", { name: "Linked Article" })).toHaveAttribute("href", "/wiki/Linked_Article");
    expect(screen.getByText(/is filed under ceremonial ballast accounting\./)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/homepage");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches homepage when the cached payload expires", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          featured: null,
          didYouKnow: [],
          generatedAt: Date.now(),
          expiresAt: Date.now() + 10,
        }), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          featured: {
            slug: "refreshed-page",
            title: "Refreshed Page",
            summaryMarkdown: "A refreshed homepage summary.",
          },
          didYouKnow: [],
          generatedAt: Date.now() + 10,
          expiresAt: Date.now() + 3600010,
        }), {
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    expect(await screen.findByText("No articles yet. Search for a topic to generate your first entry.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("link", { name: "Refreshed Page" })).toBeInTheDocument();
  });

  it("loads and renders a cached article route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(pagePayload()), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    expect(screen.getByText("Generating article and resolving canon...")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Test Article" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Linked Article" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit article" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Linking Article" })).toBeInTheDocument();
    expect(document.title).toBe("Test Article - Halupedia");
    expect(fetchMock).toHaveBeenCalledWith("/api/page/Test_Article");
  });

  it("header Go accepts a bare wiki path without nesting wiki twice", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ featured: null, didYouKnow: [], expiresAt: Date.now() + 3600000 }), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(pagePayload({
          article: {
            ...pagePayload().article,
            slug: "corvid-scouts-of-armenia",
            canonicalSlug: "corvid-scouts-of-armenia",
            title: "Corvid scouts of Armenia",
            html: "<h1>Corvid scouts of Armenia</h1><p>Scout body.</p>",
            markdown: "# Corvid scouts of Armenia\n\nScout body.",
            plain_text: "Scout body.",
          },
        })), {
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    const input = screen.getByPlaceholderText("Search the register...");
    await userEvent.type(input, "wiki/Corvid_scouts_of_Armenia");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(await screen.findByRole("heading", { name: "Corvid scouts of Armenia" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/wiki/Corvid_scouts_of_Armenia");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/page/Corvid_scouts_of_Armenia");
  });

  it("header Go accepts a full URL containing a wiki path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ featured: null, didYouKnow: [], expiresAt: Date.now() + 3600000 }), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(pagePayload({
          article: {
            ...pagePayload().article,
            slug: "night-soil-tariff",
            canonicalSlug: "night-soil-tariff",
            title: "Night soil tariff",
            html: "<h1>Night soil tariff</h1><p>Tariff body.</p>",
            markdown: "# Night soil tariff\n\nTariff body.",
            plain_text: "Tariff body.",
          },
        })), {
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    const input = screen.getByPlaceholderText("Search the register...");
    await userEvent.type(input, "https://example.invalid/prefix/wiki/Night_soil_tariff?old=1");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(await screen.findByRole("heading", { name: "Night soil tariff" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/wiki/Night_soil_tariff");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/page/Night_soil_tariff");
  });

  it("copies the canonical slug from the article toolbar", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(pagePayload({
        article: {
          ...pagePayload().article,
          slug: "fish-鱼怕我女人是鱼我是鱼害怕",
          canonicalSlug: "fish-鱼怕我女人是鱼我是鱼害怕",
          title: "Fish 鱼怕我女人是鱼我是鱼害怕",
        },
      })), {
        headers: { "content-type": "application/json" },
      })
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    setPath("/wiki/Fish_%E9%B1%BC%E6%80%95%E6%88%91%E5%A5%B3%E4%BA%BA%E6%98%AF%E9%B1%BC%E6%88%91%E6%98%AF%E9%B1%BC%E5%AE%B3%E6%80%95");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Fish 鱼怕我女人是鱼我是鱼害怕" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy slug" }));
    expect(writeText).toHaveBeenCalledWith("fish-鱼怕我女人是鱼我是鱼害怕");
    expect(screen.getByText("Slug copied.")).toBeInTheDocument();
  });

  it("handles streamed article responses and normalizes the canonical path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { type: "start", slug: "fresh-page", cached: false },
        { type: "progress", html: "<h1>Fresh Page</h1><p>Streaming body.</p>" },
        {
          type: "done",
          cached: false,
          redirectedFrom: "/wiki/fresh_page",
          canonicalPath: "/wiki/Fresh_Page",
          article: {
            slug: "fresh-page",
            canonicalSlug: "fresh-page",
            title: "Fresh Page",
            html: "",
            markdown: '# Fresh Page\n\nStreaming body with [Alpha](halu:alpha "Hint").',
            plain_text: "Streaming body with Alpha.",
            generated_at: 1715000000002,
          },
          backlinks: { existing: [], unwritten: [] },
        },
      ])
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/fresh_page");

    render(<App />);

    expect(await screen.findByText("Fresh generation from local canon.")).toBeInTheDocument();
    expect(screen.getByText("Streaming body.")).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/wiki/Fresh_Page");
    });
    expect(document.title).toBe("Fresh Page - Halupedia");
  });

  it("intercepts article link clicks and fetches the next article client-side", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(pagePayload()), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            pagePayload({
              article: {
                slug: "linked-article",
                canonicalSlug: "linked-article",
                title: "Linked Article",
                html: "<h1>Linked Article</h1><p>Second page body.</p>",
                markdown: '# Linked Article\n\nSecond page body with [Alpha](halu:alpha "Hint").',
                plain_text: "Second page body.",
                generated_at: 1715000000003,
              },
              backlinks: { existing: [], unwritten: [] },
            })
          ),
          { headers: { "content-type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("link", { name: "Linked Article" }));

    expect(await screen.findByRole("heading", { name: "Linked Article" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/page/Linked_Article");
    expect(window.location.pathname).toBe("/wiki/Linked_Article");
  });

  it("shows an empty-history message instead of a raw 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(pagePayload()), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(pagePayload()), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "article not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("button", { name: "View history" }));

    expect(await screen.findByText("No edit history yet.")).toBeInTheDocument();
  });

  it("shows refresh feedback when references are unchanged", async () => {
    const payload = pagePayload();
    let resolveRefresh: (value: Response) => void = () => {};
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockReturnValueOnce(refreshResponse);
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    const clickPromise = userEvent.click(screen.getByRole("button", { name: "Refresh with retrieved context" }));

    expect(await screen.findByText("Refreshing with retrieved context...")).toBeInTheDocument();
    resolveRefresh(
      new Response(JSON.stringify({ ...payload, refreshChanged: false }), {
        headers: { "content-type": "application/json" },
      })
    );
    await clickPromise;
    expect(await screen.findByText("References already up to date.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/article/test-article/refresh-context", { method: "POST" });
  });

  it("rolls back streamed rewrite progress when the server rejects a body subject change", async () => {
    const original = pagePayload({
      article: {
        ...pagePayload().article,
        slug: "energy-storage",
        canonicalSlug: "energy-storage",
        title: "Energy storage",
        html: "<h1>Energy storage</h1><p>Original retained energy body.</p>",
        markdown: "# Energy storage\n\nOriginal retained energy body.",
        plain_text: "Original retained energy body.",
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(original), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        ndjsonResponse([
          {
            type: "progress",
            html: "<h1>Energy storage</h1><p>Maternal Energy Potential refers to rejected renamed article body.</p>",
            markdown: "# Energy storage\n\nMaternal Energy Potential refers to rejected renamed article body.",
          },
          {
            type: "error",
            message:
              'article lead subject did not match requested title: requested="Energy storage" got="Maternal Energy Potential"',
          },
        ])
      );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Energy_storage");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Energy storage" })).toBeInTheDocument();
    expect(screen.getByText("Original retained energy body.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit article" }));
    await userEvent.type(screen.getByPlaceholderText("Describe your changes."), "make this article to be about your mom");
    await userEvent.click(screen.getByRole("button", { name: "Apply edit" }));

    expect(
      await screen.findByText(
        'article lead subject did not match requested title: requested="Energy storage" got="Maternal Energy Potential"'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Energy storage" })).toBeInTheDocument();
    expect(screen.getByText("Original retained energy body.")).toBeInTheDocument();
    expect(screen.queryByText("Rejected renamed article body.")).not.toBeInTheDocument();
  });

  it("opens history as a read-only page and restores only after confirmation", async () => {
    const current = pagePayload();
    const oldRevision = {
      id: 7,
      title: "Test Article",
      html: "<h1>Test Article</h1><p>Older body copy.</p>",
      markdown: "# Test Article\n\nOlder body copy.",
      summaryMarkdown: "Older body copy with $\\sigma$.",
      generatedAt: 1714999999000,
      createdAt: 1714999999000,
      operation: "rewrite",
      instructions: "Earlier edit.",
      revertedFromRevisionId: null,
    };
    const restored = pagePayload({
      article: {
        ...current.article,
        html: oldRevision.html,
        markdown: oldRevision.markdown,
        plain_text: "Older body copy.",
        generated_at: 1715000001000,
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(current), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(current), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ revisions: [oldRevision] }), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(restored), {
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("button", { name: "View history" }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/wiki/Test_Article/history");
    });
    expect(await screen.findByRole("heading", { name: "History: Test Article" })).toBeInTheDocument();
    expect(screen.getByText("Earlier edit.")).toBeInTheDocument();
    expect(document.querySelector(".history-summary .math-inline")).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "View revision 7" }));
    expect(await screen.findByText("You are viewing an old revision.")).toBeInTheDocument();
    expect(screen.getAllByText("Older body copy.").length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/article/test-article/revert",
      expect.objectContaining({ method: "POST" })
    );

    await userEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    expect(screen.getByText("Restore this old revision?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Yes, restore" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/article/test-article/revert",
        expect.objectContaining({ method: "POST" })
      );
    });
    expect(await screen.findByText("Version restored.")).toBeInTheDocument();
  });

  it("toggles night mode from the header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ featured: null, didYouKnow: [], didYouKnowPending: false, expiresAt: Date.now() + 3600000 }), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    const button = screen.getByRole("button", { name: "Use night mode" });
    await userEvent.click(button);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("button", { name: "Use automatic theme" })).toBeInTheDocument();
  });
});
