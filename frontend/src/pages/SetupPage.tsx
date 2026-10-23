import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { errText } from "../hooks";
import { useActionError } from "../hooks/useActionError";
import { PATHS } from "../routes/paths";
import { usePageTitle } from "../hooks/usePageTitle";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type WizardForm = {
  pgHost: string;
  /** Raw text draft, not a parsed number: a naive numeric coercion on every
      keystroke snaps an emptied field straight back to 5432, making it
      impossible to type a different port. Parsed only on submit. */
  pgPort: string;
  pgDatabase: string;
  pgUsername: string;
  pgPassword: string;
  arrappPassword: string;
  /** X-Setup-Token, required on setup mutations while bootstrap_token_required
      is true (see SetupStatus); printed to the container log at startup. */
  setupToken: string;
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
  // SetupPage renders outside AppLayout (no DiagnosticsPanel, no toasts reach
  // it), so `setError`'s shared context state is invisible here — every
  // mutating action also needs its own inline surface for failures.
  const [pageError, setPageError] = useState<string | null>(null);
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardRunInitialSync, setWizardRunInitialSync] = useState(false);
  const [wizardRunSonarr, setWizardRunSonarr] = useState(true);
  const [wizardRunRadarr, setWizardRunRadarr] = useState(true);
  const [dbNotice, setDbNotice] = useState<string | null>(null);
  const [wizardForm, setWizardForm] = useState<WizardForm>({
    pgHost: "postgres",
    pgPort: "5432",
    pgDatabase: "arranalytics",
    pgUsername: "arradmin",
    pgPassword: "",
    arrappPassword: "",
    setupToken: "",
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

  // Sent as X-Setup-Token on every mutating setup call; a no-op once the
  // server stops requiring it (bootstrap_token_required flips false).
  const setupToken = wizardForm.setupToken.trim() || undefined;

  const submitWizard = async (): Promise<void> => {
    setWizardBusy(true);
    setPageError(null);
    try {
      await api.setupWizard(
        {
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
        },
        setupToken,
      );
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
          await api.setupInitialSync(setupSources, setupToken);
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
      setPageError(errText(err));
    } finally {
      setWizardBusy(false);
    }
  };

  const skipWizard = async (): Promise<void> => {
    setWizardBusy(true);
    setPageError(null);
    try {
      await api.setupSkip(setupToken);
      await queryClient.invalidateQueries({ queryKey: ["setup-status"] });
      navigate(PATHS.home, { replace: true });
    } catch (err) {
      setError(err, "setup wizard skip");
      setPageError(errText(err));
    } finally {
      setWizardBusy(false);
    }
  };

  const runInitializePostgres = async (): Promise<void> => {
    setWizardBusy(true);
    setDbNotice(null);
    setPageError(null);
    try {
      const res = await api.setupInitializePostgres(
        {
          host: wizardForm.pgHost.trim(),
          port: Number.parseInt(wizardForm.pgPort, 10) || 5432,
          database: wizardForm.pgDatabase.trim(),
          username: wizardForm.pgUsername.trim(),
          password: wizardForm.pgPassword,
          arrapp_password: wizardForm.arrappPassword.trim() || undefined,
        },
        setupToken,
      );
      setDbNotice(
        res.restart_recommended
          ? "Database initialized. You may restart the container later; the app is already using the new connection."
          : "Database initialized. Migrations have been applied.",
      );
      await queryClient.invalidateQueries({ queryKey: ["setup-status"] });
    } catch (err) {
      setError(err, "initialize postgres");
      setPageError(errText(err));
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
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          This step <strong className="text-foreground">connects</strong> to a server that is already listening. For Docker Compose with
          the bundled <span className="font-mono text-xs">postgres</span> service, start that container first (with your{" "}
          <span className="font-mono text-xs">POSTGRES_*</span> values); the official image needs those at first boot to initialize data,
          and Nebularr cannot securely start sibling containers from the browser. Then enter the same database name, user, and password
          here. Nebularr waits for Postgres, runs Alembic migrations, then continues with integrations below.
        </p>
        {setupStatus.data?.bootstrap_token_required ? (
          <div className="space-y-2 border-y border-warn/40 py-4">
            <Label htmlFor="setup-bootstrap-token" className="text-sm font-medium text-warn">
              Setup token required
            </Label>
            <p className="text-xs text-muted-foreground">
              This server printed a one-time setup token to its startup log ("Setup bootstrap token: …") to stop
              anyone else on the network from finishing setup before you do. Paste it here — it's required for every
              action on this page until setup completes.
            </p>
            <Input
              id="setup-bootstrap-token"
              autoComplete="off"
              placeholder="Setup token from the container log"
              value={wizardForm.setupToken}
              onChange={(event) => setWizardForm({ ...wizardForm, setupToken: event.target.value })}
            />
          </div>
        ) : null}
        <div className="space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row">
            <Field label="Host">
            <Input
                aria-label="Host"
                placeholder="Host (e.g. postgres)"
                value={wizardForm.pgHost}
                onChange={(event) => setWizardForm({ ...wizardForm, pgHost: event.target.value })}
              />
            </Field>
            <Field label="Port">
            <Input
                aria-label="Port"
                type="number"
                placeholder="Port"
                value={wizardForm.pgPort}
                onChange={(event) => setWizardForm({ ...wizardForm, pgPort: event.target.value })}
              />
            </Field>
          </div>
          <div className="flex flex-col gap-4 sm:flex-row">
            <Field label="Database name">
            <Input
                aria-label="Database name"
                placeholder="Database name"
                value={wizardForm.pgDatabase}
                onChange={(event) => setWizardForm({ ...wizardForm, pgDatabase: event.target.value })}
              />
            </Field>
            <Field label="Username">
            <Input
                aria-label="Username"
                placeholder="Username (superuser)"
                value={wizardForm.pgUsername}
                onChange={(event) => setWizardForm({ ...wizardForm, pgUsername: event.target.value })}
              />
            </Field>
          </div>
          <Field label="Password">
          <Input
              aria-label="Password"
              type="password"
              placeholder="Password"
              value={wizardForm.pgPassword}
              onChange={(event) => setWizardForm({ ...wizardForm, pgPassword: event.target.value })}
            />
          </Field>
          <Field label="arrapp role password (optional)">
          <Input
              aria-label="arrapp role password (optional)"
              type="password"
              placeholder="Optional: arrapp role password (recommended for least privilege)"
              value={wizardForm.arrappPassword}
              onChange={(event) => setWizardForm({ ...wizardForm, arrappPassword: event.target.value })}
            />
          </Field>
          {engineReady ? (
            <p className="flex min-h-11 items-center text-sm text-ok">Database is connected and migrations are ready.</p>
          ) : (
            <Button type="button" className="min-h-11" disabled={wizardBusy} onClick={() => void runInitializePostgres()}>
              {wizardBusy ? "Connecting…" : "Wait for Postgres & run migrations"}
            </Button>
          )}
          {dbNotice ? <p className="text-sm text-signal">{dbNotice}</p> : null}
        </div>
      </div>
    );
  }
  if (wizardStep === 1) {
    stepBody = (
      <div className="space-y-4">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex min-h-11 items-center gap-2.5">
            <Checkbox
              id="setup-sonarr-skip"
              checked={wizardForm.sonarrSkip}
              onCheckedChange={(checked) => setWizardForm({ ...wizardForm, sonarrSkip: checked === true })}
            />
            <Label htmlFor="setup-sonarr-skip" className="text-sm font-normal">
              skip this for now
            </Label>
          </div>
          <div className="flex min-h-11 items-center gap-2.5">
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
        <div className="flex flex-col gap-4 sm:flex-row">
          <Field label="Sonarr base URL">
          <Input
              aria-label="Sonarr base URL"
              disabled={wizardForm.sonarrSkip}
              placeholder="Sonarr base URL"
              value={wizardForm.sonarrBaseUrl}
              onChange={(event) => setWizardForm({ ...wizardForm, sonarrBaseUrl: event.target.value })}
            />
          </Field>
          <Field label="Sonarr API key">
          <Input
              aria-label="Sonarr API key"
              type="password"
              autoComplete="off"
              disabled={wizardForm.sonarrSkip}
              placeholder="Sonarr API key"
              value={wizardForm.sonarrApiKey}
              onChange={(event) => setWizardForm({ ...wizardForm, sonarrApiKey: event.target.value })}
            />
          </Field>
        </div>
      </div>
    );
  }
  if (wizardStep === 2) {
    stepBody = (
      <div className="space-y-4">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex min-h-11 items-center gap-2.5">
            <Checkbox
              id="setup-radarr-skip"
              checked={wizardForm.radarrSkip}
              onCheckedChange={(checked) => setWizardForm({ ...wizardForm, radarrSkip: checked === true })}
            />
            <Label htmlFor="setup-radarr-skip" className="text-sm font-normal">
              skip this for now
            </Label>
          </div>
          <div className="flex min-h-11 items-center gap-2.5">
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
        <div className="flex flex-col gap-4 sm:flex-row">
          <Field label="Radarr base URL">
          <Input
              aria-label="Radarr base URL"
              disabled={wizardForm.radarrSkip}
              placeholder="Radarr base URL"
              value={wizardForm.radarrBaseUrl}
              onChange={(event) => setWizardForm({ ...wizardForm, radarrBaseUrl: event.target.value })}
            />
          </Field>
          <Field label="Radarr API key">
          <Input
              aria-label="Radarr API key"
              type="password"
              autoComplete="off"
              disabled={wizardForm.radarrSkip}
              placeholder="Radarr API key"
              value={wizardForm.radarrApiKey}
              onChange={(event) => setWizardForm({ ...wizardForm, radarrApiKey: event.target.value })}
            />
          </Field>
        </div>
      </div>
    );
  }
  if (wizardStep === 3) {
    stepBody = (
      <div className="space-y-4">
        <Field label="Webhook shared secret">
        <Input
            aria-label="Webhook shared secret"
            type="password"
            autoComplete="off"
            placeholder="Webhook shared secret (optional now)"
            value={wizardForm.webhookSecret}
            onChange={(event) => setWizardForm({ ...wizardForm, webhookSecret: event.target.value })}
          />
        </Field>
        <div className="flex flex-col gap-4 sm:flex-row">
          <Field label="Incremental cron">
          <Input
              aria-label="Incremental cron"
              placeholder="Incremental cron (optional)"
              value={wizardForm.incrementalCron}
              onChange={(event) => setWizardForm({ ...wizardForm, incrementalCron: event.target.value })}
            />
          </Field>
          <Field label="Reconcile cron">
          <Input
              aria-label="Reconcile cron"
              placeholder="Reconcile cron (optional)"
              value={wizardForm.reconcileCron}
              onChange={(event) => setWizardForm({ ...wizardForm, reconcileCron: event.target.value })}
            />
          </Field>
          <Field label="Timezone">
          <Input
              aria-label="Timezone"
              placeholder="Timezone (IANA)"
              value={wizardForm.timezone}
              onChange={(event) => setWizardForm({ ...wizardForm, timezone: event.target.value })}
            />
          </Field>
        </div>
      </div>
    );
  }
  if (wizardStep === 4) {
    stepBody = (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Protect this server with a password. Every API endpoint — including ones that can change integrations or
          wipe data — is otherwise open to anyone who can reach this machine on the network.
        </p>
        <div className="flex flex-col gap-4 sm:flex-row">
          <Field label="Admin password">
          <Input
              aria-label="Admin password"
              type="password"
              autoComplete="new-password"
              disabled={wizardForm.allowNoAuth}
              placeholder="Admin password (min 8 characters)"
              value={wizardForm.adminPassword}
              onChange={(event) => setWizardForm({ ...wizardForm, adminPassword: event.target.value })}
            />
          </Field>
          <Field label="Confirm admin password">
          <Input
              aria-label="Confirm admin password"
              type="password"
              autoComplete="new-password"
              disabled={wizardForm.allowNoAuth}
              placeholder="Confirm password"
              value={wizardForm.adminPasswordConfirm}
              onChange={(event) => setWizardForm({ ...wizardForm, adminPasswordConfirm: event.target.value })}
            />
          </Field>
        </div>
        {passwordTooShort ? (
          <p className="text-sm text-muted-foreground">Password must be at least 8 characters.</p>
        ) : null}
        {!passwordTooShort && wizardForm.adminPassword && passwordMismatch ? (
          <p className="text-sm text-muted-foreground">Passwords do not match.</p>
        ) : null}
        <div className="flex min-h-11 items-center gap-2.5">
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
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Do you want to run initial full sync now? If yes, Nebularr will process one system at a time to avoid overload.
        </p>
        <div className="flex min-h-11 items-center gap-2.5">
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
          <div className="flex min-h-11 items-center gap-2.5">
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
          <div className="flex min-h-11 items-center gap-2.5">
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
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Confirm details and complete setup.</p>
        <dl className="border-b border-border text-sm">
          {(
            [
              ["PostgreSQL", engineReady ? "connected" : "not connected"],
              ["Sonarr", wizardForm.sonarrSkip ? "skipped" : wizardForm.sonarrBaseUrl || "configured later"],
              ["Radarr", wizardForm.radarrSkip ? "skipped" : wizardForm.radarrBaseUrl || "configured later"],
              ["Webhook Secret", wizardForm.webhookSecret ? "set" : "not set"],
              ["Authentication", wizardForm.allowNoAuth || !wizardForm.adminPassword ? "disabled (not recommended)" : "enabled"],
              ["Initial Sync", wizardRunInitialSync ? "enabled (sequential)" : "not requested"],
            ] as const
          ).map(([term, value]) => (
            <div key={term} className="flex flex-wrap justify-between gap-x-6 gap-y-1 border-t border-border py-3">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="font-mono text-xs">{value}</dd>
            </div>
          ))}
        </dl>
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
    <main className="min-h-svh bg-background px-4 pt-10 pb-16 sm:px-10">
      <div className="mx-auto grid w-full max-w-[1360px] gap-x-16 gap-y-8 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <header className="lg:sticky lg:top-10 lg:self-start">
          <p className="flex items-baseline gap-2.5">
            <span className="cond text-[26px] leading-none font-[800]">Nebularr</span>
            <span className="font-mono text-[11px] text-subtle-foreground">setup</span>
          </p>
          <h1 className="cond mt-8 animate-rise text-[clamp(52px,5.4vw,80px)] leading-[0.84] font-[760]">
            <span className="whitespace-nowrap">First-time</span> setup
          </h1>
          <p className="mt-4 text-[15px] text-muted-foreground">
            Step {wizardStep + 1} of {totalSteps} — {stepTitles[wizardStep]}
          </p>
          <div
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={1}
            aria-valuemax={totalSteps}
            aria-valuenow={wizardStep + 1}
            className="mt-4 h-[3px] w-full bg-border"
          >
            <span
              className="block h-full bg-signal transition-[width] duration-500"
              style={{ width: `${((wizardStep + 1) / totalSteps) * 100}%` }}
            />
          </div>
          <ol className="mt-6 hidden border-b border-border lg:block">
            {stepTitles.map((title, index) => (
              <li
                key={title}
                aria-current={index === wizardStep ? "step" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-3 border-t border-border text-[15px]",
                  index === wizardStep ? "text-foreground" : index < wizardStep ? "text-muted-foreground" : "text-subtle-foreground",
                )}
              >
                <span className="w-5 font-mono text-xs tabular-nums">{index + 1}</span>
                <span className="flex-1">{title}</span>
                {index < wizardStep ? <span className="size-2 rounded-full bg-ok" aria-label="done" /> : null}
                {index === wizardStep ? <span aria-hidden className="size-2 bg-foreground" /> : null}
              </li>
            ))}
          </ol>
        </header>

        <section aria-labelledby="setup-step-title" className="min-w-0 lg:pt-[7.5rem]">
          <h2 id="setup-step-title" key={wizardStep} className="cond animate-rise text-[44px] leading-[0.9] font-[760]">
            {stepTitles[wizardStep]}
          </h2>
          <div className="mt-6">{stepBody}</div>
          {pageError ? (
            <div role="alert" className="mt-6 border-y border-critical/40 py-3 text-sm text-critical">
              {pageError}
            </div>
          ) : null}
          <div className="mt-8 flex flex-wrap gap-2.5 border-t border-border pt-5">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={wizardBusy || wizardStep === 0}
              onClick={() => setWizardStep((prev) => Math.max(0, prev - 1))}
            >
              Back
            </Button>
            {!isLastStep ? (
              <Button
                type="button"
                className="min-h-11"
                disabled={wizardBusy || databaseStepBlocksNext || databaseBlocksNonDbSteps || securityStepBlocksNext}
                onClick={() => setWizardStep((prev) => Math.min(totalSteps - 1, prev + 1))}
              >
                Next
              </Button>
            ) : (
              <Button type="button" className="min-h-11" disabled={wizardBusy || !engineReady} onClick={() => void submitWizard()}>
                {wizardBusy ? "Saving…" : "Complete setup"}
              </Button>
            )}
            {/* Reachable from step 1 onward (not just the last step) — an
                operator who only needs the database connected shouldn't have
                to click through every integration step first. */}
            <Button
              type="button"
              variant="ghost"
              className="ml-auto min-h-11"
              disabled={wizardBusy || !engineReady}
              onClick={() => void skipWizard()}
            >
              Skip for now
            </Button>
          </div>
        </section>
      </div>
    </main>
  );
}

/** A visible caption above a wizard input. */
function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="grid w-full gap-1.5 text-[11px] text-subtle-foreground">
      <span aria-hidden>{label}</span>
      {children}
    </label>
  );
}
