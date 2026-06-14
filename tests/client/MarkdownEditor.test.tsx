import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownEditor, joinMarkdownBlocks, splitMarkdownBlocks } from "../../src/client/MarkdownEditor";

describe("splitMarkdownBlocks", () => {
  it("splits on blank lines", () => {
    expect(splitMarkdownBlocks("# Title\n\nPara one.\n\n- a\n- b")).toEqual([
      "# Title",
      "Para one.",
      "- a\n- b",
    ]);
  });

  it("keeps fenced code blocks with blank lines intact", () => {
    const doc = "Intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro";
    expect(splitMarkdownBlocks(doc)).toEqual([
      "Intro",
      "```js\nconst a = 1;\n\nconst b = 2;\n```",
      "Outro",
    ]);
  });

  it("round-trips through join", () => {
    const doc = "# T\n\nBody text.\n\n> quote";
    expect(joinMarkdownBlocks(splitMarkdownBlocks(doc))).toBe(doc);
  });
});

describe("MarkdownEditor", () => {
  afterEach(() => cleanup());

  it("renders blocks as markdown and destructures to source on click", async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value={"# Heading\n\nSome **bold** text."} onChange={onChange} />);

    // Rendered, not raw: heading element exists, raw "#" syntax doesn't.
    expect(screen.getByRole("heading", { name: "Heading" })).toBeInTheDocument();
    expect(screen.queryByText("# Heading")).not.toBeInTheDocument();

    // Click the bold paragraph block → raw markdown source appears in a textarea.
    await userEvent.click(screen.getByText("bold"));
    const ta = screen.getByDisplayValue("Some **bold** text.") as HTMLTextAreaElement;
    expect(ta.tagName).toBe("TEXTAREA");
    // Spell check stays on for prose editing.
    expect(ta.getAttribute("spellcheck")).toBe("true");

    await userEvent.type(ta, " More.");
    expect(onChange).toHaveBeenLastCalledWith("# Heading\n\nSome **bold** text. More.");

    // Blur re-renders the block.
    await userEvent.tab();
    expect(screen.queryByDisplayValue(/Some \*\*bold\*\*/)).not.toBeInTheDocument();
    expect(screen.getByText("bold")).toBeInTheDocument();
  });

  it("starts a new block from the add area when empty", async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="" onChange={onChange} placeholder="Write here…" />);

    await userEvent.click(screen.getByText("Write here…"));
    await userEvent.type(screen.getByPlaceholderText("Write here…"), "hello");
    expect(onChange).toHaveBeenLastCalledWith("hello");
  });

  it("offers a raw-text mode for the whole document", async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value={"# A\n\nB"} onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: "Raw text" }));
    const ta = document.querySelector(".mdedit-raw-textarea") as HTMLTextAreaElement;
    expect(ta.value).toBe("# A\n\nB");

    await userEvent.click(screen.getByRole("button", { name: "Rendered blocks" }));
    expect(screen.getByRole("heading", { name: "A" })).toBeInTheDocument();
  });

  it("keeps rendered blocks in sync with raw-text edits", async () => {
    const Wrapper = () => {
      const [value, setValue] = useState("# A\n\nB");
      return <MarkdownEditor value={value} onChange={setValue} />;
    };
    render(<Wrapper />);

    await userEvent.click(screen.getByRole("button", { name: "Raw text" }));
    const ta = document.querySelector(".mdedit-raw-textarea") as HTMLTextAreaElement;
    await userEvent.clear(ta);
    await userEvent.type(ta, "# A\n\nChanged in raw mode.");

    await userEvent.click(screen.getByRole("button", { name: "Rendered blocks" }));
    expect(screen.getByText("Changed in raw mode.")).toBeInTheDocument();
    expect(screen.queryByText("B")).not.toBeInTheDocument();
  });
});
