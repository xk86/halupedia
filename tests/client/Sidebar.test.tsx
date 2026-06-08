import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../src/client/Sidebar";

// The Sidebar now renders the article's infobox + headline media (it no
// longer shows a backlinks list — that UI was removed). `articleTitle` is
// part of the prop type but unused by the component; pass "" for brevity.

describe("Sidebar", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing but the container when there is no article context", () => {
    render(
      <Sidebar
        articleSlug={null}
        articleTitle=""
        infobox={null}
        headlineMedia={null}
        onNavigate={vi.fn()}
        onNavigateToMedia={vi.fn()}
      />
    );
    const aside = screen.getByLabelText("Context");
    expect(aside).toBeInTheDocument();
    expect(aside).toBeEmptyDOMElement();
  });

  it("renders nothing but the container when the article has neither infobox nor headline media", () => {
    render(
      <Sidebar
        articleSlug="test-article"
        articleTitle="Test Article"
        infobox={null}
        headlineMedia={null}
        onNavigate={vi.fn()}
        onNavigateToMedia={vi.fn()}
      />
    );
    const aside = screen.getByLabelText("Context");
    expect(aside).toBeInTheDocument();
    expect(aside).toBeEmptyDOMElement();
  });

  it("renders the infobox title, subtitle, and grouped rows", () => {
    render(
      <Sidebar
        articleSlug="test-article"
        articleTitle="Test Article"
        infobox={{
          title: "Test Article",
          subtitle: "An encyclopedia entry",
          groups: [
            { label: "Overview", rows: [{ label: "Founded", value: "1923" }] },
          ],
        }}
        headlineMedia={null}
        onNavigate={vi.fn()}
        onNavigateToMedia={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Article info")).toBeInTheDocument();
    // "Test Article" appears both in the mobile-toggle button and the
    // infobox title; assert on the title element specifically.
    expect(document.querySelector(".infobox-title")?.textContent).toBe("Test Article");
    expect(screen.getByText("An encyclopedia entry")).toBeInTheDocument();
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByText("Founded")).toBeInTheDocument();
    expect(screen.getByText("1923")).toBeInTheDocument();
  });

  it("navigates client-side when an internal /wiki/ link inside the infobox is clicked", async () => {
    const onNavigate = vi.fn();
    render(
      <Sidebar
        articleSlug="test-article"
        articleTitle="Test Article"
        infobox={{
          title: 'See also <a href="/wiki/Moon_Clock">Moon Clock</a>',
          groups: [],
        }}
        headlineMedia={null}
        onNavigate={onNavigate}
        onNavigateToMedia={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("link", { name: "Moon Clock" }));
    expect(onNavigate).toHaveBeenCalledWith("Moon_Clock");
  });

  it("renders the headline image and caption, and navigates to the media page on click", async () => {
    const onNavigateToMedia = vi.fn();
    render(
      <Sidebar
        articleSlug="test-article"
        articleTitle="Test Article"
        infobox={{ title: "Test Article", groups: [] }}
        headlineMedia={{ mediaId: "img-abc123", caption: "A striking portrait", description: "desc" }}
        onNavigate={vi.fn()}
        onNavigateToMedia={onNavigateToMedia}
      />
    );

    const link = screen.getByRole("link", { name: "A striking portrait" });
    expect(link).toHaveAttribute("href", "/media/img-abc123");
    const img = link.querySelector("img");
    expect(img).toHaveAttribute("src", "/api/media/img-abc123");
    expect(screen.getByText("A striking portrait")).toBeInTheDocument();

    await userEvent.click(link);
    expect(onNavigateToMedia).toHaveBeenCalledWith("img-abc123");
  });

  it("shows a generating indicator while content is still being produced", () => {
    // No infobox/headlineMedia yet means hasContent is false; with no
    // generatingNode the aside renders empty. We can only reach the
    // "generating" branch via the live stream, which Sidebar wires up to
    // /api/article/:slug/live — stub it to emit a `generating` event.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              JSON.stringify({ type: "generating", node: "llm.generate_infobox" }) + "\n"
            ));
            // leave the stream open — Sidebar reads until done/abort
          },
        }),
        { status: 200, headers: { "content-type": "application/x-ndjson" } },
      ))
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <Sidebar
        articleSlug="test-article"
        articleTitle="Test Article"
        infobox={null}
        headlineMedia={null}
        onNavigate={vi.fn()}
        onNavigateToMedia={vi.fn()}
      />
    );

    return screen.findByText("Building infobox…").then((el) => {
      expect(el).toBeInTheDocument();
      vi.unstubAllGlobals();
    });
  });
});
