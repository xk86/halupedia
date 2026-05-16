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
  });

  it("renders the home route and fetches homepage data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ featured: null, didYouKnow: [], expiresAt: Date.now() + 3600000 }), {
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
      summaryMarkdown: "Older body copy.",
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
      new Response(JSON.stringify({ featured: null, didYouKnow: [], expiresAt: Date.now() + 3600000 }), {
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
