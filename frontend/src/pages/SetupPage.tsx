import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useActionError } from "../hooks/useActionError";
import { PATHS } from "../routes/paths";
import { usePageTitle } from "../hooks/usePageTitle";
import { GlassCard, CardContent, CardHeader, CardTitle } from "../components/nebula/GlassCard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
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
  adminPassword: string;
  adminPasswordConfirm: string;
  allowNoAuth: boolean;
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
    adminPassword: "",
    adminPasswordConfirm: "",
    allowNoAuth: false,
  });

  const engineReady = Boolean(setupStatus.data?.database?.engine_ready);
  // Populate the form only once per server payload identity, so navigating
  // between steps never reverts edits the user just made (B13).
  const populatedForRef = useRef<unknown>(null);

  useEffect(() => {
    if (!setupStatus.data) return;
    const ready = Boolean(setupStatus.data.database?.engine_ready);
    if (!ready && wizardStep > 0) {
      setWizardStep(0);
    }
    if (setupStatus.data.completed && setupStatus.data.database?.engine_ready) {
      navigate(PATHS.home, { replace: true });
    }
  }, [setupStatus.data, navigate, wizardStep]);

  useEffect(() => {
    if (!setupStatus.data || populatedForRef.current === setupStatus.data) return;
    populatedForRef.current = setupStatus.data;
    setWizardForm((prev) => ({
      ...prev,
      sonarrBaseUrl: setupStatus.data?.integrations?.sonarr?.base_url ?? prev.sonarrBaseUrl,
      radarrBaseUrl: setupStatus.data?.integrations?.radarr?.base_url ?? prev.radarrBaseUrl,
      incrementalCron: setupStatus.data?.schedules.find((s) => s.mode === "incremental")?.cron ?? prev.incrementalCron,
      reconcileCron: setupStatus.data?.schedules.find((s) => s.mode === "reconcile")?.cron ?? prev.reconcileCron,
      timezone: setupStatus.data?.schedules.find((s) => s.mode === "incremental")?.timezone ?? prev.timezone,
    }));
  }, [setupStatus.data]);

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
        admin_password: wizardForm.allowNoAuth ? "" : wizardForm.adminPassword,
        schedules: {
          incremental: wizardForm.incrementalCron,
          reconcile: wizardForm.reconcileCron,
        },
        timezone: wizardForm.timezone,
      });
      if (!wizardForm.allowNoAuth && wizardForm.adminPassword) {
        // Sign in with the freshly created password so the redirect lands in the app, not /login.
        await api.authLogin(wizardForm.adminPassword);
      }
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
    "Security",
    "Initial Sync",
    "Review",
  ];
  const totalSteps = stepTitles.length;
  const isLastStep = wizardStep === totalSteps - 1;
  const databaseStepBlocksNext = wizardStep === 0 && !engineReady;
  const databaseBlocksNonDbSteps = !engineReady && wizardStep > 0;
  const passwordTooShort = wizardForm.adminPassword.length > 0 && wizardForm.adminPassword.length < 8;
  const passwordMismatch = wizardForm.adminPassword !== wizardForm.adminPasswordConfirm;
  const securityStepBlocksNext =
    wizardStep === 4 && !wizardForm.allowNoAuth && (!wizardForm.adminPassword || passwordTooShort || passwordMismatch);

  let stepBody: JSX.Element = <div />;
  if (wizardStep === 0) {
    stepBody = (
      <div className="space-y-4">
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-card)]">
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:p-6">
            <img
              className="h-12 w-12 shrink-0 rounded-xl"
              src={nebularrIcon}
              alt=""
            />
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold tracking-tight">Nebularr</p>
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
        <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              placeholder="Host (e.g. postgres)"
              value={wizardForm.pgHost}
              onChange={(event) => setWizardForm({ ...wizardForm, pgHost: event.target.value })}
            />
            <Input
              type="number"
              placeholder="Port"
              value={wizardForm.pgPort || ""}
              onChange={(event) =>
                setWizardForm({ ...wizardForm, pgPort: Number.parseInt(event.target.value, 10) || 5432 })
              }
            />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              placeholder="Database name"
              value={wizardForm.pgDatabase}
              onChange={(event) => setWizardForm({ ...wizardForm, pgDatabase: event.target.value })}
            />
            <Input
              placeholder="Username (superuser)"
              value={wizardForm.pgUsername}
              onChange={(event) => setWizardForm({ ...wizardForm, pgUsername: event.target.value })}
            />
          </div>
          <Input
            type="password"
            placeholder="Password"
            value={wizardForm.pgPassword}
            onChange={(event) => setWizardForm({ ...wizardForm, pgPassword: event.target.value })}
          />
          <Input
            type="password"
            placeholder="Optional: arrapp role password (recommended for least privilege)"
            value={wizardForm.arrappPassword}
            onChange={(event) => setWizardForm({ ...wizardForm, arrappPassword: event.target.value })}
          />
          {engineReady ? (
            <p className="text-sm text-ok">Database is connected and migrations are ready.</p>
          ) : (
            <Button type="button" disabled={wizardBusy} onClick={() => void runInitializePostgres()}>
              {wizardBusy ? "Connecting…" : "Wait for Postgres & run migrations"}
            </Button>
          )}
          {dbNotice ? <p className="text-sm text-primary">{dbNotice}</p> : null}
        </div>
      </div>
    );
  }
  if (wizardStep === 1) {
    stepBody = (
      <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
        <p className="font-medium">Sonarr</p>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id="setup-sonarr-skip"
              checked={wizardForm.sonarrSkip}
              onCheckedChange={(checked) => setWizardForm({ ...wizardForm, sonarrSkip: checked === true })}
            />
            <Label htmlFor="setup-sonarr-skip" className="text-sm text-muted-foreground">
              skip this for now
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="setup-sonarr-enabled"
              checked={wizardForm.sonarrEnabled}
              onCheckedChange={(checked) => setWizardForm({ ...wizardForm, sonarrEnabled: checked === true })}
            />
            <Label htmlFor="setup-sonarr-enabled" className="text-sm text-muted-foreground">
              enabled
            </Label>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            disabled={wizardForm.sonarrSkip}
            placeholder="Sonarr base URL"
            value={wizardForm.sonarrBaseUrl}
            onChange={(event) => setWizardForm({ ...wizardForm, sonarrBaseUrl: event.target.value })}
          />
          <Input
            type="password"
            autoComplete="off"
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
      <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
        <p className="font-medium">Radarr</p>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id="setup-radarr-skip"
              checked={wizardForm.radarrSkip}
              onCheckedChange={(checked) => setWizardForm({ ...wizardForm, radarrSkip: checked === true })}
            />
            <Label htmlFor="setup-radarr-skip" className="text-sm text-muted-foreground">
              skip this for now
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="setup-radarr-enabled"
              checked={wizardForm.radarrEnabled}
              onCheckedChange={(checked) => setWizardForm({ ...wizardForm, radarrEnabled: checked === true })}
            />
            <Label htmlFor="setup-radarr-enabled" className="text-sm text-muted-foreground">
              enabled
            </Label>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            disabled={wizardForm.radarrSkip}
            placeholder="Radarr base URL"
            value={wizardForm.radarrBaseUrl}
            onChange={(event) => setWizardForm({ ...wizardForm, radarrBaseUrl: event.target.value })}
          />
          <Input
            type="password"
            autoComplete="off"
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
      <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
        <p className="font-medium">Webhook and Schedule</p>
        <Input
          type="password"
          autoComplete="off"
          placeholder="Webhook shared secret (optional now)"
          value={wizardForm.webhookSecret}
          onChange={(event) => setWizardForm({ ...wizardForm, webhookSecret: event.target.value })}
        />
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            placeholder="Incremental cron (optional)"
            value={wizardForm.incrementalCron}
            onChange={(event) => setWizardForm({ ...wizardForm, incrementalCron: event.target.value })}
          />
          <Input
            placeholder="Reconcile cron (optional)"
            value={wizardForm.reconcileCron}
            onChange={(event) => setWizardForm({ ...wizardForm, reconcileCron: event.target.value })}
          />
          <Input
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
      <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
        <p className="font-medium">Admin password</p>
        <p className="text-sm text-muted-foreground">
          Protect this server with a password. Every API endpoint — including ones that can change integrations or
          wipe data — is otherwise open to anyone who can reach this machine on the network.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            type="password"
            autoComplete="new-password"
            disabled={wizardForm.allowNoAuth}
            placeholder="Admin password (min 8 characters)"
            value={wizardForm.adminPassword}
            onChange={(event) => setWizardForm({ ...wizardForm, adminPassword: event.target.value })}
          />
          <Input
            type="password"
            autoComplete="new-password"
            disabled={wizardForm.allowNoAuth}
            placeholder="Confirm password"
            value={wizardForm.adminPasswordConfirm}
            onChange={(event) => setWizardForm({ ...wizardForm, adminPasswordConfirm: event.target.value })}
          />
        </div>
        {passwordTooShort ? (
          <p className="text-sm text-muted-foreground">Password must be at least 8 characters.</p>
        ) : null}
        {!passwordTooShort && wizardForm.adminPassword && passwordMismatch ? (
          <p className="text-sm text-muted-foreground">Passwords do not match.</p>
        ) : null}
        <div className="flex items-center gap-2">
          <Checkbox
            id="setup-allow-no-auth"
            checked={wizardForm.allowNoAuth}
            onCheckedChange={(checked) => setWizardForm({ ...wizardForm, allowNoAuth: checked === true })}
          />
          <Label htmlFor="setup-allow-no-auth" className="text-sm text-muted-foreground">
            run without authentication (not recommended)
          </Label>
        </div>
      </div>
    );
  }
  if (wizardStep === 5) {
    stepBody = (
      <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
        <p className="font-medium">Initial Full Sync</p>
        <p className="text-sm text-muted-foreground">
          Do you want to run initial full sync now? If yes, Nebularr will process one system at a time to avoid overload.
        </p>
        <div className="flex items-center gap-2">
          <Checkbox
            id="setup-run-initial-sync"
            checked={wizardRunInitialSync}
            onCheckedChange={(checked) => setWizardRunInitialSync(checked === true)}
          />
          <Label htmlFor="setup-run-initial-sync" className="text-sm text-muted-foreground">
            run initial full sync after setup
          </Label>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id="setup-sync-sonarr"
              disabled={!wizardRunInitialSync || wizardForm.sonarrSkip}
              checked={wizardRunSonarr}
              onCheckedChange={(checked) => setWizardRunSonarr(checked === true)}
            />
            <Label htmlFor="setup-sync-sonarr" className="text-sm text-muted-foreground">
              sonarr
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="setup-sync-radarr"
              disabled={!wizardRunInitialSync || wizardForm.radarrSkip}
              checked={wizardRunRadarr}
              onCheckedChange={(checked) => setWizardRunRadarr(checked === true)}
            />
            <Label htmlFor="setup-sync-radarr" className="text-sm text-muted-foreground">
              radarr
            </Label>
          </div>
        </div>
      </div>
    );
  }
  if (wizardStep === 6) {
    stepBody = (
      <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
        <p className="font-medium">Review</p>
        <p className="text-sm text-muted-foreground">Confirm details and complete setup.</p>
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>PostgreSQL: {engineReady ? "connected" : "not connected"}</p>
          <p>Sonarr: {wizardForm.sonarrSkip ? "skipped" : wizardForm.sonarrBaseUrl || "configured later"}</p>
          <p>Radarr: {wizardForm.radarrSkip ? "skipped" : wizardForm.radarrBaseUrl || "configured later"}</p>
          <p>Webhook Secret: {wizardForm.webhookSecret ? "set" : "not set"}</p>
          <p>
            Authentication: {wizardForm.allowNoAuth || !wizardForm.adminPassword ? "disabled (not recommended)" : "enabled"}
          </p>
          <p>Initial Sync: {wizardRunInitialSync ? "enabled (sequential)" : "not requested"}</p>
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
      <GlassCard className="mx-auto w-full max-w-3xl">
        <CardHeader>
          <CardTitle className="text-xl">First-time setup</CardTitle>
          <p className="text-sm text-muted-foreground">
            Step {wizardStep + 1} of {totalSteps} — {stepTitles[wizardStep]}
          </p>
          <Progress
            value={((wizardStep + 1) / totalSteps) * 100}
            className="mt-3 h-2 w-full max-w-md flex-col gap-0 [&_[data-slot=progress-track]]:h-2 [&_[data-slot=progress-track]]:bg-muted [&_[data-slot=progress-indicator]]:bg-primary"
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
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : index < wizardStep
                      ? "border-ok/35 text-ok"
                      : "border-border text-muted-foreground",
                )}
              >
                {index + 1}. {title}
              </span>
            ))}
          </div>
          {stepBody}
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
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
                disabled={wizardBusy || databaseStepBlocksNext || databaseBlocksNonDbSteps || securityStepBlocksNext}
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
