import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate } from "../hooks";
import { StatusPill } from "../components/ui";

export function WebhooksPage(): JSX.Element {
  usePageTitle("Webhooks");
  const webhookQueue = useQuery({ queryKey: ["webhook-queue"], queryFn: api.webhookQueue, refetchInterval: 15_000 });
  const webhookJobs = useQuery({
    queryKey: ["webhook-jobs"],
    queryFn: () => api.webhookJobs(),
    refetchInterval: 15_000,
  });
  return (
    <div className="grid">
      <div className="card span-4">
        <h3>Queue summary</h3>
        <div className="stack">
          {(webhookQueue.data ?? []).map((row) => (
            <div className="row" key={row.status}>
              <span>{row.status}</span>
              <strong>{row.count}</strong>
            </div>
          ))}
        </div>
      </div>
      <div className="card span-8">
        <h3>Webhook jobs</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Source</th>
                <th>Type</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Received</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {(webhookJobs.data ?? []).map((row) => (
                <tr key={row.id}>
                  <td>{row.id}</td>
                  <td>{row.source}</td>
                  <td>{row.event_type ?? "-"}</td>
                  <td><StatusPill status={row.status} /></td>
                  <td>{row.attempts}</td>
                  <td>{fmtDate(row.received_at)}</td>
                  <td>{row.error_message ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
