// Mock API payloads for the reference-screenshot capture
// (capture-webui-reference.mjs). Shapes follow frontend/src/types.ts and the
// backend handlers they mirror — keep them in step when a contract changes, or
// the screenshots silently stop showing what a real instance renders.
//
// Scenarios:
//   healthy  — a configured, synced instance with one sync running
//   degraded — warning/critical health, webhook backlog, dead letters, a failed
//              integration test and failed runs
//   empty    — setup complete but nothing synced yet (empty library/queues)

// Relative to capture time so "2 min ago" / "retry in 1 min" read true.
const NOW = Date.now();
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

const SHOW_TITLES = [
  ["Nova Academy", "continuing", 2, 18],
  ["Signal Drift", "ended", 1, 10],
  ["The Quiet Meridian", "continuing", 4, 40],
  ["Halcyon Station", "ended", 6, 72],
  ["Paper Lanterns", "continuing", 1, 8],
  ["Orbital Mechanics", "upcoming", 0, 0],
  ["Glass Harbor", "ended", 3, 30],
  ["Midnight Cartographers", "continuing", 2, 20],
  ["Kestrel & Vane", "ended", 5, 62],
  ["Low Tide Archive", "continuing", 3, 26],
  ["Sundial", "ended", 2, 16],
  ["Ember Protocol", "continuing", 1, 12],
];

const MOVIE_TITLES = [
  ["The Last Orbit", 2026, "Bluray-2160p", "HEVC", "HDR10", "TrueHD", "7.1", 18765432100],
  ["Pale Signal", 2019, "WEBDL-1080p", "H264", "SDR", "EAC3", "5.1", 6123456789],
  ["Atlas of Small Hours", 2022, "Bluray-1080p", "HEVC", "SDR", "DTS-HD MA", "5.1", 11234567890],
  ["Undertow", 2017, "WEBRip-720p", "H264", "SDR", "AAC", "2.0", 1834567890],
  ["Comet Season", 2024, "WEBDL-2160p", "HEVC", "DV HDR10", "EAC3 Atmos", "5.1", 15234567890],
  ["The Long Parallax", 2013, "Bluray-1080p", "H264", "SDR", "DTS", "5.1", 9876543210],
  ["Ferrous", 2021, null, null, null, null, null, null],
  ["Northbound Lights", 2025, "Remux-2160p", "HEVC", "HDR10", "TrueHD Atmos", "7.1", 58765432100],
];

function shows(scenario) {
  if (scenario === "empty") return [];
  return SHOW_TITLES.map(([title, status, seasons, episodes], i) => ({
    instance_name: i % 5 === 4 ? "anime" : "primary",
    series_id: 501 + i,
    title,
    monitored: status !== "ended" || i % 3 === 0,
    status,
    path: `/tv/${title}`,
    episode_count: episodes,
    season_count: seasons,
    last_seen_at: ago(900 + i * 60),
  }));
}

const EPISODE_TITLES = [
  "Welcome Cadets",
  "Gravity Assist",
  "The Long Burn",
  "Perihelion",
  "Dead Reckoning",
  "Station Keeping",
  "A Hole in the Sky",
  "Lagrange",
  "Terminator Line",
  "Escape Velocity",
];

function episodes(scenario) {
  if (scenario === "empty") return [];
  return EPISODE_TITLES.map((episode_title, i) => {
    const hasFile = i !== 6;
    const uhd = i % 4 === 3;
    return {
      instance_name: "primary",
      series_id: 501,
      series_title: "Nova Academy",
      episode_id: 1 + i,
      season_number: i < 6 ? 1 : 2,
      episode_number: i < 6 ? i + 1 : i - 5,
      absolute_episode_number: String(i + 1),
      episode_title,
      air_date: `2026-0${1 + Math.floor(i / 3)}-1${i % 9}`,
      runtime_minutes: 42 + (i % 3),
      monitored: true,
      has_file: hasFile,
      file_path: hasFile ? `/tv/Nova Academy/Season 0${i < 6 ? 1 : 2}/S0${i < 6 ? 1 : 2}E0${i < 6 ? i + 1 : i - 5}.mkv` : null,
      relative_path: hasFile ? `S0${i < 6 ? 1 : 2}E0${i < 6 ? i + 1 : i - 5}.mkv` : null,
      size_bytes: hasFile ? (uhd ? 7390123310 : 2390123310 + i * 41_000_000) : null,
      quality: hasFile ? (uhd ? "WEBDL-2160p" : i === 5 ? "HDTV-720p" : "WEBDL-1080p") : null,
      audio_codec: hasFile ? (uhd ? "EAC3 Atmos" : "EAC3") : null,
      audio_channels: hasFile ? "5.1" : null,
      video_codec: hasFile ? (uhd ? "HEVC" : "H264") : null,
      video_dynamic_range: hasFile ? (uhd ? "HDR10" : "SDR") : null,
      audio_languages: hasFile ? (i === 2 ? ["ja"] : ["en", "ja"]) : null,
      subtitle_languages: hasFile ? (i === 2 ? [] : ["en"]) : null,
      release_group: hasFile ? (uhd ? "FLUX" : "NTb") : null,
      custom_formats: [],
      custom_format_score: "0",
      indexer_flags: null,
      series_status: "continuing",
    };
  });
}

function movies(scenario) {
  if (scenario === "empty") return [];
  return MOVIE_TITLES.map(([title, year, quality, vcodec, hdr, acodec, ch, size], i) => ({
    instance_name: "primary",
    movie_id: 801 + i,
    title,
    year,
    runtime_minutes: String(98 + i * 7),
    monitored: i !== 3,
    status: quality ? "downloaded" : "missing",
    movie_path: `/movies/${title} (${year})`,
    movie_file_id: quality ? 90 + i : null,
    file_path: quality ? `/movies/${title} (${year})/${title.replaceAll(" ", ".")}.${year}.mkv` : null,
    relative_path: quality ? `${title.replaceAll(" ", ".")}.${year}.mkv` : null,
    size_bytes: size,
    quality,
    audio_codec: acodec,
    audio_channels: ch,
    video_codec: vcodec,
    video_dynamic_range: hdr,
    audio_languages: quality ? ["en"] : null,
    subtitle_languages: quality ? ["en", "es"] : null,
    release_group: quality ? "GROUP" : null,
    custom_formats: [],
    custom_format_score: "10",
    indexer_flags: null,
    last_seen_at: ago(1800),
  }));
}

function paged(items, limit = 50) {
  return { items, total: items.length, limit, offset: 0, has_more: false };
}

function status(scenario) {
  const base = {
    jobs_total: 364,
    webhook_queue_open: 3,
    webhook_queue_dead_letter: 0,
    active_sync_count: 1,
    sync_lag_seconds: { sonarr: 22.6, radarr: 7.3 },
    arr_versions: { sonarr: "4.0.14", radarr: "5.21.1" },
    health_state: "ok",
    health_reasons: [],
    health_dimensions: { webhooks: "ok", sync: "ok", integrations: "ok", mal: "ok" },
    health_dimension_reasons: {},
    mal_sync: {
      running: [{ run_id: 122, job_type: "matcher", started_at: ago(240) }],
      last_finished: {
        ingest: { job_type: "ingest", status: "success", started_at: ago(5400), finished_at: ago(5330), error_message: null },
        matcher: { job_type: "matcher", status: "success", started_at: ago(3600), finished_at: ago(3562), error_message: null },
        tag_sync: { job_type: "tag_sync", status: "success", started_at: ago(7200), finished_at: ago(7182), error_message: null },
      },
      client_configured: true,
      pending_fetch_count: 14,
      fetched_success_count: 318,
      dubbed_total: 430,
      schedulers: { ingest_enabled: true, matcher_enabled: true, tagging_enabled: true },
    },
  };
  if (scenario === "degraded") {
    return {
      ...base,
      webhook_queue_open: 612,
      webhook_queue_dead_letter: 7,
      active_sync_count: 0,
      arr_versions: { sonarr: "4.0.14", radarr: "unknown" },
      sync_lag_seconds: { sonarr: 5420.4, radarr: 61.2 },
      health_state: "critical",
      health_reasons: ["webhook_queue_critical", "sync_lag_warning", "arr_version_partial", "mal_tag_sync_last_failed"],
      health_dimensions: { webhooks: "critical", sync: "warning", integrations: "warning", mal: "warning" },
      health_dimension_reasons: {
        webhooks: ["webhook_queue_critical"],
        sync: ["sync_lag_warning"],
        integrations: ["arr_version_partial"],
        mal: ["mal_tag_sync_last_failed"],
      },
      mal_sync: {
        ...base.mal_sync,
        running: [],
        last_finished: {
          ...base.mal_sync.last_finished,
          tag_sync: { job_type: "tag_sync", status: "failed", started_at: ago(4000), finished_at: ago(3982), error_message: "429 from MAL API" },
        },
      },
    };
  }
  if (scenario === "empty") {
    return {
      ...base,
      jobs_total: 0,
      webhook_queue_open: 0,
      active_sync_count: 0,
      sync_lag_seconds: {},
      arr_versions: { sonarr: "4.0.14", radarr: "5.21.1" },
      health_state: "warning",
      health_reasons: ["sync_never_run:sonarr,radarr"],
      health_dimensions: { webhooks: "ok", sync: "warning", integrations: "ok", mal: "ok" },
      health_dimension_reasons: { sync: ["sync_never_run:sonarr,radarr"] },
      mal_sync: undefined,
    };
  }
  return base;
}

function workStatus(scenario) {
  if (scenario !== "healthy") {
    return { active: false, items: [], warehouse_running: false, mal_running: false, setup_running: false };
  }
  return {
    active: true,
    warehouse_running: true,
    mal_running: true,
    setup_running: false,
    items: [
      {
        kind: "warehouse",
        run_id: 901,
        source: "sonarr",
        mode: "incremental",
        instance_name: "primary",
        started_at: ago(192),
        trigger: "scheduler",
        stage: "history_poll",
        stage_note: "watermark=581220",
        elapsed_seconds: 192,
        records_processed: 1342,
        estimated_total_seconds: 370,
        eta_seconds: 178,
        progress_pct: 52.1,
        history_sample_size: 12,
      },
      {
        kind: "mal",
        run_id: 122,
        job_type: "matcher",
        started_at: ago(240),
        elapsed_seconds: 240,
        details: null,
        estimated_total_seconds: 300,
        eta_seconds: 60,
        progress_pct: 80,
        history_sample_size: 9,
      },
    ],
  };
}

function syncActivity(scenario) {
  if (scenario === "empty") return [];
  const rows = [
    { run_id: 901, source: "sonarr", mode: "incremental", instance_name: "primary", status: "running", started_at: ago(192), records_processed: 1342, trigger: "scheduler", stage: "history_poll", stage_note: "watermark=581220", elapsed_seconds: 192 },
    { run_id: 900, source: "radarr", mode: "full", instance_name: "primary", status: "success", started_at: ago(3000), records_processed: 9456, trigger: "manual", stage: "persist_movies", stage_note: "", elapsed_seconds: 584 },
    { run_id: 899, source: "sonarr", mode: "incremental", instance_name: "anime", status: "success", started_at: ago(4100), records_processed: 211, trigger: "webhook", stage: "done", stage_note: "", elapsed_seconds: 14 },
  ];
  if (scenario === "degraded") {
    rows[0] = { ...rows[0], status: "failed", stage: "fetch_series", stage_note: "ConnectError: sonarr:8989", elapsed_seconds: 31 };
  }
  return rows;
}

function recentRuns(scenario) {
  if (scenario === "empty") return [];
  const runs = [
    { source: "sonarr", mode: "incremental", instance_name: "primary", status: "running", started_at: ago(192), finished_at: null, rows_written: 1342, error_message: null },
    { source: "radarr", mode: "full", instance_name: "primary", status: "success", started_at: ago(3000), finished_at: ago(2416), rows_written: 9456, error_message: null },
    { source: "sonarr", mode: "incremental", instance_name: "anime", status: "success", started_at: ago(4100), finished_at: ago(4086), rows_written: 211, error_message: null },
    { source: "sonarr", mode: "reconcile", instance_name: "primary", status: "success", started_at: ago(21600), finished_at: ago(20900), rows_written: 48210, error_message: null },
    { source: "radarr", mode: "incremental", instance_name: "primary", status: "failed", started_at: ago(25200), finished_at: ago(25190), rows_written: 0, error_message: "ReadTimeout: radarr:7878 did not respond within 30s" },
  ];
  if (scenario === "degraded") {
    runs[0] = { ...runs[0], status: "failed", finished_at: ago(161), rows_written: 0, error_message: "ConnectError: [Errno 111] Connection refused (sonarr:8989)" };
  }
  return runs;
}

function webhookQueue(scenario) {
  if (scenario === "empty") return [];
  if (scenario === "degraded") {
    return [
      { status: "queued", count: 580 },
      { status: "retrying", count: 32 },
      { status: "dead_letter", count: 7 },
      { status: "done", count: 18233 },
    ];
  }
  return [
    { status: "queued", count: 2 },
    { status: "retrying", count: 1 },
    { status: "done", count: 18233 },
  ];
}

function webhookJobs(scenario) {
  if (scenario === "empty") return paged([]);
  const rows = [
    { id: 1004, source: "sonarr", event_type: "Download", status: "queued", attempts: 0, received_at: ago(40), next_attempt_at: null, processed_at: null, error_message: null },
    { id: 1003, source: "radarr", event_type: "MovieFileDelete", status: "retrying", attempts: 2, received_at: ago(300), next_attempt_at: ago(-60), processed_at: null, error_message: "deadlock detected; retrying" },
    { id: 1002, source: "sonarr", event_type: "SeriesAdd", status: "done", attempts: 1, received_at: ago(900), next_attempt_at: null, processed_at: ago(898), error_message: null },
    { id: 1001, source: "sonarr", event_type: "EpisodeFileDelete", status: "dead_letter", attempts: 5, received_at: ago(7200), next_attempt_at: null, processed_at: ago(5400), error_message: "signature mismatch" },
  ];
  return paged(scenario === "degraded" ? rows : rows.filter((r) => r.status !== "dead_letter"), 25);
}

function integrations(scenario) {
  if (scenario === "empty") return [];
  return [
    { id: 1, source: "sonarr", name: "Sonarr Main", base_url: "http://sonarr:8989", enabled: true, webhook_enabled: true, updated_at: ago(86400), api_key_set: true },
    { id: 2, source: "radarr", name: "Radarr Main", base_url: "http://radarr:7878", enabled: true, webhook_enabled: true, updated_at: ago(86400), api_key_set: true },
    ...(scenario === "degraded"
      ? []
      : [{ id: 3, source: "sonarr", name: "anime", base_url: "http://sonarr-anime:8989", enabled: true, webhook_enabled: false, updated_at: ago(172800), api_key_set: true }]),
  ];
}

const SCHEDULES = [
  { mode: "incremental", cron: "*/15 * * * *", timezone: "America/New_York", enabled: true, updated_at: ago(86400) },
  { mode: "reconcile", cron: "0 */6 * * *", timezone: "America/New_York", enabled: true, updated_at: ago(86400) },
  { mode: "mal_ingest", cron: "0 3 * * *", timezone: "America/New_York", enabled: true, updated_at: ago(86400) },
  { mode: "mal_matcher", cron: "30 3 * * *", timezone: "America/New_York", enabled: true, updated_at: ago(86400) },
  { mode: "mal_tag_sync", cron: "0 4 * * *", timezone: "America/New_York", enabled: false, updated_at: ago(86400) },
];

const AUTOMATIONS = [
  {
    id: 1,
    name: "Anime English-dub enforcer",
    template_key: "anime-dub-enforcer",
    params: {
      scope: { media: "series", anime_only: true, monitored_only: true },
      require: { audio_language_any: ["en", "eng", "english"] },
      actions: [{ type: "search_upgrade" }, { type: "tag", label: "needs-dub" }],
      options: { mal_dub_gate: true },
    },
    enabled: true,
    dry_run: false,
    cron: "0 5 * * *",
    timezone: "America/New_York",
    budget_per_run: 10,
    cooldown_days: 7,
    created_at: ago(86400 * 30),
    updated_at: ago(86400 * 2),
    last_run_id: 77,
    last_run_status: "success",
    last_run_started_at: ago(39600),
    last_run_matched: 23,
    last_run_actions: 10,
  },
  {
    id: 2,
    name: "Resolution floor — 1080p",
    template_key: "resolution-floor",
    params: {
      scope: { media: "both", monitored_only: true },
      require: { resolution_min: 1080 },
      actions: [{ type: "search_upgrade" }],
    },
    enabled: true,
    dry_run: true,
    cron: "0 */12 * * *",
    timezone: "UTC",
    budget_per_run: 25,
    cooldown_days: 14,
    created_at: ago(86400 * 9),
    updated_at: ago(86400),
    last_run_id: 81,
    last_run_status: "dry_run",
    last_run_started_at: ago(7200),
    last_run_matched: 142,
    last_run_actions: 0,
  },
  {
    id: 3,
    name: "Retire finished shows",
    template_key: "series-done-unmonitor",
    params: {
      scope: { media: "series", monitored_only: true, series_status_any: ["ended"], include_unmonitored_episodes: true },
      require: {},
      actions: [{ type: "set_monitored", value: false, when: "conforming" }],
    },
    enabled: false,
    dry_run: true,
    cron: "0 6 * * 0",
    timezone: "UTC",
    budget_per_run: 50,
    cooldown_days: 30,
    created_at: ago(86400 * 4),
    updated_at: ago(86400 * 4),
    last_run_id: null,
    last_run_status: null,
    last_run_started_at: null,
    last_run_matched: null,
    last_run_actions: null,
  },
];

const AUTOMATION_TEMPLATES = [
  ["anime-dub-enforcer", "Anime English-dub enforcer", "Upgrade-searches anime that lacks English audio once a dub is known to exist."],
  ["new-dub-watcher", "New-dub watcher", "Watches the dub lists and searches the moment a new English dub appears."],
  ["resolution-floor", "Resolution floor", "Upgrade-searches anything below your minimum resolution (items already at or above the floor — e.g. 4K — are left alone)."],
  ["missing-hunter", "Missing-content hunter", "Periodically searches monitored items that have no file at all."],
  ["series-done-unmonitor", "Retire finished shows (series)", "Unmonitors ended series once every aired episode meets the spec."],
  ["custom", "Custom rule", "Build your own condition from the whitelisted fields and pick the actions."],
].map(([key, title, description]) => ({ key, title, description, default_cron: "0 5 * * *", default_params: { scope: { media: "series" }, require: {}, actions: [{ type: "search_upgrade" }] } }));

const AUTOMATION_RUNS = [
  { id: 81, automation_id: 2, started_at: ago(7200), finished_at: ago(7190), status: "dry_run", matched_count: 142, actions_taken: 0, skipped_cooldown: 4, skipped_budget: 113, error_message: null },
  { id: 77, automation_id: 1, started_at: ago(39600), finished_at: ago(39540), status: "success", matched_count: 23, actions_taken: 10, skipped_cooldown: 6, skipped_budget: 7, error_message: null },
  { id: 70, automation_id: 1, started_at: ago(126000), finished_at: ago(125990), status: "partial", matched_count: 19, actions_taken: 4, skipped_cooldown: 0, skipped_budget: 0, error_message: "anime: search command rejected (HTTP 503)" },
  { id: 64, automation_id: 1, started_at: ago(212400), finished_at: ago(212399), status: "failed", matched_count: 0, actions_taken: 0, skipped_cooldown: 0, skipped_budget: 0, error_message: "Sonarr anime instance unreachable" },
];

function automationRunDetail(runId) {
  const run = AUTOMATION_RUNS.find((r) => r.id === runId) ?? AUTOMATION_RUNS[0];
  return {
    ...run,
    details: {
      dry_run: run.status === "dry_run",
      daily_cap_clamped: run.skipped_budget > 0,
      instances: {
        primary: {
          episode: {
            matched: run.matched_count,
            searched: run.actions_taken,
            matched_unit: "episodes",
            would_do:
              run.status === "dry_run"
                ? [
                    { source_id: 4411, title: "Signal Drift S01E03", actions: ["search_upgrade"] },
                    { source_id: 4412, title: "Glass Harbor S02E07", actions: ["search_upgrade"] },
                    { source_id: 4413, title: "Sundial S01E01", actions: ["search_upgrade"] },
                  ]
                : [],
            failure_reasons: { resolution: 131, no_file: 11 },
            failure_worst: [
              { title: "Glass Harbor", items: 30, reasons: ["resolution"] },
              { title: "Sundial", items: 16, reasons: ["resolution", "no_file"] },
            ],
          },
        },
      },
      errors: run.error_message ? [{ instance: "anime", phase: "search", error: run.error_message }] : [],
    },
  };
}

const MAL_OVERVIEW = {
  dubbed_total: 430,
  partial_total: 38,
  source_counts: { mal_dubs: 412, mydublist: 286 },
  coverage: { full: 212, partial: 38, none: 64 },
  fetched_success: 318,
  pending_fetch: 14,
  linked: 251,
  unlinked: 67,
  manual_link_count: 9,
  unmatched: [
    { mal_id: 52991, main_title: "Sousou no Frieren", media_type: "tv", status: "finished_airing", start_date: "2023-09-29", num_episodes: 28, mal_fetch_status: "success", has_manual_link: false },
    { mal_id: 21, main_title: "One Piece", media_type: "tv", status: "currently_airing", start_date: "1999-10-20", num_episodes: null, mal_fetch_status: "success", has_manual_link: false },
    { mal_id: 5114, main_title: "Fullmetal Alchemist: Brotherhood", media_type: "tv", status: "finished_airing", start_date: "2009-04-05", num_episodes: 64, mal_fetch_status: "pending", has_manual_link: false },
  ],
};

const MAL_JOB_RUNS = [
  { id: 122, job_type: "matcher", status: "running", started_at: ago(240), finished_at: null, details: {}, error_message: null },
  { id: 121, job_type: "tag_sync", status: "failed", started_at: ago(4000), finished_at: ago(3982), details: {}, error_message: "429 from MAL API" },
  { id: 120, job_type: "ingest", status: "success", started_at: ago(5400), finished_at: ago(5330), details: { fetched: 22 }, error_message: null },
];

function reportingDashboards() {
  return [
    { key: "overview", title: "Overview", description: "Portfolio summary and top file distributions." },
    { key: "storage-growth", title: "Storage Growth", description: "Library size over time and where the bytes live." },
    { key: "language-audit", title: "Language Audit", description: "Audio and subtitle language coverage across files." },
    { key: "sync-ops", title: "Sync Operations", description: "Run cadence, durations, and failures." },
  ];
}

function reportingDashboard(key, scenario) {
  const empty = scenario === "empty";
  const generated_at = ago(30);
  if (key === "storage-growth") {
    const days = Array.from({ length: 14 }, (_, i) => new Date(NOW - (13 - i) * 86400_000).toISOString().slice(0, 10));
    return {
      key,
      title: "Storage Growth",
      description: "Library size over time and where the bytes live.",
      generated_at,
      panels: [
        { id: "total_bytes", title: "Total Library Size", kind: "stat", value: empty ? "0 B" : "41.8 TiB" },
        {
          id: "storage_over_time",
          title: "Library Size Over Time (bytes)",
          kind: "timeseries",
          rows: empty
            ? []
            : days.flatMap((ts, i) => [
                { ts, label: "sonarr", value: 28.1e12 + i * 0.09e12 },
                { ts, label: "radarr", value: 12.9e12 + i * 0.05e12 },
              ]),
        },
        {
          id: "storage_by_quality",
          title: "Storage Share By Quality (bytes)",
          kind: "distribution",
          rows: empty
            ? []
            : [
                { label: "Bluray-2160p", value: 14.2e12 },
                { label: "WEBDL-1080p", value: 11.7e12 },
                { label: "Remux-2160p", value: 7.4e12 },
                { label: "Bluray-1080p", value: 5.1e12 },
                { label: "HDTV-720p", value: 1.9e12 },
              ],
        },
      ],
    };
  }
  return {
    key: "overview",
    title: "Overview",
    description: "Portfolio summary and top file distributions.",
    generated_at,
    panels: [
      { id: "episode_files", title: "Episode Files", kind: "stat", value: empty ? 0 : 111482 },
      { id: "movie_files", title: "Movie Files", kind: "stat", value: empty ? 0 : 2871 },
      { id: "missing_english_audio", title: "Episodes Missing English Audio", kind: "stat", value: empty ? 0 : 1214 },
      { id: "files_over_3gib", title: "Files Over 3 GiB", kind: "stat", value: empty ? 0 : 6390 },
      {
        id: "episode_quality_mix",
        title: "Episode Quality Distribution",
        kind: "distribution",
        rows: empty
          ? []
          : [
              { label: "WEBDL-1080p", value: 61204 },
              { label: "Bluray-1080p", value: 21877 },
              { label: "HDTV-720p", value: 12004 },
              { label: "WEBDL-2160p", value: 9133 },
              { label: "SDTV", value: 4120 },
              { label: "unknown", value: 3144 },
            ],
      },
      {
        id: "movie_quality_mix",
        title: "Movie Quality Distribution",
        kind: "distribution",
        rows: empty
          ? []
          : [
              { label: "Bluray-1080p", value: 1120 },
              { label: "Bluray-2160p", value: 801 },
              { label: "WEBDL-1080p", value: 588 },
              { label: "Remux-2160p", value: 214 },
              { label: "WEBRip-720p", value: 148 },
            ],
      },
      {
        id: "monitored_mix",
        title: "Monitored vs Unmonitored (Series/Movies)",
        kind: "distribution",
        rows: empty
          ? []
          : [
              { label: "series monitored", value: 812 },
              { label: "series unmonitored", value: 501 },
              { label: "movies monitored", value: 2410 },
              { label: "movies unmonitored", value: 461 },
            ],
      },
      {
        id: "largest_episode_files",
        title: "Largest Episode Files",
        kind: "table",
        rows: empty
          ? []
          : [
              { instance_name: "primary", series_title: "Halcyon Station", season_number: 6, episode_number: 10, quality: "Bluray-2160p", size_mib: 21877.4, path: "/tv/Halcyon Station/Season 06/S06E10.mkv" },
              { instance_name: "primary", series_title: "Kestrel & Vane", season_number: 1, episode_number: 1, quality: "Remux-2160p", size_mib: 18120.9, path: "/tv/Kestrel & Vane/Season 01/S01E01.mkv" },
              { instance_name: "primary", series_title: "The Quiet Meridian", season_number: 4, episode_number: 8, quality: "WEBDL-2160p", size_mib: 9032.2, path: "/tv/The Quiet Meridian/Season 04/S04E08.mkv" },
            ],
      },
    ],
  };
}

const SETUP_COMPLETE = {
  completed: true,
  has_webhook_secret: true,
  integrations: {
    sonarr: { configured: true, base_url: "http://sonarr:8989", api_key_set: true },
    radarr: { configured: true, base_url: "http://radarr:7878", api_key_set: true },
  },
  schedules: SCHEDULES.slice(0, 2),
  database: { engine_ready: true, runtime_url_persisted: true, arrapp_role_exists: true },
  bootstrap_token_required: false,
};

const SETUP_INCOMPLETE = {
  completed: false,
  has_webhook_secret: false,
  integrations: {
    sonarr: { configured: false, base_url: "", api_key_set: false },
    radarr: { configured: false, base_url: "", api_key_set: false },
  },
  schedules: [],
  database: { engine_ready: false, runtime_url_persisted: false, arrapp_role_exists: false },
  bootstrap_token_required: true,
};


// ————— Now Showing endpoints (Overview, Library, Artwork, sign-in) —————

function runTimeline(scenario) {
  const now = Date.now();
  const at = (hoursAgo) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const every = (step, offset, kind, failRecent = 0) => {
    const events = [];
    for (let h = offset; h < 24; h += step) {
      events.push({ at: at(h), kind, status: h < failRecent ? "failed" : "success", rows: Math.round(40 + ((h * 37) % 300)), duration_seconds: 12 + (h % 9) });
    }
    return events.reverse();
  };
  const sonarr = every(0.5, 0.07, "incremental").concat([{ at: at(11.9), kind: "full", status: "success", rows: 133412, duration_seconds: 381 }]);
  sonarr.sort((a, b) => a.at.localeCompare(b.at));
  const anime = scenario === "degraded" ? every(1, 9.3, "incremental") : every(1, 0.6, "incremental");
  const radarr = every(0.5, 0.18, "incremental", scenario === "degraded" ? 2 : 0);
  const hooks = Array.from({ length: scenario === "empty" ? 0 : 53 }, (_, i) => ({
    at: at(((i * 7919) % 2400) / 100),
    kind: "webhook",
    status: i < 3 ? "queued" : "done",
    source: i % 3 ? "sonarr" : "radarr",
  })).sort((a, b) => a.at.localeCompare(b.at));
  return {
    now: new Date(now).toISOString(),
    hours: 24,
    lanes: [
      { key: "sonarr:primary", label: "primary", kind: "sonarr", events: scenario === "empty" ? [] : sonarr, last_at: at(0.07) },
      { key: "sonarr:anime", label: "anime", kind: "sonarr", events: scenario === "empty" ? [] : anime, last_at: at(scenario === "degraded" ? 9.3 : 0.6) },
      { key: "radarr:primary", label: "movies", kind: "radarr", events: scenario === "empty" ? [] : radarr, last_at: at(0.18) },
      { key: "webhooks", label: "Webhooks", kind: "webhooks", events: hooks, last_at: hooks.length ? hooks[hooks.length - 1].at : null },
      { key: "mal", label: "MyAnimeList", kind: "mal", events: [0.9, 6.9, 12.9, 18.9].map((h) => ({ at: at(h), kind: "ingest", status: "success", duration_seconds: 161 })), last_at: at(0.9) },
    ],
  };
}

const IMPORT_TITLES = [
  ["episode", "primary", 501, "Halcyon Station", 2019, 6, 10, "The Long Way Down", "Bluray-2160p", 15_250_000_000],
  ["movie", "primary", 9001, "The Quiet Orchard", 2024, null, null, null, "Remux-2160p", 66_350_000_000],
  ["episode", "anime", 777, "Koya no Kitsune", 2025, 1, 7, "Ashes on the Shrine Road", "WEBDL-1080p", 1_500_000_000],
  ["episode", "primary", 502, "Ferryman's Daughter", 2022, 2, 4, "Low Water", "WEBDL-1080p", 3_330_000_000],
  ["movie", "primary", 9002, "Low Tide at Marrow Bay", 2023, null, null, null, "Bluray-2160p", 24_270_000_000],
  ["episode", "primary", 503, "Saltmarsh", 2021, 3, 6, "Brackish", "WEBDL-1080p", 2_100_000_000],
  ["episode", "primary", 504, "Glass Harbour", 2018, 5, 1, "Return", "HDTV-720p", 1_100_000_000],
  ["movie", "primary", 9003, "Ironwood", 2021, null, null, null, "Bluray-2160p", 52_500_000_000],
];

function recentImports(scenario) {
  if (scenario === "empty") return { items: [] };
  return {
    items: IMPORT_TITLES.map(([kind, inst, id, title, year, s, e, et, quality, size], i) => ({
      kind, instance_name: inst, item_id: id, title, year, season_number: s, episode_number: e, episode_title: et,
      quality, size_bytes: size, video_codec: quality.includes("2160") ? "HEVC" : "x264", audio_codec: "EAC3",
      path: kind === "movie" ? `/movies/${title} (${year})/${title}.mkv` : `/tv/${title} (${year})/Season ${String(s).padStart(2, "0")}/${title}.S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}.mkv`,
      seen_at: ago(240 + i * 5400), date_added: ago(240 + i * 5400),
    })),
  };
}

function libraryTotals(scenario) {
  if (scenario === "empty") return { shows: 0, episodes: 0, episodes_on_disk: 0, episodes_missing: 0, movies: 0, movies_on_disk: 0, movies_missing: 0, stored_bytes: 0 };
  return { shows: 1284, episodes: 133412, episodes_on_disk: 111076, episodes_missing: 1906, movies: 2341, movies_on_disk: 2298, movies_missing: 43, stored_bytes: 204_950_000_000_000 };
}

function artworkConfig(scenario) {
  return {
    enabled: true, mode: "cache", remote_fallback: false, cache_max_mb: 0,
    cache: scenario === "empty" ? { files: 0, bytes: 0, by_cover: {} } : { files: 7250, bytes: 3_190_000_000, by_cover: { poster: { files: 3625, bytes: 290_000_000 }, fanart: { files: 3625, bytes: 2_900_000_000 } } },
    prefetch_running: false,
    last_prefetch: scenario === "empty" ? null : { reason: "cron", mode: "cache", started_at: ago(7200), finished_at: ago(7080), fetched: 14, already_cached: 7236, unavailable: 3, pruned: 2, evicted: 0, interrupted: false },
  };
}

function json(body, statusCode = 200) {
  return { status: statusCode, contentType: "application/json", body: JSON.stringify(body) };
}

/**
 * Resolve a mocked response for an API path, or null to let the request
 * through (static assets from the dev server).
 * `ctx` = { scenario, setupIncomplete, loggedOut, method }
 */
export function routeResponse(pathname, search, ctx) {
  const { scenario } = ctx;
  if (pathname === "/healthz") {
    return json({ status: "ok", version: "2.9.3", git_sha: "987cb823e9a3", time: ago(0), encryption: "ok", auth: "enabled" });
  }
  if (pathname === "/api/ui/events") return { status: 204, contentType: "text/plain", body: "" };
  if (pathname === "/api/auth/status") {
    return json({ enabled: true, password_set: true, api_token_set: false, authenticated: !ctx.loggedOut });
  }
  if (pathname === "/api/setup/status") return json(ctx.setupIncomplete ? SETUP_INCOMPLETE : SETUP_COMPLETE);
  if (pathname === "/api/status") return json(status(scenario));
  if (pathname === "/api/ui/work-status") return json(workStatus(scenario));
  if (pathname === "/api/ui/sync-activity") return json(syncActivity(scenario));
  if (pathname === "/api/ui/sync-progress") {
    const item = workStatus(scenario).items.find((i) => i.kind === "warehouse");
    return json(item ? { running: true, ...item } : { running: false });
  }
  if (pathname === "/api/ui/recent-runs") return json(recentRuns(scenario));
  if (pathname === "/api/ui/run-timeline") return json(runTimeline(scenario));
  if (pathname === "/api/ui/recent-imports") return json(recentImports(scenario));
  if (pathname === "/api/ui/library-totals") return json(libraryTotals(scenario));
  if (pathname === "/api/config/artwork") return json(artworkConfig(scenario));
  // No real artwork in the harness: every image 404s, so pages show their title cards.
  if (pathname === "/api/art/wall") return json({ items: [] });
  if (pathname.startsWith("/api/art/")) return { status: 404, contentType: "application/json", body: "{}" };
  if (pathname === "/api/ui/webhook-queue") return json(webhookQueue(scenario));
  if (pathname === "/api/ui/webhook-jobs") return json(webhookJobs(scenario));
  if (pathname === "/api/config/integrations") return json(integrations(scenario));
  if (/^\/api\/config\/integrations\/[^/]+\/test$/.test(pathname)) {
    return json(scenario === "degraded" ? { ok: false, error: "Connection refused (sonarr:8989)" } : { ok: true, version: "4.0.14", app_name: "Sonarr" });
  }
  if (pathname === "/api/config/schedules") return json(scenario === "empty" ? SCHEDULES.slice(0, 2) : SCHEDULES);
  if (pathname === "/api/config/schedules/validate") {
    return json({ valid: true, timezone: "America/New_York", next_fire_times: [ago(-600), ago(-1500), ago(-2400)] });
  }
  if (pathname === "/api/config/retention") return json({ queue_days: 14, sync_run_days: 90, stat_snapshot_days: 365 });
  if (pathname === "/api/config/queue") return json({ batch_size: 50, max_attempts: 5, backoff_base_seconds: 5, backoff_cap_seconds: 600 });
  if (pathname === "/api/config/saved-views") return json({ views: { library: [{ name: "4K movies", search: "mode=movies&q=2160p" }] } });
  if (pathname === "/api/config/mal") {
    return json({
      client_id_configured: true,
      env_fallback_configured: false,
      ingest_enabled: true,
      matcher_enabled: true,
      tagging_enabled: true,
      allow_title_year_match: true,
      source_mal_dubs_enabled: true,
      source_mydublist_enabled: true,
      coverage_tagging_enabled: false,
      mydublist_tier: "all",
      mal_max_ids_per_run: 50,
      mal_min_request_interval_seconds: 1.5,
      mal_jikan_min_request_interval_seconds: 1,
    });
  }
  if (pathname === "/api/config/logging") return json({ effective_level: "INFO", stored_level: "INFO", environment_default: "INFO" });
  if (pathname === "/api/config/webhook") return json({ secret_set: scenario !== "empty" });
  if (pathname === "/api/config/alert-webhooks") {
    return json({
      urls_configured: true,
      url_count: 1,
      timeout_seconds: 5,
      min_state: "warning",
      notify_recovery: true,
      events: { health: true, sync_failure: true, dead_letter: true },
      email: { enabled: false, host: "", port: 587, username: "", password_set: false, from_address: "", to_addresses: [], starttls: true },
    });
  }
  if (pathname === "/api/auth/config") return json({ enabled: true, password_set: true, api_token_set: false });
  if (pathname === "/api/ui/logs") {
    return json({
      items: [
        { ts: ago(600), level: "INFO", logger: "arrsync.sync", message: "Sync started for sonarr/incremental (primary)" },
        { ts: ago(540), level: "DEBUG", logger: "arrsync.http", message: "GET http://sonarr:8989/api/v3/history?page=1 200 (84 ms)" },
        { ts: ago(420), level: "WARNING", logger: "arrsync.webhooks", message: "Dead-letter replay queued 2 jobs", extra: { source: "sonarr" } },
        { ts: ago(300), level: "ERROR", logger: "arrsync.mal", message: "Tag sync failed: 429 Too Many Requests", extra: { retry_in_s: 30, job_run_id: 121 } },
        { ts: ago(120), level: "INFO", logger: "arrsync.automations", message: "Automation 'Resolution floor — 1080p' dry-run matched 142 items" },
      ],
      capacity: 500,
      effective_level: "INFO",
    });
  }
  if (pathname === "/api/ui/shows") return json(paged(shows(scenario)));
  if (/^\/api\/ui\/shows\/\d+\/seasons$/.test(pathname)) return json([{ season_number: 1 }, { season_number: 2 }]);
  if (/^\/api\/ui\/shows\/\d+\/episodes$/.test(pathname)) return json(paged(episodes(scenario)));
  if (pathname === "/api/ui/episodes") return json(paged(episodes(scenario)));
  if (pathname === "/api/ui/movies") return json(paged(movies(scenario)));
  if (pathname === "/api/reporting/dashboards") return json(reportingDashboards());
  if (pathname.startsWith("/api/reporting/dashboards/")) {
    return json(reportingDashboard(pathname.split("/")[4], scenario));
  }
  if (pathname === "/api/automations") return json({ automations: scenario === "empty" ? [] : AUTOMATIONS });
  if (pathname === "/api/automations/templates") return json({ templates: AUTOMATION_TEMPLATES });
  if (pathname === "/api/automations/root-folders") {
    return json({ root_folders: [{ path: "/tv", media: "series", instances: ["primary"], item_count: 1204 }, { path: "/anime", media: "series", instances: ["anime"], item_count: 109 }, { path: "/movies", media: "movies", instances: ["primary"], item_count: 2871 }] });
  }
  if (pathname === "/api/automations/validate") {
    return json({ valid: true, next_fire_times: [ago(-3600), ago(-90000)], match_preview: { primary: 142 }, preview_sense: "non_conforming", preview_unit: "episodes" });
  }
  const runsMatch = pathname.match(/^\/api\/automations\/(\d+)\/runs$/);
  if (runsMatch) return json({ runs: AUTOMATION_RUNS.filter((r) => r.automation_id === Number(runsMatch[1])) });
  const runMatch = pathname.match(/^\/api\/automations\/runs\/(\d+)$/);
  if (runMatch) return json(automationRunDetail(Number(runMatch[1])));
  if (pathname === "/api/mal/overview") return json(MAL_OVERVIEW);
  if (pathname === "/api/mal/job-runs") return json(MAL_JOB_RUNS);
  if (pathname === "/api/operator/stuck-state") {
    return json({ job_locks: [], mal_job_runs_running: [], warehouse_sync_runs_running: [], job_run_summary_running: [] });
  }
  if (pathname.startsWith("/api/")) return json({ status: "ok" });
  void search;
  return null;
}
