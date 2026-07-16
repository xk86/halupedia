import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowSchedulePane } from "../../src/client/admin/panes/WorkflowSchedulePane";

const payload = {
  schedules: [],
  extractQueue: [
    {
      id: 11,
      articleSlug: "extraction-slug",
      articleTitle: "Extraction article with a deliberately long title",
      status: "done",
      enqueuedAt: Date.UTC(2026, 0, 1, 12, 0, 0),
      startedAt: Date.UTC(2026, 0, 1, 12, 1, 0),
      finishedAt: Date.UTC(2026, 0, 1, 12, 1, 30),
      called: true,
      reason: "vocabulary_changed",
      error: null,
    },
  ],
  queue: [
    {
      id: 12,
      articleSlug: "review-slug",
      articleTitle: "Review article with a deliberately long title",
      status: "done",
      enqueuedAt: Date.UTC(2026, 0, 1, 12, 2, 0),
      startedAt: Date.UTC(2026, 0, 1, 12, 3, 0),
      finishedAt: Date.UTC(2026, 0, 1, 12, 3, 20),
      verdict: "partial",
      passed: 2,
      failed: 1,
      resultJson: null,
      error: null,
    },
  ],
};

describe("WorkflowSchedulePane", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders extraction and review queues as dense fixed-layout shadcn tables", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(payload), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    render(<WorkflowSchedulePane onNavigate={() => {}} />);

    const extractionHeading = await screen.findByRole("heading", {
      name: "Extraction queue",
    });
    const reviewHeading = screen.getByRole("heading", { name: "Review queue" });
    expect(extractionHeading).toBeInTheDocument();
    expect(reviewHeading).toBeInTheDocument();

    const queueTables = screen.getAllByRole("table").slice(-2);
    expect(queueTables).toHaveLength(2);
    for (const table of queueTables) {
      expect(table).toHaveClass("table-fixed");
      expect(within(table).getAllByRole("columnheader")).toHaveLength(4);
      expect(
        within(table).getByRole("columnheader", { name: "Article" }),
      ).toBeInTheDocument();
      expect(
        within(table).getByRole("columnheader", { name: "State" }),
      ).toBeInTheDocument();
      expect(
        within(table).getByRole("columnheader", { name: "Timing" }),
      ).toBeInTheDocument();
      expect(
        within(table).getByRole("columnheader", { name: "Outcome" }),
      ).toBeInTheDocument();
    }

    expect(screen.getByText("#11 · extraction-slug")).toBeInTheDocument();
    expect(screen.getByText("#12 · review-slug")).toBeInTheDocument();
    expect(screen.getByText("LLM called")).toBeInTheDocument();
    expect(screen.getByText("vocabulary_changed")).toBeInTheDocument();
    expect(screen.getByText("2 passed")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getAllByText(/wait 1m/)).toHaveLength(2);
    expect(screen.getByText(/ran 30s/)).toBeInTheDocument();
    expect(screen.getByText(/ran 20s/)).toBeInTheDocument();

    const extractionLink = screen.getByRole("link", {
      name: "Extraction article with a deliberately long title",
    });
    expect(extractionLink).toHaveClass("block", "truncate");

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });
});
