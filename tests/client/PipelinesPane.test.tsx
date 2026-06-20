import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PipelinesPane } from "../../src/client/admin/panes/PipelinesPane";

describe("PipelinesPane", () => {
  afterEach(() => cleanup());

  it("shows toggleable live reasoning and response views", async () => {
    render(
      <PipelinesPane
        workflows={[]}
        runs={[]}
        activeRuns={[{
          slug: "live-article",
          title: "Live Article",
          workflow: "article.generate",
          phase: "llm.generate_article",
          startedAt: Date.now(),
          views: [{
            node: "llm.generate_article",
            reasoning: "Live reasoning tokens",
            response: "Live response tokens",
          }],
        }]}
        traceEnabled
        error={null}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByText("Live reasoning tokens")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Response/ }));
    expect(screen.getByText("Live response tokens")).toBeInTheDocument();
  });

  it("renders captured prompt, chain-of-thought, and output as markdown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        nodes: [
          {
            node_name: "llm.test",
            node_kind: "llm",
            duration_ms: 5,
            status: "ok",
            prompt_chars: 123,
            prompt_text: "### System\nUse **bold** [Alpha](ref:alpha) rules.\n\n### User\nWrite **user** [Beta](halu:beta-topic \"hint\") content.",
            cot_text: "## Thought\nConsider **constraints**.",
            response_text: "## Output\nFinal **answer**.",
            llm_role: "images",
            llm_resolved_role: "light",
            llm_config_key: "llm.light",
            llm_model: "gemma3:4b-it-qat",
            llm_base_url: "http://cat-desktop:11434/v1",
            llm_host: "cat-desktop:11434",
            llm_temperature: 0.7,
            llm_max_tokens: 2400,
            llm_top_k: 10,
            llm_top_p: 0.85,
            llm_min_p: 0.05,
            llm_thinking: 1,
            llm_json_mode: 0,
            llm_image_count: 2,
          },
        ],
      }), { headers: { "content-type": "application/json" } }),
    ));

    render(
      <PipelinesPane
        workflows={[]}
        runs={[{
          run_id: "run-1",
          workflow: "test.workflow",
          slug: "test-slug",
          started_at: 1,
          duration_ms: 5,
          status: "ok",
          nodes_executed: 1,
          error_message: null,
        }]}
        traceEnabled
        error={null}
        onRefresh={() => {}}
      />,
    );

    await userEvent.click(screen.getByText("test.workflow"));
    await userEvent.click(await screen.findByRole("button", { name: /123 chars/ }));

    const detail = screen.getByText("System prompt").closest('[data-testid="trace-detail"]');
    expect(detail).toBeTruthy();
    expect(within(detail as HTMLElement).getByText("System prompt")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("User prompt")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByRole("heading", { name: "Thought" })).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByRole("heading", { name: "Output" })).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("llm.light")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("images -> light")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("gemma3:4b-it-qat")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("cat-desktop:11434")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("http://cat-desktop:11434/v1")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("2400")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("Top K")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("10")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("Top P")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("0.85")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("Min P")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("0.05")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getAllByText("on").length).toBeGreaterThan(0);
    expect(within(detail as HTMLElement).getByText("bold").tagName).toBe("STRONG");
    expect(within(detail as HTMLElement).getByText("user").tagName).toBe("STRONG");
    expect(within(detail as HTMLElement).getByRole("link", { name: "Alpha" })).toHaveAttribute("href", "/wiki/Alpha");
    expect(within(detail as HTMLElement).getByRole("link", { name: "Beta" })).toHaveAttribute("href", "/wiki/Beta_Topic");
    expect(within(detail as HTMLElement).getByText("constraints").tagName).toBe("STRONG");
    expect(within(detail as HTMLElement).getByText("answer").tagName).toBe("STRONG");
  });

  it("renders retrieved RAG context in a prompt-style dropdown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        nodes: [
          {
            node_name: "read.retrieve_context",
            node_kind: "read",
            duration_ms: 7,
            status: "ok",
            patch: {
              retrievedContext: {
                sourceArticles: [
                  {
                    slug: "source-topic",
                    title: "Source Topic",
                    content: "Selected source segment text.",
                    score: 0.8123,
                  },
                ],
                ragTitles: ["Source Topic"],
                backlinks: [{ slug: "backlink-topic", title: "Backlink Topic" }],
              },
            },
          },
          {
            node_name: "llm.generate_article",
            node_kind: "llm",
            duration_ms: 3,
            status: "ok",
            prompt_chars: 456,
            prompt_text: [
              "### System",
              "System text.",
              "",
              "### User",
              "References — link to these using [Visible Title](ref:slug) syntax.",
              "",
              "ADDITIONAL REFERENCES — use if relevant:",
              "",
              "### [Source Topic](ref:source-topic)",
              "Selected source segment text.",
              "",
              "Retrieved context:",
              "",
              "## [Source Topic](ref:source-topic)",
              "Selected source segment text.",
              "",
              "Suggested related existing topics:",
              "",
              "- [Source Topic](ref:source-topic)",
              "",
              "Output the full article Markdown.",
            ].join("\n"),
          },
        ],
      }), { headers: { "content-type": "application/json" } }),
    ));

    render(
      <PipelinesPane
        workflows={[]}
        runs={[{
          run_id: "run-2",
          workflow: "article.generate",
          slug: "target-slug",
          started_at: 1,
          duration_ms: 10,
          status: "ok",
          nodes_executed: 2,
          error_message: null,
        }]}
        traceEnabled
        error={null}
        onRefresh={() => {}}
      />,
    );

    await userEvent.click(screen.getByText("article.generate"));
    const ragButtons = await screen.findAllByRole("button", { name: /RAG 1/ });
    await userEvent.click(ragButtons[0]);

    const detail = screen.getByText("Retrieved source segments").closest('[data-testid="trace-detail"]');
    expect(detail).toBeTruthy();
    expect(within(detail as HTMLElement).getByText(/slug: source-topic .* score: 0\.812/)).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("Selected source segment text.")).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText(/Backlink Topic/)).toBeInTheDocument();

    await userEvent.click(ragButtons[1]);
    expect(screen.getByText("Retrieved source segments")).toBeInTheDocument();
    expect(screen.getByText("Reference context in prompt")).toBeInTheDocument();
    expect(screen.getByText("RAG context in prompt")).toBeInTheDocument();
    expect(screen.getByText("Related titles in prompt")).toBeInTheDocument();
  });

  it("puts infobox reference context on the infobox LLM row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        nodes: [
          {
            node_name: "read.infobox_refs",
            node_kind: "read",
            duration_ms: 1,
            status: "ok",
            diff: {
              references: {
                kind: "add",
                after: [
                  {
                    slug: "alpha",
                    title: "Alpha",
                    content: "Alpha summary.",
                    kind: "summary",
                    pinned: false,
                    source: "body",
                  },
                  {
                    slug: "beta",
                    title: "Beta",
                    content: "Beta summary.",
                    kind: "summary",
                    pinned: false,
                    source: "body",
                  },
                ],
              },
            },
          },
          {
            node_name: "llm.generate_infobox",
            node_kind: "llm",
            duration_ms: 4,
            status: "ok",
            prompt_chars: 789,
            prompt_text: [
              "### System",
              "Return JSON.",
              "",
              "### User",
              "Article body:",
              "",
              "Body text.",
              "",
              "Known encyclopedia articles (for ref-link slugs only - derive all facts from the body above):",
              "",
              "[Alpha](ref:alpha)",
              "[Beta](ref:beta)",
              "",
              "Generate the infobox JSON for this article.",
            ].join("\n"),
          },
        ],
      }), { headers: { "content-type": "application/json" } }),
    ));

    render(
      <PipelinesPane
        workflows={[]}
        runs={[{
          run_id: "run-3",
          workflow: "article.post_process",
          slug: "target-slug",
          started_at: 1,
          duration_ms: 10,
          status: "ok",
          nodes_executed: 2,
          error_message: null,
        }]}
        traceEnabled
        error={null}
        onRefresh={() => {}}
      />,
    );

    await userEvent.click(screen.getByText("article.post_process"));
    expect(screen.queryByText("RAG 0")).not.toBeInTheDocument();
    const ragButtons = await screen.findAllByRole("button", { name: /RAG 2/ });
    await userEvent.click(ragButtons[0]);
    expect(screen.getByText("Reference list after step")).toBeInTheDocument();
    expect(screen.getByText("Alpha summary.")).toBeInTheDocument();

    await userEvent.click(ragButtons[1]);
    expect(screen.getByText("Reference list after step")).toBeInTheDocument();
    expect(screen.getByText("Reference context in prompt")).toBeInTheDocument();
    expect(screen.getAllByText("Prompt refs").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Alpha" })).toHaveAttribute("href", "/wiki/Alpha");
  });
});
