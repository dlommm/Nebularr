import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { queryKeys } from "../../lib/queryKeys";
import { fmtDate } from "../../hooks";
import type { AutomationRow } from "../../types";
import { GlassCard } from "@/components/nebula/GlassCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function RunDetail({ runId }: { runId: number }): JSX.Element {
  const run = useQuery({
    queryKey: [...queryKeys.automationRuns(), "detail", runId] as const,
    queryFn: () => api.automationRun(runId),
  });
  if (run.isLoading) return <Skeleton className="h-16 w-full" />;
  if (!run.data) return <p className="text-sm text-muted-foreground">Could not load run detail.</p>;
  const details = run.data.details ?? {};
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
      {details.daily_cap_clamped ? (
        <p className="text-amber-600 dark:text-amber-400">Search budget clamped by the daily cap.</p>
      ) : null}
      {Object.entries(details.instances ?? {}).map(([instance, entities]) =>
        Object.entries(entities).map(([entity, info]) => (
          <div key={`${instance}:${entity}`}>
            <p className="font-medium">
              {instance} / {entity}: matched {info.matched ?? 0}
              {typeof info.searched === "number" ? `, searched ${info.searched}` : ""}
            </p>
            {info.profile_warning ? (
              <p className="text-amber-600 dark:text-amber-400">{info.profile_warning}</p>
            ) : null}
            {(info.would_do ?? []).map((item) => (
              <p key={item.source_id} className="text-muted-foreground">
                would {item.actions.join(" + ")}: {item.title || `#${item.source_id}`}
              </p>
            ))}
            {Object.entries(info)
              .filter(([key]) =>
                ["would_tag:", "would_monitor:", "tag:", "monitored:"].some((prefix) => key.startsWith(prefix)),
              )
              .map(([key, value]) => (
                <p key={key} className="text-muted-foreground">
                  {key}: {JSON.stringify(value)}
                </p>
              ))}
          </div>
        )),
      )}
      {(details.errors ?? []).map((err, index) => (
        <p key={index} role="alert" className="text-destructive">
          {err.instance ? `${err.instance}: ` : ""}
          {err.phase ? `[${err.phase}] ` : ""}
          {err.error}
        </p>
      ))}
    </div>
  );
}

export function AutomationRunHistory({
  automation,
  onClose,
}: {
  automation: AutomationRow;
  onClose: () => void;
}): JSX.Element {
  const runs = useQuery({
    queryKey: queryKeys.automationRuns(automation.id),
    queryFn: () => api.automationRuns(automation.id),
  });
  const [openRunId, setOpenRunId] = useState<number | null>(null);
  return (
    <GlassCard>
      <CardHeader>
        <CardTitle>Run history: {automation.name}</CardTitle>
        <CardDescription>
          Dry-run rows list what the rule would have done; live rows list what it did.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {runs.isLoading ? <Skeleton className="h-20 w-full" /> : null}
        {runs.data && runs.data.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : null}
        {(runs.data?.runs ?? []).map((run) => (
          <div key={run.id} className="rounded-lg border border-border bg-muted/40 p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>{run.status}</Badge>
              <span>{fmtDate(run.started_at)}</span>
              <span className="text-muted-foreground">
                matched {run.matched_count}, actions {run.actions_taken}, cooldown-skipped{" "}
                {run.skipped_cooldown}, budget-skipped {run.skipped_budget}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setOpenRunId(openRunId === run.id ? null : run.id)}
              >
                {openRunId === run.id ? "Hide detail" : "Detail"}
              </Button>
            </div>
            {run.error_message ? (
              <p role="alert" className="mt-1 text-sm text-destructive">{run.error_message}</p>
            ) : null}
            {openRunId === run.id ? <RunDetail runId={run.id} /> : null}
          </div>
        ))}
        <Button type="button" size="sm" variant="secondary" onClick={onClose}>
          Close history
        </Button>
      </CardContent>
    </GlassCard>
  );
}
