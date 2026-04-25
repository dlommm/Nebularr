import { Suspense, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import {
  BarChart2,
  BookOpen,
  FileText,
  Home,
  LayoutDashboard,
  ListOrdered,
  Menu,
  Moon,
  Network,
  PanelLeftClose,
  PanelLeft,
  RefreshCw,
  Search,
  Sliders,
  Sun,
  Zap,
} from "lucide-react";
import { api } from "../api";
import { useActionError } from "../hooks/useActionError";
import { useLocalStorageState } from "../hooks";
import { LegacyViewRedirect } from "./LegacyViewRedirect";
import { pathTitle, PATHS } from "../routes/paths";
import { DiagnosticsPanel } from "../components/ui";
import { PageFallback } from "../components/PageFallback";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import nebularrIcon from "@/assets/nebularr-icon.svg?url";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

type NavItem = { to: string; label: string; end?: boolean; Icon: typeof Home };

const NAV_PRIMARY: NavItem[] = [
  { to: PATHS.home, label: "Home", end: true, Icon: Home },
  { to: PATHS.dashboard, label: "Dashboard", Icon: LayoutDashboard },
  { to: PATHS.library, label: "Library", Icon: BookOpen },
  { to: PATHS.sync, label: "Sync & Queue", Icon: Zap },
  { to: PATHS.reporting, label: "Reporting", Icon: BarChart2 },
];

const NAV_CONFIG: NavItem[] = [
  { to: PATHS.integrations, label: "Integrations", Icon: Network },
  { to: PATHS.schedules, label: "Schedules", Icon: ListOrdered },
  { to: PATHS.logs, label: "Logs", Icon: FileText },
];

function healthPillClass(state: string | undefined): string {
  const s = (state ?? "ok").toLowerCase();
  if (s === "ok") return "border-emerald-500/50 bg-emerald-500/10 text-emerald-200";
  if (s === "warning") return "border-amber-500/50 bg-amber-500/10 text-amber-200";
  return "border-rose-500/50 bg-rose-500/10 text-rose-200";
}

export function AppLayout(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { lastError, setLastError, errorContext, runAction } = useActionError();
  const [density, setDensity] = useLocalStorageState<"comfortable" | "compact">("nebularr.ui.density", "comfortable");
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState("nebularr.ui.sidebar-collapsed", false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [commandPalette, setCommandPalette] = useState(false);
  const [headerSearch, setHeaderSearch] = useState("");

  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: 15_000,
  });
  const healthz = useQuery({ queryKey: ["healthz"], queryFn: api.healthz, refetchInterval: 60_000 });

  const currentTitle = pathTitle(location.pathname);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPalette((v) => !v);
      }
      if (event.key === "/" && location.pathname === PATHS.library && document.activeElement?.id !== "nebularr-library-search") {
        event.preventDefault();
        document.getElementById("nebularr-library-search")?.focus();
      }
      if (event.key.toLowerCase() === "g" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
        event.preventDefault();
        navigate(PATHS.library);
      }
      if (event.key === "Escape") {
        setCommandPalette(false);
        setMobileOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [location.pathname, navigate]);

  const onHeaderSearch = (e: { preventDefault: () => void }): void => {
    e.preventDefault();
    const q = headerSearch.trim();
    if (q) {
      sessionStorage.setItem("nebularr.library.pendingSearch", q);
    }
    navigate(PATHS.library);
    setHeaderSearch("");
  };

  const NavLinks = ({ onNavigate }: { onNavigate?: () => void }): JSX.Element => (
    <nav className="flex flex-1 flex-col gap-1 px-2 py-2" aria-label="App sections">
      <p className={cn("px-2 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase", sidebarCollapsed && "sr-only")}>
        Main
      </p>
      {NAV_PRIMARY.map(({ to, label, end, Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          title={sidebarCollapsed ? label : undefined}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "group flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-gradient-to-r from-cyan-500/20 to-violet-600/20 text-foreground ring-1 ring-cyan-500/30"
                : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              sidebarCollapsed && "justify-center px-2",
            )
          }
        >
          <Icon className="size-[18px] shrink-0 opacity-90" strokeWidth={1.75} aria-hidden />
          {!sidebarCollapsed ? <span>{label}</span> : null}
        </NavLink>
      ))}

      <Separator className="my-2 bg-white/10" />
      <p
        className={cn(
          "px-2 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase",
          sidebarCollapsed && "sr-only",
        )}
      >
        Settings
      </p>
      {NAV_CONFIG.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          title={sidebarCollapsed ? label : undefined}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "group flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-gradient-to-r from-cyan-500/20 to-violet-600/20 text-foreground ring-1 ring-cyan-500/30"
                : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              sidebarCollapsed && "justify-center px-2",
            )
          }
        >
          <Icon className="size-[18px] shrink-0 opacity-90" strokeWidth={1.75} aria-hidden />
          {!sidebarCollapsed ? <span>{label}</span> : null}
        </NavLink>
      ))}

      {!sidebarCollapsed ? (
        <p className="mt-3 px-2 text-[10px] text-muted-foreground/80">
          <kbd className="rounded border border-white/10 bg-white/5 px-1 py-0.5 font-mono text-[9px]">⌘K</kbd> command palette
        </p>
      ) : null}
    </nav>
  );

  return (
    <div className={cn("flex min-h-svh w-full min-w-0", density === "compact" && "density-compact")}>
      <a href="#main-content" className="skip-to-main">
        Skip to content
      </a>
      <LegacyViewRedirect />

      {/* Desktop sidebar */}
      <aside
        className={cn(
          "relative z-30 hidden shrink-0 border-r border-white/10 glass-panel-strong md:flex md:flex-col",
          sidebarCollapsed ? "w-[72px]" : "w-[240px] lg:w-[256px]",
        )}
        aria-label="Primary"
      >
        <div className="flex h-14 items-center gap-2 border-b border-white/10 px-3">
          <img src={nebularrIcon} alt="" className="size-9 rounded-lg border border-cyan-500/30 bg-[#0e1630] p-0.5" />
          {!sidebarCollapsed ? (
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold tracking-tight">Nebularr</p>
              <p className="truncate text-[11px] text-muted-foreground">Control plane</p>
            </div>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
          </Button>
        </div>
        <NavLinks />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-20 border-b border-white/10 glass-panel">
          <div className="flex flex-col gap-3 px-3 py-2 sm:px-4 lg:px-5">
            <div className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                className="shrink-0 md:hidden"
                aria-label="Open menu"
                onClick={() => setMobileOpen(true)}
              >
                <Menu className="size-4" />
              </Button>
              <SheetContent side="left" className="w-[min(100vw,280px)] border-white/10 bg-[#0e1630]/95 p-0">
                <SheetHeader className="border-b border-white/10 px-4 py-3 text-left">
                  <SheetTitle className="flex items-center gap-2 text-base font-semibold">
                    <img src={nebularrIcon} alt="" className="size-8 rounded-md border border-cyan-500/30" />
                    Nebularr
                  </SheetTitle>
                </SheetHeader>
                <div className="p-2">
                  <NavLinks onNavigate={() => setMobileOpen(false)} />
                </div>
              </SheetContent>
            </Sheet>

            <div className="min-w-0 flex-1">
              <h1 className="truncate font-heading text-lg font-semibold tracking-tight sm:text-xl" id="page-title">
                {currentTitle}
              </h1>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground sm:text-xs">
                <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5", healthPillClass(status.data?.health_state))}>
                  health: {status.data?.health_state ?? "—"}
                </span>
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5">sync: {status.data?.active_sync_count ?? "—"}</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5">webhooks: {status.data?.webhook_queue_open ?? "—"}</span>
                {status.data?.mal_sync ? (
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5">
                    MAL:{" "}
                    {status.data.mal_sync.running.length > 0
                      ? `running (${status.data.mal_sync.running.map((r) => r.job_type).join(", ")})`
                      : "idle"}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1 sm:gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setCommandPalette(true)}
                className="hidden sm:inline-flex"
                title="Command palette (⌘K)"
              >
                <Sliders className="size-4" />
                <span className="ml-1 hidden lg:inline">Palette</span>
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => setDensity(density === "comfortable" ? "compact" : "comfortable")}>
                {density === "comfortable" ? "Comfort" : "Compact"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
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
                variant="secondary"
                size="icon-sm"
                onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
                title="Toggle theme"
                aria-label="Toggle color theme"
              >
                {resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger
                  className="rounded-full border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="User menu"
                >
                  <Avatar className="size-8 border border-cyan-500/30">
                    <AvatarImage src={nebularrIcon} alt="" />
                    <AvatarFallback className="bg-cyan-500/20 text-[10px]">NB</AvatarFallback>
                  </Avatar>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 border-white/10 bg-popover/95">
                  <DropdownMenuLabel className="font-normal">
                    <div className="text-sm font-medium">Nebularr</div>
                    <div className="text-xs text-muted-foreground">v{healthz.data?.version ?? "…"}</div>
                    <div className="text-[10px] text-muted-foreground/80">theme: {theme}</div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate(PATHS.home)}>Home</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate(PATHS.dashboard)}>Dashboard</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate(PATHS.library)}>Library</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            </div>

            <form onSubmit={onHeaderSearch} className="w-full min-w-0 max-w-2xl">
              <div className="relative w-full">
                <Search className="pointer-events-none absolute left-3 top-1/2 z-[1] size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  name="q"
                  value={headerSearch}
                  onChange={(e) => setHeaderSearch(e.target.value)}
                  placeholder="Search library…"
                  className="h-9 w-full min-w-0 border-white/10 bg-white/5 pl-10 pr-3 text-sm"
                  aria-label="Search library"
                />
              </div>
            </form>
          </div>
        </header>

        <main className="w-full min-w-0 max-w-full flex-1 overflow-x-hidden bg-transparent px-3 py-4 sm:px-4 lg:px-6" id="main-content" tabIndex={-1}>
          <DiagnosticsPanel message={lastError} context={errorContext} clear={() => setLastError(null)} />
          <RouteErrorBoundary>
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </RouteErrorBoundary>
        </main>
      </div>

      {commandPalette ? (
        <div
          className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 px-3 pt-[10vh] backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          onClick={() => setCommandPalette(false)}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-white/10 glass-panel-strong p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 font-heading text-base font-semibold">Command palette</h3>
            <div className="flex max-h-[min(50vh,360px)] flex-col gap-1.5 overflow-y-auto">
              <Button variant="secondary" className="w-full justify-start" onClick={() => { navigate(PATHS.home); setCommandPalette(false); }}>
                Go to home
              </Button>
              <Button variant="secondary" className="w-full justify-start" onClick={() => { navigate(PATHS.dashboard); setCommandPalette(false); }}>
                Go to dashboard
              </Button>
              <Button variant="secondary" className="w-full justify-start" onClick={() => { navigate(PATHS.library); setCommandPalette(false); }}>
                Go to library
              </Button>
              <Button variant="secondary" className="w-full justify-start" onClick={() => { navigate(PATHS.reporting); setCommandPalette(false); }}>
                Go to reporting
              </Button>
              <Button variant="secondary" className="w-full justify-start" onClick={() => { navigate(PATHS.logs); setCommandPalette(false); }}>
                Go to logs
              </Button>
              <Button
                className="w-full justify-start"
                onClick={() => runAction(() => api.runSync("sonarr", "incremental"), "palette sync sonarr")}
              >
                Run Sonarr incremental
              </Button>
              <Button
                variant="secondary"
                className="w-full justify-start"
                onClick={() => runAction(() => api.runSync("radarr", "incremental"), "palette sync radarr")}
              >
                Run Radarr incremental
              </Button>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Or use the sidebar. <Link to={PATHS.home} className="text-cyan-300 hover:underline" onClick={() => setCommandPalette(false)}>Home</Link>
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
