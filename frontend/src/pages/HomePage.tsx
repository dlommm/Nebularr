import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { PATHS } from "../routes/paths";
import { ArrowRight, BarChart2, BookOpen, FileText, LayoutDashboard, ListOrdered, Network, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import nebularrIcon from "@/assets/nebularr-icon.svg?url";

const mapLinks: { to: string; label: string; blurb: string; Icon: typeof LayoutDashboard }[] = [
  { to: PATHS.dashboard, label: "Dashboard", blurb: "Live KPIs, sync activity, and health at a glance.", Icon: LayoutDashboard },
  { to: PATHS.reporting, label: "Reporting", blurb: "Analytics, CSV export, and warehouse dashboards.", Icon: BarChart2 },
  { to: PATHS.library, label: "Library", blurb: "Browse shows, episodes, and movies in the warehouse.", Icon: BookOpen },
  { to: PATHS.sync, label: "Sync & Queue", blurb: "Progress, run history, webhooks, and manual actions.", Icon: Zap },
  { to: PATHS.integrations, label: "Integrations", blurb: "Sonarr, Radarr, MAL, logging, and webhooks.", Icon: Network },
  { to: PATHS.schedules, label: "Schedules", blurb: "Incremental sync, reconcile, and MAL job crons.", Icon: ListOrdered },
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
    <div className="mx-auto max-w-5xl space-y-8 py-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <img className="size-12 shrink-0 rounded-xl" src={nebularrIcon} alt="" />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Nebularr</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Sonarr and Radarr synced into PostgreSQL — health, media quality, and reporting in one place.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Badge variant="outline" className="font-mono text-xs text-muted-foreground">
            v{healthz.data?.version ?? "…"}
          </Badge>
          <Badge variant="outline" className="font-mono text-xs text-muted-foreground">
            {healthz.data?.git_sha?.slice(0, 7) ?? "—"}
          </Badge>
        </div>
      </div>

      <div>
        <p className="text-sm text-muted-foreground">
          Start on <Link to={PATHS.dashboard} className="font-medium text-primary hover:underline">Dashboard</Link> for live
          telemetry. Tune integrations and schedules when you are ready.
        </p>
        <ul className="mt-4 grid w-full min-w-0 list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3">
          {mapLinks.map(({ to, label, blurb, Icon }) => (
            <li key={to}>
              <Link
                to={to}
                className="group flex h-full min-h-[92px] gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-[var(--shadow-card)] transition-colors hover:border-primary/35 hover:bg-accent/40"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <Icon className="size-4.5 text-primary" strokeWidth={1.75} aria-hidden />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1 text-sm font-medium text-foreground">
                    {label}
                    <ArrowRight
                      className="size-3.5 -translate-x-1 text-muted-foreground opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100"
                      aria-hidden
                    />
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground">{blurb}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
