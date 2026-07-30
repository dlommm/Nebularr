import type { AutomationTemplate } from "../../types";
import { GlassCard } from "@/components/nebula/GlassCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function TemplateGallery({
  templates,
  onUse,
}: {
  templates: AutomationTemplate[];
  onUse: (template: AutomationTemplate) => void;
}): JSX.Element {
  return (
    <GlassCard>
      <CardHeader>
        <CardTitle>Templates</CardTitle>
        <CardDescription>
          Start from a preset and tweak it. New automations are created in dry-run: they
          report what they would do until you flip them live.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <div key={template.key} className="flex flex-col rounded-xl border border-border bg-muted/40 p-4">
              <div className="flex items-center gap-2">
                <span className="font-medium">{template.title}</span>
                <Badge variant="outline">{template.key}</Badge>
              </div>
              <p className="mt-2 flex-1 text-sm text-muted-foreground">{template.description}</p>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">cron {template.default_cron}</span>
                <Button type="button" size="sm" variant="secondary" onClick={() => onUse(template)}>
                  Use template
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </GlassCard>
  );
}
