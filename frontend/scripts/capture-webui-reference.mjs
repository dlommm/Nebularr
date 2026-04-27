import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const outputDir = join(repoRoot, "docs", "reference", "webui-pages");
const baseUrl = process.env.WEBUI_CAPTURE_BASE_URL ?? "http://127.0.0.1:4173";

const mockData = {
  healthz: { status: "ok", version: "1.7.0", git_sha: "mocksha", time: "2026-04-27T02:27:00Z" },
  setupStatusCompleted: {
    completed: true,
    has_webhook_secret: true,
    integrations: {
      sonarr: { configured: true, base_url: "http://sonarr:8989", api_key_set: true },
      radarr: { configured: true, base_url: "http://radarr:7878", api_key_set: true },
    },
    schedules: [
      { mode: "incremental", cron: "*/15 * * * *", timezone: "America/New_York", enabled: true },
      { mode: "reconcile", cron: "0 */6 * * *", timezone: "America/New_York", enabled: true },
    ],
    database: { engine_ready: true, runtime_url_persisted: true, arrapp_role_exists: true },
  },
  setupStatusIncomplete: {
    completed: false,
    has_webhook_secret: false,
    integrations: {
      sonarr: { configured: false, base_url: "", api_key_set: false },
      radarr: { configured: false, base_url: "", api_key_set: false },
    },
    schedules: [],
    database: { engine_ready: false, runtime_url_persisted: false, arrapp_role_exists: false },
  },
  status: {
    jobs_total: 364,
    webhook_queue_open: 14,
    webhook_queue_dead_letter: 2,
    active_sync_count: 1,
    sync_lag_seconds: { sonarr: 22.6, radarr: 7.3 },
    arr_versions: { sonarr: "4.0.1", radarr: "5.7.0" },
    health_state: "ok",
    health_reasons: [],
    health_dimensions: { webhooks: "ok", sync: "ok", integrations: "ok", mal: "warning" },
    health_dimension_reasons: { mal: ["pending MAL backlog"] },
    mal_sync: {
      running: [{ run_id: 122, job_type: "matcher", started_at: "2026-04-26T21:04:12Z" }],
      last_finished: {
        ingest: {
          job_type: "ingest",
          status: "success",
          started_at: "2026-04-26T20:22:01Z",
          finished_at: "2026-04-26T20:23:11Z",
          error_message: null,
        },
        matcher: {
          job_type: "matcher",
          status: "success",
          started_at: "2026-04-26T20:55:00Z",
          finished_at: "2026-04-26T20:55:38Z",
          error_message: null,
        },
        tag_sync: {
          job_type: "tag_sync",
          status: "failed",
          started_at: "2026-04-26T19:12:18Z",
          finished_at: "2026-04-26T19:12:36Z",
          error_message: "429 from MAL API",
        },
      },
      client_configured: true,
      pending_fetch_count: 14,
      fetched_success_count: 318,
      dubbed_total: 430,
      schedulers: { ingest_enabled: true, matcher_enabled: true, tagging_enabled: true },
    },
  },
  syncActivity: [
    {
      run_id: 901,
      source: "sonarr",
      mode: "incremental",
      instance_name: "primary",
      status: "running",
      started_at: "2026-04-26T21:04:12Z",
      records_processed: 1342,
      trigger: "scheduler",
      stage: "history_poll",
      stage_note: "watermark=581220",
      elapsed_seconds: 192,
    },
    {
      run_id: 900,
      source: "radarr",
      mode: "full",
      instance_name: "primary",
      status: "success",
      started_at: "2026-04-26T20:51:00Z",
      records_processed: 9456,
      trigger: "manual",
      stage: "persist_movies",
      stage_note: "",
      elapsed_seconds: 584,
    },
  ],
  recentRuns: [
    {
      source: "radarr",
      mode: "full",
      instance_name: "primary",
      status: "success",
      started_at: "2026-04-26T20:51:00Z",
      finished_at: "2026-04-26T21:01:04Z",
      rows_written: 9456,
      error_message: null,
    },
    {
      source: "sonarr",
      mode: "incremental",
      instance_name: "primary",
      status: "running",
      started_at: "2026-04-26T21:04:12Z",
      finished_at: null,
      rows_written: 1342,
      error_message: null,
    },
  ],
  webhookQueue: [
    { status: "queued", count: 8 },
    { status: "retrying", count: 4 },
    { status: "dead_letter", count: 2 },
  ],
  webhookJobs: [
    {
      id: 1001,
      source: "sonarr",
      event_type: "EpisodeFile",
      status: "queued",
      attempts: 0,
      received_at: "2026-04-26T21:07:11Z",
      next_attempt_at: null,
      processed_at: null,
      error_message: null,
    },
    {
      id: 1000,
      source: "radarr",
      event_type: "Download",
      status: "dead_letter",
      attempts: 5,
      received_at: "2026-04-26T20:58:04Z",
      next_attempt_at: null,
      processed_at: "2026-04-26T21:01:21Z",
      error_message: "signature mismatch",
    },
  ],
  syncProgress: {
    running: true,
    run_id: 901,
    source: "sonarr",
    mode: "incremental",
    instance_name: "primary",
    started_at: "2026-04-26T21:04:12Z",
    elapsed_seconds: 192,
    records_processed: 1342,
    stage: "history_poll",
    stage_note: "watermark=581220",
    estimated_total_seconds: 370,
    eta_seconds: 178,
    progress_pct: 52.1,
    history_sample_size: 12,
  },
  integrations: [
    {
      id: 1,
      source: "sonarr",
      name: "Sonarr Main",
      base_url: "http://sonarr:8989",
      enabled: true,
      webhook_enabled: true,
      updated_at: "2026-04-25T18:11:00Z",
      api_key_set: true,
    },
    {
      id: 2,
      source: "radarr",
      name: "Radarr Main",
      base_url: "http://radarr:7878",
      enabled: true,
      webhook_enabled: true,
      updated_at: "2026-04-25T18:11:00Z",
      api_key_set: true,
    },
  ],
  schedules: [
    { mode: "incremental", cron: "*/15 * * * *", timezone: "America/New_York", enabled: true, updated_at: "2026-04-26T19:20:00Z" },
    { mode: "reconcile", cron: "0 */6 * * *", timezone: "America/New_York", enabled: true, updated_at: "2026-04-26T19:20:00Z" },
  ],
  malConfig: {
    client_id_configured: true,
    env_fallback_configured: false,
    ingest_enabled: true,
    matcher_enabled: true,
    tagging_enabled: true,
    allow_title_year_match: true,
  },
  loggingConfig: { effective_level: "INFO", stored_level: "INFO", environment_default: "INFO" },
  webhookConfig: { secret_set: true },
  alertWebhookConfig: { urls_configured: true, url_count: 1, timeout_seconds: 5, min_state: "warning", notify_recovery: true },
  uiLogs: {
    items: [
      { ts: "2026-04-26T21:10:01Z", level: "INFO", logger: "arrsync.sync", message: "Sync started for sonarr/incremental" },
      { ts: "2026-04-26T21:11:20Z", level: "WARNING", logger: "arrsync.webhooks", message: "Dead-letter replay queued 2 jobs" },
      { ts: "2026-04-26T21:12:14Z", level: "ERROR", logger: "arrsync.mal", message: "Tag sync failed: 429", extra: { retry_in_s: 30 } },
    ],
    capacity: 500,
    effective_level: "INFO",
  },
  shows: {
    items: [
      { instance_name: "primary", series_id: 501, title: "Nova Academy", monitored: true, status: "continuing", path: "/tv/Nova Academy", episode_count: 18, season_count: 2, last_seen_at: "2026-04-26T21:05:00Z" },
      { instance_name: "primary", series_id: 502, title: "Signal Drift", monitored: true, status: "ended", path: "/tv/Signal Drift", episode_count: 10, season_count: 1, last_seen_at: "2026-04-26T21:05:00Z" },
    ],
    total: 2,
    limit: 50,
    offset: 0,
    has_more: false,
  },
  showSeasons: [{ season_number: 1 }, { season_number: 2 }],
  showEpisodes: {
    items: [
      {
        instance_name: "primary",
        series_id: 501,
        series_title: "Nova Academy",
        episode_id: 1,
        season_number: 1,
        episode_number: 1,
        absolute_episode_number: "1",
        episode_title: "Welcome Cadets",
        air_date: "2026-01-14",
        runtime_minutes: 42,
        monitored: true,
        has_file: true,
        file_path: "/tv/Nova Academy/S01E01.mkv",
        relative_path: "S01E01.mkv",
        size_bytes: 2390123310,
        quality: "WEBDL-1080p",
        audio_codec: "EAC3",
        audio_channels: "5.1",
        video_codec: "H264",
        video_dynamic_range: "SDR",
        audio_languages: ["en"],
        subtitle_languages: ["en"],
        release_group: "GROUP",
        custom_formats: [],
        custom_format_score: "0",
        indexer_flags: null,
        series_status: "continuing",
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
    has_more: false,
  },
  movies: {
    items: [
      {
        instance_name: "primary",
        movie_id: 801,
        title: "The Last Orbit",
        year: 2026,
        runtime_minutes: "132",
        monitored: true,
        status: "downloaded",
        movie_path: "/movies/The Last Orbit (2026)",
        movie_file_id: 90,
        file_path: "/movies/The Last Orbit (2026)/The.Last.Orbit.2160p.mkv",
        relative_path: "The.Last.Orbit.2160p.mkv",
        size_bytes: 18765432100,
        quality: "Bluray-2160p",
        audio_codec: "TrueHD",
        audio_channels: "7.1",
        video_codec: "HEVC",
        video_dynamic_range: "HDR10",
        audio_languages: ["en"],
        subtitle_languages: ["en"],
        release_group: "GROUP",
        custom_formats: [],
        custom_format_score: "10",
        indexer_flags: null,
        last_seen_at: "2026-04-26T21:02:00Z",
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
    has_more: false,
  },
  reportingDashboards: [
    { key: "library_overview", title: "Library Overview", description: "Collection-level KPIs and distributions" },
  ],
  reportingDashboard: {
    key: "library_overview",
    title: "Library Overview",
    description: "Collection-level KPIs and distributions",
    generated_at: "2026-04-26T21:12:00Z",
    panels: [
      { id: "total_titles", title: "Total Titles", kind: "stat", value: 1422 },
      {
        id: "by_source",
        title: "Titles by Source",
        kind: "distribution",
        rows: [
          { source: "sonarr", count: 877 },
          { source: "radarr", count: 545 },
        ],
      },
      {
        id: "recent_titles",
        title: "Recently Added",
        kind: "table",
        rows: [
          { title: "Nova Academy", source: "sonarr", added_at: "2026-04-20" },
          { title: "The Last Orbit", source: "radarr", added_at: "2026-04-18" },
        ],
      },
    ],
  },
};

function json(body) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

function routeResponse(pathname, referer) {
  if (pathname === "/healthz") return json(mockData.healthz);
  if (pathname === "/api/status") return json(mockData.status);
  if (pathname === "/api/setup/status") {
    return referer?.includes("setup?mockSetupIncomplete=1")
      ? json(mockData.setupStatusIncomplete)
      : json(mockData.setupStatusCompleted);
  }
  if (pathname === "/api/ui/sync-activity") return json(mockData.syncActivity);
  if (pathname === "/api/ui/recent-runs") return json(mockData.recentRuns);
  if (pathname === "/api/ui/webhook-queue") return json(mockData.webhookQueue);
  if (pathname === "/api/ui/webhook-jobs") return json(mockData.webhookJobs);
  if (pathname === "/api/ui/sync-progress") return json(mockData.syncProgress);
  if (pathname === "/api/config/integrations") return json(mockData.integrations);
  if (pathname === "/api/config/schedules") return json(mockData.schedules);
  if (pathname === "/api/config/mal") return json(mockData.malConfig);
  if (pathname === "/api/config/logging") return json(mockData.loggingConfig);
  if (pathname === "/api/config/webhook") return json(mockData.webhookConfig);
  if (pathname === "/api/config/alert-webhooks") return json(mockData.alertWebhookConfig);
  if (pathname === "/api/ui/logs") return json(mockData.uiLogs);
  if (pathname === "/api/ui/shows") return json(mockData.shows);
  if (pathname.startsWith("/api/ui/shows/") && pathname.endsWith("/seasons")) return json(mockData.showSeasons);
  if (pathname.startsWith("/api/ui/shows/") && pathname.endsWith("/episodes")) return json(mockData.showEpisodes);
  if (pathname === "/api/ui/episodes") return json(mockData.showEpisodes);
  if (pathname === "/api/ui/movies") return json(mockData.movies);
  if (pathname === "/api/reporting/dashboards") return json(mockData.reportingDashboards);
  if (pathname.startsWith("/api/reporting/dashboards/")) return json(mockData.reportingDashboard);
  if (pathname.startsWith("/api/")) return json({ status: "ok" });
  return null;
}

const captures = [
  { path: "/", file: "home.png", waitFor: "h1" },
  { path: "/dashboard", file: "dashboard.png", waitFor: "text=Mission control" },
  { path: "/reporting", file: "reporting.png", waitFor: "text=Library Overview" },
  { path: "/library", file: "library.png", waitFor: "text=Nova Academy" },
  { path: "/sync", file: "sync-overview.png", waitFor: "text=Sync progress" },
  { path: "/sync?tab=runs", file: "sync-runs.png", waitFor: "text=Run history" },
  { path: "/sync?tab=webhooks", file: "sync-webhooks.png", waitFor: "text=Webhook jobs" },
  { path: "/sync?tab=manual", file: "sync-manual.png", waitFor: "text=On-demand sync" },
  { path: "/integrations", file: "integrations.png", waitFor: "text=Integrations" },
  { path: "/schedules", file: "schedules.png", waitFor: "text=Schedules" },
  { path: "/logs", file: "logs.png", waitFor: "text=Logs" },
  { path: "/setup?mockSetupIncomplete=1", file: "setup.png", waitFor: "text=Setup" },
  { path: "/does-not-exist", file: "not-found.png", waitFor: "text=Not found" },
];

async function main() {
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1720, height: 1080 } });

  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const referer = (await req.headerValue("referer")) ?? "";
    const response = routeResponse(url.pathname, referer);
    if (response) {
      await route.fulfill(response);
      return;
    }
    await route.continue();
  });

  for (const capture of captures) {
    await page.goto(`${baseUrl}${capture.path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    await page.waitForSelector(capture.waitFor, { timeout: 15_000 });
    await page.screenshot({ path: join(outputDir, capture.file), fullPage: true });
  }

  await browser.close();
  console.log(`Saved ${captures.length} screenshots to ${outputDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
