import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArticleBacklinks } from "../../src/client/article/ArticleBacklinks";
import { ArticleBody } from "../../src/client/article/ArticleBody";

describe("article view components", () => {
  afterEach(cleanup);

  it("renders article HTML and streaming status", () => {
    render(
      <ArticleBody
        html="<p>Rendered body</p>"
        statusMessage="Updating article"
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText("Rendered body")).toBeInTheDocument();
    expect(screen.getByText("Updating article")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="separator"]')).toBeTruthy();
  });

  it("renders Markdown and navigates Unicode backlinks by their plain title", async () => {
    const onNavigate = vi.fn();
    render(
      <ArticleBacklinks
        existing={[{ slug: "woman", title: "**女**作品" }]}
        unwritten={[{ slug: "book", title: "*书名*" }]}
        onNavigate={onNavigate}
      />,
    );

    const existingLink = screen.getByRole("link", { name: "女作品" });
    expect(existingLink.querySelector("strong")).toHaveTextContent("女");
    expect(existingLink).toHaveAttribute("href", "/wiki/女作品");

    const unwrittenLink = screen.getByRole("link", { name: "书名" });
    expect(unwrittenLink.querySelector("em")).toHaveTextContent("书名");
    expect(unwrittenLink).toHaveAttribute("href", "/wiki/书名");

    await userEvent.click(unwrittenLink);
    expect(onNavigate).toHaveBeenCalledWith("书名", "书名");
    expect(screen.getByText("(unwritten)")).toBeInTheDocument();
  });
});
