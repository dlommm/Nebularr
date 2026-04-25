import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useActionError } from "../hooks/useActionError";
import { PATHS } from "../routes/paths";
import { usePageTitle } from "../hooks/usePageTitle";

type WizardForm = {
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
  });

  const [wizardBusy, setWizardBusy] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardRunInitialSync, setWizardRunInitialSync] = useState(false);
  const [wizardRunSonarr, setWizardRunSonarr] = useState(true);
  const [wizardRunRadarr, setWizardRunRadarr] = useState(true);
  const [wizardForm, setWizardForm] = useState<WizardForm>({
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

  useEffect(() => {
    if (!setupStatus.data) return;
    setWizardForm((prev) => ({
      ...prev,
      sonarrBaseUrl: setupStatus.data?.integrations?.sonarr?.base_url ?? prev.sonarrBaseUrl,
      radarrBaseUrl: setupStatus.data?.integrations?.radarr?.base_url ?? prev.radarrBaseUrl,
      incrementalCron: setupStatus.data?.schedules.find((s) => s.mode === "incremental")?.cron ?? prev.incrementalCron,
      reconcileCron: setupStatus.data?.schedules.find((s) => s.mode === "reconcile")?.cron ?? prev.reconcileCron,
      timezone: setupStatus.data?.schedules.find((s) => s.mode === "incremental")?.timezone ?? prev.timezone,
    }));
    if (setupStatus.data.completed) {
      navigate(PATHS.home, { replace: true });
    }
  }, [setupStatus.data, navigate]);

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

  const stepTitles = [
    "Welcome",
    "Sonarr Setup",
    "Radarr Setup",
    "Webhook + Schedule",
    "Initial Sync",
    "Review",
  ];
  const totalSteps = stepTitles.length;
  const isLastStep = wizardStep === totalSteps - 1;

  let stepBody: JSX.Element = <div />;
  if (wizardStep === 0) {
    stepBody = (
      <div className="inner-card">
        <h3>Welcome to Nebularr</h3>
        <p className="muted">
          Nebularr syncs Sonarr and Radarr metadata into PostgreSQL so you can search, audit, and automate your media decisions.
        </p>
        <p className="muted">
          This setup wizard will guide you through integrations, webhook security, schedules, and optional initial full sync.
        </p>
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
      <main className="setup-page">
        <p className="muted">Loading setup…</p>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <div className="card wizard-card standalone-wizard">
        <h3>First Setup Wizard</h3>
        <div className="wizard-progress">
          <span className="pill">
            Step {wizardStep + 1} of {totalSteps}
          </span>
          <span className="muted">{stepTitles[wizardStep]}</span>
        </div>
        <div className="wizard-steps">
          {stepTitles.map((title, index) => (
            <span key={title} className={`wizard-step-pill ${index === wizardStep ? "active" : index < wizardStep ? "done" : ""}`}>
              {index + 1}. {title}
            </span>
          ))}
        </div>
        {stepBody}
        <div className="row">
          <button
            type="button"
            className="secondary"
            disabled={wizardBusy || wizardStep === 0}
            onClick={() => setWizardStep((prev) => Math.max(0, prev - 1))}
          >
            Back
          </button>
          {!isLastStep ? (
            <button
              type="button"
              disabled={wizardBusy}
              onClick={() => setWizardStep((prev) => Math.min(totalSteps - 1, prev + 1))}
            >
              Next
            </button>
          ) : (
            <>
              <button type="button" className="secondary" disabled={wizardBusy} onClick={() => void skipWizard()}>
                Skip for now
              </button>
              <button type="button" disabled={wizardBusy} onClick={() => void submitWizard()}>
                {wizardBusy ? "Saving..." : "Complete setup"}
              </button>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
