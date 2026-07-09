import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatWidget } from "../../src/client/chat/ChatWidget";

function ndjsonResponse(events: unknown[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}

describe("ChatWidget", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is collapsed behind the floating button until clicked", () => {
    render(<ChatWidget onNavigateToArticle={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Ask the research chat" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Ask about the wiki…"),
    ).not.toBeInTheDocument();
  });

  it("opens the panel, sends a question, and renders the streamed answer with references", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { type: "research", query: "what is solana" },
        { type: "research_step", tool: "search_articles", args: { query: "solana" } },
        { type: "token", delta: "Solana " },
        { type: "token", delta: "is a blockchain." },
        {
          type: "done",
          references: [{ slug: "solana", title: "Solana", relevance: "primary subject" }],
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<ChatWidget onNavigateToArticle={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Ask the research chat" }));
    const input = await screen.findByPlaceholderText("Ask about the wiki…");
    await user.type(input, "What is Solana?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages).toEqual([{ role: "user", content: "What is Solana?" }]);

    await waitFor(() => {
      expect(screen.getByText(/Solana is a blockchain\./)).toBeInTheDocument();
    });
    expect(screen.getByText("Solana", { selector: "a" })).toBeInTheDocument();
  });

  it("routes a reference click through onNavigateToArticle instead of a full page nav", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { type: "token", delta: "See the article." },
        { type: "done", references: [{ slug: "solana", title: "Solana" }] },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onNavigateToArticle = vi.fn();

    const user = userEvent.setup();
    render(<ChatWidget onNavigateToArticle={onNavigateToArticle} />);
    await user.click(screen.getByRole("button", { name: "Ask the research chat" }));
    const input = await screen.findByPlaceholderText("Ask about the wiki…");
    await user.type(input, "Tell me about Solana");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const referenceLink = await screen.findByText("Solana", { selector: "a" });
    await user.click(referenceLink);
    // Navigated by title (not the raw slug) so punctuation in the title
    // survives — see ChatPanel's Sources-chip onClick.
    expect(onNavigateToArticle).toHaveBeenCalledWith("Solana", "Solana");
  });

  it("keeps the research steps available (folded by default) after the answer completes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { type: "research", query: "what is solana" },
        { type: "research_step", tool: "search_articles", args: { query: "solana" } },
        { type: "token", delta: "Solana is a blockchain." },
        { type: "done", references: [] },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<ChatWidget onNavigateToArticle={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Ask the research chat" }));
    const input = await screen.findByPlaceholderText("Ask about the wiki…");
    await user.type(input, "What is Solana?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByText(/Solana is a blockchain\./)).toBeInTheDocument();
    });

    const trigger = screen.getByText("Reasoning & sources (2 steps)");
    expect(screen.queryByText("Researching: what is solana")).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByText("Researching: what is solana")).toBeInTheDocument();
    expect(screen.getByText(/search_articles/)).toBeInTheDocument();
  });

  it("prefers the server-rendered html once the turn settles, over re-parsing raw content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ndjsonResponse([
        // The raw streamed text still has unresolved ref: markup — the
        // settled render should come from `html` (already fully resolved
        // server-side, see runChatTurn/renderChatAnswer), not from re-parsing
        // this raw content client-side.
        { type: "token", delta: "See [bingus](ref:bingus) for details." },
        {
          type: "done",
          references: [{ slug: "bingus", title: "Bingus" }],
          html: '<p>See <a href="/wiki/Bingus">Bingus</a> for details.</p>',
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<ChatWidget onNavigateToArticle={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Ask the research chat" }));
    const input = await screen.findByPlaceholderText("Ask about the wiki…");
    await user.type(input, "What is Bingus?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getAllByText("Bingus", { selector: "a" }).length).toBeGreaterThan(0);
    });
    // The answer-body link (as opposed to the Sources chip, which also reads
    // "Bingus") comes straight from the server-provided html.
    const bodyLink = document.querySelector(".prose a");
    expect(bodyLink).toHaveAttribute("href", "/wiki/Bingus");
    expect(screen.queryByText(/ref:bingus/)).not.toBeInTheDocument();
  });

  it("always leaves a visible message even if the stream ends without a done/error event", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ndjsonResponse([{ type: "research", query: "what is solana" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<ChatWidget onNavigateToArticle={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Ask the research chat" }));
    const input = await screen.findByPlaceholderText("Ask about the wiki…");
    await user.type(input, "What is Solana?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(
        screen.getByText(/didn't get a complete response/i),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
  });
});
