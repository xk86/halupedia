import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

const conceptualPrompt = {
  ...defaultPrompt,
  key: "conceptual",
  system: "conceptual system",
  user: "conceptual user",
  path: "config/prompts/article_image_presets/conceptual.toml",
};

describe("PromptEditorPane image presets", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("selects, creates, and deletes article image prompt presets", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/admin/prompts") {
        return jsonResponse({
          runnable: [
            { key: "article_image", scope: "runnable", model: "light", thinking: false, json: false, hasModes: false },
          ],
          shared: [],
        });
      }
      if (url === "/api/admin/prompt/runnable/article_image") return jsonResponse(defaultPrompt);
      if (url === "/api/admin/article-image-prompts" && method === "GET") {
        return jsonResponse({
          prompts: [
            { key: "default", label: "default" },
            { key: "conceptual", label: "conceptual" },
            { key: "neon", label: "neon" },
          ],
        });
      }
      if (url === "/api/admin/article-image-prompts/conceptual" && method === "GET") return jsonResponse(conceptualPrompt);
      if (url === "/api/admin/article-image-prompts/conceptual" && method === "PUT") {
        return jsonResponse({
          ok: true,
          prompt: { ...conceptualPrompt, system: "updated conceptual system" },
        });
      }
      if (url === "/api/admin/article-image-prompts/neon" && method === "GET") {
        return jsonResponse({ ...conceptualPrompt, key: "neon", system: "neon system", path: "config/prompts/article_image_presets/neon.toml" });
      }
      if (url.endsWith("/revisions")) return jsonResponse({ revisions: [] });
      if (url === "/api/admin/article-image-prompts" && method === "POST") {
        return jsonResponse({
          ok: true,
          prompt: { ...conceptualPrompt, key: "neon", system: "neon system", path: "config/prompts/article_image_presets/neon.toml" },
          prompts: [
            { key: "default", label: "default" },
            { key: "conceptual", label: "conceptual" },
            { key: "neon", label: "neon" },
          ],
        });
      }
      if (url === "/api/admin/article-image-prompts/conceptual" && method === "DELETE") {
        return jsonResponse({ ok: true, prompts: [{ key: "default", label: "default" }] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PromptEditorPane />);

    await user.click(screen.getByRole("button", { name: /Prompt Editor/i }));
    await user.selectOptions(await screen.findByRole("combobox"), "runnable:article_image");

    expect(await screen.findByText("Image preset")).toBeInTheDocument();
    const presetSelect = screen.getByLabelText("Image preset");
    await user.selectOptions(presetSelect, "conceptual");
    expect(await screen.findByText("conceptual system")).toBeInTheDocument();

    const systemLabel = screen.getByText("System").closest("label") as HTMLElement;
    await user.click(within(systemLabel).getByText("Raw text"));
    const systemInput = within(systemLabel).getByDisplayValue("conceptual system");
    await user.clear(systemInput);
    await user.type(systemInput, "updated conceptual system");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/article-image-prompts/conceptual",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ system: "updated conceptual system", user: "conceptual user" }),
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
          body: JSON.stringify({ name: "Neon", copyFrom: "conceptual" }),
        }),
      );
    });
    expect(await screen.findByText("Preset created.")).toBeInTheDocument();
    expect(await screen.findByText("neon system")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Image preset"), "conceptual");
    const presetPanel = screen.getByText("Image preset").closest(".admin-prompt-presets");
    await user.click(within(presetPanel as HTMLElement).getByRole("button", { name: /delete preset/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/article-image-prompts/conceptual",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
