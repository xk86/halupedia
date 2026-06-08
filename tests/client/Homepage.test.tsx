import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Homepage } from "../../src/client/Homepage";

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

  it("renders thumbnails for top articles and the featured article when imageId is present", async () => {
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
      if (url.startsWith("/api/top-articles")) {
        return Promise.resolve(jsonResponse({
          articles: [
            { slug: "with-image", title: "Article With Image", inboundCount: 3, imageId: "img-with-image", imageCaption: "Top-list thumbnail caption." },
            { slug: "without-image", title: "Article Without Image", inboundCount: 1 },
          ],
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<Homepage onNavigate={vi.fn()} />);

    // Wait for the featured card and top articles to render
    await screen.findByRole("link", { name: "Featured Article" });
    await screen.findByRole("link", { name: "Article With Image" });

    const images = Array.from(container.querySelectorAll("img"));
    const srcs = images.map((img) => img.getAttribute("src"));
    expect(srcs).toContain("/api/media/img-featured");
    expect(srcs).toContain("/api/media/img-with-image");
    expect(srcs).not.toContain("/api/media/undefined");

    // The article without an image must not render an extra thumbnail for it
    const withoutImageLink = screen.getByRole("link", { name: "Article Without Image" });
    const withoutImageItem = withoutImageLink.closest("li");
    expect(withoutImageItem?.querySelector("img")).toBeNull();

    // Captions are shown alongside their images — visibly under the larger
    // featured image (a <figcaption>), and as alt/title text on the compact
    // top-article thumbnails.
    expect(screen.getByText("A glowing orchard at dusk.")).toBeInTheDocument();
    const featuredImg = container.querySelector(".homepage-featured-image") as HTMLImageElement;
    expect(featuredImg.getAttribute("alt")).toBe("A glowing orchard at dusk.");
    const topThumb = container.querySelector(".homepage-top-thumb") as HTMLImageElement;
    expect(topThumb.getAttribute("alt")).toBe("Top-list thumbnail caption.");
    expect(topThumb.getAttribute("title")).toBe("Top-list thumbnail caption.");
  });

  it("renders no thumbnails when no articles have images", async () => {
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
      if (url.startsWith("/api/top-articles")) {
        return Promise.resolve(jsonResponse({
          articles: [{ slug: "plain", title: "Plain Article", inboundCount: 1 }],
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<Homepage onNavigate={vi.fn()} />);

    await screen.findByRole("link", { name: "Plain Article" });
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });
});
