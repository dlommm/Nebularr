import type { AutomationRow } from "../../types";
import { fmtDate } from "../../hooks";
import { GlassCard } from "@/components/nebula/GlassCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function statusVariant(status: string | null): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed") return "destructive";
  if (status === "success") return "default";
  return "secondary";
}

export function AutomationList({
  automations,
  onEdit,
  onRun,
  onDelete,
  onToggle,
  onHistory,
}: {
  automations: AutomationRow[];
  onEdit: (row: AutomationRow) => void;
  onRun: (row: AutomationRow) => void;
  onDelete: (row: AutomationRow) => void;
  onToggle: (row: AutomationRow, patch: { enabled?: boolean; dry_run?: boolean }) => void;
  onHistory: (row: AutomationRow) => void;
}): JSX.Element {
  return (
    <GlassCard>
      <CardHeader>
        <CardTitle>Automations</CardTitle>
        <CardDescription>
          Each automation runs on its own cron, capped by its per-run budget, the global
          daily search cap, and a per-item cooldown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {automations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No automations yet — pick a template below to create your first one.
          </p>
        ) : null}
        {automations.map((row) => (
          <div key={row.id} className="rounded-xl border border-border bg-muted/40 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{row.name}</span>
              <Badge variant="outline">{row.template_key}</Badge>
              {row.dry_run ? <Badge variant="secondary">dry run</Badge> : null}
              {!row.enabled ? <Badge variant="outline">disabled</Badge> : null}
              <span className="ml-auto text-xs text-muted-foreground">
                cron {row.cron} ({row.timezone})
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {row.last_run_status ? (
                <>
                  <Badge variant={statusVariant(row.last_run_status)}>{row.last_run_status}</Badge>
                  <span>
                    matched {row.last_run_matched ?? 0}, actions {row.last_run_actions ?? 0} —{" "}
                    {fmtDate(row.last_run_started_at ?? "")}
                  </span>
                </>
              ) : (
                <span>never run</span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => onRun(row)}>
                Run now
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => onEdit(row)}>
                Edit
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => onHistory(row)}>
                History
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => onToggle(row, { enabled: !row.enabled })}
              >
                {row.enabled ? "Disable" : "Enable"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => onToggle(row, { dry_run: !row.dry_run })}
              >
                {row.dry_run ? "Go live" : "Back to dry-run"}
              </Button>
              <Button type="button" size="sm" variant="destructive" onClick={() => onDelete(row)}>
                Delete
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </GlassCard>
  );
}
