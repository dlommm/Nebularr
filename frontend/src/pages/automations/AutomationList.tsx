import { CalendarClock, MoreHorizontal, Play, Zap } from "lucide-react";
import type { AutomationRow } from "../../types";
import { fmtDate } from "../../hooks";
import { EmptyState } from "@/components/nebula/EmptyState";
import { StatusBadge } from "@/components/nebula/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { describeCron } from "./automationSummary";
import { actionLinkClass } from "@/lib/ns";
import { cn } from "@/lib/utils";

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
  selectedId,
}: {
  automations: AutomationRow[];
  onEdit: (row: AutomationRow) => void;
  onRun: (row: AutomationRow) => void;
  onDelete: (row: AutomationRow) => void;
  onToggle: (row: AutomationRow, patch: { enabled?: boolean; dry_run?: boolean }) => void;
  onHistory: (row: AutomationRow) => void;
  onCreate: () => void;
  selectedId?: number;
}): JSX.Element {
  if (automations.length === 0) {
    return (
      <EmptyState
        icon={Zap}
        title="No automations yet"
        description="Automations converge your library toward what you actually want — English dubs, a resolution floor, no missing episodes — on a schedule you set."
      >
        <Button type="button" size="sm" onClick={onCreate}>
          New rule
        </Button>
      </EmptyState>
    );
  }

  return (
    <ul className="border-b border-border">
      {automations.map((row) => {
        const selected = row.id === selectedId;
        return (
          <li
            key={row.id}
            className={cn(
              "border-t border-border px-4 py-4 transition-colors hover:bg-muted",
              selected && "bg-muted shadow-[inset_3px_0_0_var(--foreground)]",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => onEdit(row)}
                aria-current={selected ? "true" : undefined}
                className="min-w-0 truncate text-left text-base hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {row.name}
              </button>
              <ModeTag row={row} />
            </div>

            <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <CalendarClock className="size-3.5 shrink-0" aria-hidden />
              {describeCron(row.cron)} · {row.timezone}
            </p>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
              {row.last_run_status ? (
                <>
                  <StatusBadge status={row.last_run_status} className="text-xs" />
                  <span className="font-mono text-[11px] text-subtle-foreground">
                    {row.last_run_matched ?? 0} matched, {row.last_run_actions ?? 0} action
                    {(row.last_run_actions ?? 0) === 1 ? "" : "s"} · {fmtDate(row.last_run_started_at ?? "")}
                  </span>
                </>
              ) : (
                <span className="font-mono text-[11px] text-subtle-foreground">Never run</span>
              )}
            </div>

            <div className="mt-2 flex items-center gap-4">
              <button type="button" className={cn(actionLinkClass, "min-h-9 gap-1.5")} onClick={() => onRun(row)}>
                <Play className="size-3.5" aria-hidden />
                Run now
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={`More actions for ${row.name}`}
                  className="inline-flex size-9 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
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
          </li>
        );
      })}
    </ul>
  );
}

/** Dry run / Live / Off, as a small uppercase tag. */
export function ModeTag({ row }: { row: Pick<AutomationRow, "enabled" | "dry_run"> }): JSX.Element {
  const mode = !row.enabled ? "off" : row.dry_run ? "dry" : "live";
  return (
    <span
      className={cn(
        "shrink-0 rounded-[2px] px-1.5 py-0.5 text-[11px] font-semibold tracking-[0.04em] uppercase",
        mode === "dry" && "border border-signal/45 text-signal",
        mode === "live" && "bg-ok text-background",
        mode === "off" && "border border-border text-subtle-foreground",
      )}
    >
      {mode === "dry" ? "Dry run" : mode === "live" ? "Live" : "Off"}
    </span>
  );
}
