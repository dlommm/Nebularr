import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MultiSelectFilter } from "./MultiSelectFilter";

const OPTIONS = ["sonarr", "radarr", "manual import"];

// The menu's accessible name comes from aria-labelledby -> the trigger
// (base-ui's standard menu-button pattern), i.e. the trigger's own
// aria-label ("Filter {label}") — not a label set on the menu itself.
async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Filter source" }));
  return screen.findByRole("menu", { name: "Filter source" });
}

describe("MultiSelectFilter", () => {
  it("shows All when nothing is selected and N selected otherwise", () => {
    const { rerender } = render(
      <MultiSelectFilter label="source" options={OPTIONS} selected={[]} onChange={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Filter source" })).toHaveTextContent("All");
    rerender(<MultiSelectFilter label="source" options={OPTIONS} selected={["sonarr", "radarr"]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Filter source" })).toHaveTextContent("2 selected");
  });

  it("opens on a real menu with keyboard-navigable checkbox items, searches, and toggles an option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MultiSelectFilter label="source" options={OPTIONS} selected={["sonarr"]} onChange={onChange} />);

    await openMenu(user);
    expect(screen.getAllByRole("menuitemcheckbox")).toHaveLength(3);
    expect(screen.getByRole("menuitemcheckbox", { name: /sonarr/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemcheckbox", { name: /radarr/ })).toHaveAttribute("aria-checked", "false");

    await user.type(screen.getByRole("textbox", { name: "Search source values" }), "rad");
    expect(screen.getAllByRole("menuitemcheckbox")).toHaveLength(1);

    await user.click(screen.getByRole("menuitemcheckbox", { name: /radarr/ }));
    expect(onChange).toHaveBeenCalledWith(["sonarr", "radarr"]);
  });

  it("deselects a selected option and clears all", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MultiSelectFilter label="source" options={OPTIONS} selected={["sonarr"]} onChange={onChange} />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitemcheckbox", { name: /sonarr/ }));
    expect(onChange).toHaveBeenCalledWith([]);

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("keeps the menu open after toggling an option (multi-select, not single-pick)", async () => {
    const user = userEvent.setup();
    render(<MultiSelectFilter label="source" options={OPTIONS} selected={[]} onChange={() => {}} />);
    await openMenu(user);
    await user.click(screen.getByRole("menuitemcheckbox", { name: /sonarr/ }));
    expect(screen.getByRole("menu", { name: "Filter source" })).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<MultiSelectFilter label="source" options={OPTIONS} selected={[]} onChange={() => {}} />);
    await openMenu(user);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Filter source" })).not.toBeInTheDocument();
    });
  });

  it("moves focus into the option list on ArrowDown without first tabbing out of the search input", async () => {
    const user = userEvent.setup();
    render(<MultiSelectFilter label="source" options={OPTIONS} selected={[]} onChange={() => {}} />);
    await openMenu(user);

    const search = screen.getByRole("textbox", { name: "Search source values" });
    expect(search).toHaveFocus();

    await user.keyboard("{ArrowDown}");

    await waitFor(() => {
      expect(search).not.toHaveFocus();
    });
    expect(screen.getAllByRole("menuitemcheckbox")).toContain(document.activeElement);
  });
});
