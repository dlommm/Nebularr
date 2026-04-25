import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDuration } from "../hooks";
import { useActionError } from "../hooks/useActionError";

export function ActionsPage(): JSX.Element {
  usePageTitle("Manual actions");
  const queryClient = useQueryClient();
  const { setError, runAction } = useActionError();
  const syncProgress = useQuery({ queryKey: ["sync-progress"], queryFn: api.syncProgress, refetchInterval: 2_000 });
  const [malPipelineResult, setMalPipelineResult] = useState<string | null>(null);

  const runMalPipeline = async (
    fn: () => Promise<{ status: string; details?: unknown }>,
    label: string,
  ): Promise<void> => {
    try {
      const r = await fn();
      setMalPipelineResult(`${label}\n${JSON.stringify(r.details ?? {}, null, 2)}`);
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    } catch (err) {
      setError(err, label);
    }
  };

  return (
    <div className="grid">
      <div className="card span-6">
        <h3>Run sync</h3>
        <div className="row">
          <button type="button" onClick={() => runAction(() => api.runSync("sonarr", "incremental"), "runSync sonarr/incremental")}>
            Sonarr incremental
          </button>
          <button type="button" onClick={() => runAction(() => api.runSync("radarr", "incremental"), "runSync radarr/incremental")}>
            Radarr incremental
          </button>
        </div>
        <div className="muted mt8">
          {syncProgress.data?.running
            ? `${syncProgress.data.source}/${syncProgress.data.mode} - ${syncProgress.data.stage} (${fmtDuration(syncProgress.data.elapsed_seconds)})`
            : "No manual sync running"}
        </div>
      </div>
      <div className="card span-6">
        <h3>System actions</h3>
        <div className="row">
          <button type="button" className="secondary" onClick={() => runAction(() => api.replayDeadLetter("sonarr"), "replay sonarr dead-letter")}>
            Replay Sonarr dead letter
          </button>
          <button type="button" className="secondary" onClick={() => runAction(() => api.replayDeadLetter("radarr"), "replay radarr dead-letter")}>
            Replay Radarr dead letter
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              if (window.confirm("Type RESET in the prompt to continue")) {
                const typed = window.prompt("Type RESET");
                if (typed?.trim().toUpperCase() === "RESET") {
                  runAction(() => api.resetData(), "reset data");
                }
              }
            }}
          >
            Reset data
          </button>
        </div>
      </div>
      <div className="card span-12">
        <h3>MyAnimeList pipelines</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Runs the same jobs as scheduled MAL tasks. Ingest requires a MyAnimeList API client ID (Integrations or <code>MAL_CLIENT_ID</code>).
          Large ingests can take several minutes.
        </p>
        <div className="row">
          <button type="button" className="secondary" onClick={() => void runMalPipeline(() => api.triggerMalIngest(), "MAL ingest")}>
            Run MAL ingest
          </button>
          <button type="button" className="secondary" onClick={() => void runMalPipeline(() => api.triggerMalMatchRefresh(), "MAL match refresh")}>
            Run match refresh
          </button>
          <button type="button" className="secondary" onClick={() => void runMalPipeline(() => api.triggerMalTagSync(), "MAL tag sync")}>
            Run tag sync
          </button>
        </div>
        {malPipelineResult ? (
          <pre className="log-row-extra mt8" style={{ maxHeight: 220, overflow: "auto" }}>
            {malPipelineResult}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
