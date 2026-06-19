import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownEditor } from "../../src/client/MarkdownEditor";

afterEach(() => cleanup());

// The rich (ProseKit) editor mounts web components that aren't jsdom-friendly,
// so it's exercised in-browser rather than here. These tests cover the
// plain-text mode, which is plain React with no ProseKit dependency.
describe("MarkdownEditor (plainText)", () => {
  it("edits the value as a literal textarea with no markdown round-trip", async () => {
    const onChange = vi.fn();
    const Wrapper = () => {
      const [value, setValue] = useState('Return JSON: {"presetKey":"one_allowed_key"}');
      return (
        <MarkdownEditor
          plainText
          value={value}
          onChange={(v) => {
            onChange(v);
            setValue(v);
          }}
        />
      );
    };
    render(<Wrapper />);

    const ta = document.querySelector(".mdedit-plain") as HTMLTextAreaElement;
    expect(ta.tagName).toBe("TEXTAREA");
    // Underscores and braces survive verbatim — not escaped to \_ or reflowed.
    expect(ta.value).toBe('Return JSON: {"presetKey":"one_allowed_key"}');

    // `{{` is userEvent's escape for a literal "{".
    await userEvent.type(ta, " also_more");
    expect(onChange).toHaveBeenLastCalledWith(
      'Return JSON: {"presetKey":"one_allowed_key"} also_more',
    );
  });

  it("passes typed text through onChange unchanged", async () => {
    const onChange = vi.fn();
    const Wrapper = () => {
      const [value, setValue] = useState("");
      return (
        <MarkdownEditor
          plainText
          value={value}
          onChange={(v) => {
            onChange(v);
            setValue(v);
          }}
          placeholder="Prompt…"
        />
      );
    };
    render(<Wrapper />);

    await userEvent.type(screen.getByPlaceholderText("Prompt…"), "a_b_c");
    expect(onChange).toHaveBeenLastCalledWith("a_b_c");
  });

  it("respects disabled", () => {
    render(<MarkdownEditor plainText value="x" onChange={vi.fn()} disabled />);
    expect(document.querySelector(".mdedit-plain")).toBeDisabled();
  });
});
