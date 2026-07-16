import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate } from "../hooks";
import { SCHEDULE_MODE_LABELS, sortScheduleRows } from "../constants/domain";
import { useActionError } from "../hooks/useActionError";
import { CronPreview } from "@/components/nebula/CronPreview";
import { GlassCard } from "@/components/nebula/GlassCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { QueryErrorNotice } from "@/components/nebula/QueryErrorNotice";
import type { RetentionPolicy } from "../types";

const RETENTION_FIELDS: { key: keyof RetentionPolicy; label: string; hint: string }[] = [
  { key: "queue_days", label: "Webhook queue & job summaries", hint: "Processed webhook jobs and per-run summaries" },
  { key: "sync_run_days", label: "Sync run history", hint: "Rows on the Sync & Queue → Runs tab" },
  { key: "stat_snapshot_days", label: "Storage snapshots", hint: "Daily captures behind the Storage & Growth dashboard" },
];

export function SchedulesPage(): JSX.Element {
  usePageTitle("Schedules");
  const queryClient = useQueryClient();
  const { runAction } = useActionError();
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const retention = useQuery({ queryKey: ["retention"], queryFn: api.retention });
  const [scheduleDrafts, setScheduleDrafts] = useState<
    Record<string, { cron: string; timezone: string; enabled: boolean }>
  >({});
  const [retentionDraft, setRetentionDraft] = useState<RetentionPolicy | null>(null);
  const [cronValidity, setCronValidity] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (retention.data) setRetentionDraft(retention.data);
  }, [retention.data]);

  const saveRetention = async (): Promise<void> => {
    if (!retentionDraft) return;
    await runAction(async () => {
      await api.saveRetention(retentionDraft);
      await queryClient.invalidateQueries({ queryKey: ["retention"] });
    }, "save retention policy");
  };

  useEffect(() => {
    if (!schedules.data) return;
    const next: Record<string, { cron: string; timezone: string; enabled: boolean }> = {};
    schedules.data.forEach((row) => {
      next[row.mode] = {
        cron: row.cron,
        timezone: row.timezone,
        enabled: row.enabled,
      };
    });
    setScheduleDrafts(next);
  }, [schedules.data]);

  const saveSchedule = async (mode: string): Promise<void> => {
    const draft = scheduleDrafts[mode];
    if (!draft) return;
    await runAction(
      async () => {
        await api.saveSchedule(mode, draft);
        await queryClient.invalidateQueries({ queryKey: ["schedules"] });
      },
      `save schedule ${mode}`,
    );
  };

  return (
    <div className="space-y-6">
    <GlassCard>
      <CardHeader>
        <CardTitle>Schedules</CardTitle>
        <CardDescription>
          Cron uses five fields: minute hour day month day_of_week (APScheduler). Timezone is per row. MAL jobs are
          controlled from Integrations → MyAnimeList; an unchecked &quot;enabled&quot; row here removes that cron from
          the scheduler entirely.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {schedules.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : null}
        {schedules.isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
          >
            <span>Could not load schedules: {schedules.error instanceof Error ? schedules.error.message : "unknown error"}</span>
            <Button size="sm" variant="secondary" onClick={() => void schedules.refetch()}>
              Retry
            </Button>
          </div>
        ) : null}
        {sortScheduleRows(schedules.data ?? []).map((row) => (
          <div className="rounded-xl border border-border bg-muted/40 p-4" key={row.mode}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{SCHEDULE_MODE_LABELS[row.mode] ?? row.mode}</span>
              <Badge variant="outline">{row.mode}</Badge>
              <span className="ml-auto text-xs text-muted-foreground">Updated {fmtDate(row.updated_at)}</span>
            </div>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row">
              <div className="grid w-full gap-1.5">
                <Label htmlFor={`schedule-cron-${row.mode}`} className="text-xs text-muted-foreground">
                  Cron
                </Label>
                <Input
                  id={`schedule-cron-${row.mode}`}
                  value={scheduleDrafts[row.mode]?.cron ?? row.cron}
                  onChange={(event) =>
                    setScheduleDrafts((prev) => ({
                      ...prev,
                      [row.mode]: {
                        ...(prev[row.mode] ?? { cron: row.cron, timezone: row.timezone, enabled: row.enabled }),
                        cron: event.target.value,
                      },
                    }))
                  }
                />
              </div>
              <div className="grid w-full gap-1.5">
                <Label htmlFor={`schedule-tz-${row.mode}`} className="text-xs text-muted-foreground">
                  Timezone (IANA)
                </Label>
                <Input
                  id={`schedule-tz-${row.mode}`}
                  value={scheduleDrafts[row.mode]?.timezone ?? row.timezone}
                  onChange={(event) =>
                    setScheduleDrafts((prev) => ({
                      ...prev,
                      [row.mode]: {
                        ...(prev[row.mode] ?? { cron: row.cron, timezone: row.timezone, enabled: row.enabled }),
                        timezone: event.target.value,
                      },
                    }))
                  }
                />
              </div>
            </div>
            <div className="mt-2">
              <CronPreview
                cron={scheduleDrafts[row.mode]?.cron ?? row.cron}
                timezone={scheduleDrafts[row.mode]?.timezone ?? row.timezone}
                onValidityChange={(valid) =>
                  setCronValidity((prev) => (prev[row.mode] === valid ? prev : { ...prev, [row.mode]: valid }))
                }
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`schedule-enabled-${row.mode}`}
                  checked={scheduleDrafts[row.mode]?.enabled ?? row.enabled}
                  onCheckedChange={(checked) =>
                    setScheduleDrafts((prev) => ({
                      ...prev,
                      [row.mode]: {
                        ...(prev[row.mode] ?? { cron: row.cron, timezone: row.timezone, enabled: row.enabled }),
                        enabled: checked === true,
                      },
                    }))
                  }
                />
                <Label htmlFor={`schedule-enabled-${row.mode}`} className="text-sm text-muted-foreground">
                  enabled
                </Label>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={cronValidity[row.mode] === false}
                onClick={() => void saveSchedule(row.mode)}
              >
                Save
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </GlassCard>

    <GlassCard>
      <CardHeader>
        <CardTitle>Data retention</CardTitle>
        <CardDescription>
          How long history rows are kept before the next cleanup pass removes them. Retention never touches your
          synced library data — only run history, processed queue rows, and storage snapshots. Set a value to 0 to
          keep rows forever.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {retention.isError ? (
          <QueryErrorNotice label="retention policy" retry={() => void retention.refetch()} error={retention.error} />
        ) : null}
        {retention.isLoading ? <Skeleton className="h-20 w-full" /> : null}
        {retentionDraft ? (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              {RETENTION_FIELDS.map(({ key, label, hint }) => (
                <div className="grid gap-1.5" key={key}>
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
                  <p className="text-[11px] text-muted-foreground">{hint}</p>
                </div>
              ))}
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={() => void saveRetention()}>
              Save retention
            </Button>
          </>
        ) : null}
      </CardContent>
    </GlassCard>
    </div>
  );
}
