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
import {
  emptyHomepagePayload,
  emptyTopArticlesPayload,
  ndjsonResponse,
  pagePayload,
  setPath,
  setRichEditorMarkdown,
  withLiveBypass,
} from "./appTestHelpers";

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
    vi.stubGlobal(
      "EyeDropper",
      class {
        async open() {
          return { sRGBHex: "#123456" };
        }
      },
    );
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
    expect(screen.getByRole("status")).toHaveTextContent(/sRGB|P3|Rec\.2020/);
    expect(
      screen.getByRole("button", {
        name: "Contrast (WCAG). Click to switch to APCA.",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Color format" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Pick color from screen" }),
    ).toBeVisible();
    expect(
      screen.getByRole("listbox", { name: "Color swatches" }),
    ).toBeVisible();
    expect(screen.getByRole("slider", { name: "Opacity" })).toBeVisible();
    expect(
      screen.queryByLabelText("light Background OKLCH value"),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Add current color to swatches" }),
    );
    expect(
      JSON.parse(
        window.localStorage.getItem("halupedia-theme-color-swatches") ?? "[]",
      ),
    ).toContain("#F3ECD8");

    const hue = screen.getByRole("slider", { name: "Hue" });
    const backgroundHex = screen.getByLabelText("light Background HEX value");
    const initialHex = (backgroundHex as HTMLInputElement).value;
    hue.focus();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(backgroundHex).not.toHaveValue(initialHex));

    await userEvent.click(screen.getByRole("button", { name: "Chroma × hue" }));
    expect(screen.getByRole("slider", { name: "Lightness" })).toBeVisible();
    expect(
      screen.queryByRole("slider", { name: "Hue" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("listbox", { name: "Color swatches" }),
    ).not.toBeInTheDocument();

    fireEvent.change(backgroundHex, { target: { value: "112233" } });
    fireEvent.blur(backgroundHex);
    expect(backgroundHex).toHaveValue("#112233");
    await waitFor(() => {
      expect(
        JSON.parse(
          window.localStorage.getItem("halupedia-user-settings") ?? "{}",
        ).light.background,
      ).toBe(hexToOklch("#112233"));
    });

    await userEvent.click(screen.getByRole("button", { name: "Night" }));

    await waitFor(() => {
      expect(
        JSON.parse(
          window.localStorage.getItem("halupedia-user-settings") ?? "{}",
        ).mode,
      ).toBe("dark");
    });
    expect(document.documentElement.dataset.theme).toBe("dark");

    // Close the color-picker popover — leaving it open at teardown leaks
    // Base UI's scroll-lock state into later tests.
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("application", { name: "Color area" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("toggles full-screen theme settings without leaving the current page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(emptyHomepagePayload()), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    setPath("/");
    render(<App />);

    const settingsButton = screen.getByRole("button", {
      name: "Theme/user settings",
    });
    expect(settingsButton).toHaveAttribute("title", "Theme/user settings");
    expect(
      within(screen.getByRole("navigation")).queryByText("Settings"),
    ).not.toBeInTheDocument();

    await userEvent.click(settingsButton);

    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Appearance" }),
    ).toBeInTheDocument();

    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Theme/user settings",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(window.location.pathname).toBe("/");
    expect(
      screen.getByRole("heading", { name: "Halupedia" }),
    ).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("tab", { name: "Articles" }));
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
      if (url === "/api/admin/llm") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              hosts: [],
              roles: {
                heavy: {
                  hosts: ["host-a"],
                  model: "heavy-model",
                  candidates: ["host-a"],
                },
                light: {
                  hosts: ["host-b"],
                  model: "light-model",
                  candidates: ["host-b"],
                },
                images: {
                  hosts: ["host-c"],
                  model: "vision-model",
                  candidates: ["host-c"],
                },
                embeddings: {
                  hosts: ["host-d"],
                  model: "embedding-model",
                  candidates: ["host-d"],
                  enabled: true,
                },
              },
              imageGeneration: {
                enabled: false,
                autoGenerateForNewArticles: false,
                autoGenerateForFeaturedArticle: false,
                homepageAutoImageMaxAttempts: 3,
                autoPresetMultipass: false,
                backend: "openai",
                aspectRatios: [],
                openai: {
                  baseUrl: "",
                  apiKey: "",
                  model: "image-model",
                  quality: "low",
                  outputFormat: "jpeg",
                  outputCompression: 70,
                  timeoutMs: 120000,
                },
                ollama: {
                  baseUrl: "",
                  model: "image-model",
                  width: 1024,
                  height: 1024,
                  steps: 20,
                  timeoutMs: 120000,
                },
              },
            }),
            { headers: { "content-type": "application/json" } },
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
    expect(screen.getByText("3 waiting clients")).toBeInTheDocument();
    const modelSummary = screen.getByTestId("admin-model-role-summary");
    expect(
      await within(modelSummary).findByText("heavy-model"),
    ).toBeInTheDocument();
    expect(within(modelSummary).getByText("@ host-a")).toBeInTheDocument();
    expect(within(modelSummary).getByText("light-model")).toBeInTheDocument();
    expect(within(modelSummary).getByText("vision-model")).toBeInTheDocument();
    expect(
      within(modelSummary).getByText("embedding-model"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Models" }));
    const promptModelRow = screen.getByText("article_summary").closest("tr")!;
    expect(within(promptModelRow).getByText("light-model")).toBeInTheDocument();
    expect(within(promptModelRow).getByText("on")).toBeInTheDocument();

    // The model picker is now a Base UI Select (button + listbox), not a native
    // <select>: open the article_summary row's trigger and click "heavy".
    await userEvent.click(within(promptModelRow).getByRole("combobox"));
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

  it("admin shows pipeline run error messages inline", async () => {
    const overview = {
      articleCount: 1,
      linkCount: 0,
      aliasCount: 0,
      latestArticles: [],
      model: "test-model",
      databasePath: "test.sqlite",
      promptConfigPath: "config/prompts",
      promptModelAssociations: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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
      if (url === "/api/admin/pipeline/runs?limit=100") {
        return new Response(
          JSON.stringify({
            traceEnabled: true,
            runs: [
              {
                run_id: "run-image-error",
                workflow: "article.image_generate",
                slug: "new-article",
                started_at: 1715000000000,
                duration_ms: 33,
                status: "error",
                nodes_executed: 2,
                error_message: "unknown image aspect ratio: documentary_photo",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    setPath("/admin");

    render(<App />);

    await screen.findByRole("heading", { name: "Admin" });
    await userEvent.click(screen.getByRole("tab", { name: "Monitoring" }));
    expect(
      await screen.findByText("unknown image aspect ratio: documentary_photo"),
    ).toBeInTheDocument();
  });

  it("refreshes pipeline runs on a background poll and when an active run disappears", async () => {
    const polls: Array<{
      delay?: number;
      handler: () => void | Promise<void>;
    }> = [];
    vi.spyOn(window, "setInterval").mockImplementation((handler, delay) => {
      polls.push({
        delay: typeof delay === "number" ? delay : undefined,
        handler: handler as () => void | Promise<void>,
      });
      return polls.length as unknown as ReturnType<typeof setInterval>;
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
    const queuePoll = polls.find((poll) => poll.delay === 1000);
    const pipelinePoll = polls.find((poll) => poll.delay === 5000);
    expect(queuePoll).toBeDefined();
    expect(pipelinePoll).toBeDefined();

    await act(async () => {
      await pipelinePoll!.handler();
    });
    await waitFor(() => expect(runRequests).toBe(2));

    active = false;
    await act(async () => {
      await queuePoll!.handler();
    });
    await waitFor(() => expect(runRequests).toBe(3));
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

    await screen.findByRole("heading", { name: "Admin" });
    await userEvent.click(screen.getByRole("tab", { name: "Articles" }));
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

  it("toggles the edit tray from the article action and keeps Close at the top", async () => {
    const fetchMock = withLiveBypass((input) => {
      const url = String(input);
      const body = url.includes("/api/page/")
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

    const editToggle = screen.getByRole("button", { name: "Edit article" });
    expect(editToggle).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(editToggle);

    expect(editToggle).toHaveAttribute("aria-pressed", "true");
    const editTray = screen.getByRole("region", { name: "Edit article" });
    const closeButton = within(editTray).getByRole("button", { name: "Close" });
    const titleInput = within(editTray).getByRole("textbox", { name: /Title/ });
    expect(
      closeButton.compareDocumentPosition(titleInput) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await userEvent.click(editToggle);

    expect(editToggle).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.queryByRole("region", { name: "Edit article" }),
    ).not.toBeInTheDocument();
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
    expect(input).toHaveAttribute("spellcheck", "true");
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

  it("sends a one-off quick edit and keeps the vibe after streaming", async () => {
    const original = pagePayload();
    const updated = pagePayload({
      article: {
        ...original.article,
        html: "<h1>Test Article</h1><p>Concise body copy.</p>",
        markdown: "# Test Article\n\nConcise body copy.",
        plain_text: "Concise body copy.",
        generated_at: original.article.generated_at + 1,
      },
    });
    const fetchMock = withLiveBypass((input, init) => {
      const url = String(input);
      if (url.includes("/api/page/")) {
        return new Response(JSON.stringify(original), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/vibe")) {
        return new Response(
          JSON.stringify({ content: "Keep every date exact." }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/rewrite")) {
        expect((init as RequestInit)?.method).toBe("POST");
        return ndjsonResponse([
          {
            type: "progress",
            html: updated.article.html,
            markdown: updated.article.markdown,
          },
          { type: "done", ...updated },
        ]);
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
    await userEvent.click(screen.getByRole("button", { name: "Edit article" }));
    const quickInstruction = await screen.findByRole("textbox", {
      name: "Quick edit instruction",
    });
    await waitFor(() =>
      expect(screen.getByText("✓ Vibe saved")).toBeInTheDocument(),
    );

    await userEvent.type(quickInstruction, "Make the prose concise.");
    await userEvent.click(screen.getByRole("button", { name: "Quick edit" }));

    expect(await screen.findByText("Concise body copy.")).toBeInTheDocument();
    expect(quickInstruction).toHaveValue("");
    const rewriteCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/rewrite"),
    );
    expect(
      JSON.parse(String((rewriteCall![1] as RequestInit).body)),
    ).toMatchObject({ instructions: "Make the prose concise." });

    await userEvent.click(
      screen.getByRole("button", { name: "Raw markdown" }),
    );
    expect(
      document.querySelector<HTMLTextAreaElement>(".mdedit-raw-textarea"),
    ).toHaveValue("Keep every date exact.");
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
    await userEvent.click(
      screen.getByRole("button", { name: "Rewrite to vibe" }),
    );

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
