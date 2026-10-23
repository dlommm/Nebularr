import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate } from "../hooks";
import { useDraftSync } from "../hooks/useDraftSync";
import { SCHEDULE_MODE_LABELS, sortScheduleRows } from "../constants/domain";
import { useActionError } from "../hooks/useActionError";
import { queryKeys } from "../lib/queryKeys";
import { CronPreview } from "@/components/nebula/CronPreview";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorNotice } from "@/components/nebula/QueryErrorNotice";
import type { RetentionPolicy, ScheduleRow } from "../types";
import { SectionCard } from "./integrations/shared";
import { describeCron } from "./automations/automationSummary";

const scheduleKeyOf = (row: ScheduleRow): string => row.mode;

const RETENTION_FIELDS: { key: keyof RetentionPolicy; label: string; hint: string }[] = [
  { key: "queue_days", label: "Webhook queue & job summaries", hint: "Processed webhook jobs and per-run summaries" },
  { key: "sync_run_days", label: "Sync run history", hint: "Rows on the Sync & Queue → Runs tab" },
  { key: "stat_snapshot_days", label: "Storage snapshots", hint: "Daily captures behind the Storage & Growth dashboard" },
];

export function SchedulesPage(): JSX.Element {
  usePageTitle("Schedules");
  const queryClient = useQueryClient();
  const { runAction } = useActionError();
  const schedules = useQuery({ queryKey: queryKeys.schedules, queryFn: api.schedules });
  const retention = useQuery({ queryKey: queryKeys.retention, queryFn: api.retention });
  // ScheduleRow already carries every field a row's draft needs (including
  // `updated_at`, read straight off the server row below), so it doubles as
  // its own draft shape — no extra mapping required.
  const { drafts: scheduleDrafts, setDraft: setScheduleDraft, resetDraft: resetScheduleDraft } = useDraftSync(
    schedules.data,
    scheduleKeyOf,
  );
  const [retentionDraft, setRetentionDraft] = useState<RetentionPolicy | null>(null);
  const [cronValidity, setCronValidity] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    if (retention.data) setRetentionDraft(retention.data);
  }, [retention.data]);

  const saveRetention = async (): Promise<void> => {
    if (!retentionDraft) return;
    await runAction(async () => {
      await api.saveRetention(retentionDraft);
      await queryClient.invalidateQueries({ queryKey: queryKeys.retention });
    }, "save retention policy");
  };

  const saveSchedule = async (mode: string): Promise<void> => {
    const draft = scheduleDrafts[mode];
    if (!draft) return;
    const ok = await runAction(
      async () => {
        await api.saveSchedule(mode, { cron: draft.cron, timezone: draft.timezone, enabled: draft.enabled });
        await queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
      },
      `save schedule ${mode}`,
    );
    if (ok) resetScheduleDraft(mode);
  };

  return (
    <div>
      <SectionCard
        title="Schedules"
        description="Cron uses five fields: minute hour day month day_of_week (APScheduler). Timezone is per row. MAL jobs are controlled from Integrations → MyAnimeList; switching a row off here removes that cron from the scheduler entirely."
      >
        {schedules.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : null}
        {schedules.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 border-y border-critical/40 py-3 text-sm text-critical">
            <span>Could not load schedules: {schedules.error instanceof Error ? schedules.error.message : "unknown error"}</span>
            <Button size="sm" variant="outline" onClick={() => void schedules.refetch()}>
              Retry
            </Button>
          </div>
        ) : null}
        <ul className="border-b border-border">
          {sortScheduleRows(schedules.data ?? []).map((row) => {
            const draft = scheduleDrafts[row.mode];
            const cron = draft?.cron ?? row.cron;
            const timezone = draft?.timezone ?? row.timezone;
            const open = editing === row.mode;
            return (
              <li key={row.mode} className="border-t border-border">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 py-3.5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <div className="truncate text-[15px]">{SCHEDULE_MODE_LABELS[row.mode] ?? row.mode}</div>
                    <div className="font-mono text-[11px] text-subtle-foreground">{row.mode}</div>
                  </div>
                  <div className="hidden min-w-0 text-[13px] text-muted-foreground md:block">{describeCron(row.cron)}</div>
                  <div className="hidden min-w-0 truncate font-mono text-xs text-subtle-foreground md:block" title={`updated ${fmtDate(row.updated_at)}`}>
                    {row.cron} · {row.timezone}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={row.enabled ? "text-[13px] text-ok" : "text-[13px] text-subtle-foreground"}>{row.enabled ? "on" : "off"}</span>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      aria-expanded={open}
                      aria-controls={`schedule-edit-${row.mode}`}
                      aria-label={`${open ? "Close" : "Edit"} ${SCHEDULE_MODE_LABELS[row.mode] ?? row.mode}`}
                      onClick={() => setEditing(open ? null : row.mode)}
                    >
                      {open ? "Close" : "Edit"}
                    </Button>
                  </div>
                </div>
                {open ? (
                  <div id={`schedule-edit-${row.mode}`} className="animate-rise pb-5">
                    <div className="flex flex-col gap-3 sm:flex-row">
                      <div className="grid w-full gap-1.5">
                        <Label htmlFor={`schedule-cron-${row.mode}`} className="text-xs text-muted-foreground">
                          Cron
                        </Label>
                        <Input
                          id={`schedule-cron-${row.mode}`}
                          value={cron}
                          onChange={(event) => setScheduleDraft(row.mode, { cron: event.target.value })}
                        />
                      </div>
                      <div className="grid w-full gap-1.5">
                        <Label htmlFor={`schedule-tz-${row.mode}`} className="text-xs text-muted-foreground">
                          Timezone (IANA)
                        </Label>
                        <Input
                          id={`schedule-tz-${row.mode}`}
                          value={timezone}
                          onChange={(event) => setScheduleDraft(row.mode, { timezone: event.target.value })}
                        />
                      </div>
                    </div>
                    <div className="mt-2">
                      <CronPreview
                        cron={cron}
                        timezone={timezone}
                        onValidityChange={(valid) =>
                          setCronValidity((prev) => (prev[row.mode] === valid ? prev : { ...prev, [row.mode]: valid }))
                        }
                      />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-5">
                      <div className="flex min-h-11 items-center gap-2">
                        <Checkbox
                          id={`schedule-enabled-${row.mode}`}
                          checked={draft?.enabled ?? row.enabled}
                          onCheckedChange={(checked) => setScheduleDraft(row.mode, { enabled: checked === true })}
                        />
                        <Label htmlFor={`schedule-enabled-${row.mode}`} className="text-sm font-normal text-muted-foreground">
                          enabled
                        </Label>
                      </div>
                      <Button
                        type="button"
                        className="min-h-11"
                        disabled={cronValidity[row.mode] === false}
                        onClick={() => void saveSchedule(row.mode)}
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <SectionCard
        title="Data retention"
        description="How long history rows are kept before the next cleanup pass removes them. Retention never touches your synced library data — only run history, processed queue rows, and storage snapshots. Set a value to 0 to keep rows forever."
      >
        {retention.isError ? (
          <QueryErrorNotice label="retention policy" retry={() => void retention.refetch()} error={retention.error} />
        ) : null}
        {retention.isLoading ? <Skeleton className="h-20 w-full" /> : null}
        {retentionDraft ? (
          <>
            <div className="grid gap-5 sm:grid-cols-3">
              {RETENTION_FIELDS.map(({ key, label, hint }) => (
                <div className="grid content-start gap-1.5" key={key}>
                  <Label htmlFor={`retention-${key}`} className="text-xs text-muted-foreground">
                    {label} (days)
                  </Label>
                  <Input
                    id={`retention-${key}`}
                    type="number"
                    min={0}
                    max={3650}
                    value={retentionDraft[key]}
                    onChange={(event) =>
                      setRetentionDraft({
                        ...retentionDraft,
                        [key]: Math.max(0, Math.min(3650, Number(event.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-[11px] text-subtle-foreground">{hint}</p>
                </div>
              ))}
            </div>
            <Button type="button" className="min-h-11" onClick={() => void saveRetention()}>
              Save retention
            </Button>
          </>
        ) : null}
      </SectionCard>
    </div>
  );
}
