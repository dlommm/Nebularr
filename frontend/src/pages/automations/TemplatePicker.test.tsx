import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TemplatePicker } from "./TemplatePicker";
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

describe("TemplatePicker", () => {
  it("makes the whole template a single click target and fires onUse", () => {
    const onUse = vi.fn();
    render(<TemplatePicker templates={TEMPLATES} onUse={onUse} />);
    fireEvent.click(screen.getByRole("button", { name: /anime english-dub enforcer/i }));
    expect(onUse).toHaveBeenCalledWith(TEMPLATES[0]);
  });

  it("phrases the schedule in English rather than showing crontab", () => {
    render(<TemplatePicker templates={TEMPLATES} onUse={vi.fn()} />);
    expect(screen.getByText(/runs every 2 days at 06:00/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 6 \*\/2/)).toBeNull();
  });
});
