import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AllEntries, entryTitleSortKey, entryTitleWikiPath, plainEntryTitle } from "../../src/client/AllEntries";

describe("AllEntries", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders entry titles without summary excerpts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              slug: "coal-futures-markets",
              title: "Coal futures markets",
              summaryMarkdown: "Coal futures markets are complex, highly volatile financial instruments.",
              generatedAt: null,
            },
          ],
          cursor: null,
          complete: true,
          total: 1,
        }),
        { headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal(
      "fetch",
      fetchMock
    );

    render(<AllEntries onNavigate={vi.fn()} />);

    expect(await screen.findByRole("link", { name: "Coal futures markets" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/index?all=1");
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
    expect(
      screen.queryByText("Coal futures markets are complex, highly volatile financial instruments.")
    ).not.toBeInTheDocument();
  });

  it("renders markdown titles, sorts without markdown markers or leading The, and navigates by title path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            { slug: "zebra", title: "Zebra", generatedAt: null },
            { slug: "the-bonfire", title: "The Bonfire", generatedAt: null },
            { slug: "algebra", title: "*Algebra*", generatedAt: null },
            { slug: "the-apple", title: "**The Apple**", generatedAt: null },
            { slug: "title-edited-to-italics-after-generation", title: "*Title edited to italics after generation*", generatedAt: null },
            { slug: "signal-relay", title: "Signal Relay", generatedAt: null },
            { slug: "coal", title: "Coal", generatedAt: null },
          ],
          cursor: null,
          complete: true,
          total: 7,
        }),
        { headers: { "content-type": "application/json" } }
      )
    );
    const onNavigate = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<AllEntries onNavigate={onNavigate} />);

    const links = await screen.findAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Algebra",
      "The Apple",
      "The Bonfire",
      "Coal",
      "Signal Relay",
      "Title edited to italics after generation",
      "Zebra",
    ]);

    const algebraLink = screen.getByRole("link", { name: "Algebra" });
    expect(algebraLink.querySelector("em")).not.toBeNull();
    expect(algebraLink.getAttribute("href")).toBe("/wiki/Algebra");

    const titleEditedLink = screen.getByRole("link", { name: "Title edited to italics after generation" });
    expect(titleEditedLink.getAttribute("href")).toBe("/wiki/Title_edited_to_italics_after_generation");
    expect(titleEditedLink.getAttribute("href")).not.toBe("/wiki/title-edited-to-italics-after-generation");

    const titlePathLink = screen.getByRole("link", { name: "Signal Relay" });
    expect(titlePathLink.getAttribute("href")).toBe("/wiki/Signal_Relay");
    expect(titlePathLink.getAttribute("href")).not.toBe("/wiki/Signal-relay");
    expect(titlePathLink.getAttribute("href")).not.toBe("/wiki/signal-relay");

    const aGroup = screen.getByRole("heading", { name: "A" }).closest("section");
    expect(aGroup).not.toBeNull();
    expect(within(aGroup as HTMLElement).getByRole("link", { name: "Algebra" })).toBeInTheDocument();
    expect(within(aGroup as HTMLElement).getByRole("link", { name: "The Apple" })).toBeInTheDocument();

    await userEvent.click(algebraLink);
    expect(onNavigate).toHaveBeenCalledWith("Algebra", "Algebra");

    await userEvent.click(titleEditedLink);
    expect(onNavigate).toHaveBeenCalledWith(
      "Title_edited_to_italics_after_generation",
      "Title edited to italics after generation",
    );

    await userEvent.click(titlePathLink);
    expect(onNavigate).toHaveBeenCalledWith("Signal_Relay", "Signal Relay");
    expect(onNavigate).not.toHaveBeenCalledWith("signal-relay");
  });

  it("builds sort keys from markdown-stripped titles before dropping leading The", () => {
    expect(plainEntryTitle("***The Title***")).toBe("The Title");
    expect(entryTitleSortKey("***The Title***")).toBe("Title");
    expect(entryTitleSortKey("*Algebra*")).toBe("Algebra");
    expect(entryTitleWikiPath("*Title edited to italics after generation*"))
      .toBe("/wiki/Title_edited_to_italics_after_generation");
    expect(entryTitleWikiPath("Signal Relay")).toBe("/wiki/Signal_Relay");
  });
});
