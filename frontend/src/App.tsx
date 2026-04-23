import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { fmtDate, fmtDuration, fmtSize, useDebouncedValue, useLocalStorageState } from "./hooks";
import type { EpisodeRow, MovieRow, ReportingPanel, ShowRow } from "./types";

type ViewName = "overview" | "reporting" | "integrations" | "schedules" | "runs" | "library" | "webhooks" | "actions";
type LibraryMode = "drilldown" | "all-episodes" | "movies";

type LibraryFilters = {
  search: string;
  instance: string;
  limit: number;
  offset: number;
  sortBy: string;
  sortDir: "asc" | "desc";
  showSeason: number | null;
};

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

const nav: { id: ViewName; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "reporting", label: "Reporting" },
  { id: "integrations", label: "Integrations" },
  { id: "schedules", label: "Schedules" },
  { id: "runs", label: "Sync Runs" },
  { id: "library", label: "Library" },
  { id: "webhooks", label: "Webhooks" },
  { id: "actions", label: "Manual Actions" },
];

function statusPill(status: string): JSX.Element {
  return <span className={`status-pill ${status.toLowerCase()}`}>{status}</span>;
}

function Pagination({
  total,
  offset,
  limit,
  onChange,
}: {
  total: number;
  offset: number;
  limit: number;
  onChange: (nextOffset: number) => void;
}): JSX.Element {
  const start = Math.min(offset + 1, total);
  const end = Math.min(offset + limit, total);
  return (
    <div className="pager">
      <span>
        {total === 0 ? "0 results" : `${start}-${end} of ${total}`}
      </span>
      <button type="button" className="secondary" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        Prev
      </button>
      <button type="button" className="secondary" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
        Next
      </button>
    </div>
  );
}

function DiagnosticsPanel({
  message,
  context,
  clear,
}: {
  message: string | null;
  context: string | null;
  clear: () => void;
}): JSX.Element | null {
  if (!message) return null;
  return (
    <div className="card error-card">
      <div className="row">
        <strong>Diagnostics</strong>
        <button type="button" className="secondary" onClick={clear}>
          Dismiss
        </button>
      </div>
      <div className="muted">{message}</div>
      {context ? <pre>{context}</pre> : null}
    </div>
  );
}

export function App(): JSX.Element {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [activeView, setActiveView] = useLocalStorageState<ViewName>("nebularr.active.view", "overview");
  const [reportingDashboardKey, setReportingDashboardKey] = useLocalStorageState<string>(
    "nebularr.reporting.dashboard",
    "overview",
  );
  const [reportingGlobalFilter, setReportingGlobalFilter] = useLocalStorageState<string>(
    "nebularr.reporting.global-filter",
    "",
  );
  const [reportingDashboardFilters, setReportingDashboardFilters] = useLocalStorageState<Record<string, string>>(
    "nebularr.reporting.dashboard-filters",
    {},
  );
  const [reportingInstance, setReportingInstance] = useLocalStorageState<string>("nebularr.reporting.instance", "");
  const [reportingLimit, setReportingLimit] = useLocalStorageState<number>("nebularr.reporting.limit", 200);
  const [reportingTablePageSize, setReportingTablePageSize] = useLocalStorageState<number>(
    "nebularr.reporting.table.page-size",
    10,
  );
  const [reportingTableOffsets, setReportingTableOffsets] = useState<Record<string, number>>({});
  const [reportingPanelFilters, setReportingPanelFilters] = useState<Record<string, string>>({});
  const [reportingColumnFilters, setReportingColumnFilters] = useState<Record<string, string>>({});
  const [libraryMode, setLibraryMode] = useLocalStorageState<LibraryMode>("nebularr.library.mode", "drilldown");
  const [density, setDensity] = useLocalStorageState<"comfortable" | "compact">("nebularr.ui.density", "comfortable");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [libraryFilters, setLibraryFilters] = useLocalStorageState<LibraryFilters>("nebularr.library.filters", {
    search: "",
    instance: "",
    limit: 50,
    offset: 0,
    sortBy: "title",
    sortDir: "asc",
    showSeason: null,
  });
  const [selectedShow, setSelectedShow] = useLocalStorageState<{ id: number; instance: string; title: string } | null>(
    "nebularr.library.selectedShow",
    null,
  );
  const [commandPalette, setCommandPalette] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [errorContext, setErrorContext] = useState<string | null>(null);
  const [detailDrawer, setDetailDrawer] = useState<Record<string, unknown> | null>(null);
  const [compareMode, setCompareMode] = useLocalStorageState<boolean>("nebularr.compare.mode", false);
  const [compareRows, setCompareRows] = useState<EpisodeRow[]>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [webhookSecretInput, setWebhookSecretInput] = useState("");
  const [alertWebhookDraft, setAlertWebhookDraft] = useState<{
    webhookUrlsText: string;
    clearUrls: boolean;
    timeoutSeconds: number;
    minState: "warning" | "critical";
    notifyRecovery: boolean;
  }>({
    webhookUrlsText: "",
    clearUrls: false,
    timeoutSeconds: 10,
    minState: "warning",
    notifyRecovery: true,
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
  const debouncedSearch = useDebouncedValue(libraryFilters.search, 300);
  const debouncedInstance = useDebouncedValue(libraryFilters.instance, 300);

  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: 15_000,
  });
  const healthz = useQuery({
    queryKey: ["healthz"],
    queryFn: api.healthz,
    refetchInterval: 60_000,
  });
  const setupStatus = useQuery({
    queryKey: ["setup-status"],
    queryFn: api.setupStatus,
  });
  const syncActivity = useQuery({
    queryKey: ["sync-activity"],
    queryFn: api.syncActivity,
    refetchInterval: 5_000,
  });
  const runs = useQuery({ queryKey: ["runs"], queryFn: api.recentRuns, refetchInterval: 15_000 });
  const syncProgress = useQuery({ queryKey: ["sync-progress"], queryFn: api.syncProgress, refetchInterval: 2_000 });
  const integrations = useQuery({ queryKey: ["integrations"], queryFn: api.integrations });
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const webhookConfig = useQuery({ queryKey: ["webhook-config"], queryFn: api.webhookConfig });
  const alertWebhookConfig = useQuery({ queryKey: ["alert-webhook-config"], queryFn: api.alertWebhookConfig });
  const webhookQueue = useQuery({ queryKey: ["webhook-queue"], queryFn: api.webhookQueue, refetchInterval: 15_000 });
  const webhookJobs = useQuery({
    queryKey: ["webhook-jobs"],
    queryFn: () => api.webhookJobs(),
    refetchInterval: 15_000,
  });
  const reportingDashboards = useQuery({
    queryKey: ["reporting-dashboards"],
    queryFn: api.reportingDashboards,
  });
  const reportingDashboard = useQuery({
    queryKey: ["reporting-dashboard", reportingDashboardKey, reportingInstance, reportingLimit],
    queryFn: () =>
      api.reportingDashboard(reportingDashboardKey, {
        instance_name: reportingInstance,
        limit: reportingLimit,
      }),
    enabled: activeView === "reporting",
    refetchInterval: 30_000,
  });

  const shows = useQuery({
    queryKey: ["shows", debouncedSearch, libraryFilters.limit, libraryFilters.offset, libraryFilters.sortBy, libraryFilters.sortDir],
    queryFn: () =>
      api.shows({
        search: debouncedSearch,
        limit: libraryFilters.limit,
        offset: libraryFilters.offset,
        sort_by: libraryFilters.sortBy,
        sort_dir: libraryFilters.sortDir,
      }),
    enabled: activeView === "library" && libraryMode === "drilldown",
  });

  const showSeasons = useQuery({
    queryKey: ["show-seasons", selectedShow?.id, selectedShow?.instance],
    queryFn: () => api.showSeasons(selectedShow!.id, selectedShow!.instance),
    enabled: !!selectedShow && activeView === "library" && libraryMode === "drilldown",
  });

  const showEpisodes = useQuery({
    queryKey: [
      "show-episodes",
      selectedShow?.id,
      selectedShow?.instance,
      libraryFilters.showSeason,
      libraryFilters.limit,
      libraryFilters.offset,
      libraryFilters.sortBy,
      libraryFilters.sortDir,
    ],
    queryFn: () =>
      api.showEpisodes(selectedShow!.id, selectedShow!.instance, {
        season_number: libraryFilters.showSeason,
        limit: libraryFilters.limit,
        offset: libraryFilters.offset,
        sort_by: libraryFilters.sortBy,
        sort_dir: libraryFilters.sortDir,
      }),
    enabled: !!selectedShow && activeView === "library" && libraryMode === "drilldown",
  });

  const allEpisodes = useQuery({
    queryKey: [
      "all-episodes",
      debouncedSearch,
      debouncedInstance,
      libraryFilters.limit,
      libraryFilters.offset,
      libraryFilters.sortBy,
      libraryFilters.sortDir,
    ],
    queryFn: () =>
      api.allEpisodes({
        search: debouncedSearch,
        instance_name: debouncedInstance,
        limit: libraryFilters.limit,
        offset: libraryFilters.offset,
        sort_by: libraryFilters.sortBy,
        sort_dir: libraryFilters.sortDir,
      }),
    enabled: activeView === "library" && libraryMode === "all-episodes",
  });

  const movies = useQuery({
    queryKey: [
      "movies",
      debouncedSearch,
      debouncedInstance,
      libraryFilters.limit,
      libraryFilters.offset,
      libraryFilters.sortBy,
      libraryFilters.sortDir,
    ],
    queryFn: () =>
      api.movies({
        search: debouncedSearch,
        instance_name: debouncedInstance,
        limit: libraryFilters.limit,
        offset: libraryFilters.offset,
        sort_by: libraryFilters.sortBy,
        sort_dir: libraryFilters.sortDir,
      }),
    enabled: activeView === "library" && libraryMode === "movies",
  });

  const [integrationDrafts, setIntegrationDrafts] = useState<Record<string, { base_url: string; api_key: string; enabled: boolean; webhook_enabled: boolean }>>({});
  const [scheduleDrafts, setScheduleDrafts] = useState<Record<string, { cron: string; timezone: string; enabled: boolean }>>({});
  const isSetupRoute = location.pathname === "/setup";

  useEffect(() => {
    if (!integrations.data) return;
    const next: Record<string, { base_url: string; api_key: string; enabled: boolean; webhook_enabled: boolean }> = {};
    integrations.data.forEach((row) => {
      next[`${row.source}:${row.name}`] = {
        base_url: row.base_url ?? "",
        api_key: "",
        enabled: row.enabled,
        webhook_enabled: row.webhook_enabled,
      };
    });
    setIntegrationDrafts(next);
  }, [integrations.data]);

  useEffect(() => {
    if (!schedules.data) return;
    const next: Record<string, { cron: string; timezone: string; enabled: boolean }> = {};
    schedules.data.forEach((row) => {
      next[row.mode] = {
        cron: row.cron,
        timezone: row.timezone,
        enabled: row.enabled,
      };
    });
    setScheduleDrafts(next);
  }, [schedules.data]);

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
    if (!setupStatus.data.completed && !isSetupRoute) {
      navigate("/setup", { replace: true });
      return;
    }
    if (setupStatus.data.completed && isSetupRoute) {
      navigate("/", { replace: true });
    }
  }, [setupStatus.data, isSetupRoute, navigate]);

  useEffect(() => {
    if (!alertWebhookConfig.data) return;
    setAlertWebhookDraft((prev) => ({
      ...prev,
      timeoutSeconds: alertWebhookConfig.data.timeout_seconds,
      minState: alertWebhookConfig.data.min_state,
      notifyRecovery: alertWebhookConfig.data.notify_recovery,
    }));
  }, [alertWebhookConfig.data]);

  const setError = (err: unknown, context: string) => {
    const message = err instanceof Error ? err.message : String(err);
    setLastError(message);
    setErrorContext(context);
  };

  const runAction = async (fn: () => Promise<unknown>, context: string): Promise<void> => {
    try {
      await fn();
      setLastError(null);
      setErrorContext(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["status"] }),
        queryClient.invalidateQueries({ queryKey: ["sync-activity"] }),
        queryClient.invalidateQueries({ queryKey: ["runs"] }),
      ]);
    } catch (err) {
      setError(err, context);
    }
  };

  const saveIntegration = async (source: string, name: string): Promise<void> => {
    const key = `${source}:${name}`;
    const draft = integrationDrafts[key];
    if (!draft) return;
    await runAction(
      async () => {
        await api.saveIntegration(source, {
          name,
          base_url: draft.base_url,
          api_key: draft.api_key,
          enabled: draft.enabled,
          webhook_enabled: draft.webhook_enabled,
        });
        await queryClient.invalidateQueries({ queryKey: ["integrations"] });
      },
      `save integration ${source}/${name}`,
    );
  };

  const saveSchedule = async (mode: string): Promise<void> => {
    const draft = scheduleDrafts[mode];
    if (!draft) return;
    await runAction(
      async () => {
        await api.saveSchedule(mode, draft);
        await queryClient.invalidateQueries({ queryKey: ["schedules"] });
      },
      `save schedule ${mode}`,
    );
  };

  const saveWebhookSecret = async (): Promise<void> => {
    if (!webhookSecretInput.trim()) {
      setError("Webhook secret cannot be empty", "save webhook secret");
      return;
    }
    await runAction(
      async () => {
        await api.saveWebhookConfig(webhookSecretInput.trim());
        setWebhookSecretInput("");
        await queryClient.invalidateQueries({ queryKey: ["webhook-config"] });
      },
      "save webhook secret",
    );
  };

  const saveAlertWebhooks = async (): Promise<void> => {
    await runAction(
      async () => {
        const payload: {
          webhook_urls?: string;
          clear_urls?: boolean;
          timeout_seconds: number;
          min_state: "warning" | "critical";
          notify_recovery: boolean;
        } = {
          timeout_seconds: alertWebhookDraft.timeoutSeconds,
          min_state: alertWebhookDraft.minState,
          notify_recovery: alertWebhookDraft.notifyRecovery,
        };
        const normalizedUrls = alertWebhookDraft.webhookUrlsText.trim();
        if (alertWebhookDraft.clearUrls) {
          payload.clear_urls = true;
        } else if (normalizedUrls) {
          payload.webhook_urls = normalizedUrls;
        }
        await api.saveAlertWebhookConfig(payload);
        setAlertWebhookDraft((prev) => ({
          ...prev,
          webhookUrlsText: "",
          clearUrls: false,
        }));
        await queryClient.invalidateQueries({ queryKey: ["alert-webhook-config"] });
      },
      "save alert webhooks",
    );
  };

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
      navigate("/", { replace: true });
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
      navigate("/", { replace: true });
    } catch (err) {
      setError(err, "setup wizard skip");
    } finally {
      setWizardBusy(false);
    }
  };

  const renderSetupPage = (): JSX.Element => {
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
          <div className="muted">
            Do you want to run initial full sync now? If yes, Nebularr will process one system at a time to avoid overload.
          </div>
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
                <button type="button" className="secondary" disabled={wizardBusy} onClick={() => skipWizard()}>
                  Skip for now
                </button>
                <button type="button" disabled={wizardBusy} onClick={() => submitWizard()}>
                  {wizardBusy ? "Saving..." : "Complete setup"}
                </button>
              </>
            )}
          </div>
        </div>
      </main>
    );
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPalette((value) => !value);
      }
      if (event.key === "/" && activeView === "library" && document.activeElement !== searchInputRef.current) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if (event.key.toLowerCase() === "g" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setActiveView("library");
      }
      if (event.key === "Escape") {
        setCommandPalette(false);
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeView, setActiveView]);

  const currentTitle = useMemo(
    () => nav.find((entry) => entry.id === activeView)?.label ?? "Nebularr",
    [activeView],
  );

  const tokenizeFilter = (raw: string): string[] =>
    raw
      .toLowerCase()
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);

  const rowMatchesFilters = (row: Record<string, unknown>, terms: string[]): boolean => {
    if (terms.length === 0) return true;
    const haystack = Object.values(row)
      .map((value) => {
        if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
          return JSON.stringify(value);
        }
        return String(value ?? "");
      })
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };

  const stringifyCellValue = (value: unknown): string => {
    if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
      return JSON.stringify(value);
    }
    return String(value ?? "-");
  };

  const reportingDashboardFilter = reportingDashboardFilters[reportingDashboardKey] ?? "";
  const reportingSharedTerms = [...tokenizeFilter(reportingGlobalFilter), ...tokenizeFilter(reportingDashboardFilter)];
  const reportingPageSizeUnlimited = reportingTablePageSize <= 0;
  const reportingLimitUnlimited = reportingLimit <= 0;

  const rowMatchesColumnFilters = (
    row: Record<string, unknown>,
    panelStateKey: string,
    columns: string[],
  ): boolean => {
    return columns.every((column) => {
      const key = `${panelStateKey}:${column}`;
      const rawFilter = (reportingColumnFilters[key] ?? "").trim().toLowerCase();
      if (!rawFilter) return true;
      const cellText = stringifyCellValue(row[column]).toLowerCase();
      return cellText === rawFilter;
    });
  };

  useEffect(() => {
    setReportingTableOffsets({});
  }, [
    reportingDashboardKey,
    reportingInstance,
    reportingLimit,
    reportingTablePageSize,
    reportingGlobalFilter,
    reportingDashboardFilter,
    reportingPanelFilters,
    reportingColumnFilters,
  ]);

  const renderOverview = (): JSX.Element => (
    <div className="grid">
      <div className="card span-12 welcome-card">
        <div className="welcome-brand">
          <img className="welcome-banner" src="/assets/nebularr-logo.svg" alt="Nebularr banner" />
          <img className="welcome-icon" src="/assets/nebularr-icon.svg" alt="Nebularr icon" />
        </div>
        <h3>Welcome to Nebularr</h3>
        <p className="muted welcome-copy">
          Nebularr syncs Sonarr and Radarr metadata into PostgreSQL so you can monitor operational health, track media quality,
          and run analytics from one control plane.
        </p>
        <div className="row">
          <span className="pill">App Version: {healthz.data?.version ?? "loading..."}</span>
          <span className="pill">Git SHA: {healthz.data?.git_sha ?? "loading..."}</span>
        </div>
      </div>
      <div className="card span-3">
        <div className="kpi-label">Total Sync Runs</div>
        <div className="kpi-value">{status.data?.jobs_total ?? "-"}</div>
      </div>
      <div className="card span-3">
        <div className="kpi-label">Webhook Queue Open</div>
        <div className="kpi-value">{status.data?.webhook_queue_open ?? "-"}</div>
      </div>
      <div className="card span-3">
        <div className="kpi-label">Sonarr Lag (s)</div>
        <div className="kpi-value">{Math.round((status.data?.sync_lag_seconds.sonarr ?? 0) * 10) / 10}</div>
      </div>
      <div className="card span-3">
        <div className="kpi-label">Radarr Lag (s)</div>
        <div className="kpi-value">{Math.round((status.data?.sync_lag_seconds.radarr ?? 0) * 10) / 10}</div>
      </div>
      <div className="card span-12">
        <h3>Live Sync Activity</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th><th>Mode</th><th>Status</th><th>Trigger</th><th>Stage</th><th>Instance</th><th>Elapsed</th><th>Rows</th>
              </tr>
            </thead>
            <tbody>
              {(syncActivity.data ?? []).map((row) => (
                <tr key={row.run_id}>
                  <td>{row.source}</td>
                  <td>{row.mode}</td>
                  <td>{statusPill(row.status)}</td>
                  <td>{row.trigger}</td>
                  <td>{row.stage_note ? `${row.stage} (${row.stage_note})` : row.stage}</td>
                  <td>{row.instance_name}</td>
                  <td>{fmtDuration(row.elapsed_seconds)}</td>
                  <td>{row.records_processed}</td>
                </tr>
              ))}
              {syncActivity.isLoading ? <tr><td colSpan={8} className="muted">Loading activity...</td></tr> : null}
              {!syncActivity.isLoading && syncActivity.data?.length === 0 ? <tr><td colSpan={8} className="muted">No active syncs</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  const renderDistributionPanel = (panel: ReportingPanel): JSX.Element => {
    const rows = (panel.rows ?? []) as Array<Record<string, unknown>>;
    const panelStateKey = `${reportingDashboardKey}:${panel.id}`;
    const panelFilter = reportingPanelFilters[panelStateKey] ?? "";
    const terms = [...reportingSharedTerms, ...tokenizeFilter(panelFilter)];
    const filteredRows = rows.filter((row) => rowMatchesFilters(row, terms));
    const total = filteredRows.reduce((acc, row) => acc + Number(row.value ?? 0), 0);
    const max = filteredRows.reduce((acc, row) => Math.max(acc, Number(row.value ?? 0)), 0);
    return (
      <div className="card span-6" key={panel.id}>
        <div className="row">
          <h3>{panel.title}</h3>
          <input
            placeholder="Panel filter"
            value={panelFilter}
            onChange={(event) =>
              setReportingPanelFilters((prev) => ({
                ...prev,
                [panelStateKey]: event.target.value,
              }))
            }
          />
          <span className="muted">
            {filteredRows.length} of {rows.length}
          </span>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              window.location.href = api.reportingPanelExportUrl(reportingDashboardKey, panel.id, {
                instance_name: reportingInstance,
                limit: reportingLimit,
              });
            }}
          >
            CSV
          </button>
        </div>
        <div className="stack">
          {filteredRows.slice(0, 20).map((row, idx) => {
            const label = String(row.label ?? "unknown");
            const value = Number(row.value ?? 0);
            const pct = total > 0 ? (value / total) * 100 : 0;
            const widthPct = max > 0 ? (value / max) * 100 : 0;
            return (
              <div className="report-bar-row" key={`${panel.id}-${label}-${idx}`}>
                <div className="row">
                  <span>{label}</span>
                  <strong>
                    {value} ({pct.toFixed(1)}%)
                  </strong>
                </div>
                <div className="report-bar-track">
                  <div className="report-bar-fill" style={{ width: `${Math.max(2, widthPct)}%` }} />
                </div>
              </div>
            );
          })}
          {filteredRows.length === 0 ? <div className="muted">No data</div> : null}
        </div>
      </div>
    );
  };

  const renderTablePanel = (panel: ReportingPanel): JSX.Element => {
    const rows = (panel.rows ?? []) as Array<Record<string, unknown>>;
    const panelStateKey = `${reportingDashboardKey}:${panel.id}`;
    const panelFilter = reportingPanelFilters[panelStateKey] ?? "";
    const terms = [...reportingSharedTerms, ...tokenizeFilter(panelFilter)];
    const termFilteredRows = rows.filter((row) => rowMatchesFilters(row, terms));
    const columns = termFilteredRows.length > 0 ? Object.keys(termFilteredRows[0]) : rows.length > 0 ? Object.keys(rows[0]) : [];
    const columnOptions = Object.fromEntries(
      columns.map((column) => {
        const counts = new Map<string, number>();
        termFilteredRows.forEach((row) => {
          const value = stringifyCellValue(row[column]);
          counts.set(value, (counts.get(value) ?? 0) + 1);
        });
        const ranked = [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 250)
          .map(([value]) => value);
        return [column, ranked];
      }),
    ) as Record<string, string[]>;
    const filteredRows = termFilteredRows.filter((row) => rowMatchesColumnFilters(row, panelStateKey, columns));
    const total = filteredRows.length;
    const offset = Math.min(reportingTableOffsets[panelStateKey] ?? 0, Math.max(0, total - 1));
    const pageSize = reportingTablePageSize <= 0 ? total : reportingTablePageSize;
    const end = reportingTablePageSize <= 0 ? total : Math.min(offset + pageSize, total);
    const pagedRows = reportingTablePageSize <= 0 ? filteredRows : filteredRows.slice(offset, end);
    return (
      <div className="card span-12" key={panel.id}>
        <div className="row">
          <h3>{panel.title}</h3>
          <input
            placeholder="Panel filter"
            value={panelFilter}
            onChange={(event) =>
              setReportingPanelFilters((prev) => ({
                ...prev,
                [panelStateKey]: event.target.value,
              }))
            }
          />
          <label className="pill">
            Rows
            <select
              value={reportingTablePageSize}
              onChange={(event) => setReportingTablePageSize(Number(event.target.value))}
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={25}>25</option>
              <option value={40}>40</option>
              <option value={50}>50</option>
              <option value={75}>75</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
              <option value={0}>Unlimited</option>
            </select>
          </label>
          <span className="muted">
            {total === 0 ? "0 rows" : `${offset + 1}-${end} of ${total}`}
            {reportingPageSizeUnlimited ? " (unlimited)" : ""} (filtered from {rows.length})
          </span>
          <button
            type="button"
            className="secondary"
            disabled={offset <= 0 || reportingPageSizeUnlimited}
            onClick={() =>
              setReportingTableOffsets((prev) => ({
                ...prev,
                [panelStateKey]: Math.max(0, (prev[panelStateKey] ?? 0) - pageSize),
              }))
            }
          >
            Prev
          </button>
          <button
            type="button"
            className="secondary"
            disabled={reportingPageSizeUnlimited || offset + pageSize >= total}
            onClick={() =>
              setReportingTableOffsets((prev) => ({
                ...prev,
                [panelStateKey]: (prev[panelStateKey] ?? 0) + pageSize,
              }))
            }
          >
            Next
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              window.location.href = api.reportingPanelExportUrl(reportingDashboardKey, panel.id, {
                instance_name: reportingInstance,
                limit: reportingLimit,
              });
            }}
          >
            CSV
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={`${panel.id}-${column}`}>
                    <div className="report-th">
                      <span>{column}</span>
                      <select
                        className="report-th-filter"
                        value={reportingColumnFilters[`${panelStateKey}:${column}`] ?? ""}
                        onChange={(event) =>
                          setReportingColumnFilters((prev) => ({
                            ...prev,
                            [`${panelStateKey}:${column}`]: event.target.value,
                          }))
                        }
                      >
                        <option value="">All</option>
                        {(columnOptions[column] ?? []).map((option) => (
                          <option key={`${panelStateKey}:${column}:${option}`} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((row, idx) => (
                <tr key={`${panel.id}-${offset + idx}`}>
                  {columns.map((column) => {
                    const value = row[column];
                    const rendered = stringifyCellValue(value);
                    return <td key={`${panel.id}-${idx}-${column}`}>{rendered}</td>;
                  })}
                </tr>
              ))}
              {pagedRows.length === 0 ? (
                <tr>
                  <td colSpan={Math.max(columns.length, 1)} className="muted">
                    No rows for current filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderReporting = (): JSX.Element => (
    <div className="grid">
      <div className="card span-12 sticky-toolbar">
        <div className="row">
          {(reportingDashboards.data ?? []).map((dash) => (
            <button
              type="button"
              key={dash.key}
              className={reportingDashboardKey === dash.key ? "" : "secondary"}
              onClick={() => setReportingDashboardKey(dash.key)}
            >
              {dash.title}
            </button>
          ))}
        </div>
        <div className="row mt8">
          <input
            placeholder="Global filter (all reports)"
            value={reportingGlobalFilter}
            onChange={(event) => setReportingGlobalFilter(event.target.value)}
          />
          <input
            placeholder="Dashboard filter (current report)"
            value={reportingDashboardFilter}
            onChange={(event) =>
              setReportingDashboardFilters({
                ...reportingDashboardFilters,
                [reportingDashboardKey]: event.target.value,
              })
            }
          />
          <input
            placeholder="Instance filter (optional)"
            value={reportingInstance}
            onChange={(event) => setReportingInstance(event.target.value)}
          />
          <label className="pill">
            Dataset rows
            <button
              type="button"
              className="secondary"
              onClick={() => setReportingLimit(Math.max(100, (reportingLimitUnlimited ? 1000 : reportingLimit) - 100))}
            >
              -
            </button>
            <span>{reportingLimitUnlimited ? "Unlimited" : reportingLimit}</span>
            <button
              type="button"
              className="secondary"
              onClick={() => setReportingLimit(reportingLimitUnlimited ? 1000 : reportingLimit + 100)}
            >
              +
            </button>
            <button
              type="button"
              className={reportingLimitUnlimited ? "" : "secondary"}
              onClick={() => setReportingLimit(0)}
            >
              Unlimited
            </button>
          </label>
          <button type="button" className="secondary" onClick={() => reportingDashboard.refetch()}>
            Refresh report
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setReportingGlobalFilter("");
              setReportingDashboardFilters({
                ...reportingDashboardFilters,
                [reportingDashboardKey]: "",
              });
              setReportingPanelFilters((prev) =>
                Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${reportingDashboardKey}:`))),
              );
              setReportingColumnFilters((prev) =>
                Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${reportingDashboardKey}:`))),
              );
            }}
          >
            Clear filters
          </button>
        </div>
        <div className="muted mt8">{reportingDashboard.data?.description ?? "Select a dashboard to view reporting panels."}</div>
      </div>

      {(reportingDashboard.data?.panels ?? []).map((panel) => {
        if (panel.kind === "stat") {
          return (
            <div className="card span-3" key={panel.id}>
              <div className="kpi-label">{panel.title}</div>
              <div className="kpi-value">{typeof panel.value === "number" ? panel.value.toLocaleString() : (panel.value ?? "-")}</div>
            </div>
          );
        }
        if (panel.kind === "distribution") {
          return renderDistributionPanel(panel);
        }
        return renderTablePanel(panel);
      })}

      {reportingDashboard.isLoading ? (
        <div className="card span-12 muted">Loading reporting dashboard...</div>
      ) : null}
    </div>
  );

  const renderLibraryRows = (rows: EpisodeRow[]) => (
    rows.map((row) => (
      <tr key={row.episode_id} onClick={() => setDetailDrawer(row)}>
        <td>{row.series_title}</td>
        <td>{row.instance_name}</td>
        <td>{row.season_number}</td>
        <td>{row.episode_number}</td>
        <td>{row.episode_title}</td>
        <td>{fmtDate(row.air_date)}</td>
        <td>{fmtSize(row.size_bytes)}</td>
        <td>{row.video_codec ?? "-"}</td>
        <td>{row.audio_codec ?? "-"}</td>
        <td>{row.has_file ? "downloaded" : row.series_status ?? "-"}</td>
        {compareMode ? (
          <td>
            <button
              type="button"
              className="secondary"
              onClick={(event) => {
                event.stopPropagation();
                setCompareRows((existing) => {
                  const has = existing.find((item) => item.episode_id === row.episode_id);
                  if (has) return existing.filter((item) => item.episode_id !== row.episode_id);
                  if (existing.length >= 2) return [existing[1], row];
                  return [...existing, row];
                });
              }}
            >
              {compareRows.find((item) => item.episode_id === row.episode_id) ? "Remove" : "Compare"}
            </button>
          </td>
        ) : null}
      </tr>
    ))
  );

  const renderLibrary = (): JSX.Element => {
    return (
      <div className="grid">
        <div className="card span-12 sticky-toolbar">
          <div className="row">
            <button type="button" className={libraryMode === "drilldown" ? "" : "secondary"} onClick={() => setLibraryMode("drilldown")}>
              Drilldown
            </button>
            <button type="button" className={libraryMode === "all-episodes" ? "" : "secondary"} onClick={() => setLibraryMode("all-episodes")}>
              All Episodes
            </button>
            <button type="button" className={libraryMode === "movies" ? "" : "secondary"} onClick={() => setLibraryMode("movies")}>
              Movies
            </button>
            <label className="pill">
              <input type="checkbox" checked={compareMode} onChange={(e) => setCompareMode(e.target.checked)} /> compare mode
            </label>
            <label className="pill">
              Column profile
              <select
                value={libraryFilters.sortBy}
                onChange={(event) => setLibraryFilters({ ...libraryFilters, sortBy: event.target.value, offset: 0 })}
              >
                <option value="title">Operations</option>
                <option value="size_bytes">Media Forensics</option>
                <option value="air_date">Language Audit</option>
              </select>
            </label>
          </div>
          <div className="row mt8">
            <input
              ref={searchInputRef}
              placeholder="Search..."
              value={libraryFilters.search}
              onChange={(event) => setLibraryFilters({ ...libraryFilters, search: event.target.value, offset: 0 })}
            />
            <input
              placeholder="Instance"
              value={libraryFilters.instance}
              onChange={(event) => setLibraryFilters({ ...libraryFilters, instance: event.target.value, offset: 0 })}
            />
            <select value={libraryFilters.sortDir} onChange={(event) => setLibraryFilters({ ...libraryFilters, sortDir: event.target.value as "asc" | "desc" })}>
              <option value="asc">ASC</option>
              <option value="desc">DESC</option>
            </select>
            <select value={libraryFilters.limit} onChange={(event) => setLibraryFilters({ ...libraryFilters, limit: Number(event.target.value), offset: 0 })}>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
            <button
              type="button"
              onClick={() => {
                const url = api.exportUrl(
                  libraryMode === "movies"
                    ? "/api/ui/movies/export.csv"
                    : libraryMode === "all-episodes"
                      ? "/api/ui/episodes/export.csv"
                      : `/api/ui/shows/${selectedShow?.id ?? 0}/episodes/export.csv`,
                  {
                    search: libraryFilters.search,
                    instance_name: libraryMode === "drilldown" ? selectedShow?.instance : libraryFilters.instance,
                    season_number: libraryFilters.showSeason ?? undefined,
                    sort_by: libraryFilters.sortBy,
                    sort_dir: libraryFilters.sortDir,
                  },
                );
                window.location.href = url;
              }}
            >
              Export CSV (all)
            </button>
          </div>
        </div>

        {libraryMode === "drilldown" ? (
          <>
            <div className="card span-4">
              <h3>Shows</h3>
              <div className="table-wrap compact">
                <table>
                  <thead>
                    <tr><th>Title</th><th>Instance</th><th>Episodes</th><th>Action</th></tr>
                  </thead>
                  <tbody>
                    {shows.isLoading ? <tr><td colSpan={4} className="muted">Loading shows...</td></tr> : null}
                    {(shows.data?.items ?? []).map((row: ShowRow) => (
                      <tr key={`${row.instance_name}-${row.series_id}`}>
                        <td>{row.title}</td>
                        <td>{row.instance_name}</td>
                        <td>{row.episode_count}</td>
                        <td>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => {
                              setSelectedShow({ id: row.series_id, instance: row.instance_name, title: row.title });
                              setLibraryFilters({ ...libraryFilters, offset: 0 });
                            }}
                          >
                            Select
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!shows.isLoading && (shows.data?.items.length ?? 0) === 0 ? <tr><td colSpan={4} className="muted">No shows match current filters.</td></tr> : null}
                  </tbody>
                </table>
              </div>
              <Pagination
                total={shows.data?.total ?? 0}
                offset={libraryFilters.offset}
                limit={libraryFilters.limit}
                onChange={(nextOffset) => setLibraryFilters({ ...libraryFilters, offset: nextOffset })}
              />
            </div>
            <div className="card span-8">
              <h3>Episodes {selectedShow ? `- ${selectedShow.title}` : ""}</h3>
              <div className="row">
                <select
                  value={libraryFilters.showSeason ?? "all"}
                  onChange={(event) =>
                    setLibraryFilters({
                      ...libraryFilters,
                      showSeason: event.target.value === "all" ? null : Number(event.target.value),
                      offset: 0,
                    })
                  }
                >
                  <option value="all">All seasons</option>
                  {(showSeasons.data ?? []).map((entry) => (
                    <option key={entry.season_number} value={entry.season_number}>
                      season {entry.season_number}
                    </option>
                  ))}
                </select>
              </div>
              <div className="table-wrap compact">
                <table>
                  <thead>
                    <tr>
                      <th>Series</th><th>Instance</th><th>Season</th><th>Episode</th><th>Title</th><th>Air Date</th><th>Size</th><th>Video</th><th>Audio</th><th>Status</th>
                      {compareMode ? <th>Compare</th> : null}
                    </tr>
                  </thead>
                  <tbody>{renderLibraryRows(showEpisodes.data?.items ?? [])}</tbody>
                </table>
              </div>
              {showEpisodes.isLoading ? <div className="muted mt8">Loading selected show episodes...</div> : null}
              <Pagination
                total={showEpisodes.data?.total ?? 0}
                offset={libraryFilters.offset}
                limit={libraryFilters.limit}
                onChange={(nextOffset) => setLibraryFilters({ ...libraryFilters, offset: nextOffset })}
              />
            </div>
          </>
        ) : null}

        {libraryMode === "all-episodes" ? (
          <div className="card span-12">
            <h3>All Episodes</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Series</th><th>Instance</th><th>Season</th><th>Episode</th><th>Title</th><th>Air Date</th><th>Size</th><th>Video</th><th>Audio</th><th>Status</th>
                    {compareMode ? <th>Compare</th> : null}
                  </tr>
                </thead>
                <tbody>{renderLibraryRows(allEpisodes.data?.items ?? [])}</tbody>
              </table>
            </div>
            {allEpisodes.isLoading ? <div className="muted mt8">Loading episodes...</div> : null}
            <Pagination
              total={allEpisodes.data?.total ?? 0}
              offset={libraryFilters.offset}
              limit={libraryFilters.limit}
              onChange={(nextOffset) => setLibraryFilters({ ...libraryFilters, offset: nextOffset })}
            />
          </div>
        ) : null}

        {libraryMode === "movies" ? (
          <div className="card span-12">
            <h3>Movies</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Title</th><th>Year</th><th>Instance</th><th>Status</th><th>Size</th><th>Video</th><th>Audio</th><th>Last Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {movies.isLoading ? <tr><td colSpan={8} className="muted">Loading movies...</td></tr> : null}
                  {(movies.data?.items ?? []).map((row: MovieRow) => (
                    <tr key={`${row.instance_name}-${row.movie_id}`} onClick={() => setDetailDrawer(row)}>
                      <td>{row.title}</td>
                      <td>{row.year ?? "-"}</td>
                      <td>{row.instance_name}</td>
                      <td>{row.status}</td>
                      <td>{fmtSize(row.size_bytes)}</td>
                      <td>{row.video_codec ?? "-"}</td>
                      <td>{row.audio_codec ?? "-"}</td>
                      <td>{fmtDate(row.last_seen_at)}</td>
                    </tr>
                  ))}
                  {!movies.isLoading && (movies.data?.items.length ?? 0) === 0 ? <tr><td colSpan={8} className="muted">No movies match current filters.</td></tr> : null}
                </tbody>
              </table>
            </div>
            <Pagination
              total={movies.data?.total ?? 0}
              offset={libraryFilters.offset}
              limit={libraryFilters.limit}
              onChange={(nextOffset) => setLibraryFilters({ ...libraryFilters, offset: nextOffset })}
            />
          </div>
        ) : null}
      </div>
    );
  };

  const compareSummary =
    compareMode && compareRows.length === 2 ? (
      <div className="card compare-card">
        <h3>Compare Mode</h3>
        <div className="compare-grid">
          <div>
            <strong>A:</strong> {compareRows[0].series_title} S{compareRows[0].season_number}E{compareRows[0].episode_number}
            <div className="muted">{compareRows[0].video_codec} / {compareRows[0].audio_codec} / {fmtSize(compareRows[0].size_bytes)}</div>
          </div>
          <div>
            <strong>B:</strong> {compareRows[1].series_title} S{compareRows[1].season_number}E{compareRows[1].episode_number}
            <div className="muted">{compareRows[1].video_codec} / {compareRows[1].audio_codec} / {fmtSize(compareRows[1].size_bytes)}</div>
          </div>
        </div>
      </div>
    ) : null;

  if (isSetupRoute) {
    return renderSetupPage();
  }

  return (
    <div className={`app-shell density-${density}`}>
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand-wrap">
          <img className="brand-mark" src="/assets/nebularr-icon.svg" alt="Nebularr icon" />
          <div>
            <h2 className="brand">Nebularr</h2>
            <div className="muted">Control Plane</div>
          </div>
        </div>
        {nav.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`nav-btn ${activeView === entry.id ? "active" : ""}`}
            onClick={() => {
              setActiveView(entry.id);
              setSidebarOpen(false);
            }}
          >
            {entry.label}
          </button>
        ))}
        <div className="muted mt16">Cmd/Ctrl+K for command palette</div>
      </aside>
      <main className="main">
        <div className="topbar">
          <div>
            <div className="row">
              <button type="button" className="secondary mobile-only" onClick={() => setSidebarOpen((v) => !v)}>
                Menu
              </button>
              <h1 className="view-title">{currentTitle}</h1>
            </div>
            <div className="row">
              <span className={`pill health-${status.data?.health_state ?? "ok"}`}>health: {status.data?.health_state ?? "-"}</span>
              <span className="pill">sync: {status.data?.active_sync_count ?? "-"}</span>
              <span className="pill">queue: {status.data?.webhook_queue_open ?? "-"}</span>
            </div>
            <div className="subtitle">
              Health: {status.data?.health_state ?? "-"} / Active syncs: {status.data?.active_sync_count ?? "-"}
            </div>
          </div>
          <div className="row">
            <button type="button" className="secondary" onClick={() => setCommandPalette(true)}>
              Command Palette
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setDensity(density === "comfortable" ? "compact" : "comfortable")}
            >
              Density: {density}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => queryClient.invalidateQueries()}
            >
              Refresh
            </button>
          </div>
        </div>

        <DiagnosticsPanel message={lastError} context={errorContext} clear={() => setLastError(null)} />
        {compareSummary}

        {activeView === "overview" ? renderOverview() : null}
        {activeView === "reporting" ? renderReporting() : null}
        {activeView === "library" ? renderLibrary() : null}

        {activeView === "runs" ? (
          <div className="card">
            <h3>Run History</h3>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Source</th><th>Mode</th><th>Status</th><th>Started</th><th>Finished</th><th>Rows</th><th>Error</th></tr></thead>
                <tbody>
                  {(runs.data ?? []).map((run, idx) => (
                    <tr key={`${run.source}-${run.started_at}-${idx}`}>
                      <td>{run.source}</td>
                      <td>{run.mode}</td>
                      <td>{statusPill(run.status)}</td>
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
        ) : null}

        {activeView === "actions" ? (
          <div className="grid">
            <div className="card span-6">
              <h3>Run Sync</h3>
              <div className="row">
                <button type="button" onClick={() => runAction(() => api.runSync("sonarr", "incremental"), "runSync sonarr/incremental")}>Sonarr Incremental</button>
                <button type="button" onClick={() => runAction(() => api.runSync("radarr", "incremental"), "runSync radarr/incremental")}>Radarr Incremental</button>
              </div>
              <div className="muted mt8">
                {syncProgress.data?.running
                  ? `${syncProgress.data.source}/${syncProgress.data.mode} - ${syncProgress.data.stage} (${fmtDuration(syncProgress.data.elapsed_seconds)})`
                  : "No manual sync running"}
              </div>
            </div>
            <div className="card span-6">
              <h3>System Actions</h3>
              <div className="row">
                <button type="button" className="secondary" onClick={() => runAction(() => api.replayDeadLetter("sonarr"), "replay sonarr dead-letter")}>
                  Replay Sonarr Dead Letter
                </button>
                <button type="button" className="secondary" onClick={() => runAction(() => api.replayDeadLetter("radarr"), "replay radarr dead-letter")}>
                  Replay Radarr Dead Letter
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
                  Reset Data
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {activeView === "integrations" ? (
          <div className="card">
            <h3>Integrations</h3>
            <div className="stack">
              {(integrations.data ?? []).map((row) => (
                <div className="inner-card" key={`${row.source}-${row.name}`}>
                  <div className="row">
                    <strong>{row.source}/{row.name}</strong>
                    <span className="muted">Updated {fmtDate(row.updated_at)}</span>
                    <span className="pill">{row.api_key_set ? "API key set" : "API key missing"}</span>
                    <span className="pill">{row.enabled ? "enabled" : "disabled"}</span>
                  </div>
                  <div className="row mt8">
                    <input
                      value={integrationDrafts[`${row.source}:${row.name}`]?.base_url ?? row.base_url}
                      onChange={(event) =>
                        setIntegrationDrafts((prev) => ({
                          ...prev,
                          [`${row.source}:${row.name}`]: {
                            ...(prev[`${row.source}:${row.name}`] ?? {
                              base_url: row.base_url,
                              api_key: "",
                              enabled: row.enabled,
                              webhook_enabled: row.webhook_enabled,
                            }),
                            base_url: event.target.value,
                          },
                        }))
                      }
                    />
                    <input
                      placeholder="New API key (optional)"
                      value={integrationDrafts[`${row.source}:${row.name}`]?.api_key ?? ""}
                      onChange={(event) =>
                        setIntegrationDrafts((prev) => ({
                          ...prev,
                          [`${row.source}:${row.name}`]: {
                            ...(prev[`${row.source}:${row.name}`] ?? {
                              base_url: row.base_url,
                              api_key: "",
                              enabled: row.enabled,
                              webhook_enabled: row.webhook_enabled,
                            }),
                            api_key: event.target.value,
                          },
                        }))
                      }
                    />
                  </div>
                  <div className="row mt8">
                    <label className="pill">
                      <input
                        type="checkbox"
                        checked={integrationDrafts[`${row.source}:${row.name}`]?.enabled ?? row.enabled}
                        onChange={(event) =>
                          setIntegrationDrafts((prev) => ({
                            ...prev,
                            [`${row.source}:${row.name}`]: {
                              ...(prev[`${row.source}:${row.name}`] ?? {
                                base_url: row.base_url,
                                api_key: "",
                                enabled: row.enabled,
                                webhook_enabled: row.webhook_enabled,
                              }),
                              enabled: event.target.checked,
                            },
                          }))
                        }
                      />
                      enabled
                    </label>
                    <label className="pill">
                      <input
                        type="checkbox"
                        checked={integrationDrafts[`${row.source}:${row.name}`]?.webhook_enabled ?? row.webhook_enabled}
                        onChange={(event) =>
                          setIntegrationDrafts((prev) => ({
                            ...prev,
                            [`${row.source}:${row.name}`]: {
                              ...(prev[`${row.source}:${row.name}`] ?? {
                                base_url: row.base_url,
                                api_key: "",
                                enabled: row.enabled,
                                webhook_enabled: row.webhook_enabled,
                              }),
                              webhook_enabled: event.target.checked,
                            },
                          }))
                        }
                      />
                      webhook enabled
                    </label>
                    <button type="button" className="secondary" onClick={() => saveIntegration(row.source, row.name)}>
                      Save
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="inner-card mt8">
              <h3>Webhook Shared Secret</h3>
              <div className="row">
                <span className="pill">{webhookConfig.data?.secret_set ? "secret set" : "secret missing"}</span>
                <input
                  placeholder="Set new webhook shared secret"
                  value={webhookSecretInput}
                  onChange={(event) => setWebhookSecretInput(event.target.value)}
                />
                <button type="button" className="secondary" onClick={() => saveWebhookSecret()}>
                  Save Secret
                </button>
              </div>
            </div>
            <div className="inner-card mt8">
              <h3>Alert Webhooks</h3>
              <div className="row">
                <span className="pill">
                  {alertWebhookConfig.data?.urls_configured
                    ? `${alertWebhookConfig.data.url_count} webhook URL${alertWebhookConfig.data.url_count === 1 ? "" : "s"} configured`
                    : "no webhook URLs configured"}
                </span>
                <span className="muted">
                  Stored in DB; URLs are encrypted when `APP_ENCRYPTION_KEY` is configured.
                </span>
              </div>
              <div className="stack mt8">
                <textarea
                  rows={4}
                  placeholder="Paste webhook URLs (one per line or comma-separated). Leave blank to keep existing URLs."
                  value={alertWebhookDraft.webhookUrlsText}
                  onChange={(event) =>
                    setAlertWebhookDraft((prev) => ({
                      ...prev,
                      webhookUrlsText: event.target.value,
                    }))
                  }
                />
                <div className="row">
                  <label className="pill">
                    <input
                      type="checkbox"
                      checked={alertWebhookDraft.clearUrls}
                      onChange={(event) =>
                        setAlertWebhookDraft((prev) => ({
                          ...prev,
                          clearUrls: event.target.checked,
                        }))
                      }
                    />
                    clear stored webhook URLs
                  </label>
                  <label className="pill">
                    minimum state
                    <select
                      value={alertWebhookDraft.minState}
                      onChange={(event) =>
                        setAlertWebhookDraft((prev) => ({
                          ...prev,
                          minState: event.target.value as "warning" | "critical",
                        }))
                      }
                    >
                      <option value="warning">warning</option>
                      <option value="critical">critical</option>
                    </select>
                  </label>
                  <label className="pill">
                    timeout (seconds)
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={alertWebhookDraft.timeoutSeconds}
                      onChange={(event) =>
                        setAlertWebhookDraft((prev) => ({
                          ...prev,
                          timeoutSeconds: Number(event.target.value || 0),
                        }))
                      }
                    />
                  </label>
                  <label className="pill">
                    <input
                      type="checkbox"
                      checked={alertWebhookDraft.notifyRecovery}
                      onChange={(event) =>
                        setAlertWebhookDraft((prev) => ({
                          ...prev,
                          notifyRecovery: event.target.checked,
                        }))
                      }
                    />
                    notify on recovery to ok
                  </label>
                  <button type="button" className="secondary" onClick={() => saveAlertWebhooks()}>
                    Save Alert Webhooks
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {activeView === "schedules" ? (
          <div className="card">
            <h3>Schedules</h3>
            <div className="stack">
              {(schedules.data ?? []).map((row) => (
                <div className="inner-card" key={row.mode}>
                  <div className="row">
                    <strong>{row.mode}</strong>
                    <span className="muted">Updated {fmtDate(row.updated_at)}</span>
                  </div>
                  <div className="row mt8">
                    <input
                      value={scheduleDrafts[row.mode]?.cron ?? row.cron}
                      onChange={(event) =>
                        setScheduleDrafts((prev) => ({
                          ...prev,
                          [row.mode]: {
                            ...(prev[row.mode] ?? { cron: row.cron, timezone: row.timezone, enabled: row.enabled }),
                            cron: event.target.value,
                          },
                        }))
                      }
                    />
                    <input
                      value={scheduleDrafts[row.mode]?.timezone ?? row.timezone}
                      onChange={(event) =>
                        setScheduleDrafts((prev) => ({
                          ...prev,
                          [row.mode]: {
                            ...(prev[row.mode] ?? { cron: row.cron, timezone: row.timezone, enabled: row.enabled }),
                            timezone: event.target.value,
                          },
                        }))
                      }
                    />
                  </div>
                  <div className="row mt8">
                    <label className="pill">
                      <input
                        type="checkbox"
                        checked={scheduleDrafts[row.mode]?.enabled ?? row.enabled}
                        onChange={(event) =>
                          setScheduleDrafts((prev) => ({
                            ...prev,
                            [row.mode]: {
                              ...(prev[row.mode] ?? { cron: row.cron, timezone: row.timezone, enabled: row.enabled }),
                              enabled: event.target.checked,
                            },
                          }))
                        }
                      />
                      enabled
                    </label>
                    <button type="button" className="secondary" onClick={() => saveSchedule(row.mode)}>
                      Save
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {activeView === "webhooks" ? (
          <div className="grid">
            <div className="card span-4">
              <h3>Queue Summary</h3>
              <div className="stack">
                {(webhookQueue.data ?? []).map((row) => (
                  <div className="row" key={row.status}>
                    <span>{row.status}</span><strong>{row.count}</strong>
                  </div>
                ))}
              </div>
            </div>
            <div className="card span-8">
              <h3>Webhook Jobs</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>ID</th><th>Source</th><th>Type</th><th>Status</th><th>Attempts</th><th>Received</th><th>Error</th></tr></thead>
                  <tbody>
                    {(webhookJobs.data ?? []).map((row) => (
                      <tr key={row.id}>
                        <td>{row.id}</td>
                        <td>{row.source}</td>
                        <td>{row.event_type ?? "-"}</td>
                        <td>{statusPill(row.status)}</td>
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
        ) : null}
      </main>

      {commandPalette ? (
        <div className="modal-backdrop" onClick={() => setCommandPalette(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <h3>Command Palette</h3>
            <button type="button" onClick={() => { setActiveView("library"); setCommandPalette(false); }}>Go to Library</button>
            <button type="button" onClick={() => { setActiveView("overview"); setCommandPalette(false); }}>Go to Overview</button>
            <button type="button" onClick={() => { setActiveView("reporting"); setCommandPalette(false); }}>Go to Reporting</button>
            <button type="button" onClick={() => runAction(() => api.runSync("sonarr", "incremental"), "palette sync sonarr")}>Run Sonarr incremental</button>
            <button type="button" onClick={() => runAction(() => api.runSync("radarr", "incremental"), "palette sync radarr")}>Run Radarr incremental</button>
          </div>
        </div>
      ) : null}

      {detailDrawer ? (
        <aside className="detail-drawer">
          <div className="row">
            <strong>Detail Drawer</strong>
            <button type="button" className="secondary" onClick={() => setDetailDrawer(null)}>Close</button>
          </div>
          <pre>{JSON.stringify(detailDrawer, null, 2)}</pre>
        </aside>
      ) : null}
    </div>
  );
}
