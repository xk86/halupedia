import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Slider } from "../../src/client/components/ui/slider";

describe("Slider", () => {
  afterEach(cleanup);

  it("maps Base UI orientation attributes to visible horizontal geometry", () => {
    const { container } = render(<Slider value={6} min={0} max={24} />);

    const root = container.querySelector('[data-slot="slider"]');
    const track = container.querySelector('[data-slot="slider-track"]');
    const range = container.querySelector('[data-slot="slider-range"]');

    expect(root).toHaveAttribute("data-orientation", "horizontal");
    expect(root).toHaveClass("data-[orientation=horizontal]:w-full");
    expect(track).toHaveClass("data-[orientation=horizontal]:h-1.5");
    expect(track).toHaveClass("data-[orientation=horizontal]:w-full");
    expect(range).toHaveClass("data-[orientation=horizontal]:h-full");
    expect(container.querySelectorAll('[data-slot="slider-thumb"]')).toHaveLength(
      1,
    );
  });
});
