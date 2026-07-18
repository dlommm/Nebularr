import { Suspense, useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import {
  AlignJustify,
  BarChart2,
  BookOpen,
  Clapperboard,
  Command,
  FileText,
  Home,
  LayoutDashboard,
  ListOrdered,
  LogOut,
  Menu,
  Moon,
  Network,
  PanelLeftClose,
  PanelLeft,
  RefreshCw,
  Search,
  Sun,
  Zap,
} from "lucide-react";
import { api } from "../api";
import { useActionError } from "../hooks/useActionError";
import { ServerEventsContext, pollInterval, useServerEvents } from "../hooks/useServerEvents";
import { useLocalStorageState } from "../hooks";
import { queryKeys } from "../lib/queryKeys";
import { LegacyViewRedirect } from "./LegacyViewRedirect";
import { buildLibrarySearchParams } from "../pages/libraryUrlState";
import { pathTitle, PATHS } from "../routes/paths";
import { DiagnosticsPanel } from "../components/ui";
import { SecurityBanner } from "../components/nebula/SecurityBanner";
import { PageFallback } from "../components/PageFallback";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import { SessionExpiredDialog } from "../components/SessionExpiredDialog";
import type { HealthDimensions } from "@/types";
import { DIM_LABELS } from "@/constants/health";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import nebularrIcon from "@/assets/nebularr-icon.svg?url";
import { toast } from "sonner";

type NavItem = { to: string; label: string; end?: boolean; Icon: typeof Home };

const NAV_PRIMARY: NavItem[] = [
  { to: PATHS.home, label: "Home", end: true, Icon: Home },
  { to: PATHS.dashboard, label: "Dashboard", Icon: LayoutDashboard },
  { to: PATHS.library, label: "Library", Icon: BookOpen },
  { to: PATHS.sync, label: "Sync & Queue", Icon: Zap },
  { to: PATHS.mal, label: "MyAnimeList", Icon: Clapperboard },
  { to: PATHS.reporting, label: "Reporting", Icon: BarChart2 },
];

const NAV_CONFIG: NavItem[] = [
  { to: PATHS.integrations, label: "Integrations", Icon: Network },
  { to: PATHS.schedules, label: "Schedules", Icon: ListOrdered },
  { to: PATHS.logs, label: "Logs", Icon: FileText },
];

function healthTone(state: string | undefined): { dot: string; pill: string } {
  const s = (state ?? "ok").toLowerCase();
  if (s === "ok") return { dot: "bg-ok", pill: "border-ok/30 bg-ok/10 text-ok" };
  if (s === "warning") return { dot: "bg-warn", pill: "border-warn/30 bg-warn/10 text-warn" };
  return { dot: "bg-critical", pill: "border-critical/30 bg-critical/10 text-critical" };
}

function navLinkClassName(isActive: boolean, collapsed: boolean): string {
  return cn(
    "group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors",
    isActive
      ? "bg-primary/10 text-foreground [&_svg]:text-primary"
      : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
    collapsed && "justify-center px-2 py-2",
  );
}

/** Hoisted to module scope: an inline component definition inside AppLayout
    would be recreated every render, remounting (and losing focus/state in)
    the whole nav tree on every keystroke elsewhere in the shell. */
function NavLinks({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }): JSX.Element {
  return (
    <nav className="flex flex-1 flex-col gap-0.5 px-2 py-3" aria-label="App sections">
      <p className={cn("mb-1 px-2.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase", collapsed && "sr-only")}>
        Main
      </p>
      {NAV_PRIMARY.map(({ to, label, end, Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          title={collapsed ? label : undefined}
          onClick={onNavigate}
          className={({ isActive }) => navLinkClassName(isActive, collapsed)}
        >
          <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
          {!collapsed ? <span>{label}</span> : null}
        </NavLink>
      ))}

      <Separator className="my-3 bg-sidebar-border" />
      <p className={cn("mb-1 px-2.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase", collapsed && "sr-only")}>
        Settings
      </p>
      {NAV_CONFIG.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          title={collapsed ? label : undefined}
          onClick={onNavigate}
          className={({ isActive }) => navLinkClassName(isActive, collapsed)}
        >
          <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
          {!collapsed ? <span>{label}</span> : null}
        </NavLink>
      ))}

      {!collapsed ? (
        <p className="mt-auto px-2.5 pt-4 text-[11px] text-muted-foreground">
          <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[9px]">⌘K</kbd> command palette
        </p>
      ) : null}
    </nav>
  );
}

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
  return (el as HTMLElement).isContentEditable === true;
}

type PaletteCommand = {
  id: string;
  label: string;
  group: "Navigate" | "Actions";
  onSelect: () => void;
};

export function AppLayout(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setTheme, resolvedTheme } = useTheme();
  const { lastError, setLastError, errorContext, runAction } = useActionError();
  const [density, setDensity] = useLocalStorageState<"comfortable" | "compact">("nebularr.ui.density", "comfortable");
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState("nebularr.ui.sidebar-collapsed", false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [commandPalette, setCommandPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [headerSearch, setHeaderSearch] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);

  const serverEvents = useServerEvents();
  const status = useQuery({
    queryKey: queryKeys.status,
    queryFn: api.status,
    refetchInterval: pollInterval(serverEvents.connected, 15_000, 60_000),
  });
  const authStatus = useQuery({ queryKey: queryKeys.authStatus, queryFn: api.authStatus, staleTime: 60_000 });
  const showLogout = authStatus.data?.enabled === true && authStatus.data.authenticated;
  const currentTitle = pathTitle(location.pathname);

  const onLogout = async (): Promise<void> => {
    try {
      await api.authLogout();
    } catch {
      // The session cookie may already be invalid; continue to the login page.
    }
    queryClient.clear();
    navigate(PATHS.login, { replace: true });
  };

  useEffect(() => {
    const onSessionExpired = (): void => setSessionExpired(true);
    window.addEventListener("nebularr:session-expired", onSessionExpired);
    return () => window.removeEventListener("nebularr:session-expired", onSessionExpired);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPalette((v) => !v);
      }
      if (
        event.key === "/" &&
        location.pathname === PATHS.library &&
        !isEditableElement(document.activeElement)
      ) {
        event.preventDefault();
        document.getElementById("nebularr-library-search")?.focus();
      }
      if (event.key.toLowerCase() === "g" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
        event.preventDefault();
        navigate(PATHS.library);
      }
      if (event.key === "Escape") {
        setMobileOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [location.pathname, navigate]);

  const onHeaderSearch = (e: { preventDefault: () => void }): void => {
    e.preventDefault();
    const q = headerSearch.trim();
    // URL-driven so the Library page picks it up even when already mounted;
    // carries the persisted mode/filters so searching never resets the view.
    navigate(q ? `${PATHS.library}?${buildLibrarySearchParams(q).toString()}` : PATHS.library);
    setHeaderSearch("");
  };

  const overallHealth = status.data?.health_state;
  const tone = healthTone(overallHealth);
  const dimensions = status.data?.health_dimensions;
  const dimensionReasons = status.data?.health_dimension_reasons;
  const problemDims = dimensions
    ? (Object.keys(DIM_LABELS) as (keyof HealthDimensions)[]).filter(
        (k) => dimensions[k] != null && dimensions[k] !== "ok",
      )
    : [];

  const paletteCommands = useMemo<PaletteCommand[]>(
    () => [
      { id: "nav-home", label: "Go to home", group: "Navigate", onSelect: () => navigate(PATHS.home) },
      { id: "nav-dashboard", label: "Go to dashboard", group: "Navigate", onSelect: () => navigate(PATHS.dashboard) },
      { id: "nav-library", label: "Go to library", group: "Navigate", onSelect: () => navigate(PATHS.library) },
      { id: "nav-reporting", label: "Go to reporting", group: "Navigate", onSelect: () => navigate(PATHS.reporting) },
      { id: "nav-logs", label: "Go to logs", group: "Navigate", onSelect: () => navigate(PATHS.logs) },
      {
        id: "action-sync-sonarr",
        label: "Run Sonarr incremental sync",
        group: "Actions",
        onSelect: () =>
          void runAction(() => api.runSync("sonarr", "incremental"), "palette sync sonarr", {
            successMessage: "Sonarr incremental sync queued",
          }),
      },
      {
        id: "action-sync-radarr",
        label: "Run Radarr incremental sync",
        group: "Actions",
        onSelect: () =>
          void runAction(() => api.runSync("radarr", "incremental"), "palette sync radarr", {
            successMessage: "Radarr incremental sync queued",
          }),
      },
    ],
    [navigate, runAction],
  );

  const filteredCommands = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    if (!q) return paletteCommands;
    return paletteCommands.filter((command) => command.label.toLowerCase().includes(q));
  }, [paletteCommands, paletteQuery]);

  useEffect(() => {
    setPaletteIndex(0);
  }, [paletteQuery]);

  useEffect(() => {
    if (!commandPalette) {
      setPaletteQuery("");
      setPaletteIndex(0);
    }
  }, [commandPalette]);

  const runCommand = (command: PaletteCommand | undefined): void => {
    if (!command) return;
    command.onSelect();
    setCommandPalette(false);
  };

  return (
    <ServerEventsContext.Provider value={serverEvents}>
    <div className={cn("flex min-h-svh w-full min-w-0", density === "compact" && "density-compact")}>
      <a href="#main-content" className="skip-to-main">
        Skip to content
      </a>
      <LegacyViewRedirect />
      <SessionExpiredDialog open={sessionExpired} />

      {/* Desktop sidebar */}
      <aside
        className={cn(
          "relative z-30 hidden shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col",
          sidebarCollapsed ? "w-[64px]" : "w-[224px] lg:w-[240px]",
        )}
        aria-label="Primary"
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-sidebar-border px-3">
          <img src={nebularrIcon} alt="" className="size-8 shrink-0 rounded-lg" />
          {!sidebarCollapsed ? (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold tracking-tight">Nebularr</p>
            </div>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
          </Button>
        </div>
        <NavLinks collapsed={sidebarCollapsed} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-20 border-b border-border glass-panel">
          <div className="flex h-14 min-w-0 items-center gap-2 px-3 sm:gap-3 sm:px-4 lg:px-6">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 md:hidden"
                aria-label="Open menu"
                onClick={() => setMobileOpen(true)}
              >
                <Menu className="size-4" />
              </Button>
              <SheetContent side="left" className="w-[min(100vw,280px)] border-sidebar-border bg-sidebar p-0">
                <SheetHeader className="border-b border-sidebar-border px-4 py-3 text-left">
                  <SheetTitle className="flex items-center gap-2 text-base font-semibold">
                    <img src={nebularrIcon} alt="" className="size-7 rounded-md" />
                    Nebularr
                  </SheetTitle>
                </SheetHeader>
                <div className="p-2">
                  <NavLinks collapsed={false} onNavigate={() => setMobileOpen(false)} />
                </div>
              </SheetContent>
            </Sheet>

            <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight" id="page-title">
              {currentTitle}
            </h1>

            <div className="flex min-w-0 items-center gap-1.5 overflow-hidden" aria-label="System health">
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                  tone.pill,
                )}
                title={
                  dimensions
                    ? (Object.keys(DIM_LABELS) as (keyof HealthDimensions)[])
                        .filter((k) => dimensions[k] != null)
                        .map((k) => {
                          const reasons = dimensionReasons?.[k];
                          return `${DIM_LABELS[k]}: ${dimensions[k]}${reasons?.length ? ` (${reasons.join(", ")})` : ""}`;
                        })
                        .join(" · ")
                    : undefined
                }
              >
                <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden />
                {overallHealth ?? "—"}
              </span>
              {problemDims.map((k) => {
                const t = healthTone(dimensions?.[k]);
                const reasons = dimensionReasons?.[k];
                return (
                  <span
                    key={k}
                    className={cn(
                      "hidden shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium sm:inline-flex",
                      t.pill,
                    )}
                    title={reasons?.length ? reasons.join(", ") : undefined}
                  >
                    {DIM_LABELS[k]}: {dimensions?.[k]}
                  </span>
                );
              })}
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-1">
              <form onSubmit={onHeaderSearch} className="relative hidden lg:block">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  name="q"
                  value={headerSearch}
                  onChange={(e) => setHeaderSearch(e.target.value)}
                  placeholder="Search library…"
                  className="h-8 w-52 rounded-lg border-border bg-muted/50 pl-8 pr-2 text-[13px] shadow-none focus-visible:bg-background"
                  aria-label="Search library"
                />
              </form>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setCommandPalette(true)}
                className="hidden text-muted-foreground sm:inline-flex"
                title="Command palette (⌘K)"
                aria-label="Open command palette"
              >
                <Command className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => setDensity(density === "comfortable" ? "compact" : "comfortable")}
                title={density === "comfortable" ? "Switch to compact density" : "Switch to comfortable density"}
                aria-label="Toggle display density"
              >
                <AlignJustify className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={async () => {
                  await queryClient.invalidateQueries();
                  toast.success("Data refreshed");
                }}
                title="Refresh all"
                aria-label="Refresh all"
              >
                <RefreshCw className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
                title="Toggle theme"
                aria-label="Toggle color theme"
              >
                {resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
              {showLogout ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  onClick={onLogout}
                  title="Log out"
                  aria-label="Log out"
                >
                  <LogOut className="size-4" />
                </Button>
              ) : null}
            </div>
          </div>
        </header>

        <main className="w-full min-w-0 max-w-full flex-1 overflow-x-hidden bg-transparent px-3 py-4 sm:px-4 lg:px-6 lg:py-5" id="main-content" tabIndex={-1}>
          <SecurityBanner />
          <DiagnosticsPanel message={lastError} context={errorContext} clear={() => setLastError(null)} />
          <RouteErrorBoundary key={location.pathname}>
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </RouteErrorBoundary>
        </main>
      </div>

      <Dialog open={commandPalette} onOpenChange={setCommandPalette}>
        <DialogContent showCloseButton={false} className="max-w-md gap-0 overflow-hidden p-0 sm:max-w-md">
          <DialogHeader className="flex-row items-center justify-between space-y-0 border-b border-border px-4 py-2.5">
            <DialogTitle className="text-sm font-semibold">Command palette</DialogTitle>
          </DialogHeader>
          <div className="p-2">
            <Input
              autoFocus
              value={paletteQuery}
              onChange={(event) => setPaletteQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setPaletteIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setPaletteIndex((i) => Math.max(i - 1, 0));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  runCommand(filteredCommands[paletteIndex]);
                }
              }}
              placeholder="Type a command or search…"
              aria-label="Filter commands"
              role="combobox"
              aria-expanded="true"
              aria-controls="command-palette-list"
              aria-activedescendant={filteredCommands[paletteIndex]?.id}
              className="h-9"
            />
          </div>
          <div
            id="command-palette-list"
            role="listbox"
            aria-label="Commands"
            className="flex max-h-[min(50vh,360px)] flex-col gap-0.5 overflow-y-auto p-1.5 pt-0"
          >
            {filteredCommands.length === 0 ? (
              <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">No matching commands.</p>
            ) : (
              (["Navigate", "Actions"] as const).map((group) => {
                const items = filteredCommands.filter((command) => command.group === group);
                if (items.length === 0) return null;
                return (
                  <div key={group}>
                    <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                      {group}
                    </p>
                    {items.map((command) => {
                      const idx = filteredCommands.indexOf(command);
                      const active = idx === paletteIndex;
                      return (
                        <Button
                          key={command.id}
                          id={command.id}
                          role="option"
                          aria-selected={active}
                          variant="ghost"
                          size="sm"
                          className={cn("w-full justify-start font-normal", active && "bg-accent text-accent-foreground")}
                          onMouseEnter={() => setPaletteIndex(idx)}
                          onClick={() => runCommand(command)}
                        >
                          {command.label}
                        </Button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
          <p className="flex items-center gap-3 border-t border-border px-4 py-2 text-xs text-muted-foreground">
            <span>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">↑↓</kbd> navigate
            </span>
            <span>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">↵</kbd> select
            </span>
            <span>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">esc</kbd> close
            </span>
          </p>
        </DialogContent>
      </Dialog>
    </div>
    </ServerEventsContext.Provider>
  );
}
