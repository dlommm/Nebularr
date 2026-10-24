import { Suspense, useEffect, useMemo, useState, type CSSProperties } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { AlignJustify, Command, LogOut, Moon, RefreshCw, Search, Sun } from "lucide-react";
import { api } from "../api";
import { useActionError } from "../hooks/useActionError";
import { ServerEventsContext, pollInterval, useServerEvents } from "../hooks/useServerEvents";
import { useLocalStorageState } from "../hooks";
import { useHeaderScrim } from "../hooks/useHeaderScrim";
import { queryKeys } from "../lib/queryKeys";
import { LegacyViewRedirect } from "./LegacyViewRedirect";
import { buildLibrarySearchParams } from "../pages/libraryUrlState";
import { PATHS, SETUP_SECTION_PATHS } from "../routes/paths";
import { ShellNotices } from "./ShellNotices";
import { PageFallback } from "../components/PageFallback";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import { StatusDot } from "@/components/ns/Page";
import type { HealthDimensions } from "@/types";
import { DIM_LABELS } from "@/constants/health";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type NavItem = { to: string; label: string; end?: boolean; match?: readonly string[] };

const NAV: NavItem[] = [
  { to: PATHS.home, label: "Overview", end: true },
  { to: PATHS.library, label: "Library" },
  { to: PATHS.sync, label: "Sync" },
  { to: PATHS.reporting, label: "Reports" },
  { to: PATHS.automations, label: "Rules" },
  { to: PATHS.mal, label: "Anime" },
  { to: PATHS.integrations, label: "Setup", match: SETUP_SECTION_PATHS },
];

/** Phone tab bar: the four destinations people reach for, the rest under More. */
const TAB_BAR: NavItem[] = NAV.slice(0, 3).concat(NAV[4]);
const TAB_MORE: NavItem[] = [NAV[3], NAV[5], ...SETUP_SECTION_PATHS.map((to) => ({ to, label: setupLabel(to) }))];

function setupLabel(path: string): string {
  if (path === PATHS.integrations) return "Integrations";
  if (path === PATHS.artwork) return "Artwork";
  if (path === PATHS.schedules) return "Schedules";
  return "Logs";
}

/** Pages that draw their own full-bleed hero under a transparent header. */
const FULL_BLEED_PATHS = new Set<string>([PATHS.home]);

const TAB_ICONS: Record<string, JSX.Element> = {
  [PATHS.home]: <path d="M4 12h4l2-6 4 12 2-6h4" />,
  [PATHS.library]: (
    <>
      <rect x="4" y="4" width="6" height="16" />
      <rect x="14" y="4" width="6" height="16" />
    </>
  ),
  [PATHS.sync]: <path d="M4 8h13l-3-3M20 16H7l3 3" />,
  [PATHS.automations]: <path d="M5 6h14M5 12h10M5 18h6" />,
};

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

function navActive(item: NavItem, pathname: string): boolean {
  if (item.match) return item.match.includes(pathname);
  if (item.end) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

export function AppLayout(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setTheme, resolvedTheme } = useTheme();
  const { runAction } = useActionError();
  const [density, setDensity] = useLocalStorageState<"comfortable" | "compact">("nebularr.ui.density", "comfortable");
  const [moreOpen, setMoreOpen] = useState(false);
  const [commandPalette, setCommandPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [headerSearch, setHeaderSearch] = useState("");

  const serverEvents = useServerEvents();
  const status = useQuery({
    queryKey: queryKeys.status,
    queryFn: api.status,
    refetchInterval: pollInterval(serverEvents.connected, 15_000, 60_000),
  });
  const authStatus = useQuery({ queryKey: queryKeys.authStatus, queryFn: api.authStatus, staleTime: 60_000 });
  const healthz = useQuery({ queryKey: queryKeys.healthz, queryFn: api.healthz, staleTime: 300_000 });
  const showLogout = authStatus.data?.enabled === true && authStatus.data.authenticated;
  const fullBleed = FULL_BLEED_PATHS.has(location.pathname);
  const [scrimStrength] = useHeaderScrim();
  const [scrolled, setScrolled] = useState(false);

  // Over fanart the bar settles into glass once the hero starts to scroll.
  useEffect(() => {
    if (!fullBleed) return;
    const onScroll = (): void => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [fullBleed]);

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
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPalette((v) => !v);
      }
      if (event.key === "/" && !isEditableElement(document.activeElement)) {
        event.preventDefault();
        const librarySearch = document.getElementById("nebularr-library-search");
        (librarySearch ?? document.getElementById("nebularr-header-search"))?.focus();
      }
      if (event.key.toLowerCase() === "g" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
        event.preventDefault();
        navigate(PATHS.library);
      }
      if (event.key === "Escape") {
        setMoreOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  const onHeaderSearch = (e: { preventDefault: () => void }): void => {
    e.preventDefault();
    const q = headerSearch.trim();
    // URL-driven so the Library page picks it up even when already mounted;
    // carries the persisted mode/filters so searching never resets the view.
    navigate(q ? `${PATHS.library}?${buildLibrarySearchParams(q).toString()}` : PATHS.library);
    setHeaderSearch("");
  };

  const overallHealth = status.data?.health_state;
  const dimensions = status.data?.health_dimensions;
  const dimensionReasons = status.data?.health_dimension_reasons;
  const healthTitle = dimensions
    ? (Object.keys(DIM_LABELS) as (keyof HealthDimensions)[])
        .filter((k) => dimensions[k] != null)
        .map((k) => {
          const reasons = dimensionReasons?.[k];
          return `${DIM_LABELS[k]}: ${dimensions[k]}${reasons?.length ? ` (${reasons.join(", ")})` : ""}`;
        })
        .join(" · ")
    : undefined;

  const paletteCommands = useMemo<PaletteCommand[]>(
    () => [
      ...NAV.map((item) => ({
        id: `nav-${item.label.toLowerCase()}`,
        label: `Go to ${item.label.toLowerCase()}`,
        group: "Navigate" as const,
        onSelect: () => navigate(item.to),
      })),
      { id: "nav-logs", label: "Go to logs", group: "Navigate", onSelect: () => navigate(PATHS.logs) },
      { id: "nav-artwork", label: "Go to artwork settings", group: "Navigate", onSelect: () => navigate(PATHS.artwork) },
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

  const iconButton = cn("text-muted-foreground hover:text-foreground", fullBleed && "text-foreground/75");

  return (
    <ServerEventsContext.Provider value={serverEvents}>
      <div className={cn("relative flex min-h-svh w-full min-w-0 flex-col pb-20 md:pb-0", density === "compact" && "density-compact")}>
        <a href="#main-content" className="skip-to-main">
          Skip to content
        </a>
        <LegacyViewRedirect />

        <header
          data-scrolled={fullBleed && scrolled ? "" : undefined}
          style={fullBleed ? ({ "--art-scrim": scrimStrength } as CSSProperties) : undefined}
          className={cn(
            "z-30 w-full",
            // Over fanart the header always reads light-on-dark (whatever the
            // theme or the art's brightness): dark tokens over a blurred,
            // lightly tinted band of the art.
            fullBleed
              ? "dark fixed inset-x-0 top-0 art-scrim text-foreground"
              : "sticky top-0 border-b border-border glass-panel-strong",
          )}
        >
          <div className="mx-auto flex w-full max-w-[1360px] flex-wrap items-center gap-x-8 gap-y-1 px-4 py-2.5 sm:px-10">
            <NavLink to={PATHS.home} className="flex items-baseline gap-2.5 py-2" aria-label="Nebularr overview">
              <span className="cond text-[26px] leading-none font-[800]">Nebularr</span>
              {healthz.data?.version ? (
                <span className="font-mono text-[11px] text-subtle-foreground">v{healthz.data.version}</span>
              ) : null}
            </NavLink>

            <nav aria-label="Main" className="order-3 hidden w-full gap-x-6 md:order-none md:flex md:w-auto md:flex-1 md:flex-wrap">
              {NAV.map((item) => {
                const active = navActive(item, location.pathname);
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "border-b-2 py-3 text-sm transition-colors",
                      active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                      fullBleed && !active && "text-foreground/75",
                    )}
                  >
                    {item.label}
                  </NavLink>
                );
              })}
            </nav>

            <div className="ml-auto flex items-center gap-1">
              <span
                className="mr-2 hidden items-center gap-2 text-xs text-muted-foreground lg:inline-flex"
                title={healthTitle}
                aria-label={`System health: ${overallHealth ?? "unknown"}`}
              >
                <StatusDot state={overallHealth} className="size-2" />
                {overallHealth ?? "—"}
              </span>
              <form onSubmit={onHeaderSearch} className="relative hidden lg:block" role="search">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-subtle-foreground" aria-hidden />
                <Input
                  id="nebularr-header-search"
                  name="q"
                  value={headerSearch}
                  onChange={(e) => setHeaderSearch(e.target.value)}
                  placeholder="Show, movie, codec or path"
                  className={cn("h-9 w-64 pl-9 text-[13px]", fullBleed && "border-transparent bg-background/55 backdrop-blur")}
                  aria-label="Search library"
                />
              </form>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setCommandPalette(true)}
                className={cn(iconButton, "hidden sm:inline-flex")}
                title="Command palette (⌘K)"
                aria-label="Open command palette"
              >
                <Command className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={iconButton}
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
                className={iconButton}
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
                className={iconButton}
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
                  className={iconButton}
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

        <main className="w-full min-w-0 flex-1 overflow-x-clip" id="main-content" tabIndex={-1}>
          <div className={cn(!fullBleed && "mx-auto w-full max-w-[1360px] px-4 pt-4 sm:px-10")}>
            {fullBleed ? null : <ShellNotices />}
            <RouteErrorBoundary key={location.pathname}>
              <Suspense fallback={<PageFallback />}>
                <Outlet />
              </Suspense>
            </RouteErrorBoundary>
          </div>
        </main>

        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-border px-1.5 pt-1.5 pb-[max(env(safe-area-inset-bottom),12px)] glass-panel-strong md:hidden"
        >
          {TAB_BAR.map((item) => {
            const active = navActive(item, location.pathname);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-12 flex-col items-center justify-center gap-1 text-[11px]",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                  {TAB_ICONS[item.to]}
                </svg>
                {item.label}
              </NavLink>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className={cn(
              "flex min-h-12 flex-col items-center justify-center gap-1 text-[11px]",
              TAB_MORE.some((item) => navActive(item, location.pathname)) ? "text-foreground" : "text-muted-foreground",
            )}
            aria-haspopup="dialog"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="6" cy="12" r="1.4" />
              <circle cx="12" cy="12" r="1.4" />
              <circle cx="18" cy="12" r="1.4" />
            </svg>
            More
          </button>
        </nav>

        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetContent side="bottom" className="border-border bg-popover p-0">
            <SheetHeader className="border-b border-border px-4 py-3 text-left">
              <SheetTitle className="cond text-2xl font-bold">More</SheetTitle>
            </SheetHeader>
            <nav aria-label="More sections" className="flex flex-col px-4 pb-8">
              {TAB_MORE.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setMoreOpen(false)}
                  className={({ isActive }) =>
                    cn("flex min-h-12 items-center border-b border-border text-base", isActive ? "text-foreground" : "text-muted-foreground")
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </SheetContent>
        </Sheet>

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
                      <p className="px-2.5 pt-1.5 pb-1 text-xs text-subtle-foreground">{group}</p>
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
