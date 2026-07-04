import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate } from "../hooks";
import { SCHEDULE_MODE_LABELS, sortScheduleRows } from "../constants/domain";
import { useActionError } from "../hooks/useActionError";
import { GlassCard } from "@/components/nebula/GlassCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function SchedulesPage(): JSX.Element {
  usePageTitle("Schedules");
  const queryClient = useQueryClient();
  const { runAction } = useActionError();
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const [scheduleDrafts, setScheduleDrafts] = useState<
    Record<string, { cron: string; timezone: string; enabled: boolean }>
  >({});

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
              <Button type="button" variant="secondary" size="sm" onClick={() => void saveSchedule(row.mode)}>
                Save
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </GlassCard>
  );
}
