import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate, fmtDuration } from "../hooks";
import { MAL_JOB_TYPE_ORDER } from "../constants/domain";
import { StatusPill } from "../components/ui";

export function DashboardPage(): JSX.Element {
  usePageTitle("Dashboard");
  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: 15_000,
  });
  const syncActivity = useQuery({
    queryKey: ["sync-activity"],
    queryFn: api.syncActivity,
    refetchInterval: 5_000,
  });
  const malSync = status.data?.mal_sync;
  return (
    <div className="grid">
      <div className="card span-3">
        <div className="kpi-label">Total sync runs</div>
        <div className="kpi-value">{status.data?.jobs_total ?? "-"}</div>
      </div>
      <div className="card span-3">
        <div className="kpi-label">Webhook backlog</div>
        <div className="kpi-value">{status.data?.webhook_queue_open ?? "-"}</div>
        <div className="muted" style={{ fontSize: 12 }}>
          queued + retrying (dead letter: {status.data?.webhook_queue_dead_letter ?? 0})
        </div>
      </div>
      <div className="card span-3">
        <div className="kpi-label">Sonarr lag (s)</div>
        <div className="kpi-value">{Math.round((status.data?.sync_lag_seconds.sonarr ?? 0) * 10) / 10}</div>
      </div>
      <div className="card span-3">
        <div className="kpi-label">Radarr lag (s)</div>
        <div className="kpi-value">{Math.round((status.data?.sync_lag_seconds.radarr ?? 0) * 10) / 10}</div>
      </div>
      {malSync ? (
        <div className="card span-12" id="mal">
          <h3>MyAnimeList sync</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Dub list ingest, warehouse matcher, and Arr tag sync jobs.{" "}
            <span className="pill">{malSync.client_configured ? "MAL client id set" : "MAL client id missing"}</span>{" "}
            <span className="muted">Schedulers respect env / compose flags; set client id under Integrations.</span>
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Scheduler</th>
                  <th>Last finished</th>
                  <th>Active run</th>
                </tr>
              </thead>
              <tbody>
                {MAL_JOB_TYPE_ORDER.map((jobType) => {
                  const enabled =
                    jobType === "ingest"
                      ? malSync.schedulers.ingest_enabled
                      : jobType === "matcher"
                        ? malSync.schedulers.matcher_enabled
                        : malSync.schedulers.tagging_enabled;
                  const last = malSync.last_finished[jobType];
                  const running = malSync.running.find((r) => r.job_type === jobType);
                  const label = jobType === "tag_sync" ? "tag sync" : jobType;
                  return (
                    <tr key={jobType}>
                      <td>{label}</td>
                      <td>{enabled ? <span className="pill">on</span> : <span className="muted">off</span>}</td>
                      <td>
                        {last ? (
                          <div>
                            <StatusPill status={last.status} /> <span className="muted">{fmtDate(last.finished_at)}</span>
                            {last.error_message ? (
                              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                                {String(last.error_message)}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {running ? (
                          <div>
                            <StatusPill status="running" /> <span className="muted">since {fmtDate(running.started_at)}</span>
                          </div>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {status.data && status.data.health_state !== "ok" ? (
        <div className="card span-12 inner-card">
          <strong>Health: {status.data.health_state}</strong>
          <span className="muted"> — {status.data.health_reasons?.join(", ") || "no reason codes"}</span>
          <p className="muted mt8" style={{ marginBottom: 0 }}>
            <code>webhook_queue_critical</code> uses queued + retrying only. Dead-letter jobs are listed under Webhooks and no
            longer inflate this. <code>sync_lag_critical</code> means time since last successful incremental sync watermark
            exceeded your threshold (default 2h).
          </p>
        </div>
      ) : null}
      <div className="card span-12">
        <h3>Live sync activity</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Trigger</th>
                <th>Stage</th>
                <th>Instance</th>
                <th>Elapsed</th>
                <th>Rows</th>
              </tr>
            </thead>
            <tbody>
              {(syncActivity.data ?? []).map((row) => (
                <tr key={row.run_id}>
                  <td>{row.source}</td>
                  <td>{row.mode}</td>
                  <td><StatusPill status={row.status} /></td>
                  <td>{row.trigger}</td>
                  <td>{row.stage_note ? `${row.stage} (${row.stage_note})` : row.stage}</td>
                  <td>{row.instance_name}</td>
                  <td>{fmtDuration(row.elapsed_seconds)}</td>
                  <td>{row.records_processed}</td>
                </tr>
              ))}
              {syncActivity.isLoading ? (
                <tr>
                  <td colSpan={8} className="muted">
                    Loading activity…
                  </td>
                </tr>
              ) : null}
              {!syncActivity.isLoading && syncActivity.data?.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted">
                    No active syncs
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
