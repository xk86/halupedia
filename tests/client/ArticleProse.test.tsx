import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ArticleProse,
  articleProseClasses,
} from "../../src/client/article/ArticleProse";

describe("ArticleProse", () => {
  afterEach(cleanup);

  it("applies the shared article presentation", () => {
    render(<ArticleProse html="<blockquote><p>Quoted text</p></blockquote>" />);

    const quote = screen.getByText("Quoted text").closest("blockquote");
    const prose = quote?.parentElement;

    expect(prose).toHaveClass("prose", "prose-halu", "max-w-none");
  });

  it("leaves quote styling to the shared blockquote rule", () => {
    // Quotes share the editor's `.prose-halu blockquote` CSS rather than
    // carrying bespoke prose utilities, so no blockquote classes are emitted.
    expect(articleProseClasses).not.toContain("[&_blockquote]");
  });

  it("combines caller layout classes with the shared prose classes", () => {
    const { container } = render(
      <ArticleProse className="article-body" html="<p>Body</p>" />,
    );

    expect(container.firstElementChild).toHaveClass(
      "article-body",
      "prose-halu",
    );
  });

  it("keeps one underline source on article links", () => {
    render(<ArticleProse html='<a href="/wiki/Test">Linked article</a>' />);

    const prose = screen.getByRole("link", { name: "Linked article" })
      .parentElement;

    expect(prose).toHaveClass("[&_a]:border-b-0");
  });
});
