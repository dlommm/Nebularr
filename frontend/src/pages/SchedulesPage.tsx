import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate } from "../hooks";
import { SCHEDULE_MODE_LABELS, sortScheduleRows } from "../constants/domain";
import { useActionError } from "../hooks/useActionError";

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
    <div className="space-y-4 rounded-2xl border border-white/10 glass-panel p-4 sm:p-6">
      <h3 className="font-heading text-lg font-semibold">Schedules</h3>
      <p className="text-sm text-muted-foreground">
        Cron uses five fields: minute hour day month day_of_week (APScheduler). Timezone is per row. MAL jobs appear only if the
        matching feature is enabled in the environment (for example <code>MAL_INGEST_ENABLED</code>, <code>MAL_MATCHER_ENABLED</code>,{" "}
        <code>MAL_TAGGING_ENABLED</code>); an unchecked &quot;enabled&quot; row here removes that cron from the scheduler
        entirely.
      </p>
      <div className="stack">
        {sortScheduleRows(schedules.data ?? []).map((row) => (
          <div className="inner-card" key={row.mode}>
            <div className="row">
              <div>
                <strong>{SCHEDULE_MODE_LABELS[row.mode] ?? row.mode}</strong>
                <span className="pill" style={{ marginLeft: 8 }}>
                  {row.mode}
                </span>
              </div>
              <span className="muted">Updated {fmtDate(row.updated_at)}</span>
            </div>
            <div className="row mt8">
              <input
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
              <input
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
            <div className="row mt8">
              <label className="pill">
                <input
                  type="checkbox"
                  checked={scheduleDrafts[row.mode]?.enabled ?? row.enabled}
                  onChange={(event) =>
                    setScheduleDrafts((prev) => ({
                      ...prev,
                      [row.mode]: {
                        ...(prev[row.mode] ?? { cron: row.cron, timezone: row.timezone, enabled: row.enabled }),
                        enabled: event.target.checked,
                      },
                    }))
                  }
                />
                enabled
              </label>
              <button type="button" className="secondary" onClick={() => void saveSchedule(row.mode)}>
                Save
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
