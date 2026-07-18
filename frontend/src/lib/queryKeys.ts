import type { api } from "../api";

/**
 * Central React Query key registry.
 *
 * Every factory returns the exact array shape already used at the current
 * call sites, so swapping a literal (`["shows", search, limit, ...]`) for
 * `queryKeys.shows({ search, limit, ... })` is a drop-in replacement: same
 * cache entries, same invalidation targets. Calling a parameterized factory
 * with no arguments returns the bare `[name]` prefix — that's what
 * SSE/action invalidation uses to match every query under that key
 * regardless of its filters (React Query does prefix matching by default).
 */

type ShowsParams = Parameters<typeof api.shows>[0];
type AllEpisodesParams = Parameters<typeof api.allEpisodes>[0];
type MoviesParams = Parameters<typeof api.movies>[0];
type ShowEpisodesParams = Parameters<typeof api.showEpisodes>[2];
type ReportingDashboardParams = Parameters<typeof api.reportingDashboard>[1];

export const queryKeys = {
  // Simple, non-parameterized keys.
  status: ["status"] as const,
  healthz: ["healthz"] as const,
  authStatus: ["auth-status"] as const,
  setupStatus: ["setup-status"] as const,
  setupInitialSyncStatus: ["setup-initial-sync-status"] as const,
  runs: ["runs"] as const,
  recentRuns: ["recent-runs"] as const,
  syncActivity: ["sync-activity"] as const,
  syncProgress: ["sync-progress"] as const,
  workStatus: ["work-status"] as const,
  webhookQueue: ["webhook-queue"] as const,
  stuckState: ["stuck-state"] as const,
  queueConfig: ["queue-config"] as const,
  retention: ["retention"] as const,
  uiLogs: ["ui-logs"] as const,
  loggingConfig: ["logging-config"] as const,
  webhookConfig: ["webhook-config"] as const,
  alertWebhookConfig: ["alert-webhook-config"] as const,
  malOverview: ["mal-overview"] as const,
  integrations: ["integrations"] as const,
  schedules: ["schedules"] as const,
  malConfig: ["mal-config"] as const,
  savedViews: ["saved-views"] as const,
  reportingDashboards: ["reporting-dashboards"] as const,

  // Parameterized keys: call with no args for the bare prefix (invalidation),
  // or with the same params used to build the query for the full cache key.
  shows: (params?: ShowsParams) =>
    params
      ? (["shows", params.search, params.limit, params.offset, params.sort_by, params.sort_dir] as const)
      : (["shows"] as const),

  allEpisodes: (params?: AllEpisodesParams) =>
    params
      ? ([
          "all-episodes",
          params.search,
          params.instance_name,
          params.limit,
          params.offset,
          params.sort_by,
          params.sort_dir,
        ] as const)
      : (["all-episodes"] as const),

  movies: (params?: MoviesParams) =>
    params
      ? ([
          "movies",
          params.search,
          params.instance_name,
          params.limit,
          params.offset,
          params.sort_by,
          params.sort_dir,
        ] as const)
      : (["movies"] as const),

  showSeasons: (seriesId?: number, instanceName?: string) =>
    seriesId !== undefined && instanceName !== undefined
      ? (["show-seasons", seriesId, instanceName] as const)
      : (["show-seasons"] as const),

  showEpisodes: (seriesId?: number, instanceName?: string, params?: ShowEpisodesParams) =>
    seriesId !== undefined && instanceName !== undefined && params
      ? ([
          "show-episodes",
          seriesId,
          instanceName,
          params.season_number ?? null,
          params.limit,
          params.offset,
          params.sort_by,
          params.sort_dir,
        ] as const)
      : (["show-episodes"] as const),

  webhookJobs: (status?: string, offset?: number) =>
    status !== undefined && offset !== undefined
      ? (["webhook-jobs", status, offset] as const)
      : (["webhook-jobs"] as const),

  malJobRuns: (jobType?: string) =>
    jobType !== undefined ? (["mal-job-runs", jobType] as const) : (["mal-job-runs"] as const),

  reportingDashboard: (dashboardKey?: string, params?: ReportingDashboardParams) =>
    dashboardKey !== undefined
      ? (["reporting-dashboard", dashboardKey, params?.instance_name ?? "", params?.limit ?? 200] as const)
      : (["reporting-dashboard"] as const),
} as const;
