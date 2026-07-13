import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import {
  emptyHomepagePayload,
  emptyTopArticlesPayload,
  pagePayload,
  setPath,
  setRichEditorMarkdown,
  withLiveBypass,
} from "./appTestHelpers";

// These tests each open two Base UI overlays back-to-back in a single test
// (a Dialog/editor plus a nested Select or AlertDialog). Base UI 1.6.0's
// FloatingFocusManager hides everything outside the active overlay via a
// module-level `aria-hidden`/`inert` marking singleton (markOthers.mjs),
// ref-counted across the whole process. Exercising many such overlays back
// to back in one large test file (as App.test.tsx does, at ~40 tests) can
// unbalance that counter, permanently mis-marking a later test's own
// interactive elements as inert and silently blocking clicks on them —
// `findByRole` then reports "element not found" for content that's actually
// present but inaccessible. Vitest isolates modules per test *file*, so
// keeping these nested-overlay sequences in their own smaller file keeps
// them (and the rest of App.test.tsx) clear of that cross-test accumulation.
describe("App overlay sequences", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("persists font and roundness changes immediately from the settings overlay", async () => {
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

    await userEvent.click(
      screen.getByRole("button", { name: "Theme/user settings" }),
    );

    await userEvent.click(
      screen.getByRole("combobox", { name: "Article font" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Georgia" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("option", { name: "Georgia" }),
      ).not.toBeInTheDocument(),
    );

    const radius = document.querySelector<HTMLInputElement>(
      "#theme-radius input[type='range']",
    );
    expect(radius).not.toBeNull();
    fireEvent.change(radius!, { target: { value: "12" } });

    expect(
      JSON.parse(
        window.localStorage.getItem("halupedia-user-settings") ?? "{}",
      ),
    ).toMatchObject({ articleFont: "georgia", radius: 12 });
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

  it("admin prompt editor: loads, edits, and saves a prompt", async () => {
    const overview = {
      articleCount: 0,
      linkCount: 0,
      aliasCount: 0,
      latestArticles: [],
      model: "test-model",
      databasePath: "test.sqlite",
      promptConfigPath: "config/prompts",
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
    await userEvent.click(screen.getByRole("tab", { name: "Prompts" }));

    // Select the article prompt (Base UI Select: open trigger, click option)
    const promptPicker = await screen.findByRole("combobox");
    await waitFor(() => expect(promptPicker).toBeEnabled());
    await userEvent.click(promptPicker);
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
});
