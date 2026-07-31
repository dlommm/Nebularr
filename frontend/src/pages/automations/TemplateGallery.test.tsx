import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TemplateGallery } from "./TemplateGallery";
import type { AutomationTemplate } from "../../types";

const TEMPLATES: AutomationTemplate[] = [
  {
    key: "anime-dub-enforcer",
    title: "Anime English-dub enforcer",
    description: "Hunts dubs.",
    default_cron: "0 6 */2 * *",
    default_params: { scope: { media: "both" } },
  },
];

describe("TemplateGallery", () => {
  it("renders a card per template and fires onUse", () => {
    const onUse = vi.fn();
    render(<TemplateGallery templates={TEMPLATES} onUse={onUse} />);
    expect(screen.getByText("Anime English-dub enforcer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /use template/i }));
    expect(onUse).toHaveBeenCalledWith(TEMPLATES[0]);
  });
});
