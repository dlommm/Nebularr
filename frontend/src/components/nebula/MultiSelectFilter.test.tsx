import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MultiSelectFilter } from "./MultiSelectFilter";

const OPTIONS = ["sonarr", "radarr", "manual import"];

describe("MultiSelectFilter", () => {
  it("shows All when nothing is selected and N selected otherwise", () => {
    const { rerender } = render(
      <MultiSelectFilter label="source" options={OPTIONS} selected={[]} onChange={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Filter source" })).toHaveTextContent("All");
    rerender(<MultiSelectFilter label="source" options={OPTIONS} selected={["sonarr", "radarr"]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Filter source" })).toHaveTextContent("2 selected");
  });

  it("opens, searches, and toggles an option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MultiSelectFilter label="source" options={OPTIONS} selected={["sonarr"]} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Filter source" }));
    expect(screen.getByRole("listbox", { name: "source values" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);

    await user.type(screen.getByRole("textbox", { name: "Search source values" }), "rad");
    expect(screen.getAllByRole("option")).toHaveLength(1);

    await user.click(screen.getByRole("option", { name: /radarr/ }));
    expect(onChange).toHaveBeenCalledWith(["sonarr", "radarr"]);
  });

  it("deselects a selected option and clears all", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MultiSelectFilter label="source" options={OPTIONS} selected={["sonarr"]} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Filter source" }));
    await user.click(screen.getByRole("option", { name: /sonarr/ }));
    expect(onChange).toHaveBeenCalledWith([]);

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<MultiSelectFilter label="source" options={OPTIONS} selected={[]} onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Filter source" }));
    expect(screen.getByRole("listbox", { name: "source values" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "source values" })).not.toBeInTheDocument();
  });
});
