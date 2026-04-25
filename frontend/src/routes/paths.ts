export const PATHS = {
  home: "/",
  dashboard: "/dashboard",
  reporting: "/reporting",
  library: "/library",
  /** Combined sync progress, queue, webhooks, and manual actions */
  sync: "/sync",
  runs: "/runs",
  integrations: "/integrations",
  schedules: "/schedules",
  webhooks: "/webhooks",
  actions: "/actions",
  logs: "/logs",
  setup: "/setup",
} as const;

export const APP_ROUTE_TITLES: Record<string, string> = {
  [PATHS.home]: "Home",
  [PATHS.dashboard]: "Dashboard",
  [PATHS.reporting]: "Reporting",
  [PATHS.library]: "Library",
  [PATHS.sync]: "Sync & Queue",
  [PATHS.runs]: "Sync Runs",
  [PATHS.integrations]: "Integrations",
  [PATHS.schedules]: "Schedules",
  [PATHS.webhooks]: "Webhooks",
  [PATHS.actions]: "Manual Actions",
  [PATHS.logs]: "Logs",
  [PATHS.setup]: "Setup",
};

export function pathTitle(pathname: string): string {
  if (APP_ROUTE_TITLES[pathname]) return APP_ROUTE_TITLES[pathname];
  if (pathname === "/") return "Home";
  return "Nebularr";
}
