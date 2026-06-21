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

  it("navigates from existing and unwritten backlinks", async () => {
    const onNavigate = vi.fn();
    render(
      <ArticleBacklinks
        existing={[{ slug: "alpha", title: "Alpha Entry" }]}
        unwritten={[{ slug: "beta", title: "Beta Entry" }]}
        onNavigate={onNavigate}
      />,
    );

    await userEvent.click(screen.getByRole("link", { name: "Beta Entry" }));
    expect(onNavigate).toHaveBeenCalledWith("Beta_Entry");
    expect(screen.getByText("(unwritten)")).toBeInTheDocument();
  });
});
