export type HealthState = "ok" | "warning" | "critical";

export type MalSyncRunningJob = {
  run_id: number;
  job_type: string;
  started_at: string;
};

export type MalSyncLastFinished = {
  job_type: string;
  status: string;
  started_at: string;
  finished_at: string;
  error_message: string | null;
};

export type MalSyncStatus = {
  running: MalSyncRunningJob[];
  last_finished: Record<string, MalSyncLastFinished>;
  client_configured: boolean;
  pending_fetch_count?: number;
  fetched_success_count?: number;
  dubbed_total?: number;
  schedulers: {
    ingest_enabled: boolean;
    matcher_enabled: boolean;
    tagging_enabled: boolean;
  };
};

export type HealthDimensions = {
  webhooks: HealthState;
  sync: HealthState;
  integrations: HealthState;
  mal: HealthState;
};

export type StatusResponse = {
  jobs_total: number;
  webhook_queue_open: number;
  webhook_queue_dead_letter?: number;
  active_sync_count: number;
  sync_lag_seconds: { sonarr?: number; radarr?: number };
  arr_versions: { sonarr: string; radarr: string };
  health_state: HealthState;
  health_reasons: string[];
  /** When present, per-subsystem state (queues, sync lag, Arr connectivity, MAL) */
  health_dimensions?: HealthDimensions;
  health_dimension_reasons?: Partial<Record<keyof HealthDimensions, string[]>>;
  mal_sync?: MalSyncStatus;
};

export type HealthzResponse = {
  status: string;
  version: string;
  git_sha: string;
  time: string;
};

export type MalConfigResponse = {
  client_id_configured: boolean;
  env_fallback_configured: boolean;
  ingest_enabled: boolean;
  matcher_enabled: boolean;
  tagging_enabled: boolean;
  allow_title_year_match: boolean;
  /** One batch of MAL fetches per ingest run; default from server env `MAL_MAX_IDS_PER_RUN`. */
  mal_max_ids_per_run: number;
  mal_min_request_interval_seconds: number;
  mal_jikan_min_request_interval_seconds: number;
};

export type LoggingConfigResponse = {
  effective_level: string;
  stored_level: string | null;
  environment_default: string;
};

export type UiLogEntry = Record<string, unknown>;

export type UiLogsResponse = {
  items: UiLogEntry[];
  capacity: number;
  /** Server-side log level; lines below this severity are not kept in the ring buffer */
  effective_level?: string;
};

export type SyncActivityRow = {
  run_id: number;
  source: string;
  mode: string;
  instance_name: string;
  status: string;
  started_at: string;
  records_processed: number;
  trigger: string;
  stage: string;
  stage_note: string;
  elapsed_seconds: number;
};

export type PagedResponse<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
};

export type ShowRow = {
  instance_name: string;
  series_id: number;
  title: string;
  monitored: boolean;
  status: string;
  path: string | null;
  episode_count: number;
  season_count: number;
  last_seen_at: string | null;
};

export type EpisodeRow = {
  instance_name: string;
  series_id: number;
  series_title: string;
  episode_id: number;
  season_number: number;
  episode_number: number;
  absolute_episode_number: string | null;
  episode_title: string;
  air_date: string | null;
  runtime_minutes: number | null;
  monitored: boolean;
  has_file: boolean;
  file_path: string | null;
  relative_path: string | null;
  size_bytes: number | null;
  quality: string | null;
  audio_codec: string | null;
  audio_channels: string | null;
  video_codec: string | null;
  video_dynamic_range: string | null;
  audio_languages: string[] | null;
  subtitle_languages: string[] | null;
  release_group: string | null;
  custom_formats: unknown[] | null;
  custom_format_score: string | null;
  indexer_flags: string | null;
  series_status: string | null;
};

export type MovieRow = {
  instance_name: string;
  movie_id: number;
  title: string;
  year: number | null;
  runtime_minutes: string | null;
  monitored: boolean;
  status: string;
  movie_path: string | null;
  movie_file_id: number | null;
  file_path: string | null;
  relative_path: string | null;
  size_bytes: number | null;
  quality: string | null;
  audio_codec: string | null;
  audio_channels: string | null;
  video_codec: string | null;
  video_dynamic_range: string | null;
  audio_languages: string[] | null;
  subtitle_languages: string[] | null;
  release_group: string | null;
  custom_formats: unknown[] | null;
  custom_format_score: string | null;
  indexer_flags: string | null;
  last_seen_at: string | null;
};

export type IntegrationRow = {
  id: number;
  source: string;
  name: string;
  base_url: string;
  enabled: boolean;
  webhook_enabled: boolean;
  updated_at: string;
  api_key_set: boolean;
};

export type ScheduleRow = {
  mode: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  updated_at: string;
};

export type RunRow = {
  source: string;
  mode: string;
  instance_name: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  rows_written: number | null;
  error_message: string | null;
};

export type SyncProgress = {
  running: boolean;
  run_id?: number;
  source?: string;
  mode?: string;
  instance_name?: string;
  started_at?: string;
  elapsed_seconds?: number;
  records_processed?: number;
  stage?: string;
  stage_note?: string;
  /** manual, scheduler, webhook, setup, etc. */
  trigger?: string;
  estimated_total_seconds?: number | null;
  eta_seconds?: number | null;
  progress_pct?: number | null;
  history_sample_size?: number;
};

export type WorkWarehouseItem = {
  kind: "warehouse";
  run_id: number;
  source: string;
  mode: string;
  instance_name: string;
  started_at: string;
  trigger: string;
  stage: string;
  stage_note: string;
  elapsed_seconds: number;
  records_processed: number;
  estimated_total_seconds: number | null;
  eta_seconds: number | null;
  progress_pct: number | null;
  history_sample_size: number;
};

export type WorkMalItem = {
  kind: "mal";
  run_id: number;
  job_type: string;
  started_at: string;
  elapsed_seconds: number;
  details: Record<string, unknown> | null;
  estimated_total_seconds: number | null;
  eta_seconds: number | null;
  progress_pct: number | null;
  history_sample_size: number;
};

export type WorkSetupItem = {
  kind: "setup";
  running: true;
  sources: string[];
  elapsed_seconds: number | null;
  stage: string;
  stage_note: string;
};

export type WorkStatusItem = WorkWarehouseItem | WorkMalItem | WorkSetupItem;

export type WorkStatusResponse = {
  active: boolean;
  items: WorkStatusItem[];
  warehouse_running: boolean;
  mal_running: boolean;
  setup_running: boolean;
};

export type StuckLockRow = {
  lock_name: string;
  owner_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
};

export type StuckMalJobRow = {
  id: number;
  job_type: string;
  status: string;
  started_at: string;
  error_message: string | null;
};

export type StuckWarehouseSyncRunRow = {
  id: number;
  source: string;
  mode: string;
  instance_name: string;
  status: string;
  started_at: string;
  records_processed: number;
  trigger: string;
  stage: string;
};

export type StuckJobRunSummaryRow = {
  id: number;
  source: string;
  mode: string;
  instance_name: string;
  status: string;
  started_at: string;
  rows_written: number;
};

export type StuckStateResponse = {
  job_locks: StuckLockRow[];
  mal_job_runs_running: StuckMalJobRow[];
  warehouse_sync_runs_running: StuckWarehouseSyncRunRow[];
  job_run_summary_running: StuckJobRunSummaryRow[];
};

export type ClearStuckResponse = {
  status: string;
  cleared_all_job_locks: boolean;
  job_locks_removed: number;
  mal_ingest_locks_removed: number;
  warehouse_sync_locks_removed: number;
  mal_job_runs_marked_failed: number;
  warehouse_sync_runs_marked_failed: number;
  job_run_summary_rows_marked_failed: number;
};

export type WebhookQueueRow = { status: string; count: number };

export type WebhookJobRow = {
  id: number;
  source: string;
  event_type: string | null;
  status: string;
  attempts: number;
  received_at: string;
  next_attempt_at: string | null;
  processed_at: string | null;
  error_message: string | null;
};

export type SetupStatus = {
  completed: boolean;
  has_webhook_secret: boolean;
  integrations: Record<string, { configured: boolean; base_url: string; api_key_set: boolean }>;
  schedules: { mode: string; cron: string; timezone: string; enabled: boolean }[];
  database: {
    engine_ready?: boolean;
    runtime_url_persisted: boolean;
    arrapp_role_exists: boolean;
  };
};

export type AlertWebhookConfig = {
  urls_configured: boolean;
  url_count: number;
  timeout_seconds: number;
  min_state: "warning" | "critical";
  notify_recovery: boolean;
};

export type ReportingDashboardMeta = {
  key: string;
  title: string;
  description: string;
};

export type ReportingPanel = {
  id: string;
  title: string;
  kind: "stat" | "distribution" | "table";
  value?: number | string;
  rows?: Array<Record<string, unknown>>;
};

export type ReportingDashboard = {
  key: string;
  title: string;
  description: string;
  generated_at: string;
  panels: ReportingPanel[];
};
