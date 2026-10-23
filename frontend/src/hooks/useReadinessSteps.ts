import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { PATHS } from "../routes/paths";

export type ReadinessStep = { label: string; done: boolean; to: string; cta: string };

/** The four readiness checks, derived entirely from already-cached queries.
    `loading` stays true until every signal has loaded. */
export function useReadinessSteps(): { steps: ReadinessStep[]; loading: boolean } {
  const integrations = useQuery({ queryKey: ["integrations"], queryFn: api.integrations, staleTime: 60_000 });
  const recentRuns = useQuery({ queryKey: ["recent-runs"], queryFn: api.recentRuns, staleTime: 30_000 });
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules, staleTime: 60_000 });
  const webhookConfig = useQuery({ queryKey: ["webhook-config"], queryFn: api.webhookConfig, staleTime: 60_000 });

  const hasIntegration = (integrations.data ?? []).some((row) => row.enabled && row.api_key_set);
  const hasSuccessfulSync = (recentRuns.data ?? []).some((run) => run.status === "success");
  const hasEnabledSchedule = (schedules.data ?? []).some((row) => row.enabled);
  const hasWebhookSecret = webhookConfig.data?.secret_set === true;

  return {
    loading: integrations.isLoading || recentRuns.isLoading || schedules.isLoading || webhookConfig.isLoading,
    steps: [
      { label: "Connect Sonarr / Radarr", done: hasIntegration, to: PATHS.integrations, cta: "Integrations" },
      { label: "Run a full sync", done: hasSuccessfulSync, to: `${PATHS.sync}?tab=manual`, cta: "Sync now" },
      { label: "Review schedules", done: hasEnabledSchedule, to: PATHS.schedules, cta: "Schedules" },
      { label: "Set a webhook secret (optional)", done: hasWebhookSecret, to: PATHS.integrations, cta: "Configure" },
    ],
  };
}
