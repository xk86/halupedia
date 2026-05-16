import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../src/client/Sidebar";

describe("Sidebar", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing but the container when no article context is active", () => {
    render(<Sidebar articleSlug={null} articleTitle="" backlinks={null} onNavigate={vi.fn()} />);
    expect(screen.getByLabelText("Context")).toBeInTheDocument();
    expect(screen.queryByText("Referenced By")).not.toBeInTheDocument();
  });

  it("renders existing and unwritten backlinks and navigates client-side", async () => {
    const onNavigate = vi.fn();
    render(
      <Sidebar
        articleSlug="test-article"
        articleTitle="Test Article"
        backlinks={{
          existing: [
            {
              slug: "archive-entry",
              title: "Archive Entry",
              visibleLabel: "Archive Entry",
              hiddenHint: "Existing backlink hint",
              createdAt: 1,
            },
          ],
          unwritten: [
            {
              slug: "moon-clock",
              title: "Moon Clock",
              visibleLabel: "Moon Clock",
              hiddenHint: "Unwritten backlink hint",
              createdAt: 2,
            },
          ],
        }}
        onNavigate={onNavigate}
      />
    );

    expect(screen.getByText("Existing Articles")).toBeInTheDocument();
    expect(screen.getByText("Unwritten Articles")).toBeInTheDocument();
    expect(screen.getByText("Existing backlink hint")).toBeInTheDocument();
    expect(screen.getByText("Unwritten backlink hint")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Moon Clock" }));
    expect(onNavigate).toHaveBeenCalledWith("Moon_Clock");
  });

  it("renders inline KaTeX inside backlink summaries", () => {
    render(
      <Sidebar
        articleSlug="test-article"
        articleTitle="Test Article"
        backlinks={{
          existing: [
            {
              slug: "sigma-entry",
              title: "Sigma Entry",
              visibleLabel: "Sigma Entry",
              hiddenHint: "Fallback hint",
              summaryMarkdown: "The coefficient $\\sigma$ governs drift.",
              createdAt: 1,
            },
          ],
          unwritten: [],
        }}
        onNavigate={vi.fn()}
      />
    );

    expect(document.querySelector(".sb-hint .math-inline")).not.toBeNull();
    expect(document.querySelector(".sb-hint .katex")).not.toBeNull();
  });

  it("renders markdown-rich backlink summaries inside a block container", () => {
    render(
      <Sidebar
        articleSlug="test-article"
        articleTitle="Test Article"
        backlinks={{
          existing: [
            {
              slug: "multi-paragraph-entry",
              title: "Multi Paragraph Entry",
              visibleLabel: "Multi Paragraph Entry",
              hiddenHint: "Fallback hint",
              summaryMarkdown: "First paragraph.\n\nSecond paragraph.",
              createdAt: 1,
            },
          ],
          unwritten: [],
        }}
        onNavigate={vi.fn()}
      />
    );

    const hintNode = document.querySelector(".sb-hint");
    expect(hintNode?.tagName).toBe("DIV");
    expect(screen.getByText("Second paragraph.")).toBeInTheDocument();
  });
});
