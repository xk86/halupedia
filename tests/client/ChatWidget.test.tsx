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
    expect(onNavigateToArticle).toHaveBeenCalledWith("solana");
  });
});
