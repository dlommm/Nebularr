import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { PATHS } from "../routes/paths";
import { BarChart2, BookOpen, FileText, Inbox, LayoutDashboard, ListOrdered, Network, Server, Wrench } from "lucide-react";

const mapLinks: { to: string; label: string; blurb: string; Icon: typeof LayoutDashboard }[] = [
  { to: PATHS.dashboard, label: "Dashboard", blurb: "Live KPIs, sync activity, and health at a glance.", Icon: LayoutDashboard },
  { to: PATHS.reporting, label: "Reporting", blurb: "Analytics, CSV export, and warehouse dashboards.", Icon: BarChart2 },
  { to: PATHS.library, label: "Library", blurb: "Browse shows, episodes, and movies in the warehouse.", Icon: BookOpen },
  { to: PATHS.integrations, label: "Integrations", blurb: "Sonarr, Radarr, MAL, logging, and webhooks.", Icon: Network },
  { to: PATHS.schedules, label: "Schedules", blurb: "Incremental sync, reconcile, and MAL job crons.", Icon: ListOrdered },
  { to: PATHS.runs, label: "Sync runs", blurb: "History of past sync and reconcile jobs.", Icon: Server },
  { to: PATHS.webhooks, label: "Webhooks", blurb: "Inbound queue, retries, and dead-letter visibility.", Icon: Inbox },
  { to: PATHS.actions, label: "Manual actions", blurb: "On-demand sync, dead-letter replay, and MAL pipelines.", Icon: Wrench },
  { to: PATHS.logs, label: "Logs", blurb: "In-memory app logs from this instance.", Icon: FileText },
];

export function HomePage(): JSX.Element {
  usePageTitle("Home");
  const healthz = useQuery({
    queryKey: ["healthz"],
    queryFn: api.healthz,
    refetchInterval: 60_000,
  });

  return (
    <div className="grid">
      <div className="card span-12 welcome-card home-hero">
        <div className="welcome-brand">
          <img className="welcome-banner" src="/assets/nebularr-logo.svg" alt="Nebularr banner" />
          <img className="welcome-icon" src="/assets/nebularr-icon.svg" alt="Nebularr icon" />
        </div>
        <h1 className="home-title">Nebularr</h1>
        <p className="muted welcome-copy">
          Nebularr syncs Sonarr and Radarr into PostgreSQL so you can monitor health, track media quality, and run
          reporting from a single control plane. Use the map below to jump to the area you need.
        </p>
        <div className="row">
          <span className="pill">App version: {healthz.data?.version ?? "…"}</span>
          <span className="pill">Git: {healthz.data?.git_sha?.slice(0, 7) ?? "…"}</span>
        </div>
      </div>

      <div className="card span-12 home-map">
        <h2>Where to go</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Operators: start on <Link to={PATHS.dashboard}>Dashboard</Link> for live telemetry. Day-two tuning lives under Integrations
          and Schedules.
        </p>
        <ul className="app-map-list">
          {mapLinks.map(({ to, label, blurb, Icon }) => (
            <li key={to} className="app-map-item">
              <Link to={to} className="app-map-link">
                <Icon className="app-map-icon" size={20} strokeWidth={1.75} aria-hidden />
                <span className="app-map-text">
                  <span className="app-map-title">{label}</span>
                  <span className="muted app-map-blurb">{blurb}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
