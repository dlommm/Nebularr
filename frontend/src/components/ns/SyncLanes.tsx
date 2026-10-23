import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { clock, sinceShort, relTime } from "@/lib/time";
import type { RunTimeline, TimelineEvent, TimelineLane } from "@/types";

/** A lane with no run for this long reads as "silent" (schedules run every
    30–60 min by default, so three hours of nothing is worth saying out loud). */
const SILENT_AFTER_HOURS = 3;

const LANE_SUBTITLE: Record<string, string> = {
  sonarr: "Sonarr",
  radarr: "Radarr",
  webhooks: "pushed by Sonarr and Radarr",
  mal: "fetch · match · tag",
};

type Tick = { left: number; cls: string; delay: number; title: string };

function tickClass(event: TimelineEvent): string {
  if (event.status === "failed") return "fail";
  if (event.kind === "webhook") return event.status === "dead_letter" ? "fail" : "ev";
  if (event.kind === "full" || event.kind === "reconcile" || event.kind === "ingest") return "full";
  return "inc";
}

function laneSummary(lane: TimelineLane, now: Date): { big: string; meta: string; tone?: "warn" | "critical" } {
  const failed = lane.events.filter((e) => e.status === "failed" || e.status === "dead_letter").length;
  if (lane.kind === "webhooks") {
    const waiting = lane.events.filter((e) => e.status === "queued" || e.status === "retrying").length;
    const dead = lane.events.filter((e) => e.status === "dead_letter").length;
    return {
      big: String(lane.events.length) + (lane.truncated ? "+" : ""),
      meta: dead ? `${dead} dead letter${dead === 1 ? "" : "s"}` : `received · ${waiting} waiting`,
      tone: dead ? "critical" : undefined,
    };
  }
  const recentFailures = [...lane.events].reverse().findIndex((e) => e.status !== "failed");
  const failStreak = recentFailures === -1 ? lane.events.length : recentFailures;
  if (failStreak >= 2) return { big: `${failStreak} ✕`, meta: "failed in a row", tone: "critical" };
  if (!lane.events.length) {
    return { big: sinceShort(lane.last_at, now), meta: lane.last_at ? "since last run" : "never run", tone: "warn" };
  }
  return {
    big: String(lane.events.length),
    meta: `runs · last ${relTime(lane.events[lane.events.length - 1].at, now)}${failed ? ` · ${failed} failed` : ""}`,
  };
}

/** The 24-hour sync lanes: one row per source, a tick per run (tall for a full
    pass), rings for failures, and a hatched stretch when a source goes quiet. */
export function SyncLanes({ timeline, size = "lg" }: { timeline: RunTimeline; size?: "lg" | "sm" }): JSX.Element {
  const now = useMemo(() => new Date(timeline.now), [timeline.now]);
  const windowMs = timeline.hours * 3_600_000;
  const startMs = now.getTime() - windowMs;
  const pos = (iso: string): number => Math.min(100, Math.max(0, ((new Date(iso).getTime() - startMs) / windowMs) * 100));

  const lanes = timeline.lanes.map((lane) => {
    const ticks: Tick[] = lane.events.map((event) => {
      const left = pos(event.at);
      return {
        left,
        cls: tickClass(event),
        delay: Math.round(250 + left * 12),
        title: `${clock(event.at)} · ${event.kind} · ${event.status}${event.rows ? ` · ${event.rows} rows` : ""}`,
      };
    });
    const lastAt = lane.events.length ? lane.events[lane.events.length - 1].at : lane.last_at;
    const quietHours = lastAt ? (now.getTime() - new Date(lastAt).getTime()) / 3_600_000 : timeline.hours;
    const silent = (lane.kind === "sonarr" || lane.kind === "radarr") && quietHours >= SILENT_AFTER_HOURS;
    const silentFrom = silent ? (lastAt ? pos(lastAt) : 0) : 100;
    return { lane, ticks, silent, silentFrom, quietHours, summary: laneSummary(lane, now) };
  });

  const axis = useMemo(() => {
    const marks: { left: number; label: string }[] = [];
    const step = timeline.hours <= 24 ? 3 : 12;
    const first = new Date(startMs);
    first.setMinutes(0, 0, 0);
    first.setHours(first.getHours() + (step - (first.getHours() % step)));
    for (let t = first.getTime(); t < now.getTime() - step * 0.8 * 3_600_000; t += step * 3_600_000) {
      marks.push({ left: ((t - startMs) / windowMs) * 100, label: clock(new Date(t).toISOString()) });
    }
    return marks;
  }, [now, startMs, timeline.hours, windowMs]);

  const big = size === "lg";
  return (
    <div className="ns-lanes">
      {lanes.map(({ lane, ticks, silent, silentFrom, quietHours, summary }) => (
        <div
          key={lane.key}
          className={cn(
            "grid items-center gap-x-6 gap-y-2 border-t border-border transition-colors hover:bg-muted/60",
            big
              ? "grid-cols-[minmax(0,1fr)_auto] py-3 md:min-h-[96px] md:grid-cols-[220px_minmax(0,1fr)_160px] md:py-0"
              : "grid-cols-[minmax(0,1fr)_auto] py-3 md:min-h-[60px] md:grid-cols-[170px_minmax(0,1fr)_170px] md:py-0",
          )}
        >
          <div className="min-w-0">
            <div className={cn(big ? "cond text-[30px] leading-[0.95] font-bold" : "text-[15px] font-medium")}>{lane.label}</div>
            <div className="mt-1 text-xs text-subtle-foreground">{LANE_SUBTITLE[lane.kind] ?? lane.kind}</div>
          </div>
          <div
            className={cn("ns-track relative col-span-2 row-start-2 overflow-hidden md:col-span-1 md:row-start-auto", big ? "h-16" : "h-9")}
            role="img"
            aria-label={`${lane.label}: ${summary.big} ${summary.meta}${silent ? `, silent for ${Math.round(quietHours)} hours` : ""}`}
          >
            {ticks.map((t, i) => (
              <span key={i} className={cn("ns-tick", t.cls)} style={{ left: `${t.left}%`, animationDelay: `${t.delay}ms` }} title={t.title} />
            ))}
            {silent ? (
              <span className="ns-silent" style={{ left: `${silentFrom}%` }}>
                {silentFrom < 80 ? `silent for ${Math.round(quietHours)} h` : null}
              </span>
            ) : null}
            <span aria-hidden className="absolute inset-y-0 right-0 w-px bg-signal shadow-[0_0_10px_var(--signal)]" />
          </div>
          <div className="text-right">
            <div
              className={cn(
                "cond leading-none font-[640] tabular-nums",
                big ? "text-[30px]" : "text-[20px]",
                summary.tone === "warn" && "text-warn",
                summary.tone === "critical" && "text-critical",
              )}
            >
              {summary.big}
            </div>
            <div className="mt-1 text-xs text-subtle-foreground">{summary.meta}</div>
          </div>
        </div>
      ))}
      <div
        aria-hidden
        className={cn(
          "grid gap-x-6 border-t border-rule-strong",
          big ? "md:grid-cols-[220px_minmax(0,1fr)_160px]" : "md:grid-cols-[170px_minmax(0,1fr)_170px]",
        )}
      >
        <div className="max-md:hidden" />
        <div className="relative h-7 font-mono text-[11px] text-subtle-foreground">
          {axis.map((m) => (
            <span key={m.left} className="absolute top-2 -translate-x-1/2 max-sm:[&:nth-child(even)]:hidden" style={{ left: `${m.left}%` }}>
              {m.label}
            </span>
          ))}
          <span className="absolute top-2 right-0 text-signal">now {clock(timeline.now)}</span>
        </div>
      </div>
    </div>
  );
}
