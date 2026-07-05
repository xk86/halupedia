import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptEditorPane } from "../../src/client/admin/panes/PromptEditorPane";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const defaultPrompt = {
  key: "article_image",
  scope: "runnable",
  system: "default system",
  user: "default user",
  model: "light",
  thinking: false,
  json: false,
  hasModes: false,
  path: "config/prompts/article_image.toml",
};

const psychedelicEditorialPrompt = {
  ...defaultPrompt,
  key: "psychedelic_editorial",
  system: "psychedelic editorial system",
  user: "psychedelic editorial user",
  path: "config/prompts/article_image_presets/psychedelic_editorial.toml",
};

describe("PromptEditorPane image presets", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("selects, creates, and deletes article image prompt presets", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/admin/prompts") {
          return jsonResponse({
            runnable: [
              {
                key: "article_image",
                scope: "runnable",
                model: "light",
                thinking: false,
                json: false,
                hasModes: false,
              },
            ],
            shared: [],
          });
        }
        if (url === "/api/admin/prompt/runnable/article_image")
          return jsonResponse(defaultPrompt);
        if (url === "/api/admin/article-image-prompts" && method === "GET") {
          return jsonResponse({
            prompts: [
              { key: "documentary_photo", label: "documentary_photo" },
              { key: "psychedelic_editorial", label: "psychedelic_editorial" },
              { key: "neon", label: "neon" },
            ],
          });
        }
        if (
          url === "/api/admin/article-image-prompts/psychedelic_editorial" &&
          method === "GET"
        )
          return jsonResponse(psychedelicEditorialPrompt);
        if (
          url === "/api/admin/article-image-prompts/psychedelic_editorial" &&
          method === "PUT"
        ) {
          return jsonResponse({
            ok: true,
            prompt: {
              ...psychedelicEditorialPrompt,
              system: "updated psychedelic editorial system",
            },
          });
        }
        if (
          url === "/api/admin/article-image-prompts/neon" &&
          method === "GET"
        ) {
          return jsonResponse({
            ...psychedelicEditorialPrompt,
            key: "neon",
            system: "neon system",
            path: "config/prompts/article_image_presets/neon.toml",
          });
        }
        if (url.endsWith("/revisions")) return jsonResponse({ revisions: [] });
        if (url === "/api/admin/article-image-prompts" && method === "POST") {
          return jsonResponse({
            ok: true,
            prompt: {
              ...psychedelicEditorialPrompt,
              key: "neon",
              system: "neon system",
              path: "config/prompts/article_image_presets/neon.toml",
            },
            prompts: [
              { key: "documentary_photo", label: "documentary_photo" },
              { key: "psychedelic_editorial", label: "psychedelic_editorial" },
              { key: "neon", label: "neon" },
            ],
          });
        }
        if (
          url === "/api/admin/article-image-prompts/psychedelic_editorial" &&
          method === "DELETE"
        ) {
          return jsonResponse({
            ok: true,
            prompts: [{ key: "documentary_photo", label: "documentary_photo" }],
          });
        }
        return jsonResponse({ error: "not found" }, 404);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PromptEditorPane />);

    expect(
      await screen.findByRole("textbox", {
        name: "article_image system prompt",
      }),
    ).toHaveValue("default system");

    expect(await screen.findByText("Image preset")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Image preset" }));
    await user.click(
      await screen.findByRole("option", { name: "psychedelic_editorial" }),
    );
    expect(
      await screen.findByText("psychedelic editorial system"),
    ).toBeInTheDocument();

    const systemInput = screen.getByRole("textbox", {
      name: "article_image system prompt",
    });
    expect(systemInput).toHaveValue("psychedelic editorial system");
    await user.clear(systemInput);
    await user.type(systemInput, "updated psychedelic editorial system");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/article-image-prompts/psychedelic_editorial",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            system: "updated psychedelic editorial system",
            user: "psychedelic editorial user",
          }),
        }),
      );
    });

    await user.type(screen.getByPlaceholderText(/new preset name/i), "Neon");
    await user.click(screen.getByRole("button", { name: /add preset/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/article-image-prompts",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "Neon",
            copyFrom: "psychedelic_editorial",
          }),
        }),
      );
    });
    expect(await screen.findByText("Preset created.")).toBeInTheDocument();
    expect(await screen.findByText("neon system")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Image preset" }));
    await user.click(
      await screen.findByRole("option", { name: "psychedelic_editorial" }),
    );
    await user.click(
      within(
        screen.getByTestId("prompt-editor-runnable-article_image"),
      ).getByRole("button", {
        name: /delete preset/i,
      }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/article-image-prompts/psychedelic_editorial",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("shows the first prompt immediately and can display every prompt", async () => {
    const articleMeta = {
      key: "article",
      scope: "runnable",
      description: "Writes a new article body.",
      usedBy: ["article.generate"],
      model: "heavy",
      thinking: true,
      json: false,
      hasModes: false,
    };
    const toneMeta = {
      key: "shared_tone",
      scope: "shared",
      description: "Base tone included by model-facing prompts.",
      usedBy: ["shared prompt include"],
      hasModes: false,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/prompts") {
        return jsonResponse({
          runnable: [articleMeta],
          shared: [toneMeta],
        });
      }
      if (url === "/api/admin/prompt/runnable/article") {
        return jsonResponse({
          ...articleMeta,
          system: "article system",
          user: "article user",
          path: "config/prompts/article.toml",
        });
      }
      if (url === "/api/admin/prompt/shared/shared_tone") {
        return jsonResponse({
          ...toneMeta,
          system: "tone system",
          user: "",
          path: "config/prompts/shared/shared_tone.toml",
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PromptEditorPane />);

    expect(
      await screen.findByRole("textbox", { name: "article system prompt" }),
    ).toHaveValue("article system");
    expect(screen.getByText("Writes a new article body.")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "All prompts",
      }),
    );

    expect(await screen.findByTestId("all-prompt-editors")).toBeInTheDocument();
    expect(
      await screen.findByRole("textbox", { name: "shared_tone system prompt" }),
    ).toHaveValue("tone system");
    expect(
      screen.getByTestId("prompt-editor-runnable-article"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("prompt-editor-shared-shared_tone"),
    ).toBeInTheDocument();
  });
});
