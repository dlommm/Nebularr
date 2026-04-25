import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { PATHS } from "../routes/paths";
import { BarChart2, BookOpen, FileText, LayoutDashboard, ListOrdered, Network, Zap } from "lucide-react";
import { GlassCard, CardContent, CardHeader, CardTitle } from "../components/nebula/GlassCard";
import { Badge } from "@/components/ui/badge";
import nebularrLogo from "@/assets/nebularr-logo.svg?url";
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
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/10 via-[#0e1630] to-violet-600/20 p-6 nebula-glow sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="flex min-w-0 flex-1 flex-col gap-4 sm:flex-row sm:items-start">
            <img className="h-20 w-20 shrink-0 rounded-2xl border border-cyan-500/30 bg-[#0e1630] p-1" src={nebularrIcon} alt="" />
            <div className="min-w-0">
              <img className="mb-2 h-8 w-auto max-w-full object-contain opacity-90" src={nebularrLogo} alt="Nebularr" />
              <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">Control plane</h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                Nebularr syncs Sonarr and Radarr into PostgreSQL so you can monitor health, track media quality, and run
                reporting from a single place. Use the map below to jump in.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary" className="border-white/10 bg-white/5">
              v{healthz.data?.version ?? "…"}
            </Badge>
            <Badge variant="secondary" className="border-white/10 bg-white/5">
              {healthz.data?.git_sha?.slice(0, 7) ?? "—"}
            </Badge>
          </div>
        </div>
      </div>

      <GlassCard>
        <CardHeader>
          <CardTitle className="text-lg">Where to go</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Start on <Link to={PATHS.dashboard} className="text-cyan-300 hover:underline">Dashboard</Link> for live telemetry.
            Tune integrations and schedules when you are ready.
          </p>
          <ul className="mt-4 grid w-full min-w-0 list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3">
            {mapLinks.map(({ to, label, blurb, Icon }) => (
              <li key={to}>
                <Link
                  to={to}
                  className="flex h-full min-h-[88px] gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-left transition hover:border-cyan-500/40 hover:bg-white/[0.07]"
                >
                  <Icon className="mt-0.5 size-5 shrink-0 text-cyan-300/80" strokeWidth={1.75} aria-hidden />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium text-foreground">{label}</span>
                    <span className="text-xs text-muted-foreground">{blurb}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </GlassCard>
    </div>
  );
}
