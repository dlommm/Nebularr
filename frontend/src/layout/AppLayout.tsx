import { Suspense, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart2,
  BookOpen,
  Home,
  LayoutDashboard,
  ListOrdered,
  Network,
  Server,
  FileText,
  Inbox,
  Sliders,
  Wrench,
} from "lucide-react";
import { api } from "../api";
import { useActionError } from "../hooks/useActionError";
import { useLocalStorageState } from "../hooks";
import { LegacyViewRedirect } from "./LegacyViewRedirect";
import { pathTitle, PATHS } from "../routes/paths";
import { DiagnosticsPanel } from "../components/ui";
import { PageFallback } from "../components/PageFallback";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
const NAV: { to: string; label: string; end?: boolean; Icon: typeof Home }[] = [
  { to: PATHS.home, label: "Home", end: true, Icon: Home },
  { to: PATHS.dashboard, label: "Dashboard", Icon: LayoutDashboard },
  { to: PATHS.reporting, label: "Reporting", Icon: BarChart2 },
  { to: PATHS.library, label: "Library", Icon: BookOpen },
  { to: PATHS.runs, label: "Sync runs", Icon: Server },
  { to: PATHS.integrations, label: "Integrations", Icon: Network },
  { to: PATHS.schedules, label: "Schedules", Icon: ListOrdered },
  { to: PATHS.webhooks, label: "Webhooks", Icon: Inbox },
  { to: PATHS.actions, label: "Manual actions", Icon: Wrench },
  { to: PATHS.logs, label: "Logs", Icon: FileText },
];

export function AppLayout(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { lastError, setLastError, errorContext, runAction } = useActionError();
  const [density, setDensity] = useLocalStorageState<"comfortable" | "compact">("nebularr.ui.density", "comfortable");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [commandPalette, setCommandPalette] = useState(false);

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
        setCommandPalette((value) => !value);
      }
      if (event.key === "/" && location.pathname === PATHS.library && document.activeElement?.id !== "nebularr-library-search") {
        event.preventDefault();
        document.getElementById("nebularr-library-search")?.focus();
      }
      if (event.key.toLowerCase() === "g" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        navigate(PATHS.library);
      }
      if (event.key === "Escape") {
        setCommandPalette(false);
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [location.pathname, navigate]);

  return (
    <div className={`app-shell density-${density}`}>
      <a href="#main-content" className="skip-to-main">
        Skip to content
      </a>
      <LegacyViewRedirect />
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`} aria-label="Primary">
        <div className="brand-wrap">
          <img className="brand-mark" src="/assets/nebularr-icon.svg" alt="Nebularr icon" />
          <div>
            <h2 className="brand">Nebularr</h2>
            <div className="muted">Control plane</div>
          </div>
        </div>
        <nav className="side-nav" aria-label="App sections">
          {NAV.map(({ to, label, end, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
              onClick={() => setSidebarOpen(false)}
            >
              <Icon className="nav-link-icon" size={18} strokeWidth={1.75} aria-hidden />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="muted mt16">Cmd/Ctrl+K for command palette</div>
      </aside>
      <main className="main" id="main-content" tabIndex={-1}>
        <div className="topbar">
          <div>
            <div className="row">
              <button type="button" className="secondary mobile-only" onClick={() => setSidebarOpen((v) => !v)}>
                Menu
              </button>
              <h1 className="view-title">{currentTitle}</h1>
            </div>
            <div className="row">
              <span className={`pill health-${status.data?.health_state ?? "ok"}`}>
                health: {status.data?.health_state ?? "-"}
              </span>
              <span className="pill">sync: {status.data?.active_sync_count ?? "-"}</span>
              <span className="pill">webhooks: {status.data?.webhook_queue_open ?? "-"}</span>
              {status.data?.mal_sync ? (
                <span className="pill">
                  MAL:{" "}
                  {status.data.mal_sync.running.length > 0
                    ? `running (${status.data.mal_sync.running.map((r) => r.job_type).join(", ")})`
                    : "idle"}
                </span>
              ) : null}
            </div>
            <div className="subtitle">
              Health: {status.data?.health_state ?? "-"} / Active syncs: {status.data?.active_sync_count ?? "-"}
              {status.data?.mal_sync ? (
                <>
                  {" "}
                  / MAL:{" "}
                  {status.data.mal_sync.running.length > 0
                    ? `${status.data.mal_sync.running.length} job(s) running`
                    : "idle"}
                </>
              ) : null}
            </div>
          </div>
          <div className="row">
            <button type="button" className="secondary" onClick={() => setCommandPalette(true)} title="Command palette (Cmd/Ctrl+K)">
              <Sliders size={16} style={{ marginRight: 6, verticalAlign: "text-bottom" }} aria-hidden />
              Command palette
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setDensity(density === "comfortable" ? "compact" : "comfortable")}
            >
              Density: {density}
            </button>
            <button type="button" className="secondary" onClick={() => queryClient.invalidateQueries()}>
              Refresh
            </button>
          </div>
        </div>

        <DiagnosticsPanel message={lastError} context={errorContext} clear={() => setLastError(null)} />
        <RouteErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </RouteErrorBoundary>
      </main>

      {commandPalette ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Command palette" onClick={() => setCommandPalette(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <h3>Command palette</h3>
            <button type="button" onClick={() => { navigate(PATHS.home); setCommandPalette(false); }}>
              Go to home
            </button>
            <button type="button" onClick={() => { navigate(PATHS.dashboard); setCommandPalette(false); }}>
              Go to dashboard
            </button>
            <button type="button" onClick={() => { navigate(PATHS.library); setCommandPalette(false); }}>
              Go to library
            </button>
            <button type="button" onClick={() => { navigate(PATHS.reporting); setCommandPalette(false); }}>
              Go to reporting
            </button>
            <button type="button" onClick={() => { navigate(PATHS.logs); setCommandPalette(false); }}>
              Go to logs
            </button>
            <button
              type="button"
              onClick={() => runAction(() => api.runSync("sonarr", "incremental"), "palette sync sonarr")}
            >
              Run Sonarr incremental
            </button>
            <button
              type="button"
              onClick={() => runAction(() => api.runSync("radarr", "incremental"), "palette sync radarr")}
            >
              Run Radarr incremental
            </button>
            <p className="muted" style={{ marginTop: 8 }}>
              Or use the sidebar. <Link to={PATHS.home} onClick={() => setCommandPalette(false)}>Home</Link>
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
