import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PromptRulesConfig } from "../../src/client/admin/prompts/PromptRulesConfig";

const categories = [
  {
    id: "canon",
    title: "Canon foundations",
    description: "Core world consistency.",
    order: 10,
    rules: [
      {
        id: "references_are_gospel",
        category: "canon",
        tier: 1 as const,
        text: "Treat references as canon.",
      },
    ],
  },
  {
    id: "content_policy",
    title: "Content policy",
    description: "Allowed subject matter.",
    order: 5,
    rules: [
      {
        id: "preserve_intent",
        category: "content_policy",
        tier: 1 as const,
        text: "Preserve intent.",
      },
    ],
  },
];

describe("PromptRulesConfig", () => {
  afterEach(cleanup);

  it("imports a category without enabling any of its rules", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PromptRulesConfig
        rules={{ categories: ["canon"] }}
        categories={categories}
        onChange={onChange}
      />,
    );

    expect(screen.getByText("Canon foundations")).toBeInTheDocument();
    expect(screen.queryByText("Content policy")).not.toBeInTheDocument();
    expect(screen.queryByText(/canon@/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/placeholder/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Add category" }));
    await user.click(
      await screen.findByRole("option", { name: "Content policy" }),
    );

    expect(onChange).toHaveBeenCalledWith({
      categories: ["canon", "content_policy"],
    });
  });

  it("shows shadowed rules in a fold and enables an explicit selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PromptRulesConfig
        rules={{ categories: ["canon"] }}
        categories={categories}
        onChange={onChange}
      />,
    );

    expect(screen.queryByText("References are gospel")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Expand Canon foundations rules" }),
    );

    const checkbox = screen.getByRole("checkbox", {
      name: "References are gospel",
    });
    expect(checkbox).toBeEnabled();
    expect(checkbox.closest("[data-selected]"))?.toHaveAttribute(
      "data-selected",
      "false",
    );

    await user.click(checkbox);

    expect(onChange).toHaveBeenCalledWith({
      categories: ["canon"],
      rules: ["canon/references_are_gospel"],
    });
  });

  it("removes selected rules when their namespace is removed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PromptRulesConfig
        rules={{
          categories: ["canon", "content_policy"],
          rules: [
            "canon/references_are_gospel",
            "content_policy/preserve_intent",
          ],
        }}
        categories={categories}
        onChange={onChange}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Remove Canon foundations" }),
    );

    expect(onChange).toHaveBeenCalledWith({
      categories: ["content_policy"],
      rules: ["content_policy/preserve_intent"],
    });
    expect(
      screen.queryByRole("button", { name: "Add prompt-only rule" }),
    ).not.toBeInTheDocument();
  });

  it("select-all writes a category/* wildcard and shows every rule as selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PromptRulesConfig
        rules={{ categories: ["canon"], rules: ["canon/references_are_gospel"] }}
        categories={categories}
        onChange={onChange}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Expand Canon foundations rules" }),
    );
    await user.click(screen.getByRole("checkbox", { name: /Select all/ }));

    expect(onChange).toHaveBeenLastCalledWith({
      categories: ["canon"],
      rules: ["canon/*"],
    });
  });

  it("turning select-all back off restores the exact prior explicit selection", async () => {
    const user = userEvent.setup();
    let rules: { categories: string[]; rules?: string[] } = {
      categories: ["canon"],
      rules: ["canon/references_are_gospel"],
    };
    const onChange = vi.fn((next) => {
      rules = next;
      rerender(
        <PromptRulesConfig
          rules={rules}
          categories={categories}
          onChange={onChange}
        />,
      );
    });
    const { rerender } = render(
      <PromptRulesConfig
        rules={rules}
        categories={categories}
        onChange={onChange}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Expand Canon foundations rules" }),
    );
    const selectAll = screen.getByRole("checkbox", { name: /Select all/ });
    await user.click(selectAll);
    expect(rules).toEqual({ categories: ["canon"], rules: ["canon/*"] });

    await user.click(screen.getByRole("checkbox", { name: /Select all/ }));
    expect(rules).toEqual({
      categories: ["canon"],
      rules: ["canon/references_are_gospel"],
    });
  });

  it("select-all disables individual checkboxes, all shown as checked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PromptRulesConfig
        rules={{ categories: ["canon"], rules: ["canon/*"] }}
        categories={categories}
        onChange={onChange}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Expand Canon foundations rules" }),
    );
    const checkbox = screen.getByRole("checkbox", {
      name: "References are gospel",
    });
    expect(checkbox).toBeChecked();
    expect(checkbox).toHaveAttribute("aria-disabled", "true");
  });
});
