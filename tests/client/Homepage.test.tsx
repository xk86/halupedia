import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Homepage } from "../../src/client/Homepage";
import { Sidebar } from "../../src/client/Sidebar";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

describe("Homepage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders thumbnails for the featured article when imageId is present", async () => {
    const now = Date.now();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/homepage/history")) return Promise.resolve(jsonResponse({ history: [] }));
      if (url.startsWith("/api/homepage")) {
        return Promise.resolve(jsonResponse({
          featured: {
            slug: "featured-article",
            title: "Featured Article",
            summaryMarkdown: "A summary.",
            imageId: "img-featured",
            imageCaption: "A glowing orchard at dusk.",
          },
          didYouKnow: [],
          generatedAt: now,
          expiresAt: now + 60_000,
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<Homepage onNavigate={vi.fn()} />);

    await screen.findByRole("link", { name: "Featured Article" });

    const images = Array.from(container.querySelectorAll("img"));
    const srcs = images.map((img) => img.getAttribute("src"));
    expect(srcs).toContain("/api/media/img-featured");
    expect(srcs).not.toContain("/api/media/undefined");

    // Captions are shown alongside their images — visibly under the larger
    // featured image (a <figcaption>).
    expect(screen.getByText("A glowing orchard at dusk.")).toBeInTheDocument();
    const featuredImg = container.querySelector(".homepage-featured-image") as HTMLImageElement;
    expect(featuredImg.getAttribute("alt")).toBe("A glowing orchard at dusk.");
  });

  it("renders no thumbnails when the featured article has no image", async () => {
    const now = Date.now();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/homepage/history")) return Promise.resolve(jsonResponse({ history: [] }));
      if (url.startsWith("/api/homepage")) {
        return Promise.resolve(jsonResponse({
          featured: { slug: "featured-article", title: "Featured Article", summaryMarkdown: "A summary." },
          didYouKnow: [],
          generatedAt: now,
          expiresAt: now + 60_000,
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<Homepage onNavigate={vi.fn()} />);

    await screen.findByRole("link", { name: "Featured Article" });
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("shows the top-10 list in the side pane, not the homepage body", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/top-articles")) {
        return Promise.resolve(jsonResponse({
          articles: [
            { slug: "alpha", title: "Alpha Article", inboundCount: 3 },
            { slug: "beta", title: "Beta Article", inboundCount: 1 },
          ],
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const onNavigate = vi.fn();
    render(
      <Sidebar
        articleSlug={null}
        articleTitle=""
        infobox={null}
        headlineMedia={null}
        showTopArticles
        onNavigate={onNavigate}
        onNavigateToMedia={vi.fn()}
      />,
    );

    const link = await screen.findByRole("link", { name: "Alpha Article" });
    expect(screen.getByText("3 refs")).toBeInTheDocument();
    link.click();
    expect(onNavigate).toHaveBeenCalledWith("Alpha Article");
  });
});
