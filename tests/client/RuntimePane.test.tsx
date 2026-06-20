import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RuntimePane } from "../../src/client/admin/panes/RuntimePane";

describe("RuntimePane", () => {
  it("uses shared themed data and action primitives", () => {
    render(
      <RuntimePane
        databasePath="data/halupedia.sqlite"
        promptConfigPath="config/prompts"
        ragMode="full"
      />,
    );

    const table = screen.getByRole("table");
    expect(table).toHaveAttribute("data-slot", "table");
    expect(screen.getByText("data/halupedia.sqlite")).toHaveClass("font-mono");
    expect(screen.getByText("config/prompts")).toBeInTheDocument();
    expect(screen.getByText("full")).toBeInTheDocument();

    const download = screen.getByRole("link", {
      name: "Download latest DB backup",
    });
    expect(download).toHaveAttribute("download");
    expect(download).toHaveAttribute("href", "/api/admin/db-backup/latest");
    expect(download).toHaveClass("bg-primary", "rounded-md");
  });
});
