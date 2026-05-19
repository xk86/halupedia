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
        new Response(JSON.stringify({ path: "/wiki/Ledger_tariff" }), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(pagePayload({
          article: {
            ...pagePayload().article,
            slug: "ledger-tariff",
            canonicalSlug: "ledger-tariff",
            title: "Ledger Tariff",
            html: "<h1>Ledger Tariff</h1><p>Random article body.</p>",
            markdown: "# Ledger Tariff\n\nRandom article body.",
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

    expect(await screen.findByRole("heading", { name: "Ledger Tariff" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/wiki/Ledger_tariff");
    expect(window.location.search).toBe("");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/random-page");
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/page/Ledger_tariff");
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
      promptModelAssociations: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/overview") {
        return new Response(JSON.stringify(overview), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/admin/generation-queue") {
        return new Response(JSON.stringify({ items: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/admin/regenerate-summary") {
        return new Response(JSON.stringify({
          ok: true,
          slug: "test-article",
          article: { title: "Test Article" },
        }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/admin");

    render(<App />);

    await screen.findByRole("heading", { name: "Admin" });
    await userEvent.type(screen.getByPlaceholderText("Slug or /wiki/ link for summary"), "https://host/wiki/Test_Article");
    await userEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));

    expect(await screen.findByText("Summary regenerated for Test Article.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/regenerate-summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "https://host/wiki/Test_Article" }),
    });
  });

  it("admin shows active generation queue entries", async () => {
    const overview = {
      articleCount: 1,
      linkCount: 0,
      aliasCount: 0,
      latestArticles: [],
      model: "test-model",
      databasePath: "test.sqlite",
      promptConfigPath: "config/prompts.toml",
      ragMode: "full",
      promptModelAssociations: [
        {
          key: "article",
          model: "heavy",
          modelName: "heavy-model",
          baseUrl: "http://heavy.test/v1",
          thinking: false,
        },
        {
          key: "article_summary",
          model: "light",
          modelName: "light-model",
          baseUrl: "http://light.test/v1",
          thinking: true,
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/admin/overview") {
          return Promise.resolve(
            new Response(JSON.stringify(overview), {
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url === "/api/admin/generation-queue") {
          return Promise.resolve(
            new Response(JSON.stringify({
              items: [
                {
                  slug: "queued-article",
                  title: "Queued Article",
                  seq: 7,
                  startedAt: 1715000000000,
                  waiting: 3,
                },
              ],
            }), {
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url === "/api/admin/prompt-model") {
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true, key: "article_summary", model: "heavy", thinking: true }), {
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/admin");

    render(<App />);

    expect(await screen.findByText("Queued Article")).toBeInTheDocument();
    expect(screen.getByText("3 waiting")).toBeInTheDocument();
    expect(screen.getByText("article_summary")).toBeInTheDocument();
    expect(screen.getByText("light-model")).toBeInTheDocument();
    expect(screen.getByText("on")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByDisplayValue("light"), "heavy");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/prompt-model", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "article_summary", model: "heavy", thinking: true }),
      });
    });
  });

  it("shows the DYK section with an empty placeholder instead of hiding it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        featured: {
          slug: "index-lamp",
          title: "Index Lamp",
          summaryMarkdown: "Index Lamp are ceremonial freshwater accountants.",
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

    expect(screen.getByText("Waiting and contemplating...")).toBeInTheDocument();
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
            slug: "archive-scouts",
            canonicalSlug: "archive-scouts",
            title: "Archive scouts",
            html: "<h1>Archive scouts</h1><p>Scout body.</p>",
            markdown: "# Archive scouts\n\nScout body.",
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
    await userEvent.type(input, "wiki/Archive_scouts");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(await screen.findByRole("heading", { name: "Archive scouts" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/wiki/Archive_scouts");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/page/Archive_scouts");
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
            slug: "ledger-tariff",
            canonicalSlug: "ledger-tariff",
            title: "Ledger tariff",
            html: "<h1>Ledger tariff</h1><p>Tariff body.</p>",
            markdown: "# Ledger tariff\n\nTariff body.",
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
    await userEvent.type(input, "https://example.invalid/prefix/wiki/Ledger_tariff?old=1");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(await screen.findByRole("heading", { name: "Ledger tariff" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/wiki/Ledger_tariff");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/page/Ledger_tariff");
  });

  it("copies the canonical slug from the article toolbar", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(pagePayload({
        article: {
          ...pagePayload().article,
          slug: "café-β-registry",
          canonicalSlug: "café-β-registry",
          title: "Café β Registry",
        },
      })), {
        headers: { "content-type": "application/json" },
      })
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    setPath(`/wiki/${encodeURIComponent("Café_β_Registry")}`);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Café β Registry" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy slug" }));
    expect(writeText).toHaveBeenCalledWith("café-β-registry");
    // Message now shows the slug itself so it's visible even if clipboard fails
    expect(screen.getByText("Slug: café-β-registry")).toBeInTheDocument();
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

  it("updates a generated article when post-processing adds See also", async () => {
    const initial = {
      slug: "fresh-page",
      canonicalSlug: "fresh-page",
      title: "Fresh Page",
      html: "<h1>Fresh Page</h1><p>Streaming body.</p>",
      markdown: "# Fresh Page\n\nStreaming body.",
      plain_text: "Streaming body.",
      generated_at: 1715000000002,
    };
    const updated = {
      ...initial,
      html: '<h1>Fresh Page</h1><p>Streaming body.</p><h2>See also</h2><ul><li><a href="/wiki/Related_Page">Related Page</a></li></ul>',
      markdown: '# Fresh Page\n\nStreaming body.\n\n## See also\n\n- [Related Page](halu:related-page "Related Page")',
      generated_at: 1715000001000,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/page/fresh_page") {
        return ndjsonResponse([
          { type: "start", slug: "fresh-page", cached: false },
          {
            type: "done",
            cached: false,
            canonicalPath: "/wiki/Fresh_Page",
            article: initial,
            backlinks: { existing: [], unwritten: [] },
          },
        ]);
      }
      if (url === "/api/page/Fresh_Page?wait=0") {
        return new Response(JSON.stringify({
          cached: true,
          canonicalPath: "/wiki/Fresh_Page",
          article: updated,
          backlinks: { existing: [], unwritten: [] },
        }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/fresh_page");

    render(<App />);

    expect(await screen.findByText("Streaming body.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "See also" }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Related Page" })).toBeInTheDocument();
  });

  it("polls for an article after a fast joined generation response", async () => {
    const generated = {
      slug: "gated-page",
      canonicalSlug: "gated-page",
      title: "Gated Page",
      html: "<h1>Gated Page</h1><p>Finished article.</p>",
      markdown: "# Gated Page\n\nFinished article.",
      plain_text: "Finished article.",
      generated_at: 1715000002000,
    };
    let pollCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/page/Gated_Page" || url === "/api/page/gated-page") {
        return ndjsonResponse([
          { type: "start", slug: "gated-page", cached: false, joined: true },
          { type: "status", message: "Waiting and contemplating..." },
        ]);
      }
      if (url === "/api/page/Gated_Page?wait=0" || url === "/api/page/gated-page?wait=0") {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(JSON.stringify({ generating: true }), {
            status: 202,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          cached: true,
          canonicalPath: "/wiki/Gated_Page",
          article: generated,
          backlinks: { existing: [], unwritten: [] },
        }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Gated_Page");

    render(<App />);

    expect(await screen.findByText("Finished article.", undefined, { timeout: 2500 })).toBeInTheDocument();
    expect(pollCount).toBeGreaterThanOrEqual(2);
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
      new Response(`${JSON.stringify({ type: "done", ...payload, refreshChanged: false })}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      })
    );
    await clickPromise;
    expect(await screen.findByText("References already up to date.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/article/test-article/refresh-context?stream=1", {
      method: "POST",
      headers: { accept: "application/x-ndjson" },
    });
  });

  it("reports article refresh when streamed refresh changes body content", async () => {
    const payload = pagePayload({
      article: {
        ...pagePayload().article,
        markdown: "# Test Article\n\nChanged body.",
        html: "<h1>Test Article</h1><p>Changed body.</p>",
      },
      refreshChanged: true,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(pagePayload()), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(`${JSON.stringify({ type: "done", ...payload })}\n`, {
          headers: { "content-type": "application/x-ndjson" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("button", { name: "Refresh with retrieved context" }));

    expect(await screen.findByText("Article refreshed.")).toBeInTheDocument();
    expect(await screen.findByText("Changed body.")).toBeInTheDocument();
  });

  it("shows a refresh notice when body references are missing from metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(pagePayload({
        referenceStatus: {
          missing: [{ slug: "source-article", title: "Source Article" }],
        },
      })), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    expect(await screen.findByText(/This article seems to cite references that are not listed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh with retrieved context" })).toBeInTheDocument();
  });

  it("shows a refresh notice when legacy references are embedded in the article body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(pagePayload({
        referenceStatus: {
          missing: [],
          unformatted: [],
          hasReferencesSection: true,
        },
      })), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    expect(await screen.findByText(/current reference format/)).toBeInTheDocument();
  });

  it("locks existing references during section edits", async () => {
    const payload = pagePayload({
      sections: [{ id: "notes", title: "Notes" }],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            references: [
              {
                slug: "source-entry",
                title: "Source Entry",
                summaryMarkdown: "Source summary.",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("button", { name: "Edit article" }));

    const refsCheckbox = await screen.findByRole("checkbox", { name: "Reference other articles" });
    await waitFor(() => expect(refsCheckbox).toBeChecked());
    expect(refsCheckbox).not.toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText("Section"), "notes");

    expect(refsCheckbox).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Source Entry" })).toBeDisabled();
  });

  it("can include recent edit prompts in a rewrite request", async () => {
    const payload = pagePayload();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ references: [] }), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        ndjsonResponse([{ type: "done", ...payload }])
      );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("button", { name: "Edit article" }));
    await userEvent.type(screen.getByPlaceholderText("Describe your changes."), "tighten the ending");
    await userEvent.click(screen.getByRole("button", { name: "Use last 2 edit prompts" }));
    await userEvent.click(screen.getByRole("button", { name: "Apply edit" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const rewriteInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect(JSON.parse(String(rewriteInit.body))).toMatchObject({
      instructions: "tighten the ending",
      includeRecentEditHistory: true,
      rewriteMode: "aggressive",
    });
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
    const refsResponse = new Response(
      JSON.stringify({ references: [] }),
      { headers: { "content-type": "application/json" } },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(original), {
          headers: { "content-type": "application/json" },
        })
      )
      // References fetch fires when the edit tray opens
      .mockResolvedValueOnce(refsResponse)
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
