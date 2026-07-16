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
  {
    id: "tone",
    title: "Tone rules",
    description: "Voice and phrasing.",
    order: 20,
    rules: [
      {
        id: "no_fictional_label",
        category: "tone",
        tier: 1 as const,
        text: "Do not label the world as fictional.",
      },
    ],
  },
];

const availableRules = categories.flatMap((category) => category.rules);

describe("PromptRulesConfig", () => {
  afterEach(cleanup);

  it("shows human names and adds whole categories without selector syntax", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PromptRulesConfig
        rules={{ categories: ["canon"], rules: ["tone/no_fictional_label"] }}
        localRules={[]}
        categories={categories}
        availableRules={availableRules}
        onChange={onChange}
      />,
    );

    expect(screen.getByText("Canon foundations")).toBeInTheDocument();
    expect(screen.getByText("No fictional label")).toBeInTheDocument();
    expect(screen.queryByText(/canon@/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/placeholder/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Choose categories" }));
    await user.click(screen.getByRole("checkbox", { name: /content policy/i }));

    expect(onChange).toHaveBeenCalledWith(
      {
        categories: ["canon", "content_policy"],
        rules: ["tone/no_fictional_label"],
      },
      [],
    );
  });
});
