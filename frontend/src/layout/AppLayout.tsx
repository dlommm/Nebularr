import { Suspense, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import {
  AlignJustify,
  BarChart2,
  BookOpen,
  Command,
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
  Sun,
  Zap,
} from "lucide-react";
import { api } from "../api";
import { useActionError } from "../hooks/useActionError";
import { useLocalStorageState } from "../hooks";
import { LegacyViewRedirect } from "./LegacyViewRedirect";
import { pathTitle, PATHS } from "../routes/paths";
import { DiagnosticsPanel } from "../components/ui";
import { SecurityBanner } from "../components/nebula/SecurityBanner";
import { PageFallback } from "../components/PageFallback";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import type { HealthDimensions } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  { to: PATHS.reporting, label: "Reporting", Icon: BarChart2 },
];

const NAV_CONFIG: NavItem[] = [
  { to: PATHS.integrations, label: "Integrations", Icon: Network },
  { to: PATHS.schedules, label: "Schedules", Icon: ListOrdered },
  { to: PATHS.logs, label: "Logs", Icon: FileText },
];

const DIM_LABELS: Record<keyof HealthDimensions, string> = {
  webhooks: "Queues",
  sync: "Sync",
  integrations: "Arr",
  mal: "MAL",
};

function healthTone(state: string | undefined): { dot: string; pill: string } {
  const s = (state ?? "ok").toLowerCase();
  if (s === "ok") return { dot: "bg-ok", pill: "border-ok/30 bg-ok/10 text-ok" };
  if (s === "warning") return { dot: "bg-warn", pill: "border-warn/30 bg-warn/10 text-warn" };
  return { dot: "bg-critical", pill: "border-critical/30 bg-critical/10 text-critical" };
}

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
  const [headerSearch, setHeaderSearch] = useState("");

  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: 15_000,
  });
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

  const overallHealth = status.data?.health_state;
  const tone = healthTone(overallHealth);
  const dimensions = status.data?.health_dimensions;
  const dimensionReasons = status.data?.health_dimension_reasons;
  const problemDims = dimensions
    ? (Object.keys(DIM_LABELS) as (keyof HealthDimensions)[]).filter(
        (k) => dimensions[k] != null && dimensions[k] !== "ok",
      )
    : [];

  const NavLinks = ({ onNavigate }: { onNavigate?: () => void }): JSX.Element => (
    <nav className="flex flex-1 flex-col gap-0.5 px-2 py-3" aria-label="App sections">
      <p className={cn("mb-1 px-2.5 text-[10px] font-semibold tracking-widest text-muted-foreground/80 uppercase", sidebarCollapsed && "sr-only")}>
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
              "group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors",
              isActive
                ? "bg-primary/10 text-foreground [&_svg]:text-primary"
                : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
              sidebarCollapsed && "justify-center px-2 py-2",
            )
          }
        >
          <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
          {!sidebarCollapsed ? <span>{label}</span> : null}
        </NavLink>
      ))}

      <Separator className="my-3 bg-sidebar-border" />
      <p
        className={cn(
          "mb-1 px-2.5 text-[10px] font-semibold tracking-widest text-muted-foreground/80 uppercase",
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
              "group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors",
              isActive
                ? "bg-primary/10 text-foreground [&_svg]:text-primary"
                : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
              sidebarCollapsed && "justify-center px-2 py-2",
            )
          }
        >
          <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
          {!sidebarCollapsed ? <span>{label}</span> : null}
        </NavLink>
      ))}

      {!sidebarCollapsed ? (
        <p className="mt-auto px-2.5 pt-4 text-[10px] text-muted-foreground/70">
          <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[9px]">⌘K</kbd> command palette
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
        <NavLinks />
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
                  <NavLinks onNavigate={() => setMobileOpen(false)} />
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
            </div>
          </div>
        </header>

        <main className="w-full min-w-0 max-w-full flex-1 overflow-x-hidden bg-transparent px-3 py-4 sm:px-4 lg:px-6 lg:py-5" id="main-content" tabIndex={-1}>
          <SecurityBanner />
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
          className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 px-3 pt-[12vh] backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          onClick={() => setCommandPalette(false)}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <h3 className="text-sm font-semibold">Command palette</h3>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">esc</kbd>
            </div>
            <div className="flex max-h-[min(50vh,360px)] flex-col gap-0.5 overflow-y-auto p-1.5">
              <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">Navigate</p>
              {[
                { label: "Go to home", to: PATHS.home },
                { label: "Go to dashboard", to: PATHS.dashboard },
                { label: "Go to library", to: PATHS.library },
                { label: "Go to reporting", to: PATHS.reporting },
                { label: "Go to logs", to: PATHS.logs },
              ].map(({ label, to }) => (
                <Button
                  key={to}
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start font-normal"
                  onClick={() => {
                    navigate(to);
                    setCommandPalette(false);
                  }}
                >
                  {label}
                </Button>
              ))}
              <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">Actions</p>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={() => runAction(() => api.runSync("sonarr", "incremental"), "palette sync sonarr")}
              >
                Run Sonarr incremental sync
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={() => runAction(() => api.runSync("radarr", "incremental"), "palette sync radarr")}
              >
                Run Radarr incremental sync
              </Button>
            </div>
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              Or use the sidebar. <Link to={PATHS.home} className="text-primary hover:underline" onClick={() => setCommandPalette(false)}>Home</Link>
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
