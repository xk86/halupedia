import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdminWorkspace,
  useAdminLayout,
} from "../../src/client/admin/AdminLayout";
import { Pane } from "../../src/client/admin/Pane";

function Harness() {
  const { state, setOrder } = useAdminLayout();
  return (
    <AdminWorkspace
      view="overview"
      storedOrder={state.orders.overview ?? []}
      onOrderChange={setOrder}
      tiles={[
        {
          id: "alpha",
          content: (
            <Pane id="alpha" title="Alpha">
              Alpha content
            </Pane>
          ),
        },
        {
          id: "beta",
          content: (
            <Pane id="beta" title="Beta">
              Beta content
            </Pane>
          ),
        },
      ]}
    />
  );
}

function StateHarness() {
  const { state, setActiveView, setMode } = useAdminLayout();
  return (
    <>
      <output>{`${state.activeView}:${state.mode}`}</output>
      <button type="button" onClick={() => setActiveView("models")}>
        Models
      </button>
      <button type="button" onClick={() => setMode("split")}>
        Split
      </button>
    </>
  );
}

describe("AdminWorkspace", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(cleanup);

  it("reorders tiles and persists the order", async () => {
    const firstRender = render(<Harness />);
    const workspace = screen.getByTestId("admin-workspace-overview");

    expect(
      within(workspace)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Alpha", "Beta"]);

    await userEvent.click(
      screen.getByRole("button", { name: "Move Beta earlier" }),
    );

    expect(
      within(workspace)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Beta", "Alpha"]);
    expect(localStorage.getItem("halupedia:admin-layout:v1")).toContain(
      '"overview":["beta","alpha"]',
    );

    firstRender.unmount();
    render(<Harness />);
    expect(
      screen.getAllByRole("heading").map((heading) => heading.textContent),
    ).toEqual(["Beta", "Alpha"]);
  });

  it("persists the active tab and tab/split mode", async () => {
    const firstRender = render(<StateHarness />);
    expect(screen.getByText("overview:tabs")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Models" }));
    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(screen.getByText("models:split")).toBeInTheDocument();

    firstRender.unmount();
    render(<StateHarness />);
    expect(screen.getByText("models:split")).toBeInTheDocument();
  });
});
