export const PATHS = {
  home: "/",
  /** Folded into the Overview; kept as a redirect for bookmarks. */
  dashboard: "/dashboard",
  reporting: "/reporting",
  library: "/library",
  /** Combined sync progress, queue, webhooks, and manual actions */
  sync: "/sync",
  mal: "/mal",
  automations: "/automations",
  runs: "/runs",
  integrations: "/integrations",
  artwork: "/artwork",
  schedules: "/schedules",
  webhooks: "/webhooks",
  actions: "/actions",
  logs: "/logs",
  setup: "/setup",
  login: "/login",
} as const;

/** Routes that live under the "Setup" section of the top navigation. */
export const SETUP_SECTION_PATHS: readonly string[] = [PATHS.integrations, PATHS.artwork, PATHS.schedules, PATHS.logs];

export const APP_ROUTE_TITLES: Record<string, string> = {
  [PATHS.home]: "Overview",
  [PATHS.dashboard]: "Overview",
  [PATHS.reporting]: "Reports",
  [PATHS.library]: "Library",
  [PATHS.sync]: "Sync & Queue",
  [PATHS.mal]: "Anime",
  [PATHS.automations]: "Rules",
  [PATHS.runs]: "Sync Runs",
  [PATHS.integrations]: "Integrations",
  [PATHS.artwork]: "Artwork",
  [PATHS.schedules]: "Schedules",
  [PATHS.webhooks]: "Webhooks",
  [PATHS.actions]: "Manual Actions",
  [PATHS.logs]: "Logs",
  [PATHS.setup]: "Setup",
};

export function pathTitle(pathname: string): string {
  if (APP_ROUTE_TITLES[pathname]) return APP_ROUTE_TITLES[pathname];
  if (pathname === "/") return "Overview";
  return "Nebularr";
}
