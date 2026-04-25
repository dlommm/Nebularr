import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useActionError } from "../hooks/useActionError";
import { PATHS } from "../routes/paths";
import { usePageTitle } from "../hooks/usePageTitle";
import { GlassCard, CardContent, CardHeader, CardTitle } from "../components/nebula/GlassCard";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import nebularrLogo from "@/assets/nebularr-logo.svg?url";
import nebularrIcon from "@/assets/nebularr-icon.svg?url";

type WizardForm = {
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
  pgUsername: string;
  pgPassword: string;
  arrappPassword: string;
  sonarrEnabled: boolean;
  sonarrSkip: boolean;
  sonarrBaseUrl: string;
  sonarrApiKey: string;
  radarrEnabled: boolean;
  radarrSkip: boolean;
  radarrBaseUrl: string;
  radarrApiKey: string;
  webhookSecret: string;
  incrementalCron: string;
  reconcileCron: string;
  timezone: string;
};

export function SetupPage(): JSX.Element {
  usePageTitle("Setup");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { setError } = useActionError();
  const setupStatus = useQuery({
    queryKey: ["setup-status"],
    queryFn: api.setupStatus,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const [wizardBusy, setWizardBusy] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardRunInitialSync, setWizardRunInitialSync] = useState(false);
  const [wizardRunSonarr, setWizardRunSonarr] = useState(true);
  const [wizardRunRadarr, setWizardRunRadarr] = useState(true);
  const [dbNotice, setDbNotice] = useState<string | null>(null);
  const [wizardForm, setWizardForm] = useState<WizardForm>({
    pgHost: "postgres",
    pgPort: 5432,
    pgDatabase: "arranalytics",
    pgUsername: "arradmin",
    pgPassword: "",
    arrappPassword: "",
    sonarrEnabled: true,
    sonarrSkip: false,
    sonarrBaseUrl: "",
    sonarrApiKey: "",
    radarrEnabled: true,
    radarrSkip: false,
    radarrBaseUrl: "",
    radarrApiKey: "",
    webhookSecret: "",
    incrementalCron: "",
    reconcileCron: "",
    timezone: "UTC",
  });

  const engineReady = Boolean(setupStatus.data?.database?.engine_ready);

  useEffect(() => {
    if (!setupStatus.data) return;
    const ready = Boolean(setupStatus.data.database?.engine_ready);
    if (!ready && wizardStep > 0) {
      setWizardStep(0);
    }
    setWizardForm((prev) => ({
      ...prev,
      sonarrBaseUrl: setupStatus.data?.integrations?.sonarr?.base_url ?? prev.sonarrBaseUrl,
      radarrBaseUrl: setupStatus.data?.integrations?.radarr?.base_url ?? prev.radarrBaseUrl,
      incrementalCron: setupStatus.data?.schedules.find((s) => s.mode === "incremental")?.cron ?? prev.incrementalCron,
      reconcileCron: setupStatus.data?.schedules.find((s) => s.mode === "reconcile")?.cron ?? prev.reconcileCron,
      timezone: setupStatus.data?.schedules.find((s) => s.mode === "incremental")?.timezone ?? prev.timezone,
    }));
    if (setupStatus.data.completed && setupStatus.data.database?.engine_ready) {
      navigate(PATHS.home, { replace: true });
    }
  }, [setupStatus.data, navigate, wizardStep]);

  const submitWizard = async (): Promise<void> => {
    setWizardBusy(true);
    try {
      await api.setupWizard({
        sonarr: {
          skip: wizardForm.sonarrSkip,
          enabled: wizardForm.sonarrEnabled,
          base_url: wizardForm.sonarrBaseUrl,
          api_key: wizardForm.sonarrApiKey,
          webhook_enabled: true,
        },
        radarr: {
          skip: wizardForm.radarrSkip,
          enabled: wizardForm.radarrEnabled,
          base_url: wizardForm.radarrBaseUrl,
          api_key: wizardForm.radarrApiKey,
          webhook_enabled: true,
        },
        webhook_secret: wizardForm.webhookSecret,
        schedules: {
          incremental: wizardForm.incrementalCron,
          reconcile: wizardForm.reconcileCron,
        },
        timezone: wizardForm.timezone,
      });
      if (wizardRunInitialSync) {
        const setupSources: string[] = [];
        if (!wizardForm.sonarrSkip && wizardRunSonarr) {
          setupSources.push("sonarr");
        }
        if (!wizardForm.radarrSkip && wizardRunRadarr) {
          setupSources.push("radarr");
        }
        if (setupSources.length > 0) {
          await api.setupInitialSync(setupSources);
        }
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["setup-status"] }),
        queryClient.invalidateQueries({ queryKey: ["integrations"] }),
        queryClient.invalidateQueries({ queryKey: ["schedules"] }),
        queryClient.invalidateQueries({ queryKey: ["webhook-config"] }),
        queryClient.invalidateQueries({ queryKey: ["setup-initial-sync-status"] }),
      ]);
      navigate(PATHS.home, { replace: true });
    } catch (err) {
      setError(err, "setup wizard submit");
    } finally {
      setWizardBusy(false);
    }
  };

  const skipWizard = async (): Promise<void> => {
    setWizardBusy(true);
    try {
      await api.setupSkip();
      await queryClient.invalidateQueries({ queryKey: ["setup-status"] });
      navigate(PATHS.home, { replace: true });
    } catch (err) {
      setError(err, "setup wizard skip");
    } finally {
      setWizardBusy(false);
    }
  };

  const runInitializePostgres = async (): Promise<void> => {
    setWizardBusy(true);
    setDbNotice(null);
    try {
      const res = await api.setupInitializePostgres({
        host: wizardForm.pgHost.trim(),
        port: wizardForm.pgPort,
        database: wizardForm.pgDatabase.trim(),
        username: wizardForm.pgUsername.trim(),
        password: wizardForm.pgPassword,
        arrapp_password: wizardForm.arrappPassword.trim() || undefined,
      });
      setDbNotice(
        res.restart_recommended
          ? "Database initialized. You may restart the container later; the app is already using the new connection."
          : "Database initialized. Migrations have been applied.",
      );
      await queryClient.invalidateQueries({ queryKey: ["setup-status"] });
    } catch (err) {
      setError(err, "initialize postgres");
    } finally {
      setWizardBusy(false);
    }
  };

  const stepTitles = [
    "PostgreSQL",
    "Sonarr Setup",
    "Radarr Setup",
    "Webhook + Schedule",
    "Initial Sync",
    "Review",
  ];
  const totalSteps = stepTitles.length;
  const isLastStep = wizardStep === totalSteps - 1;
  const databaseStepBlocksNext = wizardStep === 0 && !engineReady;
  const databaseBlocksNonDbSteps = !engineReady && wizardStep > 0;

  let stepBody: JSX.Element = <div />;
  if (wizardStep === 0) {
    stepBody = (
      <div className="space-y-4">
        <div className="overflow-hidden rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/10 via-[#0e1630] to-violet-600/20 nebula-glow">
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:p-6">
            <img
              className="h-14 w-14 shrink-0 rounded-2xl border border-cyan-500/30 bg-[#0e1630] p-1"
              src={nebularrIcon}
              alt=""
            />
            <div className="min-w-0 flex-1">
              <img className="mb-1 h-6 w-auto max-w-full object-contain opacity-90 sm:h-7" src={nebularrLogo} alt="Nebularr" />
              <p className="mt-2 text-sm text-muted-foreground">
                This step <strong>connects</strong> to a server that is already listening. For Docker Compose with the
                bundled <span className="font-mono text-xs">postgres</span> service, start that container first (with
                your <span className="font-mono text-xs">POSTGRES_*</span> values); the official image needs those at
                first boot to initialize data, and Nebularr cannot securely start sibling containers from the browser.
                Then enter the same database name, user, and password here. Nebularr waits for Postgres, runs Alembic
                migrations, then continues with integrations below.
              </p>
            </div>
          </div>
        </div>
        <div className="inner-card space-y-3">
          <div className="row mt8 flex-col gap-3 sm:flex-row">
            <input
              placeholder="Host (e.g. postgres)"
              value={wizardForm.pgHost}
              onChange={(event) => setWizardForm({ ...wizardForm, pgHost: event.target.value })}
            />
            <input
              type="number"
              placeholder="Port"
              value={wizardForm.pgPort || ""}
              onChange={(event) =>
                setWizardForm({ ...wizardForm, pgPort: Number.parseInt(event.target.value, 10) || 5432 })
              }
            />
          </div>
          <div className="row mt8 flex-col gap-3 sm:flex-row">
            <input
              placeholder="Database name"
              value={wizardForm.pgDatabase}
              onChange={(event) => setWizardForm({ ...wizardForm, pgDatabase: event.target.value })}
            />
            <input
              placeholder="Username (superuser)"
              value={wizardForm.pgUsername}
              onChange={(event) => setWizardForm({ ...wizardForm, pgUsername: event.target.value })}
            />
          </div>
          <div className="row mt8">
            <input
              type="password"
              placeholder="Password"
              value={wizardForm.pgPassword}
              onChange={(event) => setWizardForm({ ...wizardForm, pgPassword: event.target.value })}
            />
          </div>
          <div className="row mt8">
            <input
              type="password"
              placeholder="Optional: arrapp role password (recommended for least privilege)"
              value={wizardForm.arrappPassword}
              onChange={(event) => setWizardForm({ ...wizardForm, arrappPassword: event.target.value })}
            />
          </div>
          {engineReady ? (
            <p className="text-sm text-emerald-200/90">Database is connected and migrations are ready.</p>
          ) : (
            <Button type="button" disabled={wizardBusy} onClick={() => void runInitializePostgres()}>
              {wizardBusy ? "Connecting…" : "Wait for Postgres & run migrations"}
            </Button>
          )}
          {dbNotice ? <p className="text-sm text-cyan-200/90">{dbNotice}</p> : null}
        </div>
      </div>
    );
  }
  if (wizardStep === 1) {
    stepBody = (
      <div className="inner-card">
        <strong>Sonarr</strong>
        <div className="row mt8">
          <label className="pill">
            <input
              type="checkbox"
              checked={wizardForm.sonarrSkip}
              onChange={(event) => setWizardForm({ ...wizardForm, sonarrSkip: event.target.checked })}
            />
            skip this for now
          </label>
          <label className="pill">
            <input
              type="checkbox"
              checked={wizardForm.sonarrEnabled}
              onChange={(event) => setWizardForm({ ...wizardForm, sonarrEnabled: event.target.checked })}
            />
            enabled
          </label>
        </div>
        <div className="row mt8">
          <input
            disabled={wizardForm.sonarrSkip}
            placeholder="Sonarr base URL"
            value={wizardForm.sonarrBaseUrl}
            onChange={(event) => setWizardForm({ ...wizardForm, sonarrBaseUrl: event.target.value })}
          />
          <input
            disabled={wizardForm.sonarrSkip}
            placeholder="Sonarr API key"
            value={wizardForm.sonarrApiKey}
            onChange={(event) => setWizardForm({ ...wizardForm, sonarrApiKey: event.target.value })}
          />
        </div>
      </div>
    );
  }
  if (wizardStep === 2) {
    stepBody = (
      <div className="inner-card">
        <strong>Radarr</strong>
        <div className="row mt8">
          <label className="pill">
            <input
              type="checkbox"
              checked={wizardForm.radarrSkip}
              onChange={(event) => setWizardForm({ ...wizardForm, radarrSkip: event.target.checked })}
            />
            skip this for now
          </label>
          <label className="pill">
            <input
              type="checkbox"
              checked={wizardForm.radarrEnabled}
              onChange={(event) => setWizardForm({ ...wizardForm, radarrEnabled: event.target.checked })}
            />
            enabled
          </label>
        </div>
        <div className="row mt8">
          <input
            disabled={wizardForm.radarrSkip}
            placeholder="Radarr base URL"
            value={wizardForm.radarrBaseUrl}
            onChange={(event) => setWizardForm({ ...wizardForm, radarrBaseUrl: event.target.value })}
          />
          <input
            disabled={wizardForm.radarrSkip}
            placeholder="Radarr API key"
            value={wizardForm.radarrApiKey}
            onChange={(event) => setWizardForm({ ...wizardForm, radarrApiKey: event.target.value })}
          />
        </div>
      </div>
    );
  }
  if (wizardStep === 3) {
    stepBody = (
      <div className="inner-card">
        <strong>Webhook and Schedule</strong>
        <div className="row mt8">
          <input
            placeholder="Webhook shared secret (optional now)"
            value={wizardForm.webhookSecret}
            onChange={(event) => setWizardForm({ ...wizardForm, webhookSecret: event.target.value })}
          />
        </div>
        <div className="row mt8">
          <input
            placeholder="Incremental cron (optional)"
            value={wizardForm.incrementalCron}
            onChange={(event) => setWizardForm({ ...wizardForm, incrementalCron: event.target.value })}
          />
          <input
            placeholder="Reconcile cron (optional)"
            value={wizardForm.reconcileCron}
            onChange={(event) => setWizardForm({ ...wizardForm, reconcileCron: event.target.value })}
          />
          <input
            placeholder="Timezone (IANA)"
            value={wizardForm.timezone}
            onChange={(event) => setWizardForm({ ...wizardForm, timezone: event.target.value })}
          />
        </div>
      </div>
    );
  }
  if (wizardStep === 4) {
    stepBody = (
      <div className="inner-card">
        <strong>Initial Full Sync</strong>
        <div className="muted">Do you want to run initial full sync now? If yes, Nebularr will process one system at a time to avoid overload.</div>
        <div className="row mt8">
          <label className="pill">
            <input
              type="checkbox"
              checked={wizardRunInitialSync}
              onChange={(event) => setWizardRunInitialSync(event.target.checked)}
            />
            run initial full sync after setup
          </label>
        </div>
        <div className="row mt8">
          <label className="pill">
            <input
              type="checkbox"
              disabled={!wizardRunInitialSync || wizardForm.sonarrSkip}
              checked={wizardRunSonarr}
              onChange={(event) => setWizardRunSonarr(event.target.checked)}
            />
            sonarr
          </label>
          <label className="pill">
            <input
              type="checkbox"
              disabled={!wizardRunInitialSync || wizardForm.radarrSkip}
              checked={wizardRunRadarr}
              onChange={(event) => setWizardRunRadarr(event.target.checked)}
            />
            radarr
          </label>
        </div>
      </div>
    );
  }
  if (wizardStep === 5) {
    stepBody = (
      <div className="inner-card">
        <strong>Review</strong>
        <div className="muted">Confirm details and complete setup.</div>
        <div className="stack mt8">
          <div className="muted">PostgreSQL: {engineReady ? "connected" : "not connected"}</div>
          <div className="muted">Sonarr: {wizardForm.sonarrSkip ? "skipped" : wizardForm.sonarrBaseUrl || "configured later"}</div>
          <div className="muted">Radarr: {wizardForm.radarrSkip ? "skipped" : wizardForm.radarrBaseUrl || "configured later"}</div>
          <div className="muted">Webhook Secret: {wizardForm.webhookSecret ? "set" : "not set"}</div>
          <div className="muted">Initial Sync: {wizardRunInitialSync ? "enabled (sequential)" : "not requested"}</div>
        </div>
      </div>
    );
  }

  if (setupStatus.isLoading) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-background px-4">
        <p className="text-sm text-muted-foreground">Loading setup…</p>
      </main>
    );
  }

  return (
    <main className="min-h-svh bg-background px-4 py-10">
      <GlassCard className="mx-auto w-full max-w-3xl border-cyan-500/20 nebula-glow">
        <CardHeader>
          <CardTitle className="text-xl">First-time setup</CardTitle>
          <p className="text-sm text-muted-foreground">
            Step {wizardStep + 1} of {totalSteps} — {stepTitles[wizardStep]}
          </p>
          <Progress
            value={((wizardStep + 1) / totalSteps) * 100}
            className="mt-3 h-2 w-full max-w-md flex-col gap-0 [&_[data-slot=progress-track]]:h-2 [&_[data-slot=progress-track]]:bg-white/10 [&_[data-slot=progress-indicator]]:bg-gradient-to-r [&_[data-slot=progress-indicator]]:from-cyan-400 [&_[data-slot=progress-indicator]]:to-violet-500"
          />
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap gap-2">
            {stepTitles.map((title, index) => (
              <span
                key={title}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] font-medium",
                  index === wizardStep
                    ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-100"
                    : index < wizardStep
                      ? "border-emerald-500/40 text-emerald-200/80"
                      : "border-white/10 text-muted-foreground",
                )}
              >
                {index + 1}. {title}
              </span>
            ))}
          </div>
          {stepBody}
          <div className="flex flex-wrap gap-2 border-t border-white/10 pt-4">
            <Button
              type="button"
              variant="secondary"
              disabled={wizardBusy || wizardStep === 0}
              onClick={() => setWizardStep((prev) => Math.max(0, prev - 1))}
            >
              Back
            </Button>
            {!isLastStep ? (
              <Button
                type="button"
                disabled={wizardBusy || databaseStepBlocksNext || databaseBlocksNonDbSteps}
                onClick={() => setWizardStep((prev) => Math.min(totalSteps - 1, prev + 1))}
              >
                Next
              </Button>
            ) : (
              <>
                <Button type="button" variant="secondary" disabled={wizardBusy || !engineReady} onClick={() => void skipWizard()}>
                  Skip for now
                </Button>
                <Button type="button" disabled={wizardBusy || !engineReady} onClick={() => void submitWizard()}>
                  {wizardBusy ? "Saving…" : "Complete setup"}
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </GlassCard>
    </main>
  );
}
