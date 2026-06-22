import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmHostsPane } from "../../src/client/admin/panes/LlmHostsPane";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const payload = {
  hosts: [
    {
      id: "local",
      base_url: "http://127.0.0.1:11434/v1",
      api_key: "********",
      max_in_flight: 4,
      pref: 0,
      blacklist: [],
      online: true,
      active: 0,
      queued: 0,
      activeJobs: [],
      queuedJobs: [],
      models: ["gemma4"],
    },
  ],
  roles: {
    heavy: {
      hosts: ["local"],
      model: "gemma4",
      temperature: 1,
      max_tokens: 9001,
      num_ctx: 16384,
      repeat_last_n: 64,
      repeat_penalty: 1.1,
      seed: 42,
      draft_num_predict: 4,
      top_k: 10,
      top_p: 0.9,
      min_p: null,
      candidates: ["local"],
    },
    light: null,
    images: null,
    embeddings: null,
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
      model: "gpt-image-2",
      size: "1088x624",
      quality: "low",
      outputFormat: "jpeg",
      outputCompression: 70,
      timeoutMs: 120000,
    },
    ollama: {
      baseUrl: "http://127.0.0.1:11434",
      model: "image-model",
      width: 1088,
      height: 624,
      steps: 20,
      timeoutMs: 120000,
    },
  },
};

describe("LlmHostsPane", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("edits and saves all supported Ollama role parameters", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(payload),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<LlmHostsPane />);
    await user.click(
      screen.getByRole("button", { name: /LLM Hosts & Roles/i }),
    );

    const roleHeading = await screen.findByText("heavy (llm.chat)");
    const roleCard = roleHeading.parentElement?.parentElement;
    expect(roleCard).not.toBeNull();
    const contextInput = within(roleCard as HTMLElement).getByLabelText(
      "num_ctx",
    );
    expect(contextInput).toHaveValue(16384);
    expect(
      within(roleCard as HTMLElement).getByLabelText("repeat_last_n"),
    ).toHaveValue(64);
    expect(
      within(roleCard as HTMLElement).getByLabelText("repeat_penalty"),
    ).toHaveValue(1.1);
    expect(within(roleCard as HTMLElement).getByLabelText("seed")).toHaveValue(
      42,
    );
    expect(
      within(roleCard as HTMLElement).getByLabelText("draft_num_predict"),
    ).toHaveValue(4);
    expect(
      within(roleCard as HTMLElement).getByLabelText("num_predict"),
    ).toHaveValue(9001);
    expect(
      within(roleCard as HTMLElement).getByText("repeat_penalty"),
    ).toHaveClass("text-[0.65rem]");

    await user.clear(contextInput);
    await user.type(contextInput, "32768");
    await user.click(
      within(roleCard as HTMLElement).getByRole("button", {
        name: "Save role",
      }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/llm/role/heavy",
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"num_ctx":32768'),
        }),
      );
    });
    const saveCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === "/api/admin/llm/role/heavy" && init?.method === "PUT",
    );
    const savedBody = JSON.parse(String(saveCall?.[1]?.body));
    expect(savedBody).toMatchObject({
      max_tokens: 9001,
      num_ctx: 32768,
      repeat_last_n: 64,
      repeat_penalty: 1.1,
      seed: 42,
      draft_num_predict: 4,
      top_k: 10,
      top_p: 0.9,
      min_p: null,
    });

    await user.clear(contextInput);
    await user.click(
      within(roleCard as HTMLElement).getByRole("button", {
        name: "Save role",
      }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/llm/role/heavy",
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"num_ctx":null'),
        }),
      );
    });
  });
});
