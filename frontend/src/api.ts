import type {
  AlertWebhookConfig,
  AuthConfigResponse,
  AuthStatusResponse,
  EpisodeRow,
  HealthzResponse,
  IntegrationRow,
  LoggingConfigResponse,
  MalConfigResponse,
  UiLogsResponse,
  MovieRow,
  PagedResponse,
  RunRow,
  ScheduleRow,
  ShowRow,
  ReportingDashboard,
  ReportingDashboardMeta,
  StatusResponse,
  SyncActivityRow,
  SyncProgress,
  SetupStatus,
  WebhookJobRow,
  WebhookQueueRow,
  WorkStatusResponse,
  StuckStateResponse,
  ClearStuckResponse,
} from "./types";

type HttpMethod = "GET" | "POST" | "PUT";

const AUTH_EXEMPT_PATHS = new Set(["/api/auth/login", "/api/auth/status"]);

function redirectToLogin(): void {
  if (window.location.pathname !== "/login") {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/login?next=${next}`);
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const ERROR_MESSAGE_MAX_CHARS = 300;

async function errorMessageFrom(response: Response): Promise<string> {
  // Prefer the API's {"detail": ...} shape; never surface a raw HTML error page.
  try {
    const text = await response.text();
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "detail" in parsed) {
        const detail = (parsed as { detail: unknown }).detail;
        const message = typeof detail === "string" ? detail : JSON.stringify(detail);
        if (message) return message.slice(0, ERROR_MESSAGE_MAX_CHARS);
      }
    } catch {
      if (text && !text.trimStart().startsWith("<")) {
        return text.slice(0, ERROR_MESSAGE_MAX_CHARS);
      }
    }
  } catch {
    // fall through to the status line
  }
  return `HTTP ${response.status} ${response.statusText}`.trim();
}

async function requestJson<T>(path: string, method: HttpMethod = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${method} ${path.split("?")[0]}`);
    }
    throw error;
  }
  if (!response.ok) {
    const apiPath = path.split("?")[0];
    if (response.status === 401 && !AUTH_EXEMPT_PATHS.has(apiPath)) {
      redirectToLogin();
    }
    throw new Error(await errorMessageFrom(response));
  }
  return (await response.json()) as T;
}

function withParams(path: string, params: Record<string, string | number | boolean | undefined | null>): string {
  const url = new URL(path, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return `${url.pathname}?${url.searchParams.toString()}`;
}

export const api = {
  healthz: () => requestJson<HealthzResponse>("/healthz"),
  status: () => requestJson<StatusResponse>("/api/status"),
  authStatus: () => requestJson<AuthStatusResponse>("/api/auth/status"),
  authLogin: (password: string) => requestJson<{ status: string }>("/api/auth/login", "POST", { password }),
  authLogout: () => requestJson<{ status: string }>("/api/auth/logout", "POST"),
  saveAuthConfig: (payload: {
    password?: string;
    enabled?: boolean;
    rotate_api_token?: boolean;
    revoke_api_token?: boolean;
  }) => requestJson<AuthConfigResponse>("/api/auth/config", "PUT", payload),
  setupStatus: () => requestJson<SetupStatus>("/api/setup/status"),
  setupSkip: () => requestJson<{ status: string; completed: boolean }>("/api/setup/skip", "POST"),
  setupInitializePostgres: (payload: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    arrapp_password?: string;
  }) => requestJson<{ status: string; restart_recommended: boolean }>("/api/setup/initialize-postgres", "POST", payload),
  setupBootstrapDatabase: (payload: {
    admin_database_url: string;
    database_name: string;
    arrapp_password: string;
  }) => requestJson<{ status: string; restart_required: boolean }>("/api/setup/bootstrap-database", "POST", payload),
  setupPersistRuntimeDatabaseUrl: () =>
    requestJson<{ status: string; restart_required: boolean }>("/api/setup/persist-runtime-database-url", "POST"),
  setupWizard: (payload: unknown) => requestJson<{ status: string; completed: boolean }>("/api/setup/wizard", "POST", payload),
  setupInitialSync: (sources: string[]) =>
    requestJson<{ status: string; running: boolean; sources: string[] }>("/api/setup/initial-sync", "POST", { sources }),
  setupInitialSyncStatus: () =>
    requestJson<{ running: boolean; sources: string[] }>("/api/setup/initial-sync-status"),
  syncActivity: () => requestJson<SyncActivityRow[]>("/api/ui/sync-activity"),
  syncProgress: () => requestJson<SyncProgress>("/api/ui/sync-progress"),
  workStatus: () => requestJson<WorkStatusResponse>("/api/ui/work-status"),
  recentRuns: () => requestJson<RunRow[]>("/api/ui/recent-runs"),
  webhookQueue: () => requestJson<WebhookQueueRow[]>("/api/ui/webhook-queue"),
  webhookJobs: (status = "all", limit = 150) =>
    requestJson<WebhookJobRow[]>(withParams("/api/ui/webhook-jobs", { status, limit })),
  integrations: () => requestJson<IntegrationRow[]>("/api/config/integrations"),
  schedules: () => requestJson<ScheduleRow[]>("/api/config/schedules"),
  saveIntegration: (source: string, payload: unknown) =>
    requestJson<{ status: string }>(`/api/config/integrations/${source}`, "PUT", payload),
  malConfig: () => requestJson<MalConfigResponse>("/api/config/mal"),
  saveMalConfig: (payload: {
    client_id?: string;
    clear_client_id?: boolean;
    ingest_enabled?: boolean;
    matcher_enabled?: boolean;
    tagging_enabled?: boolean;
    allow_title_year_match?: boolean;
  }) =>
    requestJson<{ status: string }>("/api/config/mal", "PUT", payload),
  loggingConfig: () => requestJson<LoggingConfigResponse>("/api/config/logging"),
  saveLoggingConfig: (payload: { level?: string; use_environment_default?: boolean }) =>
    requestJson<{ status: string; effective_level: string }>("/api/config/logging", "PUT", payload),
  uiLogs: (limit = 500) => requestJson<UiLogsResponse>(withParams("/api/ui/logs", { limit })),
  triggerMalIngest: (payload?: { max_ids_per_run?: number }) =>
    requestJson<{ status: string; details: unknown }>("/api/mal/ingest", "POST", payload ?? {}),
  triggerMalIngestBacklog: (payload?: {
    max_cycles?: number;
    cycle_delay_seconds?: number;
    import_all?: boolean;
    max_ids_per_run?: number;
  }) => requestJson<{ status: string; details: unknown }>("/api/mal/ingest-backlog", "POST", payload ?? {}),
  triggerMalMatchRefresh: () => requestJson<{ status: string; details: unknown }>("/api/mal/match-refresh", "POST"),
  triggerMalTagSync: () => requestJson<{ status: string; details: unknown }>("/api/mal/tag-sync", "POST"),
  resetMalData: () =>
    requestJson<{ status: string; message?: string }>("/api/mal/reset-data", "POST", {
      confirmation: "RESET_MAL",
    }),
  stuckState: () => requestJson<StuckStateResponse>("/api/operator/stuck-state"),
  clearStuck: (payload: {
    clear_all_job_locks?: boolean;
    clear_mal_ingest_lock?: boolean;
    fail_stuck_mal_job_runs?: boolean;
    clear_warehouse_sync_locks?: boolean;
    fail_stuck_warehouse_sync_runs?: boolean;
  }) =>
    requestJson<ClearStuckResponse>("/api/operator/clear-stuck", "POST", {
      confirmation: "CLEAR_STUCK",
      ...payload,
    }),
  saveSchedule: (mode: string, payload: unknown) =>
    requestJson<{ status: string }>(`/api/config/schedules/${mode}`, "PUT", payload),
  webhookConfig: () => requestJson<{ secret_set: boolean }>("/api/config/webhook"),
  saveWebhookConfig: (secret: string) =>
    requestJson<{ status: string }>("/api/config/webhook", "PUT", { secret }),
  alertWebhookConfig: () => requestJson<AlertWebhookConfig>("/api/config/alert-webhooks"),
  saveAlertWebhookConfig: (payload: {
    webhook_urls?: string | string[];
    clear_urls?: boolean;
    timeout_seconds: number;
    min_state: "warning" | "critical";
    notify_recovery: boolean;
  }) => requestJson<{ status: string; url_count: number }>("/api/config/alert-webhooks", "PUT", payload),
  runSync: (source: string, mode: string) =>
    requestJson<{ status: string }>(`/api/sync/${source}/${mode}`, "POST"),
  replayDeadLetter: (source: string) =>
    requestJson<{ status: string }>(`/api/webhooks/replay-dead-letter/${source}`, "POST"),
  requeueWebhook: (jobId: number) => requestJson<{ status: string }>(`/api/webhooks/requeue/${jobId}`, "POST"),
  resetData: () => requestJson<{ status: string }>("/api/admin/reset-data", "POST", { confirmation: "RESET" }),
  shows: (params: {
    search: string;
    limit: number;
    offset: number;
    sort_by: string;
    sort_dir: string;
  }) => requestJson<PagedResponse<ShowRow>>(withParams("/api/ui/shows", { ...params, paged: true })),
  showSeasons: (seriesId: number, instanceName: string) =>
    requestJson<{ season_number: number }[]>(
      withParams(`/api/ui/shows/${seriesId}/seasons`, { instance_name: instanceName }),
    ),
  showEpisodes: (
    seriesId: number,
    instanceName: string,
    params: {
      season_number?: number | null;
      limit: number;
      offset: number;
      sort_by: string;
      sort_dir: string;
    },
  ) =>
    requestJson<PagedResponse<EpisodeRow>>(
      withParams(`/api/ui/shows/${seriesId}/episodes`, {
        instance_name: instanceName,
        season_number: params.season_number,
        limit: params.limit,
        offset: params.offset,
        sort_by: params.sort_by,
        sort_dir: params.sort_dir,
        paged: true,
      }),
    ),
  allEpisodes: (params: {
    search: string;
    instance_name: string;
    limit: number;
    offset: number;
    sort_by: string;
    sort_dir: string;
  }) => requestJson<PagedResponse<EpisodeRow>>(withParams("/api/ui/episodes", { ...params, paged: true })),
  movies: (params: {
    search: string;
    instance_name: string;
    limit: number;
    offset: number;
    sort_by: string;
    sort_dir: string;
  }) => requestJson<PagedResponse<MovieRow>>(withParams("/api/ui/movies", { ...params, paged: true })),
  exportUrl: (path: string, params: Record<string, string | number | boolean | undefined>) =>
    withParams(path, { ...params, export_all: true }),
  reportingDashboards: () => requestJson<ReportingDashboardMeta[]>("/api/reporting/dashboards"),
  reportingDashboard: (dashboardKey: string, params: { instance_name?: string; limit?: number }) =>
    requestJson<ReportingDashboard>(
      withParams(`/api/reporting/dashboards/${dashboardKey}`, {
        instance_name: params.instance_name ?? "",
        limit: params.limit ?? 200,
      }),
    ),
  reportingPanelExportUrl: (dashboardKey: string, panelId: string, params: { instance_name?: string; limit?: number }) =>
    withParams(`/api/reporting/dashboards/${dashboardKey}/panels/${panelId}/export.csv`, {
      instance_name: params.instance_name ?? "",
      limit: params.limit ?? 5000,
    }),
};
