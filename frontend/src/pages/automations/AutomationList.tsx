import { CalendarClock, MoreHorizontal, Play, Zap } from "lucide-react";
import type { AutomationRow } from "../../types";
import { fmtDate } from "../../hooks";
import { EmptyState } from "@/components/nebula/EmptyState";
import { StatusBadge } from "@/components/nebula/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { describeCron } from "./automationSummary";

/**
 * One row per automation: identity and last outcome at a glance, a single
 * primary action, and everything else behind an overflow menu.
 *
 * The previous row offered six same-weight buttons — including an unconfirmed
 * Delete and an unconfirmed "Go live", which is the one control that turns a
 * simulation into real searches against the user's indexers.
 */
export function AutomationList({
  automations,
  onEdit,
  onRun,
  onDelete,
  onToggle,
  onHistory,
  onCreate,
}: {
  automations: AutomationRow[];
  onEdit: (row: AutomationRow) => void;
  onRun: (row: AutomationRow) => void;
  onDelete: (row: AutomationRow) => void;
  onToggle: (row: AutomationRow, patch: { enabled?: boolean; dry_run?: boolean }) => void;
  onHistory: (row: AutomationRow) => void;
  onCreate: () => void;
}): JSX.Element {
  if (automations.length === 0) {
    return (
      <EmptyState
        icon={Zap}
        title="No automations yet"
        description="Automations converge your library toward what you actually want — English dubs, a resolution floor, no missing episodes — on a schedule you set."
      >
        <Button type="button" size="sm" onClick={onCreate}>
          New automation
        </Button>
      </EmptyState>
    );
  }

  return (
    <div className="grid gap-3">
      {automations.map((row) => (
        <div key={row.id} className="rounded-xl border border-border bg-muted/40 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onEdit(row)}
              className="rounded-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              {row.name}
            </button>
            {row.dry_run ? <Badge variant="secondary">dry run</Badge> : null}
            {!row.enabled ? <Badge variant="outline">disabled</Badge> : null}
            {row.enabled && !row.dry_run ? <Badge>live</Badge> : null}
          </div>

          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarClock className="size-3.5 shrink-0" aria-hidden />
            {describeCron(row.cron)} · {row.timezone}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {row.last_run_status ? (
              <>
                <StatusBadge status={row.last_run_status} />
                <span>
                  {row.last_run_matched ?? 0} matched, {row.last_run_actions ?? 0} action
                  {(row.last_run_actions ?? 0) === 1 ? "" : "s"} · {fmtDate(row.last_run_started_at ?? "")}
                </span>
              </>
            ) : (
              <span className="text-xs">Never run</span>
            )}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button type="button" size="sm" onClick={() => onRun(row)}>
              <Play className="size-3.5" aria-hidden />
              Run now
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`More actions for ${row.name}`}
                className="inline-flex size-8 items-center justify-center rounded-md border border-input hover:bg-accent"
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => onEdit(row)}>Edit</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onHistory(row)}>Run history</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onToggle(row, { enabled: !row.enabled })}>
                  {row.enabled ? "Disable" : "Enable"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onToggle(row, { dry_run: !row.dry_run })}>
                  {row.dry_run ? "Go live…" : "Back to dry-run"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => onDelete(row)}>
                  Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      ))}
    </div>
  );
}
