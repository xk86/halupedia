import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import { hexToOklch } from "../../src/client/theme";

function setPath(path: string) {
  window.history.replaceState({}, "", path);
}

// The article/instruction editors are ProseKit (WYSIWYG) — its contenteditable
// surface can't be driven in jsdom, but its "Raw markdown" footer toggle reveals
// a plain textarea that round-trips the same value. Use that to set editor text
// deterministically. Pass an index when more than one editor is on screen.
async function setRichEditorMarkdown(markdown: string, editorIndex = 0) {
  const toggles = screen.getAllByRole("button", { name: "Raw markdown" });
  await userEvent.click(toggles[editorIndex]);
  const textareas = document.querySelectorAll<HTMLTextAreaElement>(
    ".mdedit-raw-textarea",
  );
  const textarea =
    textareas[textareas.length === toggles.length ? editorIndex : 0];
  fireEvent.change(textarea, { target: { value: markdown } });
}

// Minimal well-shaped stand-ins for the homepage/top-articles endpoints —
// Homepage reads `data.didYouKnow.length` / `data.articles`, so a shared
// article-page payload (wrong shape) crashes it with "Cannot read properties
// of undefined (reading 'length')".
function emptyHomepagePayload() {
  return {
    featured: null,
    didYouKnow: [],
    generatedAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
  };
}
function emptyTopArticlesPayload() {
  return { articles: [] };
}

// The Sidebar subscribes to /api/article/:slug/live as soon as an article
// route is active — concurrently with the page-data fetch. Test fixtures
// built around a single shared mocked Response (mockResolvedValue / a fixed
// Response instance returned for every URL) break once that body is read
// twice ("Body is unusable: Body has already been read"). Wrapping the test's
// fetch implementation so /live requests short-circuit with a non-ok response
// (Sidebar bails out on `!res.ok` without touching the body) keeps the shared
// fixture pattern working without each test having to special-case /live.
function withLiveBypass(
  impl: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> | Response,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (/\/live(\?|$)/.test(String(input))) {
      return new Response(null, { status: 404 });
    }
    return impl(input, init);
  });
}

function pagePayload(overrides: Partial<any> = {}) {
  return {
    cached: true,
    article: {
      slug: "test-article",
      canonicalSlug: "test-article",
      title: "Test Article",
      html: '<h1>Test Article</h1><p>Body copy with <a href="/wiki/Linked_Article">Linked Article</a>.</p>',
      markdown:
        '# Test Article\n\nBody copy with [Linked Article](halu:linked-article "Hidden hint").',
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
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders the home route and fetches homepage data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          featured: null,
          didYouKnow: [],
          didYouKnowPending: false,
          expiresAt: Date.now() + 3600000,
        }),
        {
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Halupedia" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/homepage");
    expect(document.title).toBe("Halupedia");
  });

  it("renders persistent appearance settings at /settings", async () => {
    setPath("/settings");
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Appearance" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Live preview" }),
    ).toBeInTheDocument();
    // The real MarkdownEditor renders the shared sample in both panels.
    expect(screen.getAllByText(/cartographer/i).length).toBeGreaterThan(0);
    // Day and night palettes render side by side, not behind tabs.
    expect(screen.getByRole("heading", { name: "Day colors" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Night colors" })).toBeVisible();
    expect(
      screen.getByLabelText("dark Background HEX value"),
    ).toBeInTheDocument();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await userEvent.click(
      screen.getByRole("button", { name: "Edit light Background color" }),
    );
    expect(
      screen.getByRole("application", { name: "Color area" }),
    ).toBeVisible();
    const hue = screen.getByRole("slider", { name: "Hue" });
    const pickerValue = screen.getByLabelText(
      "light Background OKLCH value",
    ) as HTMLInputElement;
    const initialPickerValue = pickerValue.value;
    hue.focus();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(pickerValue).not.toHaveValue(initialPickerValue),
    );

    const backgroundHex = screen.getByLabelText("light Background HEX value");
    fireEvent.change(backgroundHex, { target: { value: "112233" } });
    fireEvent.blur(backgroundHex);
    expect(backgroundHex).toHaveValue("#112233");
    expect(screen.getByLabelText("light Background OKLCH value")).toHaveValue(
      hexToOklch("#112233"),
    );

    await userEvent.click(screen.getByRole("button", { name: "Night" }));

    await waitFor(() => {
      expect(
        JSON.parse(
          window.localStorage.getItem("halupedia-user-settings") ?? "{}",
        ).mode,
      ).toBe("dark");
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("random nav asks the server for a random page and redirects to it", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/homepage") {
        return new Response(
          JSON.stringify({
            featured: null,
            didYouKnow: [],
            expiresAt: Date.now() + 3600000,
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url === "/api/top-articles?limit=10") {
        return new Response(JSON.stringify({ articles: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/random-page") {
        return new Response(JSON.stringify({ path: "/wiki/Ledger_tariff" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/page/Ledger_tariff") {
        return new Response(
          JSON.stringify(
            pagePayload({
              article: {
                ...pagePayload().article,
                slug: "ledger-tariff",
                canonicalSlug: "ledger-tariff",
                title: "Ledger Tariff",
                html: "<h1>Ledger Tariff</h1><p>Random article body.</p>",
                markdown: "# Ledger Tariff\n\nRandom article body.",
                plain_text: "Random article body.",
              },
            }),
          ),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    await userEvent.click(screen.getByRole("link", { name: "Random" }));

    expect(
      await screen.findByRole("heading", { name: "Ledger Tariff" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/wiki/Ledger_tariff");
    expect(window.location.search).toBe("");
    expect(fetchMock).toHaveBeenCalledWith("/api/random-page");
    expect(fetchMock).toHaveBeenCalledWith("/api/page/Ledger_tariff");
  });

  it("admin can regenerate an article summary from a pasted wiki link", async () => {
    const overview = {
      articleCount: 1,
      linkCount: 0,
      aliasCount: 0,
      latestArticles: [],
      model: "test-model",
      databasePath: "test.sqlite",
      promptConfigPath: "config/prompts",
      ragMode: "full",
      promptModelAssociations: [],
    };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
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
        if (url === "/api/admin/pipeline/workflows") {
          return new Response(JSON.stringify({ workflows: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "/api/admin/pipeline/runs?limit=12") {
          return new Response(
            JSON.stringify({ traceEnabled: true, runs: [] }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url === "/api/admin/regenerate-summary") {
          return new Response(
            JSON.stringify({
              ok: true,
              slug: "test-article",
              article: { title: "Test Article" },
            }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/admin");

    render(<App />);

    await screen.findByRole("heading", { name: "Admin" });
    await userEvent.type(
      screen.getByPlaceholderText("Search or paste /wiki/ link…"),
      "https://host/wiki/Test_Article",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Regenerate summary" }),
    );

    expect(
      await screen.findByText("Summary regenerated for Test Article."),
    ).toBeInTheDocument();
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
      promptConfigPath: "config/prompts",
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
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
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
          new Response(
            JSON.stringify({
              items: [
                {
                  slug: "queued-article",
                  title: "Queued Article",
                  seq: 7,
                  startedAt: 1715000000000,
                  waiting: 3,
                },
              ],
            }),
            {
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }
      if (url === "/api/admin/pipeline/workflows") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              workflows: [
                {
                  name: "article.generate",
                  summary: "article.generate (14 nodes, read=2)",
                  nodes: [
                    { name: "read.article", kind: "read", conditional: false },
                  ],
                },
              ],
            }),
            {
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }
      if (url === "/api/admin/pipeline/runs?limit=12") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              traceEnabled: true,
              runs: [
                {
                  run_id: "run-1",
                  workflow: "article.generate",
                  slug: "queued-article",
                  started_at: 1715000000000,
                  duration_ms: 12,
                  status: "ok",
                  nodes_executed: 14,
                  error_message: null,
                },
              ],
            }),
            {
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }
      if (url === "/api/admin/prompt-model") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              key: "article_summary",
              model: "heavy",
              thinking: true,
            }),
            {
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/admin");

    render(<App />);

    expect(await screen.findByText("Queued Article")).toBeInTheDocument();
    // The waiting count is concatenated into the same <span> as the workflow
    // label/phase (e.g. "Active · 3 waiting"), so match on substring rather
    // than the exact combined text.
    expect(
      screen.getByText(
        (_, el) =>
          el?.classList.contains("admin-queue-meta") === true &&
          /3 waiting/.test(el.textContent ?? ""),
      ),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /Prompt Models/ }),
    );
    expect(screen.getByText("article_summary")).toBeInTheDocument();
    expect(screen.getByText("light-model")).toBeInTheDocument();
    expect(screen.getByText("on")).toBeInTheDocument();

    // The model picker is now a Base UI Select (button + listbox), not a native
    // <select>: open the article_summary row's trigger and click "heavy".
    const summaryRow = screen.getByText("light-model").closest("tr")!;
    await userEvent.click(within(summaryRow).getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "heavy" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/prompt-model", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: "article_summary",
          model: "heavy",
          thinking: true,
        }),
      });
    });
  });

  it("refreshes pipeline runs immediately when an active run disappears", async () => {
    const polls: Array<() => void | Promise<void>> = [];
    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      polls.push(handler as () => void | Promise<void>);
      return {} as ReturnType<typeof setInterval>;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});

    let active = true;
    let runRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/overview") {
        return new Response(
          JSON.stringify({
            articleCount: 0,
            linkCount: 0,
            aliasCount: 0,
            latestArticles: [],
            model: "test-model",
            databasePath: "test.sqlite",
            promptConfigPath: "config/prompts",
            ragMode: "full",
            promptModelAssociations: [],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/admin/generation-queue") {
        return new Response(
          JSON.stringify({
            items: active
              ? [
                  {
                    slug: "live-article",
                    title: "Live Article",
                    seq: 1,
                    startedAt: 100,
                    state: "llm",
                    workflow: "article.generate",
                    waiting: 0,
                  },
                ]
              : [],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/admin/pipeline/workflows") {
        return new Response(JSON.stringify({ workflows: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/admin/pipeline/runs?limit=100") {
        runRequests += 1;
        return new Response(JSON.stringify({ traceEnabled: true, runs: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/admin");

    render(<App />);
    await screen.findByRole("heading", { name: "Admin" });
    await waitFor(() => expect(runRequests).toBe(1));
    expect(screen.getByText("Live Article")).toBeInTheDocument();

    active = false;
    await act(async () => {
      await Promise.all(polls.map((poll) => poll()));
    });
    await waitFor(() => expect(runRequests).toBe(2));
  });

  it("admin can reset the featured article, forcing a regenerate of featured/DYK/timer together", async () => {
    const overview = {
      articleCount: 1,
      linkCount: 0,
      aliasCount: 0,
      latestArticles: [],
      model: "test-model",
      databasePath: "test.sqlite",
      promptConfigPath: "config/prompts",
      ragMode: "full",
      promptModelAssociations: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/overview") {
        return new Response(JSON.stringify(overview), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/admin/reset-featured-article") {
        return new Response(JSON.stringify({ status: "triggered" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/admin/generation-queue") {
        return new Response(JSON.stringify({ items: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/admin/pipeline/workflows") {
        return new Response(JSON.stringify({ workflows: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/admin/pipeline/runs?limit=12") {
        return new Response(JSON.stringify({ traceEnabled: false, runs: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/admin");

    render(<App />);

    const button = await screen.findByRole("button", {
      name: "Reset featured article",
    });
    await userEvent.click(button);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/reset-featured-article",
        { method: "POST" },
      );
    });
    expect(
      await screen.findByRole("button", { name: "Reset featured article" }),
    ).not.toBeDisabled();
  });

  it("shows the DYK section with an empty placeholder instead of hiding it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          featured: {
            slug: "index-lamp",
            title: "Index Lamp",
            summaryMarkdown:
              "Index Lamp are ceremonial freshwater accountants.",
          },
          didYouKnow: [],
          didYouKnowPending: false,
          expiresAt: Date.now() + 3600000,
        }),
        {
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Featured article" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Did you know..." }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Add or generate an article to seed the first featured fact.",
      ),
    ).toBeInTheDocument();
  });

  it("renders cached featured article, timer, and startup DYK without polling", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          featured: {
            slug: "test-article",
            title: "Test Article",
            summaryMarkdown: "A featured summary with $\\\\sigma$.",
          },
          didYouKnow: [
            {
              slug: "linked-article",
              title: "Linked Article",
              fact: '... [Linked Article](halu:linked-article "Linked Article") is filed under ceremonial ballast accounting.',
            },
          ],
          generatedAt: Date.now(),
          expiresAt: Date.now() + 3600000,
        }),
        {
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Featured article" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Test Article" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Homepage refreshes in/)).toBeInTheDocument();
    expect(
      document.querySelector(".homepage-summary .math-inline"),
    ).not.toBeNull();
    expect(
      await screen.findByRole("link", { name: "Linked Article" }),
    ).toHaveAttribute("href", "/wiki/Linked_Article");
    expect(
      screen.getByText(/is filed under ceremonial ballast accounting\./),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/homepage");
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === "/api/homepage"),
    ).toHaveLength(1);
  });

  it("refetches homepage when the cached payload expires", async () => {
    let homepageCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/top-articles?limit=10") {
        return new Response(JSON.stringify({ articles: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      homepageCalls += 1;
      if (homepageCalls === 1) {
        return new Response(
          JSON.stringify({
            featured: null,
            didYouKnow: [],
            generatedAt: Date.now(),
            expiresAt: Date.now() + 10,
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          featured: {
            slug: "refreshed-page",
            title: "Refreshed Page",
            summaryMarkdown: "A refreshed homepage summary.",
          },
          didYouKnow: [],
          generatedAt: Date.now() + 10,
          expiresAt: Date.now() + 3600010,
        }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    expect(
      await screen.findByText(
        "No articles yet. Search for a topic to generate your first entry.",
      ),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === "/api/homepage"),
    ).toHaveLength(1);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url) === "/api/homepage"),
      ).toHaveLength(2),
    );
    expect(
      await screen.findByRole("link", { name: "Refreshed Page" }),
    ).toBeInTheDocument();
  });

  it("loads and renders a cached article route", async () => {
    const fetchMock = withLiveBypass(
      () =>
        new Response(JSON.stringify(pagePayload()), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    expect(
      screen.getByText("Waiting and contemplating..."),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Test Article" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Linked Article" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit article" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Linking Article" }),
    ).toBeInTheDocument();
    expect(document.title).toBe("Test Article - Halupedia");
    expect(fetchMock).toHaveBeenCalledWith("/api/page/Test_Article");
  });

  it("header Go accepts a bare wiki path without nesting wiki twice", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/homepage") {
        return new Response(
          JSON.stringify({
            featured: null,
            didYouKnow: [],
            expiresAt: Date.now() + 3600000,
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url === "/api/top-articles?limit=10") {
        return new Response(JSON.stringify({ articles: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/page/Archive_scouts") {
        return new Response(
          JSON.stringify(
            pagePayload({
              article: {
                ...pagePayload().article,
                slug: "archive-scouts",
                canonicalSlug: "archive-scouts",
                title: "Archive scouts",
                html: "<h1>Archive scouts</h1><p>Scout body.</p>",
                markdown: "# Archive scouts\n\nScout body.",
                plain_text: "Scout body.",
              },
            }),
          ),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    const input = screen.getByPlaceholderText("Search the register...");
    await userEvent.type(input, "wiki/Archive_scouts");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(
      await screen.findByRole("heading", { name: "Archive scouts" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/wiki/Archive_scouts");
    expect(fetchMock).toHaveBeenCalledWith("/api/page/Archive_scouts");
  });

  it("header search dropdown shows live article results and navigates on click", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/homepage") {
        return new Response(
          JSON.stringify({
            featured: null,
            didYouKnow: [],
            expiresAt: Date.now() + 3600000,
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url === "/api/top-articles?limit=10") {
        return new Response(JSON.stringify({ articles: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("/api/search?")) {
        return new Response(
          JSON.stringify({
            results: [
              { slug: "clock-tower", title: "Clock Tower", exists: true },
              { slug: "ghost-clock", title: "Ghost Clock", exists: false },
            ],
            has_more: false,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/page/Clock_Tower") {
        return new Response(
          JSON.stringify(
            pagePayload({
              article: {
                ...pagePayload().article,
                slug: "clock-tower",
                canonicalSlug: "clock-tower",
                title: "Clock Tower",
                html: "<h1>Clock Tower</h1><p>Body.</p>",
                markdown: "# Clock Tower\n\nBody.",
                plain_text: "Body.",
              },
            }),
          ),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    const input = screen.getByPlaceholderText("Search the register...");
    await userEvent.type(input, "clock");

    // The existing article surfaces as a live suggestion; the unwritten one is filtered out.
    const result = await screen.findByRole("button", { name: "Clock Tower" });
    expect(screen.queryByRole("button", { name: "Ghost Clock" })).toBeNull();
    // The "Go to" literal-title option still appears alongside the live results.
    expect(screen.getByText(/Go to:/)).toBeInTheDocument();

    await userEvent.click(result);

    expect(
      await screen.findByRole("heading", { name: "Clock Tower" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/wiki/Clock_Tower");
    // Passing the literal title forwards it out-of-band as a request header,
    // so the page fetch carries the exact text alongside the canonical URL.
    expect(fetchMock).toHaveBeenCalledWith("/api/page/Clock_Tower", {
      headers: { "x-requested-title": "Clock%20Tower" },
    });

    // Regression: after navigating via a result the input keeps focus, so
    // typing again must reopen the dropdown without needing a re-focus.
    await userEvent.type(input, "clock");
    expect(await screen.findByText(/Go to:/)).toBeInTheDocument();
  });

  it("header Go accepts a full URL containing a wiki path", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/homepage") {
        return new Response(
          JSON.stringify({
            featured: null,
            didYouKnow: [],
            expiresAt: Date.now() + 3600000,
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url === "/api/top-articles?limit=10") {
        return new Response(JSON.stringify({ articles: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/page/Ledger_tariff") {
        return new Response(
          JSON.stringify(
            pagePayload({
              article: {
                ...pagePayload().article,
                slug: "ledger-tariff",
                canonicalSlug: "ledger-tariff",
                title: "Ledger tariff",
                html: "<h1>Ledger tariff</h1><p>Tariff body.</p>",
                markdown: "# Ledger tariff\n\nTariff body.",
                plain_text: "Tariff body.",
              },
            }),
          ),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    const input = screen.getByPlaceholderText("Search the register...");
    await userEvent.type(
      input,
      "https://example.invalid/prefix/wiki/Ledger_tariff?old=1",
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(
      await screen.findByRole("heading", { name: "Ledger tariff" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/wiki/Ledger_tariff");
    expect(fetchMock).toHaveBeenCalledWith("/api/page/Ledger_tariff");
  });

  it("copies the canonical slug from the article toolbar", async () => {
    const fetchMock = withLiveBypass(
      () =>
        new Response(
          JSON.stringify(
            pagePayload({
              article: {
                ...pagePayload().article,
                slug: "café-β-registry",
                canonicalSlug: "café-β-registry",
                title: "Café β Registry",
              },
            }),
          ),
          {
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    setPath(`/wiki/${encodeURIComponent("Café_β_Registry")}`);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Café β Registry" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy slug" }));
    expect(writeText).toHaveBeenCalledWith("café-β-registry");
    // Message now shows the slug itself so it's visible even if clipboard fails
    expect(screen.getByText("Slug: café-β-registry")).toBeInTheDocument();
  });

  it("handles streamed article responses and normalizes the canonical path", async () => {
    const fetchMock = withLiveBypass(() =>
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
            markdown:
              '# Fresh Page\n\nStreaming body with [Alpha](halu:alpha "Hint").',
            plain_text: "Streaming body with Alpha.",
            generated_at: 1715000000002,
          },
          backlinks: { existing: [], unwritten: [] },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/fresh_page");

    render(<App />);

    expect(
      await screen.findByText("Fresh generation from local canon."),
    ).toBeInTheDocument();
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
      markdown:
        '# Fresh Page\n\nStreaming body.\n\n## See also\n\n- [Related Page](halu:related-page "Related Page")',
      generated_at: 1715000001000,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/live(\?|$)/.test(url)) {
        return new Response(null, { status: 404 });
      }
      // toWikiSegment("fresh_page") capitalizes the first letter -> "Fresh_page"
      if (url === "/api/page/Fresh_page") {
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
        return new Response(
          JSON.stringify({
            cached: true,
            canonicalPath: "/wiki/Fresh_Page",
            article: updated,
            backlinks: { existing: [], unwritten: [] },
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/fresh_page");

    render(<App />);

    expect(await screen.findByText("Streaming body.")).toBeInTheDocument();
    expect(
      await screen.findByRole(
        "heading",
        { name: "See also" },
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Related Page" }),
    ).toBeInTheDocument();
  });

  it("renders a joined generation stream directly from progress/done events without polling", async () => {
    // Joined streams (the requester arrives mid-generation) now receive live
    // progress/done events over the same stream — no separate ?wait=0 polling
    // (see App.tsx: "Joined streams now receive live progress events").
    const generated = {
      slug: "gated-page",
      canonicalSlug: "gated-page",
      title: "Gated Page",
      html: "<h1>Gated Page</h1><p>Finished article.</p>",
      markdown: "# Gated Page\n\nFinished article.",
      plain_text: "Finished article.",
      generated_at: 1715000002000,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/page/Gated_Page") {
        return ndjsonResponse([
          { type: "start", slug: "gated-page", cached: false, joined: true },
          { type: "status", message: "Waiting and contemplating..." },
          { type: "progress", html: "<h1>Gated Page</h1><p>Drafting…</p>" },
          {
            type: "done",
            cached: true,
            canonicalPath: "/wiki/Gated_Page",
            article: generated,
            backlinks: { existing: [], unwritten: [] },
          },
        ]);
      }
      if (/\/live(\?|$)/.test(url)) {
        return new Response(null, { status: 404 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Gated_Page");

    render(<App />);

    expect(
      await screen.findByText("Finished article.", undefined, {
        timeout: 2500,
      }),
    ).toBeInTheDocument();
    // No ?wait=0 polling requests should have been issued for a joined stream.
    expect(fetchMock.mock.calls.some(([u]) => /\?wait=0/.test(String(u)))).toBe(
      false,
    );
  });

  it("intercepts article link clicks and fetches the next article client-side", async () => {
    const fetchMock = withLiveBypass((input) => {
      const url = String(input);
      if (url === "/api/page/Test_Article") {
        return new Response(JSON.stringify(pagePayload()), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/page/Linked_Article") {
        return new Response(
          JSON.stringify(
            pagePayload({
              article: {
                slug: "linked-article",
                canonicalSlug: "linked-article",
                title: "Linked Article",
                html: "<h1>Linked Article</h1><p>Second page body.</p>",
                markdown:
                  '# Linked Article\n\nSecond page body with [Alpha](halu:alpha "Hint").',
                plain_text: "Second page body.",
                generated_at: 1715000000003,
              },
              backlinks: { existing: [], unwritten: [] },
            }),
          ),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("link", { name: "Linked Article" }));

    expect(
      await screen.findByRole("heading", { name: "Linked Article" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/page/Linked_Article");
    expect(window.location.pathname).toBe("/wiki/Linked_Article");
  });

  it("shows an empty-history message instead of a raw 404", async () => {
    const fetchMock = withLiveBypass((input) => {
      const url = String(input);
      if (url === "/api/article/test-article/history") {
        return new Response(JSON.stringify({ error: "article not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      // /api/page/Test_Article — both the initial load and the history-route
      // reload resolve to the same cached article payload.
      return new Response(JSON.stringify(pagePayload()), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("button", { name: "View history" }));

    expect(await screen.findByText("No edit history yet.")).toBeInTheDocument();
  });

  it("raw edit saves block-mode edits (default WYSIWYG path)", async () => {
    const original = pagePayload({
      article: {
        ...pagePayload().article,
        markdown: "# Test Article\n\nOriginal body paragraph.",
        html: "<h1>Test Article</h1><p>Original body paragraph.</p>",
        plain_text: "Original body paragraph.",
      },
    });
    const updated = pagePayload({
      article: {
        ...original.article,
        markdown: "# Test Article\n\nRewritten in block mode.",
        html: "<h1>Test Article</h1><p>Rewritten in block mode.</p>",
        plain_text: "Rewritten in block mode.",
      },
    });
    const fetchMock = withLiveBypass((input) => {
      const url = String(input);
      if (url.includes("/raw-save")) {
        return new Response(JSON.stringify({ article: updated.article }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/references")) {
        return new Response(JSON.stringify({ references: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/page/")) {
        return new Response(JSON.stringify(original), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ image: null }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);
    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("button", { name: "Edit article" }));
    await userEvent.click(screen.getByRole("button", { name: "Raw" }));

    await setRichEditorMarkdown("# Test Article\n\nRewritten in block mode.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const rawCall = fetchMock.mock.calls.find(
        ([u, callInit]) =>
          String(u).includes("/raw-save") &&
          (callInit as RequestInit)?.method === "POST",
      );
      expect(rawCall).toBeDefined();
      expect(
        JSON.parse(String((rawCall![1] as RequestInit).body)).markdown,
      ).toContain("Rewritten in block mode.");
    });
  });

  it("confirms before leaving a page with unsaved in-place edits", async () => {
    const fetchMock = withLiveBypass((input) => {
      const url = String(input);
      const body = url.includes("/api/homepage")
        ? emptyHomepagePayload()
        : url.includes("/api/top-articles")
          ? emptyTopArticlesPayload()
          : url.includes("/api/page/")
            ? pagePayload()
            : url.includes("/references")
              ? { references: [] }
              : { image: null };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);
    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("button", { name: "Edit article" }));
    await userEvent.click(screen.getByRole("button", { name: "Raw" }));
    await setRichEditorMarkdown("# Test Article\n\nUnsaved local change.");

    // Leaving via the home link raises the discard confirm; the page stays.
    await userEvent.click(screen.getByRole("link", { name: "Halupedia" }));
    expect(
      await screen.findByText("Discard unsaved edits?"),
    ).toBeInTheDocument();
    // Navigation is held: still in the in-place editor.
    expect(document.querySelector(".article--editing")).toBeTruthy();

    // "Stay on page" dismisses the dialog and keeps the editor open.
    await userEvent.click(screen.getByRole("button", { name: "Stay on page" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Discard unsaved edits?"),
      ).not.toBeInTheDocument(),
    );
    expect(document.querySelector(".article--editing")).toBeTruthy();

    // "Discard changes" closes the editor and follows the navigation.
    await userEvent.click(screen.getByRole("link", { name: "Halupedia" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() =>
      expect(document.querySelector(".article--editing")).toBeNull(),
    );
  });

  it("closes the editor without confirming when leaving with no unsaved edits", async () => {
    const fetchMock = withLiveBypass((input) => {
      const url = String(input);
      const body = url.includes("/api/homepage")
        ? emptyHomepagePayload()
        : url.includes("/api/top-articles")
          ? emptyTopArticlesPayload()
          : url.includes("/api/page/")
            ? pagePayload()
            : url.includes("/references")
              ? { references: [] }
              : { image: null };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);
    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("button", { name: "Edit article" }));
    await userEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(document.querySelector(".article--editing")).toBeTruthy();

    // No edits made → navigating away just closes the editor, no dialog.
    await userEvent.click(screen.getByRole("link", { name: "Halupedia" }));
    expect(
      screen.queryByText("Discard unsaved edits?"),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector(".article--editing")).toBeNull(),
    );
  });

  it("raw edit applies markdown and refreshes an already-open revision history", async () => {
    const original = pagePayload();
    const updated = pagePayload({
      article: {
        ...original.article,
        markdown: "# Test Article\n\nChanged by raw save.",
        html: "<h1>Test Article</h1><p>Changed by raw save.</p>",
        plain_text: "Changed by raw save.",
      },
    });
    let historyCalls = 0;
    const fetchMock = withLiveBypass((input, init) => {
      const url = String(input);
      if (url.includes("/api/page/")) {
        return new Response(JSON.stringify(original), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/history")) {
        historyCalls += 1;
        const revisions =
          historyCalls === 1
            ? []
            : [
                {
                  id: 9,
                  title: "Test Article",
                  html: updated.article.html,
                  markdown: updated.article.markdown,
                  summaryMarkdown: "Changed by raw save.",
                  generatedAt: 1715000000001,
                  createdAt: 1715000000002,
                  operation: "raw-edit",
                  instructions: "raw-edit",
                  revertedFromRevisionId: null,
                },
              ];
        return new Response(JSON.stringify({ revisions }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/raw-save")) {
        expect((init as RequestInit)?.method).toBe("POST");
        return new Response(JSON.stringify({ article: updated.article }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/references")) {
        return new Response(JSON.stringify({ references: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ image: null }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("button", { name: "View history" }));
    expect(await screen.findByText("No edit history yet.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit article" }));
    await userEvent.click(screen.getByRole("button", { name: "Raw" }));
    await setRichEditorMarkdown("# Test Article\n\nChanged by raw save.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const rawCall = fetchMock.mock.calls.find(
        ([u, callInit]) =>
          String(u).includes("/raw-save") &&
          (callInit as RequestInit)?.method === "POST",
      );
      expect(rawCall).toBeDefined();
      expect(
        JSON.parse(String((rawCall![1] as RequestInit).body)),
      ).toMatchObject({
        markdown: "# Test Article\n\nChanged by raw save.",
      });
    });
    await waitFor(() => {
      expect(
        screen.getAllByText("Changed by raw save.").length,
      ).toBeGreaterThan(0);
      expect(screen.getAllByText("raw-edit").length).toBeGreaterThan(0);
    });
    expect(historyCalls).toBe(2);
  });

  it("shows refresh feedback when references are unchanged", async () => {
    const payload = pagePayload();
    const refreshUrl = "/api/article/test-article/refresh-context?stream=1";
    let resolveRefresh: (value: Response) => void = () => {};
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = withLiveBypass((input) => {
      const url = String(input);
      if (url === refreshUrl) return refreshResponse;
      return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    const clickPromise = userEvent.click(
      screen.getByRole("button", { name: "Refresh with retrieved context" }),
    );

    expect(
      await screen.findByText("Refreshing with retrieved context..."),
    ).toBeInTheDocument();
    resolveRefresh(
      new Response(
        `${JSON.stringify({ type: "done", ...payload, refreshChanged: false })}\n`,
        {
          headers: { "content-type": "application/x-ndjson" },
        },
      ),
    );
    await clickPromise;
    expect(
      await screen.findByText("References already up to date."),
    ).toBeInTheDocument();
    // objectContaining: the refresh request also passes an AbortSignal now,
    // which isn't relevant to what this test is verifying.
    expect(fetchMock).toHaveBeenCalledWith(
      refreshUrl,
      expect.objectContaining({
        method: "POST",
        headers: { accept: "application/x-ndjson" },
      }),
    );
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
    const refreshUrl = "/api/article/test-article/refresh-context?stream=1";
    const fetchMock = withLiveBypass((input) => {
      const url = String(input);
      if (url === refreshUrl) {
        return new Response(
          `${JSON.stringify({ type: "done", ...payload })}\n`,
          {
            headers: { "content-type": "application/x-ndjson" },
          },
        );
      }
      return new Response(JSON.stringify(pagePayload()), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh with retrieved context" }),
    );

    expect(await screen.findByText("Article refreshed.")).toBeInTheDocument();
    expect(await screen.findByText("Changed body.")).toBeInTheDocument();
  });

  it("shows a refresh notice when body references are missing from metadata", async () => {
    const fetchMock = withLiveBypass(
      () =>
        new Response(
          JSON.stringify(
            pagePayload({
              referenceStatus: {
                missing: [{ slug: "source-article", title: "Source Article" }],
              },
            }),
          ),
          {
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    expect(
      await screen.findByText(
        /This article seems to cite references that are not listed/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh with retrieved context" }),
    ).toBeInTheDocument();
  });

  it("shows a refresh notice when legacy references are embedded in the article body", async () => {
    const fetchMock = withLiveBypass(
      () =>
        new Response(
          JSON.stringify(
            pagePayload({
              referenceStatus: {
                missing: [],
                unformatted: [],
                hasReferencesSection: true,
              },
            }),
          ),
          {
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    expect(
      await screen.findByText(/current reference format/),
    ).toBeInTheDocument();
  });

  it("locks existing references during section edits", async () => {
    const payload = pagePayload({
      sections: [{ id: "notes", title: "Notes" }],
    });
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/page/"))
        return new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        });
      if (u.includes("/references"))
        return new Response(
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
        );
      return new Response(JSON.stringify({ image: null }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("button", { name: "Edit article" }));

    const refsCheckbox = await screen.findByRole("checkbox", {
      name: "Reference other articles",
    });
    await waitFor(() => expect(refsCheckbox).toBeChecked());
    // Base UI Checkbox renders a <span role=checkbox>, so disabled state is
    // aria-disabled (not the native disabled attribute / toBeDisabled).
    expect(refsCheckbox).not.toHaveAttribute("aria-disabled", "true");

    // Section picker is now a Base UI Select: open it and click the "Notes" option.
    await userEvent.click(screen.getByRole("combobox", { name: "Section" }));
    await userEvent.click(await screen.findByRole("option", { name: "Notes" }));

    expect(refsCheckbox).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("button", { name: "Remove Source Entry" }),
    ).toBeDisabled();
  });

  it("can include recent edit prompts in a rewrite request", async () => {
    const payload = pagePayload();
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/api/page/"))
          return new Response(JSON.stringify(payload), {
            headers: { "content-type": "application/json" },
          });
        if (u.includes("/rewrite"))
          return ndjsonResponse([{ type: "done", ...payload }]);
        if (u.includes("/references"))
          return new Response(JSON.stringify({ references: [] }), {
            headers: { "content-type": "application/json" },
          });
        return new Response(JSON.stringify({ image: null }), {
          headers: { "content-type": "application/json" },
        });
      });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("button", { name: "Edit article" }));
    await setRichEditorMarkdown("tighten the ending");
    await userEvent.click(
      screen.getByRole("button", { name: "Use last 2 edit prompts" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Apply edit" }));

    // Wait for the rewrite POST to appear among the calls
    await waitFor(() => {
      const rewriteCall = fetchMock.mock.calls.find(
        ([u, init]) =>
          String(u).includes("/rewrite") &&
          (init as RequestInit)?.method === "POST",
      );
      expect(rewriteCall).toBeDefined();
    });
    const rewriteCall = fetchMock.mock.calls.find(
      ([u, init]) =>
        String(u).includes("/rewrite") &&
        (init as RequestInit)?.method === "POST",
    )!;
    expect(
      JSON.parse(String((rewriteCall[1] as RequestInit).body)),
    ).toMatchObject({
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
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/page/"))
        return new Response(JSON.stringify(original), {
          headers: { "content-type": "application/json" },
        });
      if (u.includes("/rewrite"))
        return ndjsonResponse([
          {
            type: "progress",
            html: "<h1>Energy storage</h1><p>Maternal Energy Potential refers to rejected renamed article body.</p>",
            markdown:
              "# Energy storage\n\nMaternal Energy Potential refers to rejected renamed article body.",
          },
          {
            type: "error",
            message:
              'article lead subject did not match requested title: requested="Energy storage" got="Maternal Energy Potential"',
          },
        ]);
      if (u.includes("/references"))
        return new Response(JSON.stringify({ references: [] }), {
          headers: { "content-type": "application/json" },
        });
      return new Response(JSON.stringify({ image: null }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Energy_storage");

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Energy storage" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Original retained energy body."),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit article" }));
    await setRichEditorMarkdown("make this article to be about your mom");
    await userEvent.click(screen.getByRole("button", { name: "Apply edit" }));

    expect(
      await screen.findByText(
        'article lead subject did not match requested title: requested="Energy storage" got="Maternal Energy Potential"',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Energy storage" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Original retained energy body."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Rejected renamed article body."),
    ).not.toBeInTheDocument();
  });

  it("opens history in-page and restores only after confirmation", async () => {
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
    const fetchMock = withLiveBypass((input) => {
      const url = String(input);
      if (url === "/api/article/test-article/history") {
        return new Response(JSON.stringify({ revisions: [oldRevision] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/article/test-article/revert") {
        return new Response(JSON.stringify(restored), {
          headers: { "content-type": "application/json" },
        });
      }
      // /api/page/Test_Article — both the initial load and the history-route
      // reload resolve to the same cached article payload.
      return new Response(JSON.stringify(current), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/wiki/Test_Article");

    render(<App />);

    await screen.findByRole("heading", { name: "Test Article" });
    await userEvent.click(screen.getByRole("button", { name: "View history" }));

    // History renders in-page: the URL never changes (a /history suffix used
    // to be mangled into "..._urlhistory" by back-button navigation).
    expect(window.location.pathname).toBe("/wiki/Test_Article");
    expect(
      await screen.findByRole("heading", { name: "History" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Earlier edit.")).toBeInTheDocument();
    expect(
      document.querySelector(".history-summary .math-inline"),
    ).not.toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "View revision 7" }),
    );
    expect(
      await screen.findByText("You are viewing an old revision."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Older body copy.").length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/article/test-article/revert",
      expect.objectContaining({ method: "POST" }),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    expect(screen.getByText("Restore this old revision?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Yes, restore" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/article/test-article/revert",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByText("Version restored.")).toBeInTheDocument();
  });

  it("admin prompt editor: loads, edits, and saves a prompt", async () => {
    const overview = {
      articleCount: 0,
      linkCount: 0,
      aliasCount: 0,
      latestArticles: [],
      model: "test-model",
      databasePath: "test.sqlite",
      promptConfigPath: "config/prompts",
      ragMode: "full",
      promptModelAssociations: [],
    };
    const promptContent = {
      key: "article",
      scope: "runnable",
      system: "original system text",
      user: "original user text",
      model: "heavy",
      thinking: false,
      json: false,
      hasModes: false,
      path: "config/prompts/article.toml",
    };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/admin/overview")
          return new Response(JSON.stringify(overview), {
            headers: { "content-type": "application/json" },
          });
        if (url === "/api/admin/generation-queue")
          return new Response(JSON.stringify({ items: [] }), {
            headers: { "content-type": "application/json" },
          });
        if (url === "/api/admin/pipeline/workflows")
          return new Response(JSON.stringify({ workflows: [] }), {
            headers: { "content-type": "application/json" },
          });
        if (url === "/api/admin/pipeline/runs?limit=12")
          return new Response(
            JSON.stringify({ traceEnabled: false, runs: [] }),
            { headers: { "content-type": "application/json" } },
          );
        if (url === "/api/admin/prompts")
          return new Response(
            JSON.stringify({
              runnable: [
                {
                  key: "article",
                  scope: "runnable",
                  model: "heavy",
                  thinking: false,
                  json: false,
                  hasModes: false,
                },
              ],
              shared: [],
            }),
            { headers: { "content-type": "application/json" } },
          );
        if (url === "/api/admin/prompt/runnable/article" && method === "GET")
          return new Response(JSON.stringify(promptContent), {
            headers: { "content-type": "application/json" },
          });
        if (url === "/api/admin/prompt/runnable/article" && method === "PUT") {
          const body = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              ok: true,
              prompt: {
                ...promptContent,
                system: body.system,
                user: body.user,
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/admin");

    render(<App />);

    await screen.findByRole("heading", { name: "Admin" });

    // Expand the Prompt Editor pane (collapsed by default)
    const paneHeader = screen.getByRole("button", {
      name: /Prompt Editor/i,
      hidden: true,
    });
    await userEvent.click(paneHeader);

    // Select the article prompt (Base UI Select: open trigger, click option)
    await userEvent.click(await screen.findByRole("combobox"));
    await userEvent.click(
      await screen.findByRole("option", { name: "article" }),
    );

    // Prompt text loads as rendered markdown blocks — click to destructure
    // into the raw source textarea.
    await userEvent.click(await screen.findByText("original system text"));
    const systemTA = await screen.findByDisplayValue("original system text");

    // Edit the system block
    await userEvent.clear(systemTA);
    await userEvent.type(systemTA, "updated system text");

    // Save button becomes enabled and can be clicked
    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect(saveBtn).not.toBeDisabled();
    await userEvent.click(saveBtn);

    // Confirm the PUT was called with edited content
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/prompt/runnable/article",
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining("updated system text"),
        }),
      );
    });

    expect(
      await screen.findByText("Saved — runtime reloaded."),
    ).toBeInTheDocument();
  });

  it("toggles night mode from the header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          featured: null,
          didYouKnow: [],
          didYouKnowPending: false,
          expiresAt: Date.now() + 3600000,
        }),
        {
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    const button = screen.getByRole("button", { name: "Use night mode" });
    await userEvent.click(button);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(
      screen.getByRole("button", { name: "Use day mode" }),
    ).toBeInTheDocument();
  });

  it("normalises spaces to underscores in the URL immediately when navigating via the search bar", async () => {
    const fetchMock = withLiveBypass((input) => {
      const url = String(input);
      if (url === "/api/homepage") {
        return new Response(JSON.stringify(emptyHomepagePayload()), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("/api/top-articles")) {
        return new Response(JSON.stringify(emptyTopArticlesPayload()), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(pagePayload()), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    const input = screen.getByPlaceholderText("Search the register...");
    await userEvent.type(input, "Differences in penis size");
    await userEvent.keyboard("{Enter}");

    // URL must have underscores, not spaces, before any server response.
    expect(window.location.pathname).toBe("/wiki/Differences_in_penis_size");
  });

  it("preserves colons and other punctuation typed into the search bar as an out-of-band requested title", async () => {
    // The URL path segment is slug-safe and drops punctuation like ":" (e.g.
    // "Test: The Movie" -> /wiki/Test_The_Movie, with a clean URL — no query
    // params). The client must still carry the user's literal typed text to
    // the server so the model receives "Test: The Movie" verbatim rather than
    // reconstructing an approximation from the slug — sent out-of-band as a
    // request header (x-requested-title), invisible in the address bar.
    const fetchMock = withLiveBypass((input) => {
      const url = String(input);
      if (url === "/api/homepage") {
        return new Response(JSON.stringify(emptyHomepagePayload()), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("/api/top-articles")) {
        return new Response(JSON.stringify(emptyTopArticlesPayload()), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify(
          pagePayload({
            article: { ...pagePayload().article, title: "Test: The Movie" },
          }),
        ),
        {
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    const input = screen.getByPlaceholderText("Search the register...");
    await userEvent.type(input, "Test: The Movie");
    await userEvent.keyboard("{Enter}");

    // URL stays title-shaped and clean: no query string.
    expect(window.location.pathname).toBe("/wiki/Test_The_Movie");
    expect(window.location.search).toBe("");
    await waitFor(() => {
      // HTTP header values must be ASCII/Latin-1 — titles with punctuation or
      // emoji are percent-encoded for transport (the server decodes them back).
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/page/Test_The_Movie",
        expect.objectContaining({
          headers: {
            "x-requested-title": encodeURIComponent("Test: The Movie"),
          },
        }),
      );
    });
  });

  it("shows the typed title (with punctuation) immediately while the article streams in", async () => {
    // While generating, the placeholder title must be the user's literal typed
    // text — punctuation and all ("Rat: Eating Test") — not the slug-derived
    // "Rat Eating Test" that only gets the colon back once generation finishes.
    const fetchMock = withLiveBypass((input) => {
      const url = String(input);
      if (url === "/api/homepage") {
        return new Response(JSON.stringify(emptyHomepagePayload()), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("/api/top-articles")) {
        return new Response(JSON.stringify(emptyTopArticlesPayload()), {
          headers: { "content-type": "application/json" },
        });
      }
      // A stream that opens with a `start` event and stays open (never sends
      // `done`) so we observe the placeholder title, not the final one.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                type: "start",
                slug: "rat-eating-test",
                cached: false,
              }) + "\n",
            ),
          );
          // intentionally left open
        },
      });
      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    const input = screen.getByPlaceholderText("Search the register...");
    await userEvent.click(input);
    await userEvent.type(input, "Rat: Eating Test");
    // Navigate via the "Go to:" suggestion button (the path that previously
    // dropped the typed title), not the form submit.
    await userEvent.click(
      await screen.findByRole("button", { name: /Go to:/ }),
    );

    expect(
      await screen.findByRole("heading", { name: "Rat: Eating Test" }),
    ).toBeInTheDocument();
  });

  it("normalises a URL with spaces when loaded directly (e.g. pasted into address bar)", async () => {
    const fetchMock = withLiveBypass(
      () =>
        new Response(JSON.stringify(pagePayload()), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // Simulate browser decoding %20 spaces in the URL.
    setPath("/wiki/Differences in penis size");

    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/wiki/Differences_in_penis_size");
    });
  });

  it("normalises a title with hyphens that also has spaces (previous regression)", async () => {
    const fetchMock = withLiveBypass((input) => {
      const url = String(input);
      if (url === "/api/homepage") {
        return new Response(JSON.stringify(emptyHomepagePayload()), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("/api/top-articles")) {
        return new Response(JSON.stringify(emptyTopArticlesPayload()), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(pagePayload()), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/");

    render(<App />);

    const input = screen.getByPlaceholderText("Search the register...");
    await userEvent.type(input, "human-horse hybrids");
    await userEvent.keyboard("{Enter}");

    // Hyphen in input must not bypass space→underscore normalisation.
    expect(window.location.pathname).toBe("/wiki/Human-horse_hybrids");
  });
});
