import type { AutomationTemplate } from "../../types";
import { describeCron } from "./automationSummary";

/**
 * Starting point for a new automation, shown inside the sheet.
 *
 * This replaces a template gallery that was permanently mounted at the bottom
 * of the page: it was only useful at the moment of creation, but it competed
 * with the automations you already had for the rest of the time.
 */
export function TemplatePicker({
  templates,
  onUse,
}: {
  templates: AutomationTemplate[];
  onUse: (template: AutomationTemplate) => void;
}): JSX.Element {
  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted-foreground">
        Pick a starting point — you can change everything afterwards. New automations begin in
        dry-run: they report what they would do until you flip them live.
      </p>
      {templates.map((template) => (
        <button
          key={template.key}
          type="button"
          onClick={() => onUse(template)}
          className="rounded-xl border border-border bg-muted/40 p-3 text-left transition-colors hover:border-ring hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className="block text-sm font-medium">{template.title}</span>
          <span className="mt-1 block text-xs text-muted-foreground">{template.description}</span>
          <span className="mt-2 block text-xs text-muted-foreground">
            Runs {describeCron(template.default_cron)}
          </span>
        </button>
      ))}
    </div>
  );
}
