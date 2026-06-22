import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Homepage } from "../../src/client/Homepage";
import { Sidebar } from "../../src/client/Sidebar";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

describe("Homepage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("uses the configured article font as its default", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({}))),
    );

    const { container } = render(<Homepage onNavigate={vi.fn()} />);

    expect(container.querySelector("article")).toHaveClass("font-serif");
  });

  it("renders thumbnails for the featured article when imageId is present", async () => {
    const now = Date.now();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/homepage/history"))
        return Promise.resolve(jsonResponse({ history: [] }));
      if (url.startsWith("/api/homepage")) {
        return Promise.resolve(
          jsonResponse({
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
          }),
        );
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
    const featuredImg = container.querySelector(
      ".homepage-featured-image",
    ) as HTMLImageElement;
    expect(featuredImg.getAttribute("alt")).toBe("A glowing orchard at dusk.");
  });

  it("renders no thumbnails when the featured article has no image", async () => {
    const now = Date.now();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/homepage/history"))
        return Promise.resolve(jsonResponse({ history: [] }));
      if (url.startsWith("/api/homepage")) {
        return Promise.resolve(
          jsonResponse({
            featured: {
              slug: "featured-article",
              title: "Featured Article",
              summaryMarkdown: "A summary.",
            },
            didYouKnow: [],
            generatedAt: now,
            expiresAt: now + 60_000,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<Homepage onNavigate={vi.fn()} />);

    await screen.findByRole("link", { name: "Featured Article" });
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("renders today's news dates without era labels", async () => {
    const now = Date.now();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/homepage/history"))
        return Promise.resolve(jsonResponse({ history: [] }));
      if (url.startsWith("/api/homepage")) {
        return Promise.resolve(
          jsonResponse({
            featured: null,
            todaysNews: {
              slug: "todays-news-day-000253",
              title: "Today's News: September 10, 2025",
              worldDate: "September 10, 2025",
              worldDay: 253,
              generatorVersion: "1",
              summaryMarkdown: "A regular edition.",
              headlines: [
                {
                  text: "Canal ledgers steady",
                  summary: "Accountants approve moonlight totals.",
                },
              ],
            },
            didYouKnow: [],
            generatedAt: now,
            expiresAt: now + 60_000,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Homepage onNavigate={vi.fn()} />);

    await screen.findByText("September 10, 2025");
  });

  it("renders today's news below featured and DYK with its broadcast image", async () => {
    const now = Date.now();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/homepage/history"))
        return Promise.resolve(jsonResponse({ history: [] }));
      if (url.startsWith("/api/homepage")) {
        return Promise.resolve(
          jsonResponse({
            featured: {
              slug: "featured-article",
              title: "Featured Article",
              summaryMarkdown: "A summary.",
            },
            todaysNews: {
              slug: "todays-news-day-000252",
              title: "Today's News: September 9, 2025",
              worldDate: "September 9, 2025",
              worldDay: 252,
              generatorVersion: "1",
              summaryMarkdown: "A sponsored edition.",
              imageId: "news-img",
              imageCaption: "A broadcast still from the top story.",
              headlines: [
                {
                  text: "Canal ledgers wobble",
                  summary: "Accountants deny moonlight errors.",
                },
                {
                  text: "Archivists delay vote",
                  summary: "The committee requests another stamp.",
                },
                {
                  text: "Ferry court adjourns",
                  summary: "Witnesses cite the wrong tide table.",
                },
              ],
            },
            didYouKnow: [
              {
                slug: "featured-article",
                title: "Featured Article",
                fact: '... that [Featured Article](halu:featured-article "Featured Article") keeps ledgers?',
              },
            ],
            generatedAt: now,
            expiresAt: now + 60_000,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<Homepage onNavigate={vi.fn()} />);

    const featuredHeading = await screen.findByText("Featured article");
    const dykHeading = screen.getByText("Did you know...");
    const newsHeading = screen.getByText("Today's News");
    expect(
      featuredHeading.compareDocumentPosition(newsHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      dykHeading.compareDocumentPosition(newsHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getAllByRole("link", {
        name: "Canal ledgers wobble Accountants deny moonlight errors.",
      })[0],
    ).toBeInTheDocument();
    const newsImg = container.querySelector(
      ".homepage-news-image",
    ) as HTMLImageElement;
    expect(newsImg.getAttribute("src")).toBe("/api/media/news-img");
    expect(newsImg.getAttribute("alt")).toBe(
      "A broadcast still from the top story.",
    );
  });

  it("shows the top-10 list in the side pane, not the homepage body", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/top-articles")) {
        return Promise.resolve(
          jsonResponse({
            articles: [
              { slug: "alpha", title: "Alpha Article", inboundCount: 3 },
              { slug: "beta", title: "Beta Article", inboundCount: 1 },
            ],
          }),
        );
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
