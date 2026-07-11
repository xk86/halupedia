import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppConfigPane } from "../../src/client/admin/panes/AppConfigPane";

const payload = {
  sections: [
    {
      id: "retrieval",
      title: "Search & retrieval",
      description: "Retrieval controls.",
      fields: [
        {
          table: "rag",
          key: "enabled",
          label: "Enable retrieval",
          description: "Use retrieval.",
          kind: "boolean",
          value: true,
          configured: true,
        },
        {
          table: "rag",
          key: "min_score",
          label: "RAG minimum score",
          description: "Minimum score.",
          kind: "number",
          value: 0.25,
          configured: true,
          min: 0,
          max: 1,
          step: 0.01,
        },
      ],
    },
  ],
};

describe("AppConfigPane", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders typed controls and saves only changed section values", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") return Response.json({ ok: true });
        return Response.json(payload);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AppConfigPane />);

    const card = (await screen.findByText("Search & retrieval")).closest(
      "[data-slot=card]",
    );
    expect(card).not.toBeNull();
    expect(
      within(card as HTMLElement).getByRole("checkbox", {
        name: "Enable retrieval",
      }),
    ).toBeChecked();
    expect(
      within(card as HTMLElement).getByLabelText("RAG minimum score", {
        selector: "input",
      }),
    ).toHaveValue(0.25);

    await user.click(
      within(card as HTMLElement).getByRole("checkbox", {
        name: "Enable retrieval",
      }),
    );
    await user.click(
      within(card as HTMLElement).getByRole("button", { name: "Save section" }),
    );

    await waitFor(() => {
      const saveCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === "PUT",
      );
      expect(saveCall).toBeDefined();
      expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
        updates: [{ path: "rag.enabled", value: false }],
      });
    });
    expect(
      await screen.findByText("Search & retrieval saved and runtime reloaded."),
    ).toBeInTheDocument();
  });

  it("resets unsaved values without sending a request", async () => {
    const fetchMock = vi.fn(async () => Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AppConfigPane />);

    const input = await screen.findByLabelText("RAG minimum score", {
      selector: "input",
    });
    await user.clear(input);
    await user.type(input, "0.5");
    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(input).toHaveValue(0.25);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses a responsive auto-fit grid for compact section fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(payload)),
    );
    render(<AppConfigPane />);

    const sections = await screen.findByTestId("config-sections");
    const fields = await screen.findByTestId("config-fields-retrieval");
    expect(sections).toHaveClass("grid", "min-w-0", "gap-3");
    expect(sections.className).not.toContain("grid-cols-2");
    expect(fields).toHaveClass("grid", "min-w-0", "gap-y-3");
    expect(fields.className).toContain("auto-fit");
    expect(fields.className).toContain("min(100%,15rem)");
  });
});
