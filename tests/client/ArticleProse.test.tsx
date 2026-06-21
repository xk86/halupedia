import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ArticleProse,
  articleProseClasses,
} from "../../src/client/article/ArticleProse";

describe("ArticleProse", () => {
  afterEach(cleanup);

  it("applies the shared article and quote presentation", () => {
    render(<ArticleProse html="<blockquote><p>Quoted text</p></blockquote>" />);

    const quote = screen.getByText("Quoted text").closest("blockquote");
    const prose = quote?.parentElement;

    expect(prose).toHaveClass("prose", "prose-halu", "max-w-none");
    expect(articleProseClasses).toContain("[&_blockquote]:border-l-accent");
    expect(articleProseClasses).toContain("[&_blockquote]:bg-blockquote-bg");
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
});
