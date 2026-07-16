import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CheckCircle2, Circle, X } from "lucide-react";
import { api } from "../../api";
import { useLocalStorageState } from "../../hooks";
import { GlassCard, CardContent, CardHeader, CardTitle } from "./GlassCard";
import { Button } from "@/components/ui/button";
import { PATHS } from "../../routes/paths";

type Step = { label: string; done: boolean; to: string; cta: string };

/**
 * First-run guidance on the Dashboard: derived entirely from already-cached
 * queries. Auto-hides once every step is done, and is dismissable so returning
 * operators don't keep seeing it.
 */
export function OnboardingChecklist(): JSX.Element | null {
  const [dismissed, setDismissed] = useLocalStorageState("nebularr.onboarding.dismissed", false);
  const integrations = useQuery({ queryKey: ["integrations"], queryFn: api.integrations, staleTime: 60_000 });
  const recentRuns = useQuery({ queryKey: ["recent-runs"], queryFn: api.recentRuns, staleTime: 30_000 });
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules, staleTime: 60_000 });
  const webhookConfig = useQuery({ queryKey: ["webhook-config"], queryFn: api.webhookConfig, staleTime: 60_000 });

  // Wait until the signals load so we never flash the checklist at a configured
  // instance (which would then vanish and read as a glitch).
  if (
    dismissed ||
    integrations.isLoading ||
    recentRuns.isLoading ||
    schedules.isLoading ||
    webhookConfig.isLoading
  ) {
    return null;
  }

  const hasIntegration = (integrations.data ?? []).some((row) => row.enabled && row.api_key_set);
  const hasSuccessfulSync = (recentRuns.data ?? []).some((run) => run.status === "success");
  const hasEnabledSchedule = (schedules.data ?? []).some((row) => row.enabled);
  const hasWebhookSecret = webhookConfig.data?.secret_set === true;

  const steps: Step[] = [
    { label: "Connect Sonarr / Radarr", done: hasIntegration, to: PATHS.integrations, cta: "Integrations" },
    { label: "Run a full sync", done: hasSuccessfulSync, to: `${PATHS.sync}?tab=manual`, cta: "Sync now" },
    { label: "Review schedules", done: hasEnabledSchedule, to: PATHS.schedules, cta: "Schedules" },
    { label: "Set a webhook secret (optional)", done: hasWebhookSecret, to: PATHS.integrations, cta: "Configure" },
  ];

  if (steps.every((step) => step.done)) return null;

  return (
    <GlassCard>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Get started</CardTitle>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss getting-started checklist"
          onClick={() => setDismissed(true)}
        >
          <X className="size-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {steps.map((step) => (
            <li key={step.label} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm">
                {step.done ? (
                  <CheckCircle2 className="size-4 text-ok" aria-hidden />
                ) : (
                  <Circle className="size-4 text-muted-foreground" aria-hidden />
                )}
                <span className={step.done ? "text-muted-foreground line-through" : "text-foreground"}>
                  {step.label}
                </span>
              </span>
              {!step.done ? (
                <Button type="button" variant="secondary" size="sm" render={<Link to={step.to} />}>
                  {step.cta}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </GlassCard>
  );
}
