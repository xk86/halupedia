import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PipelinesPane } from "../../src/client/admin/panes/PipelinesPane";

describe("PipelinesPane", () => {
  afterEach(() => cleanup());

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
            prompt_text: "### System\nUse **bold** rules.",
            cot_text: "## Thought\nConsider **constraints**.",
            response_text: "## Output\nFinal **answer**.",
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
    await userEvent.click(await screen.findByRole("button", { name: /123c/ }));

    const detail = screen.getByText("Prompt").closest(".admin-prompt-detail");
    expect(detail).toBeTruthy();
    expect(within(detail as HTMLElement).getByRole("heading", { name: "System" })).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByRole("heading", { name: "Thought" })).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByRole("heading", { name: "Output" })).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText("bold").tagName).toBe("STRONG");
    expect(within(detail as HTMLElement).getByText("constraints").tagName).toBe("STRONG");
    expect(within(detail as HTMLElement).getByText("answer").tagName).toBe("STRONG");
  });
});
