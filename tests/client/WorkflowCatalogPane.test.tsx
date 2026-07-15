import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { WorkflowCatalogPane } from "../../src/client/admin/panes/WorkflowCatalogPane";

describe("WorkflowCatalogPane", () => {
  afterEach(() => cleanup());

  it("is collapsed by default and shows the complete workflow graph once expanded", async () => {
    render(
      <WorkflowCatalogPane
        workflows={[
          {
            name: "article.generate",
            description: "Generate a new encyclopedia article.",
            summary: "Generate and persist an article.",
            nodes: [
              {
                name: "read.retrieve_context",
                kind: "read",
                description: "Retrieve related source material.",
                conditional: false,
              },
              {
                name: "llm.generate_article",
                kind: "llm",
                description: "Generate article Markdown.",
                conditional: true,
                whenLabel: "when generation is required",
              },
              {
                name: "write.persist_article",
                kind: "write",
                description: "Persist Markdown and graph edges.",
                conditional: false,
              },
            ],
          },
        ]}
      />,
    );

    // Collapsed by default: node detail isn't rendered yet.
    expect(
      screen.queryByText("Generate a new encyclopedia article."),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Workflows/ }));

    expect(
      screen.getByText("Generate a new encyclopedia article."),
    ).toBeVisible();
    const flow = screen.getByTestId("workflow-flow");
    const nodeName = screen.getByText("read.retrieve_context");
    const nodeDescription = screen.getByText(
      /Retrieve related source material/,
    );
    expect(nodeName.parentElement).toBe(nodeDescription.parentElement);
    expect(nodeDescription).toBeVisible();
    expect(screen.getByText(/Generate article Markdown/)).toBeVisible();
    expect(screen.getByText(/Persist Markdown and graph edges/)).toBeVisible();
    expect(screen.getByText("when generation is required")).toBeVisible();
    expect(within(flow).getAllByRole("listitem")).toHaveLength(3);
  });
});
