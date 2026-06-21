import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeadlineImagePanel } from "../../src/client/HeadlineImagePanel";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const NO_IMAGE_RESPONSE = jsonResponse({ image: null });
const WITH_IMAGE_RESPONSE = () =>
  jsonResponse({
    image: {
      id: "test-img-slug",
      description: "A description",
      articleCaption: "The caption",
      width: 800,
      height: 600,
    },
  });

function renderPanel(
  overrides: Partial<{
    articleSlug: string;
    onArticleUpdate: (a: unknown) => void;
    onNavigateToMedia: (s: string) => void;
  }> = {}
) {
  const props = {
    articleSlug: "aspirin",
    onArticleUpdate: vi.fn(),
    onNavigateToMedia: vi.fn(),
    ...overrides,
  };
  return { ...render(<HeadlineImagePanel {...props} />), props };
}

describe("HeadlineImagePanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // ── initial load ─────────────────────────────────────────────────────────────

  it("shows URL input when no image is attached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(NO_IMAGE_RESPONSE));
    renderPanel();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/paste image url/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows thumbnail and media-id when image is attached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(WITH_IMAGE_RESPONSE()));
    renderPanel();
    await waitFor(() => {
      expect(screen.getByRole("img")).toBeInTheDocument();
    });
    expect(screen.getByText("test-img-slug")).toBeInTheDocument();
    expect(screen.getByText("The caption")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/paste image url/i)).not.toBeInTheDocument();
  });

  it("fetches image info on mount using the articleSlug prop", async () => {
    const fetchMock = vi.fn().mockResolvedValue(NO_IMAGE_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);
    renderPanel({ articleSlug: "benzodiazepine" });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/article/benzodiazepine/image"
      );
    });
  });

  // ── URL input reactivity (the original bug) ───────────────────────────────────

  it("URL input is typeable — value updates on each keystroke", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(NO_IMAGE_RESPONSE));
    const user = userEvent.setup();
    renderPanel();

    const input = await screen.findByPlaceholderText(/paste image url/i);
    await user.type(input, "https://example.com/img.png");
    expect(input).toHaveValue("https://example.com/img.png");
  });

  it("Attach button is disabled while URL input is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(NO_IMAGE_RESPONSE));
    renderPanel();
    const attach = await screen.findByRole("button", { name: /attach/i });
    expect(attach).toBeDisabled();
  });

  it("Attach button enables once URL is typed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(NO_IMAGE_RESPONSE));
    const user = userEvent.setup();
    renderPanel();

    const input = await screen.findByPlaceholderText(/paste image url/i);
    await user.type(input, "https://example.com/img.png");
    expect(screen.getByRole("button", { name: /attach/i })).not.toBeDisabled();
  });

  it("shows Generate button when no image is attached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(NO_IMAGE_RESPONSE));
    renderPanel();
    expect(await screen.findByRole("button", { name: /generate/i })).toBeInTheDocument();
  });

  it("keeps built-in aspect ratio options when the aspect-ratio endpoint is unavailable", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/article-image-aspect-ratios")) {
        return jsonResponse({ error: "not found" }, 404);
      }
      return NO_IMAGE_RESPONSE;
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("combobox", { name: /image aspect ratio/i }));

    expect(await screen.findByRole("option", { name: /portrait \(832x1088\)/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /square \(832x832\)/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /poster portrait \(768x1152\)/i })).toBeInTheDocument();
  });

  // ── URL attach ───────────────────────────────────────────────────────────────

  it("clicking Attach POSTs to the image endpoint and shows thumbnail", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/image") && !init?.method) return NO_IMAGE_RESPONSE;
      if (String(url).endsWith("/image") && init?.method === "POST") {
        return jsonResponse({
          mediaId: "new-img",
          caption: "Nice shot",
          description: "A nice shot",
          width: 640,
          height: 480,
          article: { slug: "aspirin", title: "Aspirin" },
        });
      }
      return NO_IMAGE_RESPONSE;
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const onArticleUpdate = vi.fn();
    renderPanel({ onArticleUpdate });

    const input = await screen.findByPlaceholderText(/paste image url/i);
    await user.type(input, "https://example.com/img.png");
    await user.click(screen.getByRole("button", { name: /attach/i }));

    await waitFor(() => {
      expect(screen.getByRole("img")).toBeInTheDocument();
    });
    expect(screen.getByText("new-img")).toBeInTheDocument();
    expect(onArticleUpdate).toHaveBeenCalled();
  });

  it("Enter key in URL input triggers upload", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return jsonResponse({ mediaId: "kb-img", caption: "", description: "", width: 1, height: 1 });
      return NO_IMAGE_RESPONSE;
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPanel();

    const input = await screen.findByPlaceholderText(/paste image url/i);
    await user.type(input, "https://example.com/x.jpg{Enter}");

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) => {
        const [, init] = c as [string, RequestInit];
        return init?.method === "POST";
      });
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  // ── generated image attach ──────────────────────────────────────────────────

  it("clicking Generate POSTs to the generate endpoint and shows thumbnail", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/image") && !init?.method) return NO_IMAGE_RESPONSE;
      if (String(url).endsWith("/image/generate") && init?.method === "POST") {
        return jsonResponse({
          mediaId: "generated-img",
          caption: "Generated caption",
          description: "Generated description",
          width: 1024,
          height: 1024,
          article: { slug: "aspirin", title: "Aspirin" },
        });
      }
      return NO_IMAGE_RESPONSE;
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const onArticleUpdate = vi.fn();
    renderPanel({ onArticleUpdate });

    await user.click(await screen.findByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(screen.getByRole("img")).toBeInTheDocument();
    });
    expect(screen.getByText("generated-img")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/article/aspirin/image/generate",
      expect.objectContaining({ method: "POST" }),
    );
    expect(onArticleUpdate).toHaveBeenCalled();
  });

  it("sends the selected image preset key when generating", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/article-image-prompts")) {
        return jsonResponse({
          prompts: [
            { key: "default", label: "default" },
            { key: "psychedelic_editorial", label: "psychedelic_editorial" },
          ],
        });
      }
      if (String(url).endsWith("/image") && !init?.method) return NO_IMAGE_RESPONSE;
      if (String(url).endsWith("/image/generate") && init?.method === "POST") {
        return jsonResponse({
          mediaId: "generated-img",
          caption: "Generated caption",
          description: "Generated description",
          width: 1024,
          height: 1024,
        });
      }
      return NO_IMAGE_RESPONSE;
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("combobox", { name: /image preset/i }));
    await user.click(await screen.findByRole("option", { name: "psychedelic_editorial" }));
    await user.click(screen.getByRole("button", { name: /generate/i }));

    await waitFor(() => {
      const generateCall = fetchMock.mock.calls.find(([url, init]) =>
        String(url).endsWith("/image/generate") && (init as RequestInit | undefined)?.method === "POST"
      );
      expect(generateCall).toBeTruthy();
      expect(JSON.parse(String((generateCall?.[1] as RequestInit).body))).toEqual({
        presetKey: "psychedelic_editorial",
        aspectRatioKey: "landscape",
      });
    });
  });

  it("sends auto preset key from the automatic preset generate button", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/article-image-prompts")) {
        return jsonResponse({
          prompts: [
            { key: "default", label: "default" },
            { key: "psychedelic_editorial", label: "psychedelic_editorial" },
          ],
        });
      }
      if (String(url).endsWith("/image") && !init?.method) return NO_IMAGE_RESPONSE;
      if (String(url).endsWith("/image/generate") && init?.method === "POST") {
        return jsonResponse({
          mediaId: "auto-generated-img",
          caption: "Generated caption",
          description: "Generated description",
          width: 1024,
          height: 1024,
        });
      }
      return NO_IMAGE_RESPONSE;
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /automatically select preset/i }));

    await waitFor(() => {
      const generateCall = fetchMock.mock.calls.find(([url, init]) =>
        String(url).endsWith("/image/generate") && (init as RequestInit | undefined)?.method === "POST"
      );
      expect(generateCall).toBeTruthy();
      expect(JSON.parse(String((generateCall?.[1] as RequestInit).body))).toEqual({
        presetKey: "auto",
        aspectRatioKey: "auto",
      });
    });
  });

  it("shows server error when generated image request fails", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/image/generate") && init?.method === "POST") {
        return jsonResponse({ error: "image generation is disabled" }, 400);
      }
      return NO_IMAGE_RESPONSE;
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /generate/i }));

    expect(await screen.findByText(/image generation is disabled/i)).toBeInTheDocument();
  });

  // ── file upload ───────────────────────────────────────────────────────────────

  it("selecting a file via the file picker triggers an upload", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/image/upload"))
        return jsonResponse({ mediaId: "file-img", caption: "", description: "", width: 1, height: 1 });
      return NO_IMAGE_RESPONSE;
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPanel();

    await screen.findByPlaceholderText(/paste image url/i);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["bytes"], "photo.jpg", { type: "image/jpeg" });
    await user.upload(fileInput, file);

    await waitFor(() => {
      const uploadCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).endsWith("/image/upload")
      );
      expect(uploadCalls.length).toBe(1);
    });
  });

  // ── remove ───────────────────────────────────────────────────────────────────

  it("Remove button DELETEs and hides the thumbnail", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return WITH_IMAGE_RESPONSE();
      if (init.method === "DELETE") return jsonResponse({ article: null });
      return NO_IMAGE_RESPONSE;
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPanel();

    await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /remove/i }));

    await waitFor(() => {
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/paste image url/i)).toBeInTheDocument();
  });

  // ── error display ─────────────────────────────────────────────────────────────

  it("shows error message when upload fails", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return jsonResponse({ error: "SSRF blocked" }, 400);
      return NO_IMAGE_RESPONSE;
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPanel();

    const input = await screen.findByPlaceholderText(/paste image url/i);
    await user.type(input, "https://internal.corp/img.png");
    await user.click(screen.getByRole("button", { name: /attach/i }));

    await waitFor(() => {
      expect(screen.getByText(/SSRF blocked/i)).toBeInTheDocument();
    });
  });

  // ── slug change resets panel ──────────────────────────────────────────────────

  it("changing articleSlug reloads image info and resets state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(NO_IMAGE_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { rerender, props } = renderPanel({ articleSlug: "alpha" });

    const input = await screen.findByPlaceholderText(/paste image url/i);
    await user.type(input, "https://example.com/img.png");
    expect(input).toHaveValue("https://example.com/img.png");

    rerender(
      <HeadlineImagePanel
        articleSlug="beta"
        onArticleUpdate={props.onArticleUpdate}
        onNavigateToMedia={props.onNavigateToMedia}
      />
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/article/beta/image");
    });
    // URL draft resets when slug changes
    const freshInput = screen.getByPlaceholderText(/paste image url/i);
    expect(freshInput).toHaveValue("");
  });

  // ── media page navigation ─────────────────────────────────────────────────────

  it("clicking the thumbnail calls onNavigateToMedia with the image slug", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(WITH_IMAGE_RESPONSE()));
    const user = userEvent.setup();
    const onNavigateToMedia = vi.fn();
    renderPanel({ onNavigateToMedia });

    await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
    const link = screen.getByRole("link");
    await user.click(link);
    expect(onNavigateToMedia).toHaveBeenCalledWith("test-img-slug");
  });
});
