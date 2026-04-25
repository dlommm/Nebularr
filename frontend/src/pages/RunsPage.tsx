import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate } from "../hooks";
import { StatusPill } from "../components/ui";

export function RunsPage(): JSX.Element {
  usePageTitle("Sync runs");
  const runs = useQuery({ queryKey: ["runs"], queryFn: api.recentRuns, refetchInterval: 15_000 });
  return (
    <div className="card">
      <h3>Run history</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Mode</th>
              <th>Status</th>
              <th>Started</th>
              <th>Finished</th>
              <th>Rows</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {(runs.data ?? []).map((run, idx) => (
              <tr key={`${run.source}-${run.started_at}-${idx}`}>
                <td>{run.source}</td>
                <td>{run.mode}</td>
                <td><StatusPill status={run.status} /></td>
                <td>{fmtDate(run.started_at)}</td>
                <td>{fmtDate(run.finished_at)}</td>
                <td>{run.rows_written ?? "-"}</td>
                <td>{run.error_message ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
